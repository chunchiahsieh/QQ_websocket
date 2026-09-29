using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Playwright;

namespace CollectorDesktop;

// The AB official browser and decoder run only on the backup Windows PC.
// Render receives complete normalized snapshots, never an official token.
public sealed class AbCollector
{
    readonly RenderCollectorClient render;
    readonly Action<string> log;
    readonly Dictionary<string, Dictionary<string, object?>> tables = new(StringComparer.Ordinal);
    readonly object tableGate = new();
    bool initialSnapshotPublished;
    bool initialSnapshotScheduled;
    DateTimeOffset initialSnapshotStartedAt;
    DateTimeOffset latestInitialTableUpdateAt;
    int lastAcceptedSnapshotCount = -1;

    public AbCollector(RenderCollectorClient render, Action<string> log) { this.render = render; this.log = log; }

    public async Task RunAsync(string gameUrl, CancellationToken ct)
    {
        if (!AllowedGameUrl(gameUrl)) throw new InvalidOperationException("歐博授權網址不是允許的官方網址。");
        await render.PublishStatusAsync("AB", "connecting", "歐博正在建立即時連線…", ct);
        var packets = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });
        await using var snapshots = new LatestSnapshotPublisher<Dictionary<string, object?>[]>(
            PublishSnapshotAsync,
            ex => log("歐博完整快照上傳失敗，保留最新資料並重試：" + ex.Message));
        AbMediaCatalog media;
        try { media = await AbMediaCatalog.Load(ct); }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or System.Security.Cryptography.CryptographicException or FormatException or ArgumentException)
        {
            // Public image/video metadata is optional. A media-server outage
            // must not stop the primary table feed.
            media = new AbMediaCatalog();
            log("歐博媒體設定暫不可用；桌況採集仍會繼續。");
        }
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(new() {
            Headless = false, Channel = "chrome", Timeout = 30000,
            Args = new[] { "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--no-first-run", "--disable-dev-shm-usage" }
        });
        await using var context = await browser.NewContextAsync(new() { AcceptDownloads = false });
        using var cancellation = ct.Register(() => { _ = browser.CloseAsync(); });
        var observedPages = new HashSet<IPage>();
        void Attach(IPage page)
        {
            lock (observedPages) if (!observedPages.Add(page)) return;
            page.WebSocket += (_, socket) => {
                if (!Uri.TryCreate(socket.Url, UriKind.Absolute, out var endpoint) || !AllowedSocket(endpoint)) return;
                log($"歐博官方 WebSocket 已建立：{endpoint.Host}");
                socket.FrameReceived += (_, frame) => {
                    var bytes = frame.Text is { } message ? Encoding.UTF8.GetBytes(message) : frame.Binary;
                    if (bytes is not { Length: > 0 }) return;
                    if (!packets.Writer.TryWrite(bytes.ToArray()) && !ct.IsCancellationRequested)
                        log("歐博官方封包佇列已停止；此工作階段將重建。");
                };
            };
        }
        context.Page += (_, page) => Attach(page);
        var page = await context.NewPageAsync(); Attach(page);
        // Browser exceptions can contain a short-lived launch URL. Do not
        // copy that diagnostic text into the operator log.
        page.PageError += (_, _) => log("歐博官方頁面回報錯誤，將檢查桌況連線。");
        var navigation = await page.GotoAsync(gameUrl, new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 60000 });
        if (navigation?.Status == 403 || page.Url.Contains("/403", StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("歐博官方拒絕此電腦的連線（HTTP 403）。");
        log("歐博授權頁面已開啟，等待桌況封包。");
        var decoder = new AbTableDecoder(media);
        var lastTableUpdate = DateTimeOffset.UtcNow;
        var lastPacketAt = lastTableUpdate;
        using var heartbeatStop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var heartbeat = KeepSnapshotAliveAsync(snapshots, heartbeatStop.Token);
        var ignoredNonTableFrames = 0;
        try
        {
            while (!ct.IsCancellationRequested)
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                // An official positive countdown may be the final packet before
                // cards appear. Advance its verified deadline even if no zero
                // packet arrives; waiting for a new frame would delay the overlay.
                timeout.CancelAfter(TimeSpan.FromMilliseconds(250));
                byte[]? bytes = null;
                try { bytes = await packets.Reader.ReadAsync(timeout.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    if (DateTimeOffset.UtcNow - lastPacketAt > TimeSpan.FromSeconds(65))
                        throw new TimeoutException("歐博 65 秒未收到官方 WebSocket 封包。");
                }
                List<Dictionary<string, object>> updates;
                try
                {
                    if (bytes is null) updates = decoder.AdvanceTime(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
                    else
                    {
                        lastPacketAt = DateTimeOffset.UtcNow;
                        updates = decoder.Accept(bytes);
                        // Unrelated official frames can arrive continuously, so
                        // a read timeout is not guaranteed at the deadline.
                        updates.AddRange(decoder.AdvanceTime(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
                    }
                }
                catch (Exception ex) when (ex is JsonException or InvalidDataException or FormatException)
                {
                    if (Interlocked.Increment(ref ignoredNonTableFrames) <= 3)
                        log("歐博收到非桌況控制封包，已略過。");
                    continue;
                }
                if (updates.Count == 0)
                {
                    if (DateTimeOffset.UtcNow - lastTableUpdate > TimeSpan.FromMinutes(3))
                        throw new TimeoutException("歐博 3 分鐘未更新桌況，將重新取得授權。");
                    continue;
                }
                if (bytes is not null) lastTableUpdate = DateTimeOffset.UtcNow;
                Dictionary<string, object?>[]? snapshot = null;
                var startInitialSnapshot = false;
                lock (tableGate)
                {
                    foreach (var update in updates)
                    {
                        if (!update.TryGetValue("tableId", out var idValue) || idValue is not string id || string.IsNullOrWhiteSpace(id)) continue;
                        tables[id] = AbCardMapper.ToCard(update);
                    }
                    if (!initialSnapshotPublished)
                    {
                        latestInitialTableUpdateAt = DateTimeOffset.UtcNow;
                        if (!initialSnapshotScheduled)
                        {
                            initialSnapshotScheduled = true;
                            initialSnapshotStartedAt = latestInitialTableUpdateAt;
                            startInitialSnapshot = true;
                        }
                    }
                    else snapshot = SnapshotUnsafe();
                }
                if (startInitialSnapshot) _ = PublishInitialSnapshotAsync(snapshots, ct);
                if (snapshot is { Length: > 0 }) snapshots.Submit(snapshot);
            }
        }
        finally
        {
            heartbeatStop.Cancel();
            try { await heartbeat; } catch (OperationCanceledException) { }
            packets.Writer.TryComplete();
        }
    }

    async Task PublishInitialSnapshotAsync(LatestSnapshotPublisher<Dictionary<string, object?>[]> snapshots, CancellationToken ct)
    {
        try
        {
            while (true)
            {
                DateTimeOffset started, updated;
                lock (tableGate) { started = initialSnapshotStartedAt; updated = latestInitialTableUpdateAt; }
                var now = DateTimeOffset.UtcNow;
                if (now - started >= TimeSpan.FromSeconds(20)
                    || (now - started >= TimeSpan.FromSeconds(10) && now - updated >= TimeSpan.FromSeconds(1))) break;
                await Task.Delay(250, ct);
            }
            Dictionary<string, object?>[] snapshot;
            lock (tableGate) { initialSnapshotPublished = true; snapshot = SnapshotUnsafe(); }
            if (snapshot.Length > 0) snapshots.Submit(snapshot);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception ex)
        {
            lock (tableGate) initialSnapshotScheduled = false;
            log("歐博初始桌況同步失敗，等待下一次更新重試：" + ex.Message);
        }
    }

    async Task KeepSnapshotAliveAsync(LatestSnapshotPublisher<Dictionary<string, object?>[]> snapshots, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
        try
        {
            while (await timer.WaitForNextTickAsync(ct)) snapshots.Pulse();
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }

    Dictionary<string, object?>[] SnapshotUnsafe() => tables.Values
        .OrderBy(row => Convert.ToString(row.GetValueOrDefault("name")), StringComparer.Ordinal)
        .Select(row => new Dictionary<string, object?>(row, StringComparer.Ordinal)).ToArray();

    async Task PublishSnapshotAsync(IReadOnlyCollection<Dictionary<string, object?>> snapshot, CancellationToken ct)
    {
        await render.PublishSnapshotAsync("AB", snapshot, ct);
        if (Interlocked.Exchange(ref lastAcceptedSnapshotCount, snapshot.Count) != snapshot.Count)
        {
            log($"歐博 Render 已接受完整快照（{snapshot.Count} 桌）。");
            try { await render.PublishStatusAsync("AB", "connected", $"歐博即時連線中（{snapshot.Count} 桌）。", ct); }
            catch (Exception ex) { log("歐博 Render 狀態更新失敗，資料快照仍已保存：" + ex.Message); }
        }
    }

    internal static bool AllowedGameUrl(string raw)
    {
        if (!Uri.TryCreate(raw, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps
            || !(uri.Query.Contains("token=", StringComparison.OrdinalIgnoreCase) || uri.Query.Contains("sessionId=", StringComparison.OrdinalIgnoreCase))) return false;
        return AllowedHost(uri.Host, ".ahsy114.com", ".ofa1188.net", ".20299999.com", "ab8888.games", ".ab8888.games");
    }

    static bool AllowedSocket(Uri uri) => uri.Scheme == Uri.UriSchemeWss
        && AllowedHost(uri.Host, ".maofeiyan.com", ".51shengce.com", ".kindlestone.com");

    static bool AllowedHost(string host, params string[] suffixes) => suffixes.Any(suffix => suffix.StartsWith('.')
        ? host.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)
        : host.Equals(suffix, StringComparison.OrdinalIgnoreCase));
}
