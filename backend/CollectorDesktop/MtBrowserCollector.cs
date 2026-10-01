using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Playwright;

namespace CollectorDesktop;

// MT rejects a raw .NET WebSocket upgrade on some networks.  We therefore run
// the official launch page in Google Chrome, but drive the *same* protocol as
// the proven browser collector: authenticate, member, /tables, multiple_join,
// ping and five-second table refresh.  Chrome supplies the trusted Origin and
// cookies; C# owns lossless decoding and only publishes complete snapshots.
public sealed class MtBrowserCollector
{
    const string TablesAction = "/api/v1/gametype/*/game/*/room/*/tables";
    readonly RenderCollectorClient render;
    readonly Action<string> log;
    readonly Dictionary<string, Dictionary<string, object?>> tables = new(StringComparer.Ordinal);
    readonly object tableGate = new();
    long tableVersion;
    bool initialSnapshotReady;
    int authenticated;
    int lastAcceptedSnapshotCount = -1;
    string joinedMtTables = "";
    IPage? activeSocketPage;

    public MtBrowserCollector(RenderCollectorClient render, Action<string> log)
    {
        this.render = render;
        this.log = log;
    }

    public async Task RunAsync(string gameUrl, CancellationToken ct)
    {
        if (!AllowedGameUrl(gameUrl)) throw new InvalidOperationException("MT 授權網址不是允許的官方網址。");
        await render.PublishStatusAsync("MT", "connecting", "MT 正在建立即時連線…", ct);

        // Back pressure belongs after the state has been normalized, never on
        // the official packet stream. Dropping a /wait or road packet makes a
        // table permanently wrong, so raw packets are intentionally lossless.
        var packets = Channel.CreateUnbounded<string>(new UnboundedChannelOptions {
            SingleReader = true,
            SingleWriter = false,
            AllowSynchronousContinuations = false,
        });
        using var playwright = await Playwright.CreateAsync();
        await using var browser = await playwright.Chromium.LaunchAsync(new BrowserTypeLaunchOptions {
            Headless = false,
            Channel = "chrome",
            Timeout = 30000,
            Args = new[] { "--disable-extensions", "--no-first-run", "--disable-background-networking" },
        });
        await using var context = await browser.NewContextAsync(new BrowserNewContextOptions { AcceptDownloads = false });
        await context.AddInitScriptAsync(MtSocketCaptureScript);

        var observedPages = new HashSet<IPage>();
        void Attach(IPage observedPage)
        {
            lock (observedPages) if (!observedPages.Add(observedPage)) return;
            observedPage.WebSocket += (_, socket) => {
                if (!Uri.TryCreate(socket.Url, UriKind.Absolute, out var endpoint) || !IsMtSocket(endpoint)) return;
                activeSocketPage = observedPage;
                log("MT 官方 WebSocket 已建立，將使用完整桌況同步流程。");
                socket.Close += (_, _) => { if (ReferenceEquals(activeSocketPage, observedPage)) activeSocketPage = null; };
                socket.FrameReceived += (_, frame) => {
                    var text = frame.Text;
                    if (string.IsNullOrWhiteSpace(text) && frame.Binary is { Length: > 0 and <= 1_000_000 } binary)
                        text = Encoding.UTF8.GetString(binary);
                    if (!string.IsNullOrWhiteSpace(text)) packets.Writer.TryWrite(text);
                };
            };
        }

        context.Page += (_, page) => Attach(page);
        var page = await context.NewPageAsync();
        Attach(page);
        page.PageError += (_, _) => log("MT 官方頁面回報錯誤；將持續等待官方 WebSocket。");
        await page.GotoAsync(gameUrl, new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 60000 });
        log("MT 官方遊戲頁面已開啟，等待官方驗證封包。");

