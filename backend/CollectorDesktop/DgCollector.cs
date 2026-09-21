using System.Threading.Channels;
using Microsoft.Playwright;

namespace CollectorDesktop;

public sealed class DgCollector
{
    readonly RenderCollectorClient render;
    readonly Action<string> log;
    readonly Dictionary<string, Dictionary<string, object?>> tables = new(StringComparer.Ordinal);
    public DgCollector(RenderCollectorClient render, Action<string> log) { this.render = render; this.log = log; }

    public async Task RunAsync(string gameUrl, CancellationToken ct)
    {
        if (!AllowedGameUrl(gameUrl)) throw new InvalidOperationException("DG 授權網址不是允許的官方網址。");
        await render.PublishStatusAsync("DG", "connecting", "DG 本機採集器正在啟動 Edge…", ct);
        var packets = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(64) { SingleReader = true, FullMode = BoundedChannelFullMode.DropOldest });
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(new() {
            Headless = true, Channel = "msedge", Timeout = 30000,
            Args = new[] { "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--no-first-run", "--disable-dev-shm-usage" }
        });
        await using var context = await browser.NewContextAsync(new() { AcceptDownloads = false });
        await context.RouteAsync("**/*", async route => {
            if (route.Request.ResourceType is "image" or "media") await route.AbortAsync(); else await route.ContinueAsync();
        });
        var sockets = new HashSet<IWebSocket>();
        void Attach(IPage page) => page.WebSocket += (_, socket) => {
            if (!Uri.TryCreate(socket.Url, UriKind.Absolute, out var endpoint) || !AllowedSocket(endpoint)) return;
            lock (sockets) sockets.Add(socket);
            log($"DG 官方 WebSocket 已建立：{endpoint.Host}");
            socket.Close += (_, _) => { lock (sockets) sockets.Remove(socket); };
            socket.FrameReceived += (_, frame) => { if (frame.Binary is { Length: > 0 and <= 262144 } bytes) packets.Writer.TryWrite(bytes); };
        };
        context.Page += (_, page) => Attach(page);
        var page = await context.NewPageAsync(); Attach(page);
        page.PageError += (_, message) => log("DG 官方頁面回報錯誤：" + message);
        await page.GotoAsync(gameUrl, new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 60000 });
        log("DG 授權頁面已開啟，等待桌況封包。");
        var decoder = new DgTableDecoder();
        var lastPacket = DateTimeOffset.UtcNow;
        while (!ct.IsCancellationRequested) {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(65));
            byte[] bytes;
            try { bytes = await packets.Reader.ReadAsync(timeout.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new TimeoutException("DG 65 秒未收到官方桌況封包。"); }
            var updates = decoder.Accept(bytes);
            lastPacket = DateTimeOffset.UtcNow;
            if (updates.Count == 0) continue;
            foreach (var update in updates) {
                if (!update.TryGetValue("tableId", out var idValue) || idValue is not string tableId || string.IsNullOrWhiteSpace(tableId)) continue;
                if (!tables.TryGetValue(tableId, out var row)) tables[tableId] = row = new(StringComparer.Ordinal);
                foreach (var value in ToCard(update, page.Url)) row[value.Key] = value.Value;
            }
            await render.PublishSnapshotAsync("DG", tables.Values.ToArray(), ct);
            await render.PublishStatusAsync("DG", "connected", $"DG 即時連線中（{tables.Count} 桌）。", ct);
        }
    }

    static Dictionary<string, object?> ToCard(Dictionary<string, object> source, string pageUrl)
    {
        var id = Convert.ToString(source.GetValueOrDefault("tableId"))!;
        var row = new Dictionary<string, object?> {
            ["id"] = "DG:" + id, ["name"] = Convert.ToString(source.GetValueOrDefault("tableName")) ?? id, ["gameType"] = "BAC",
            ["room"] = Convert.ToString(source.GetValueOrDefault("tableName")) ?? "—", ["shoe"] = Convert.ToString(source.GetValueOrDefault("shoeId")) ?? "—",
            ["round"] = Convert.ToString(source.GetValueOrDefault("playId")) ?? "—", ["players"] = Convert.ToString(source.GetValueOrDefault("onlineCount")) ?? "—",
            ["banker"] = "0", ["player"] = "0", ["tie"] = "0", ["beadPlate"] = "", ["bigRoad"] = "", ["bigEyeRoad"] = "", ["smallRoad"] = "", ["cockroachRoad"] = "",
        };
        if (source.TryGetValue("countDown", out var countdown) && long.TryParse(Convert.ToString(countdown), out var seconds)) {
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); row["countdownValue"] = Math.Max(0, seconds); row["countdownDeadline"] = now + Math.Max(0, seconds) * 1000; row["countdownReceivedAt"] = now;
        }
        if (source.TryGetValue("state", out var state)) row["tableState"] = Convert.ToString(state);
        if (source.TryGetValue("dealer", out var dealerValue) && dealerValue is Dictionary<string, object> dealer) {
            row["dealer"] = Convert.ToString(dealer.GetValueOrDefault("name")) ?? "未指派";
            var photo = Convert.ToString(dealer.GetValueOrDefault("photo"));
            if (!string.IsNullOrWhiteSpace(photo) && !photo.Contains("..") && !photo.Contains(':')) row["dealerPhoto"] = new Uri(new Uri(pageUrl).GetLeftPart(UriPartial.Authority) + "/vd/vd/image/Image/dealer/" + photo.TrimStart('/')).ToString();
        }
        return row;
    }

    static bool AllowedGameUrl(string raw) => Uri.TryCreate(raw, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps && uri.Query.Contains("token=", StringComparison.OrdinalIgnoreCase) && (uri.Host.EndsWith(".ahsy114.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".20299999.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".dggw.vip", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".ywjxi.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".dingdangmail.com", StringComparison.OrdinalIgnoreCase));
    static bool AllowedSocket(Uri uri) => uri.Scheme is "ws" or "wss" && (uri.Host.EndsWith(".taxyss.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".kindlestone.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".ywjxi.com", StringComparison.OrdinalIgnoreCase));
}
