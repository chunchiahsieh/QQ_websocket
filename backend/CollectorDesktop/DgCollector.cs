using System.Threading.Channels;
using Microsoft.Playwright;

namespace CollectorDesktop;

public sealed class DgCollector
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
    public DgCollector(RenderCollectorClient render, Action<string> log) { this.render = render; this.log = log; }

    public async Task RunAsync(string gameUrl, CancellationToken ct)
    {
        if (!AllowedGameUrl(gameUrl)) throw new InvalidOperationException("DG 授權網址不是允許的官方網址。");
        await render.PublishStatusAsync("DG", "connecting", "DG 正在建立即時連線…", ct);
        // Correctness comes first here.  The previous bounded DropOldest
        // queue silently lost table packets during the lobby's initial burst.
        // Decode every received binary frame into the local full state, then
        // coalesce only the *resulting complete snapshots* before posting.
        var packets = Channel.CreateUnbounded<byte[]>(new UnboundedChannelOptions { SingleReader = true, SingleWriter = false });
        await using var snapshots = new LatestSnapshotPublisher<Dictionary<string, object?>[]>(
            PublishSnapshotAsync,
            ex => log("DG Render 完整快照上傳失敗，保留最新資料並重試：" + ex.Message));
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(new() {
            Headless = false, Channel = "chrome", Timeout = 30000,
            Args = new[] { "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--no-first-run", "--disable-dev-shm-usage" }
        });
        await using var context = await browser.NewContextAsync(new() { AcceptDownloads = false });
        var sockets = new HashSet<IWebSocket>();
        var observedPages = new HashSet<IPage>();
        void Attach(IPage page)
        {
            lock (observedPages) if (!observedPages.Add(page)) return;
            page.WebSocket += (_, socket) => {
                if (!Uri.TryCreate(socket.Url, UriKind.Absolute, out var endpoint) || !AllowedSocket(endpoint)) return;
                lock (sockets) sockets.Add(socket);
                log($"DG 官方 WebSocket 已建立：{endpoint.Host}");
                socket.Close += (_, _) => { lock (sockets) sockets.Remove(socket); };
                socket.FrameReceived += (_, frame) =>
                {
                    if (frame.Binary is not { Length: > 0 } bytes) return;
                    // Keep an owned copy.  Playwright event buffers are not a
                    // safe long-lived queue payload, and a size cap would be
                    // another silent source-packet drop.
                    if (!packets.Writer.TryWrite(bytes.ToArray()) && !ct.IsCancellationRequested)
                        log("DG 官方封包佇列已停止；此採集工作階段將重建。");
                };
            };
        }
        context.Page += (_, page) => Attach(page);
        var page = await context.NewPageAsync(); Attach(page);
        page.PageError += (_, message) => log("DG 官方頁面回報錯誤：" + message);
        await page.GotoAsync(gameUrl, new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 60000 });
        log("DG 授權頁面已開啟，等待桌況封包。");
        var decoder = new DgTableDecoder();
        var loggedNonzeroLobbyCount = false;
        ulong? loggedRb02Count = null;
        using var heartbeatStop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var heartbeat = KeepSnapshotAliveAsync(snapshots, heartbeatStop.Token);
        var ignoredNonTableFrames = 0;
        try {
            while (!ct.IsCancellationRequested) {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(65));
                byte[] bytes;
                try { bytes = await packets.Reader.ReadAsync(timeout.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested) { throw new TimeoutException("DG 65 秒未收到官方桌況封包。"); }
                List<Dictionary<string, object>> updates;
                try { updates = decoder.Accept(bytes); }
                catch (InvalidDataException)
                {
                    // DG shares the same socket with control packets.  They
                    // have been received and examined, but contain no table
                    // state, so do not tear down a healthy table stream.
                    if (Interlocked.Increment(ref ignoredNonTableFrames) <= 3)
                        log("DG 收到非桌況控制封包，已略過。");
                    continue;
                }
                if (updates.Count == 0) continue;
                Dictionary<string, object?>[]? snapshot = null;
                var startInitialSnapshot = false;
                string? lobbyCountDiagnostic = null;
                lock (tableGate) {
                    foreach (var update in updates) {
                        if (!update.TryGetValue("tableId", out var idValue) || idValue is not string tableId || string.IsNullOrWhiteSpace(tableId)) continue;
                        if (!tables.TryGetValue(tableId, out var row)) tables[tableId] = row = new(StringComparer.Ordinal);
                        foreach (var value in DgCardMapper.ToCard(update, page.Url)) row[value.Key] = value.Value;
                    }
                    if (decoder.LastPacketHadLobbyCount) {
                        var nonzeroTables = tables.Values.Count(row => ulong.TryParse(Convert.ToString(row.GetValueOrDefault("players")), out var count) && count > 0);
                        var rb02 = tables.Values.FirstOrDefault(row =>
                            Convert.ToString(row.GetValueOrDefault("room"))?.Contains("RB02", StringComparison.OrdinalIgnoreCase) == true ||
                            Convert.ToString(row.GetValueOrDefault("id"))?.Contains("RB02", StringComparison.OrdinalIgnoreCase) == true);
                        ulong? rb02Count = rb02 != null && ulong.TryParse(Convert.ToString(rb02.GetValueOrDefault("players")), out var count) ? count : null;
                        if ((!loggedNonzeroLobbyCount && nonzeroTables > 0) || (rb02Count.HasValue && rb02Count != loggedRb02Count)) {
                            lobbyCountDiagnostic = $"DG 已收到大廳在線人數更新（非零桌數 {nonzeroTables}，RB02={rb02Count?.ToString() ?? "未收到"}）";
                            loggedNonzeroLobbyCount |= nonzeroTables > 0;
                            loggedRb02Count = rb02Count;
                        }
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
                if (lobbyCountDiagnostic != null) log(lobbyCountDiagnostic);
                if (startInitialSnapshot) _ = PublishInitialSnapshotAsync(snapshots, ct);
                if (snapshot is { Length: > 0 }) snapshots.Submit(snapshot);
            }
        }
        finally {
            heartbeatStop.Cancel();
            try { await heartbeat; } catch (OperationCanceledException) { }
            packets.Writer.TryComplete();
        }
    }

    async Task PublishInitialSnapshotAsync(LatestSnapshotPublisher<Dictionary<string, object?>[]> snapshots, CancellationToken ct)
    {
        try
        {
            // The DG lobby arrives as a series of per-table frames.  Do not
            // briefly publish the first one or two tables as if they were the
            // whole lobby.  Wait until the initial burst has gone quiet after
            // a minimum warm-up, but put a firm upper bound on first render.
            // This is a connection-time cost only; normal live updates use
            // the short publisher debounce below.
            await WaitForInitialLobbyAsync(ct);
            Dictionary<string, object?>[] snapshot;
            lock (tableGate)
            {
                initialSnapshotPublished = true;
                snapshot = SnapshotUnsafe();
            }
            if (snapshot.Length > 0) snapshots.Submit(snapshot);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception ex)
        {
            lock (tableGate) initialSnapshotScheduled = false;
            log("DG 初始桌況同步失敗，將等待下一個更新重試：" + ex.Message);
        }
    }

    async Task WaitForInitialLobbyAsync(CancellationToken ct)
    {
        var minimumWarmup = TimeSpan.FromSeconds(10);
        var quietPeriod = TimeSpan.FromSeconds(1);
        var maximumWarmup = TimeSpan.FromSeconds(20);
        while (true)
        {
            DateTimeOffset startedAt, latestUpdateAt;
            lock (tableGate)
            {
                startedAt = initialSnapshotStartedAt;
                latestUpdateAt = latestInitialTableUpdateAt;
            }
            var now = DateTimeOffset.UtcNow;
            var elapsed = now - startedAt;
            if (elapsed >= maximumWarmup || (elapsed >= minimumWarmup && now - latestUpdateAt >= quietPeriod)) return;
            await Task.Delay(TimeSpan.FromMilliseconds(250), ct);
        }
    }

    async Task KeepSnapshotAliveAsync(LatestSnapshotPublisher<Dictionary<string, object?>[]> snapshots, CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(10));
        try {
            while (await timer.WaitForNextTickAsync(ct)) {
                try {
                    // The coordinator reposts exactly the newest fully
                    // decoded snapshot.  It cannot race an event update and
                    // overwrite it with an older captured array.
                    snapshots.Pulse();
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex) { log("DG Render 快照保活失敗，10 秒後重試：" + ex.Message); }
            }
        } catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }

    Dictionary<string, object?>[] SnapshotUnsafe() => tables.Values
        .OrderBy(row => Convert.ToString(row.GetValueOrDefault("name")), StringComparer.Ordinal)
        .Select(row => new Dictionary<string, object?>(row, StringComparer.Ordinal))
        .ToArray();

    async Task PublishSnapshotAsync(IReadOnlyCollection<Dictionary<string, object?>> snapshot, CancellationToken ct)
    {
        await render.PublishSnapshotAsync("DG", snapshot, ct);
        if (Interlocked.Exchange(ref lastAcceptedSnapshotCount, snapshot.Count) != snapshot.Count)
        {
            log($"DG Render 已接受完整快照（{snapshot.Count} 桌）。");
            // The snapshot is authoritative.  Do not retry/reorder it merely
            // because the cosmetic status request happened to fail.
            try { await render.PublishStatusAsync("DG", "connected", $"DG 即時連線中（{snapshot.Count} 桌）。", ct); }
            catch (Exception ex) { log("DG Render 狀態更新失敗，資料快照仍已保存：" + ex.Message); }
        }
    }

    static bool AllowedGameUrl(string raw) => Uri.TryCreate(raw, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps && uri.Query.Contains("token=", StringComparison.OrdinalIgnoreCase) && (uri.Host.EndsWith(".ahsy114.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".20299999.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".dggw.vip", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".ywjxi.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".dingdangmail.com", StringComparison.OrdinalIgnoreCase));
    static bool AllowedSocket(Uri uri) => uri.Scheme is "ws" or "wss" && (uri.Host.EndsWith(".taxyss.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".kindlestone.com", StringComparison.OrdinalIgnoreCase) || uri.Host.EndsWith(".ywjxi.com", StringComparison.OrdinalIgnoreCase));
}