        using var backgroundStop = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var publisher = PublishLoopAsync(backgroundStop.Token);
        var commands = CommandLoopAsync(backgroundStop.Token);
        try
        {
            while (!ct.IsCancellationRequested)
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(65));
                string raw;
                try { raw = await packets.Reader.ReadAsync(timeout.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    throw new TimeoutException("MT 65 秒未收到官方桌況封包。");
                }
                await HandlePacketAsync(raw, ct);
            }
        }
        finally
        {
            packets.Writer.TryComplete();
            backgroundStop.Cancel();
            try { await Task.WhenAll(publisher, commands); }
            catch (OperationCanceledException) { }
        }
    }

    async Task HandlePacketAsync(string raw, CancellationToken ct)
    {
        try
        {
            using var doc = JsonDocument.Parse(raw);
            var root = doc.RootElement;
            var action = MtTableNormalizer.ActionName(root);
            if (string.Equals(action, "/api/v1/authenticate", StringComparison.Ordinal))
            {
                if (ReadLong(root, "err") is { } errorCode && errorCode != 0)
                    throw new InvalidOperationException("MT 官方驗證被拒絕。");
                Interlocked.Exchange(ref authenticated, 1);
                await SendAsync(MemberPacket(), ct);
                await SendAsync(TablesPacket(), ct);
                log("MT 已完成官方驗證，已要求完整桌況。");
                return;
            }
            if (string.Equals(action, "/api/v1/member/logout", StringComparison.Ordinal))
                throw new InvalidOperationException("MT 官方工作階段已登出。");

            var updates = MtTableNormalizer.Extract(root);
            if (updates.Count == 0) return;
            string? joinIds = null;
            lock (tableGate)
            {
                MtTableState.Merge(tables, updates);
                if (MtTableNormalizer.IsTableSnapshot(root))
                {
                    // This is the one authoritative lobby response. It is the
                    // same list used by the original collector to subscribe to
                    // every table's /wait updates, not just visible cards.
                    var allIds = updates.Select(update => Convert.ToString(update["id"]))
                        .Where(id => !string.IsNullOrWhiteSpace(id))
                        .Cast<string>()
                        .OrderBy(id => id, StringComparer.Ordinal)
                        .ToArray();
                    var nextJoined = string.Join(',', allIds);
                    if (!string.IsNullOrWhiteSpace(nextJoined) && !string.Equals(nextJoined, joinedMtTables, StringComparison.Ordinal))
                    {
                        joinedMtTables = nextJoined;
                        joinIds = nextJoined;
                    }
                    initialSnapshotReady = tables.Count > 0;
                }
                tableVersion++;
            }
            if (joinIds is not null) await SendAsync(MultipleJoinPacket(joinIds), ct);
        }
        catch (JsonException)
        {
            // MT also sends text heartbeats/control frames that are not JSON.
        }
    }

    async Task PublishLoopAsync(CancellationToken ct)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
        long publishedVersion = -1;
        var lastPublish = DateTimeOffset.MinValue;
        try
        {
            while (await timer.WaitForNextTickAsync(ct))
            {
                Dictionary<string, object?>[]? snapshot = null;
                long version = 0;
                lock (tableGate)
                {
                    if (!initialSnapshotReady) continue;
                    version = tableVersion;
                    // Coalesce only complete, already-normalized snapshots.
                    // Every raw official packet above is still decoded.
                    if (version != publishedVersion || DateTimeOffset.UtcNow - lastPublish >= TimeSpan.FromSeconds(10))
                        snapshot = SnapshotUnsafe();
                }
                if (snapshot is not { Length: > 0 }) continue;
                try
                {
                    await render.PublishSnapshotAsync("MT", snapshot, ct);
                    publishedVersion = version;
                    lastPublish = DateTimeOffset.UtcNow;
                    if (Interlocked.Exchange(ref lastAcceptedSnapshotCount, snapshot.Length) != snapshot.Length)
                    {
                        log($"MT Render 已接受完整快照（{snapshot.Length} 桌）。");
                        await render.PublishStatusAsync("MT", "connected", $"MT 即時連線中（{snapshot.Length} 桌）。", ct);
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    // Do not block or discard official packets when Render has
                    // a transient delay. The next interval sends the latest
                    // complete state again.
                    log("MT Render 快照傳送失敗，將保留完整桌況並重試：" + ex.Message);
                }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }

    async Task CommandLoopAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                await Task.Delay(TimeSpan.FromSeconds(5), ct);
                if (Volatile.Read(ref authenticated) == 0) continue;
                try
                {
                    await SendAsync(PingPacket(), ct);
                    await SendAsync(TablesPacket(), ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex) { log("MT 官方桌況刷新暫時失敗，將重試：" + ex.Message); }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
    }

    Dictionary<string, object?>[] SnapshotUnsafe()
    {
        var baccarat = tables.Values
            .Where(table => string.Equals(Text(table, "gameType"), "BAC", StringComparison.OrdinalIgnoreCase)
                || string.Equals(Text(table, "gameType"), "BAS", StringComparison.OrdinalIgnoreCase))
            .OrderBy(table => Text(table, "name"), StringComparer.Ordinal)
            .Select(table => new Dictionary<string, object?>(table, StringComparer.Ordinal))
            .ToArray();
        return baccarat.Length > 0 ? baccarat : tables.Values
            .Select(table => new Dictionary<string, object?>(table, StringComparer.Ordinal))
            .ToArray();
    }

    async Task SendAsync(object packet, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        var page = activeSocketPage;
        if (page is null) throw new InvalidOperationException("MT 官方 WebSocket 尚未準備完成。");
        var sent = await page.EvaluateAsync<bool>("packet => Boolean(window.__collectorMtSend && window.__collectorMtSend(packet))", packet);
        if (!sent) throw new InvalidOperationException("MT 官方 WebSocket 尚未準備完成。");
    }

    static object MemberPacket() => new { method = "POST", action = new { name = "/api/v1/member/me", lang = "zhtw" } };
    static object TablesPacket() => new { method = "GET", action = new { name = TablesAction, data = new { gametype_id = 3, game_id = 1, room_id = 1 } } };
    static object MultipleJoinPacket(string tableIds) => new { method = "GET", action = new { name = "/api/v1/gametype/*/game/*/room/*/mulitple_join", data = new { table_id = tableIds } } };
    static object PingPacket() => new { method = "POST", action = new { name = "/api/v1/ping" } };

    static long? ReadLong(JsonElement value, string name) => value.TryGetProperty(name, out var field) && field.TryGetInt64(out var number) ? number : null;
    static string? Text(IReadOnlyDictionary<string, object?> source, string name) => source.TryGetValue(name, out var value) ? Convert.ToString(value) : null;

    static bool AllowedGameUrl(string raw) => Uri.TryCreate(raw, UriKind.Absolute, out var uri)
        && uri.Scheme == Uri.UriSchemeHttps
        && uri.Query.Contains("token=", StringComparison.OrdinalIgnoreCase)
        && uri.Host.EndsWith(".ofalive99.net", StringComparison.OrdinalIgnoreCase);

    static bool IsMtSocket(Uri uri) => uri.Scheme is "ws" or "wss"
        && uri.Host.EndsWith(".ofalive99.net", StringComparison.OrdinalIgnoreCase)
        && uri.AbsolutePath.Contains("/game/ws", StringComparison.OrdinalIgnoreCase);

    // Installed before the official page's scripts.  It records the native
    // browser-owned WebSocket without changing its network behavior, allowing
    // C# to send the exact same protocol commands as ?collector=1.
    const string MtSocketCaptureScript = """
        (() => {
          const NativeWebSocket = window.WebSocket;
          const sockets = [];
          const matches = (value) => {
            try {
              const url = new URL(value, window.location.href);
              return url.hostname.endsWith('.ofalive99.net') && url.pathname.includes('/game/ws');
            } catch { return false; }
          };
          const remember = (socket) => {
            if (matches(socket.url) && !sockets.includes(socket)) sockets.push(socket);
            return socket;
          };
          function CollectorWebSocket(...args) {
            return remember(new NativeWebSocket(...args));
          }
          CollectorWebSocket.prototype = NativeWebSocket.prototype;
          Object.setPrototypeOf(CollectorWebSocket, NativeWebSocket);
          window.WebSocket = CollectorWebSocket;
          window.__collectorMtSend = (packet) => {
            const socket = sockets.find(candidate => candidate.readyState === NativeWebSocket.OPEN);
            if (!socket) return false;
            socket.send(JSON.stringify(packet));
            return true;
          };
        })();
        """;
}
