using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace CollectorDesktop;

public sealed class MtCollector
{
    readonly RenderCollectorClient render;
    readonly Action<string> log;
    readonly Dictionary<string, Dictionary<string, object?>> tables = new(StringComparer.Ordinal);

    public MtCollector(RenderCollectorClient render, Action<string> log) { this.render = render; this.log = log; }

    public async Task RunAsync(string launchUrl, CancellationToken ct)
    {
        var connection = ParseLaunchUrl(launchUrl);
        await render.PublishStatusAsync("MT", "connecting", "MT 本機採集器正在建立官方 WebSocket…", ct);
        using var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        await socket.ConnectAsync(connection.WebSocketUrl, ct);
        await SendAsync(socket, Authenticate(connection.Token), ct);
        log("MT WebSocket 已建立，等待官方驗證。");
        using var timers = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var ping = PingLoop(socket, timers.Token);
        var refresh = RefreshLoop(socket, timers.Token);
        try {
            var buffer = new byte[64 * 1024];
            while (!ct.IsCancellationRequested && socket.State == WebSocketState.Open) {
                using var frame = new MemoryStream();
                WebSocketReceiveResult result;
                do {
                    result = await socket.ReceiveAsync(buffer, ct);
                    if (result.MessageType == WebSocketMessageType.Close) throw new WebSocketException("MT 官方已關閉 WebSocket。");
                    if (frame.Length + result.Count > 1_000_000) throw new InvalidDataException("MT 封包過大。");
                    frame.Write(buffer, 0, result.Count);
                } while (!result.EndOfMessage);
                if (result.MessageType != WebSocketMessageType.Text) continue;
                await HandlePacketAsync(socket, Encoding.UTF8.GetString(frame.ToArray()), ct);
            }
        } finally {
            timers.Cancel();
            try { await Task.WhenAll(ping, refresh); } catch (OperationCanceledException) { }
            if (!ct.IsCancellationRequested) await render.PublishStatusAsync("MT", "offline", "MT 本機採集器已停止。", CancellationToken.None);
        }
    }

    async Task HandlePacketAsync(ClientWebSocket socket, string raw, CancellationToken ct)
    {
        using var doc = JsonDocument.Parse(raw);
        var root = doc.RootElement;
        var action = ReadString(root, "action");
        if (action == "/api/v1/authenticate") {
            if (ReadLong(root, "err") is { } err && err != 0) throw new InvalidOperationException("MT 官方驗證被拒絕。");
            await SendAsync(socket, Member(), ct); await SendAsync(socket, TableRequest(), ct);
            log("MT 已完成官方驗證，正在取得牌桌。"); return;
        }
        if (action == "/api/v1/member/logout") throw new InvalidOperationException("MT 官方工作階段已登出。");
        var updates = MtTableNormalizer.Extract(root);
        if (updates.Count == 0) return;
        foreach (var update in updates) {
            var id = (string)update["id"]!;
            if (!tables.TryGetValue(id, out var current)) tables[id] = current = new(StringComparer.Ordinal);
            foreach (var item in update) current[item.Key] = item.Value;
        }
        if (action == "/api/v1/gametype/*/game/*/room/*/tables") {
            var ids = tables.Keys.Order().ToArray();
            if (ids.Length > 0) await SendAsync(socket, MultipleJoin(ids), ct);
        }
        var snapshot = tables.Values.Where(t => string.Equals(Convert.ToString(t.GetValueOrDefault("gameType")), "BAC", StringComparison.OrdinalIgnoreCase) || string.Equals(Convert.ToString(t.GetValueOrDefault("gameType")), "BAS", StringComparison.OrdinalIgnoreCase)).OrderBy(t => Convert.ToString(t.GetValueOrDefault("name")), StringComparer.Ordinal).ToArray();
        if (snapshot.Length == 0) snapshot = tables.Values.ToArray();
        await render.PublishSnapshotAsync("MT", snapshot, ct);
        await render.PublishStatusAsync("MT", "connected", $"MT 即時連線中（{snapshot.Length} 桌）。", ct);
    }

    static async Task SendAsync(ClientWebSocket socket, object packet, CancellationToken ct) => await socket.SendAsync(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(packet)), WebSocketMessageType.Text, true, ct);
    static async Task PingLoop(ClientWebSocket socket, CancellationToken ct) { while (!ct.IsCancellationRequested) { await Task.Delay(TimeSpan.FromSeconds(5), ct); if (socket.State == WebSocketState.Open) await SendAsync(socket, new { method = "POST", action = new { name = "/api/v1/ping" } }, ct); } }
    static async Task RefreshLoop(ClientWebSocket socket, CancellationToken ct) { while (!ct.IsCancellationRequested) { await Task.Delay(TimeSpan.FromSeconds(5), ct); if (socket.State == WebSocketState.Open) await SendAsync(socket, TableRequest(), ct); } }
    static object Authenticate(string token) => new { method = "POST", action = new { name = "/api/v1/authenticate", path = "/api/v1/authenticate" }, body = new { type = 3, token } };
    static object Member() => new { method = "POST", action = new { name = "/api/v1/member/me", lang = "zhtw" } };
    static object TableRequest() => new { method = "GET", action = new { name = "/api/v1/gametype/*/game/*/room/*/tables", data = new { gametype_id = 3, game_id = 1, room_id = 1 } } };
    static object MultipleJoin(string[] ids) => new { method = "GET", action = new { name = "/api/v1/gametype/*/game/*/room/*/mulitple_join", data = new { table_id = string.Join(',', ids) } } };
    static string? ReadString(JsonElement value, string name) => value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString() : value.TryGetProperty("action", out var action) && action.ValueKind == JsonValueKind.Object && action.TryGetProperty("name", out var nested) && nested.ValueKind == JsonValueKind.String ? nested.GetString() : null;
    static long? ReadLong(JsonElement value, string name) => value.TryGetProperty(name, out var field) && field.TryGetInt64(out var number) ? number : null;
    static (Uri WebSocketUrl, string Token) ParseLaunchUrl(string raw) {
        var source = new Uri(raw);
        var token = source.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries)
            .Select(pair => pair.Split('=', 2)).Where(pair => pair.Length == 2 && pair[0].Equals("token", StringComparison.OrdinalIgnoreCase))
            .Select(pair => Uri.UnescapeDataString(pair[1])).FirstOrDefault();
        if (string.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("MT 授權網址缺少 token。");
        var builder = new UriBuilder(source) { Path = "/game/ws", Query = "", Fragment = "", Scheme = source.Scheme == "http" ? "ws" : "wss" };
        builder.Host = source.Host.EndsWith(".ofalive99.net", StringComparison.OrdinalIgnoreCase) ? "a1.ofalive99.net" : System.Text.RegularExpressions.Regex.Replace(source.Host, "^gsa\\.", "a1.", System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return (builder.Uri, token);
    }
}
