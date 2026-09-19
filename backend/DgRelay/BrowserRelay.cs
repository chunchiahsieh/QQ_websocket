using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Playwright;

static class BrowserRelay
{
    record LaunchRequest(bool DirectLogin, string? GameUrl, bool Collector);
    record Ticket(DateTimeOffset Expires, string? GameUrl, bool Collector);
    static readonly ConcurrentDictionary<string, Ticket> Tickets = new();
    static SharedDgFeed? feed;
    static string? requestedGameUrl;
    public static object? Health => feed?.Health;
    static int active;
    public static int Active => Volatile.Read(ref active);

    public static void Map(WebApplication app, string key)
    {
        feed = new SharedDgFeed(app.Lifetime.ApplicationStopping,
            (publish, ct) => Capture(app.Configuration, publish, ct),
            "DG", TimeSpan.FromMinutes(15));
        app.MapPost("/api/dg/start", async (HttpContext http) =>
        {
            if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(http.Request.Headers["X-Relay-Key"].ToString()), Encoding.UTF8.GetBytes(key)))
                return Results.Json(new { message = "內部驗證失敗。" }, statusCode: 401);
            if (http.Request.ContentLength is null or > 8192) return Results.StatusCode(413);
            LaunchRequest? input;
            try { input = await http.Request.ReadFromJsonAsync<LaunchRequest>(); }
            catch (JsonException) { return Results.BadRequest(); }
            if (input?.DirectLogin != true) return Results.BadRequest();
            string? gameUrl = null;
            if (!string.IsNullOrWhiteSpace(input.GameUrl))
            {
                if (!TryValidateGameUrl(input.GameUrl, out gameUrl))
                    return Results.Json(new { message = "DG 遊戲授權網址不受支援。" }, statusCode: 400);
                // The DGLI URL is short-lived and is used only by the relay
                // browser. Never return it to viewers or write it to logs.
                requestedGameUrl = gameUrl;
            }
            if (gameUrl is null && requestedGameUrl is null)
                return Results.Json(new { message = "DG 授權網址尚未由採集端提供。" }, statusCode: 503);
            foreach (var entry in Tickets.Where(e => e.Value.Expires < DateTimeOffset.UtcNow)) Tickets.TryRemove(entry.Key, out _);
            if (Tickets.Count >= 32) return Results.StatusCode(429);
            var ticket = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            Tickets[ticket] = new(DateTimeOffset.UtcNow.AddMinutes(1), gameUrl, input.Collector);
            http.Response.Headers.CacheControl = "no-store";
            return Results.Json(new { ticket });
        });
        app.Map("/ws/dg", async (HttpContext http) =>
        {
            if (!OriginPolicy.IsAllowed(app.Configuration, http.Request.Headers.Origin) || !http.WebSockets.IsWebSocketRequest) { http.Response.StatusCode = 403; return; }
            using var socket = await http.WebSockets.AcceptWebSocketAsync();
            using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(http.RequestAborted);
            lifetime.CancelAfter(TimeSpan.FromHours(1));
            var buffer = new byte[1024];
            try
            {
                using var authTimeout = CancellationTokenSource.CreateLinkedTokenSource(lifetime.Token);
                authTimeout.CancelAfter(TimeSpan.FromSeconds(5));
                var auth = await socket.ReceiveAsync(buffer.AsMemory(), authTimeout.Token);
                if (!auth.EndOfMessage || auth.MessageType != WebSocketMessageType.Text) return;
                using var json = JsonDocument.Parse(buffer.AsMemory(0, auth.Count));
                if (!json.RootElement.TryGetProperty("ticket", out var field) || field.ValueKind != JsonValueKind.String) return;
                if (!Tickets.TryRemove(field.GetString()!, out var ticket) || ticket.Expires < DateTimeOffset.UtcNow) return;
                if (ticket.GameUrl is not null) requestedGameUrl = ticket.GameUrl;
                var subscription = ticket.Collector ? feed.SubscribeCollector() : feed.Subscribe();
                try
                {
                    var receiving = WatchClient(socket, lifetime.Token);
                    var sending = Forward(socket, subscription.Reader, lifetime.Token);
                    await Task.WhenAny(receiving, sending);
                    lifetime.Cancel();
                    try { await Task.WhenAll(receiving, sending); } catch (OperationCanceledException) { }
                }
                finally { feed.Unsubscribe(subscription.Id); }
            }
            catch (Exception ex) when (ex is OperationCanceledException or WebSocketException or JsonException or PlaywrightException) { }
            finally { lifetime.Cancel(); socket.Abort(); }
        });
    }
    static async Task WatchClient(System.Net.WebSockets.WebSocket socket, CancellationToken ct)
    {
        var buffer = new byte[1024];
        while (!ct.IsCancellationRequested)
        {
            var result = await socket.ReceiveAsync(buffer.AsMemory(), ct);
            if (result.MessageType == WebSocketMessageType.Close) return;
            // The client cannot relay arbitrary commands to DG.
            if (result.Count > 0) return;
        }
    }
    static async Task Forward(System.Net.WebSockets.WebSocket socket, ChannelReader<byte[]> reader, CancellationToken ct)
    {
        await foreach (var message in reader.ReadAllAsync(ct))
            await socket.SendAsync(message.AsMemory(), WebSocketMessageType.Text, true, ct);
    }

    static Task Send(System.Net.WebSockets.WebSocket socket, object data, CancellationToken ct) =>
        socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(data).AsMemory(), WebSocketMessageType.Text, true, ct).AsTask();

    static bool TryValidateGameUrl(string raw, out string normalized)
    {
        normalized = "";
        var value = raw.Trim();
        if (!value.Contains("://", StringComparison.Ordinal)) value = "https://" + value;
        if (!Uri.TryCreate(value, UriKind.Absolute, out var uri) || uri.Scheme != Uri.UriSchemeHttps) return false;
        var host = uri.Host.ToLowerInvariant();
        var allowed = host.EndsWith(".ahsy114.com", StringComparison.Ordinal)
            || host.EndsWith(".20299999.com", StringComparison.Ordinal)
            || host.EndsWith(".dggw.vip", StringComparison.Ordinal)
            || host.EndsWith(".ywjxi.com", StringComparison.Ordinal);
        if (!allowed || !uri.Query.Contains("token=", StringComparison.OrdinalIgnoreCase)) return false;
        normalized = uri.ToString();
        return true;
    }

    static async Task Capture(IConfiguration configuration, Func<object, CancellationToken, Task> publish, CancellationToken ct)
    {
        // DG can open several fail-over sockets. Keep the raw frame queue
        // deliberately small so a stalled decoder cannot retain hundreds of
        // megabytes of protobuf/control frames in a Free Render instance.
        var packets = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(64) {
            SingleReader = true, FullMode = BoundedChannelFullMode.DropOldest
        });
        Interlocked.Increment(ref active);
        var budgetAcquired = false;
        try
        {
            Console.Error.WriteLine("[DG] capture starting");
            await BrowserSessionBudget.Gate.WaitAsync(ct);
            budgetAcquired = true;
            Console.Error.WriteLine("[DG] browser budget acquired");
            await publish( new { type = "status", message = "正在啟動獨立 DG 瀏覽器…" }, ct);
            using var playwright = await Playwright.CreateAsync();
            Console.Error.WriteLine("[DG] Playwright initialized");
            await using var browser = await playwright.Chromium.LaunchAsync(new() {
                Headless = true,
                Channel = configuration["DG_BROWSER_CHANNEL"] ?? "msedge",
                Timeout = 30000,
                // DG only needs the official page and its WebSocket feed. Keep
                // Edge's background services from consuming the small Render
                // instance while preserving the real browser protocol.
                Args = new[] {
                    "--disable-gpu",
                    "--disable-extensions",
                    "--disable-background-networking",
                    "--disable-component-update",
                    "--disable-default-apps",
                    "--disable-sync",
                    "--no-first-run",
                    "--no-default-browser-check",
                    "--disable-dev-shm-usage"
                }
            });
            Console.Error.WriteLine("[DG] Edge launched");
            await using var context = await browser.NewContextAsync(new() { AcceptDownloads = false });
            // The official game does not need local media to produce its
            // WebSocket table feed. Avoid retaining large dealer images/fonts
            // in the relay browser's renderer process.
            await context.RouteAsync("**/*", async route =>
            {
                var resourceType = route.Request.ResourceType;
                // The DG bundle waits for its TTF load callback before it
                // initializes the protobuf/WebSocket feed. Keep fonts
                // available; only large visual resources are optional here.
                if (resourceType is "image" or "media")
                {
                    await route.AbortAsync();
                    return;
                }
                await route.ContinueAsync();
            });
            using var cancellation = ct.Register(() => { _ = browser.CloseAsync(); });
            IPage? gamePage = null;
            // DG opens a primary socket plus one or more fail-over sockets.
            // Keep all official sockets active: the last socket opened is not
            // guaranteed to be the one carrying baccarat table packets.
            var liveSockets = new HashSet<Microsoft.Playwright.IWebSocket>();
            var rawFrames = 0;
            var decodeFailures = 0;
            void AttachPage(IPage observedPage) => observedPage.WebSocket += (_, ws) =>
            {
                if (!Uri.TryCreate(ws.Url, UriKind.Absolute, out var upstream)
                    || !(upstream.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase)
                        || upstream.Scheme.Equals("ws", StringComparison.OrdinalIgnoreCase))) return;
                // Keep diagnostics useful without ever writing query strings
                // (the official page can put a session token in the URL).
                Console.WriteLine($"[DG] websocket observed: {upstream.Host}{upstream.AbsolutePath}");
                if (!(upstream.Host.EndsWith(".taxyss.com") || upstream.Host.EndsWith(".kindlestone.com") || upstream.Host.EndsWith(".ywjxi.com"))) return;
                gamePage = observedPage;
                lock (liveSockets) liveSockets.Add(ws);
                feed!.Connection(true);
                Console.WriteLine($"[DG] official socket connected: {upstream.Host}");
                ws.Close += (_, _) =>
                {
                    lock (liveSockets) liveSockets.Remove(ws);
                    lock (liveSockets)
                    {
                        if (liveSockets.Count == 0) feed.Connection(false);
                    }
                };
                ws.FrameReceived += (_, frame) =>
                {
                    var bytes = frame.Binary;
                    if (bytes is null || bytes.Length > 256 * 1024) return;
                    var frameNumber = Interlocked.Increment(ref rawFrames);
                    if (frameNumber <= 5)
                        Console.WriteLine($"[DG] binary frame received: {bytes.Length} bytes");
                    packets.Writer.TryWrite(bytes);
                };
            };
            context.Page += (_, openedPage) => AttachPage(openedPage);
            var page = await context.NewPageAsync();
            // Keep this explicit as well as subscribing to context.Page. This
            // avoids missing the initial page on Playwright/Edge combinations
            // that deliver the Page event before the handler is observed.
            AttachPage(page);
            page.PageError += (_, error) => Console.Error.WriteLine($"[DG] page error: {error}");
            page.Console += (_, message) =>
            {
                // Console output can contain the current URL (and therefore a
                // session token), so keep only the message type here.
                if (message.Type is "error" or "warning")
                    Console.Error.WriteLine($"[DG] browser console {message.Type}");
            };
            page.RequestFailed += (_, request) =>
            {
                if (Uri.TryCreate(request.Url, UriKind.Absolute, out var failed))
                    Console.Error.WriteLine($"[DG] request failed: {failed.Host}{failed.AbsolutePath}");
            };
            var directGameUrl = requestedGameUrl;
            if (directGameUrl is null)
            {
                throw new DgLoginRequiredException("等待前端提供 DGLI 遊戲授權網址。", false);
            }
            await page.GotoAsync(directGameUrl, new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 60000 });
            Console.Error.WriteLine($"[DG] DGLI game page loaded: {new Uri(page.Url).Host}{new Uri(page.Url).AbsolutePath}");
            gamePage = page;
            await publish(new { type = "status", message = "官方 DG 頁面已開啟，等待百家樂桌況…" }, ct);
            var decoder = new DgTableDecoder();
            var lastTables = DateTimeOffset.UtcNow;
            var lastPacket = DateTimeOffset.UtcNow;
            var reloaded = false;
            while (!ct.IsCancellationRequested)
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(10));
                byte[] bytes;
                try { bytes = await packets.Reader.ReadAsync(timeout.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    if (DateTimeOffset.UtcNow - lastPacket > TimeSpan.FromSeconds(60)
                        || DateTimeOffset.UtcNow - lastTables > TimeSpan.FromMinutes(3)
                        || !browser.IsConnected || gamePage?.IsClosed == true)
                    {
                        feed!.Invalidate();
                        if (!reloaded && browser.IsConnected && gamePage is { IsClosed: false })
                        {
                            reloaded = true;
                            decoder = new DgTableDecoder();
                            lock (liveSockets) liveSockets.Clear();
                            while (packets.Reader.TryRead(out _)) { }
                            await gamePage.ReloadAsync(new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 30000 });
                            lastPacket = lastTables = DateTimeOffset.UtcNow;
                            continue;
                        }
                        return;
                    }
                    await publish( new { type = "heartbeat" }, ct); continue;
                }
                List<Dictionary<string, object>> tables;
                try { tables = decoder.Accept(bytes); }
                catch (InvalidDataException)
                {
                    // Control/heartbeat frames can share the same official
                    // sockets. They are not table protobuf messages.
                    var failureNumber = Interlocked.Increment(ref decodeFailures);
                    if (failureNumber <= 5)
                        Console.WriteLine($"[DG] ignored non-table frame ({failureNumber})");
                    continue;
                }
                lastPacket = DateTimeOffset.UtcNow;
                feed!.Packet();
                if (tables.Count > 0)
                {
                    Console.WriteLine($"[DG] decoded tables: {tables.Count}; frames={rawFrames}");
                    foreach (var table in tables)
                    {
                        if (table.TryGetValue("dealer", out var value) && value is Dictionary<string, object> dealer && dealer.TryGetValue("photo", out var photo))
                        {
                            var file = Convert.ToString(photo);
                            if (!string.IsNullOrWhiteSpace(file) && !file.Contains("..") && !file.Contains(':'))
                                table["dealerPhoto"] = new Uri(new Uri((gamePage ?? page).Url).GetLeftPart(UriPartial.Authority) + "/vd/vd/image/Image/dealer/" + file.TrimStart('/')).ToString();
                        }
                    }
                    lastTables = DateTimeOffset.UtcNow; await publish( new { type = "tables", tables }, ct);
                }
                else if (DateTimeOffset.UtcNow - lastTables > TimeSpan.FromMinutes(3))
                { await publish( new { type = "reset", message = "DG 重新連線中…" }, ct); return; }
            }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception ex) when (ex is PlaywrightException or InvalidDataException or ChannelClosedException)
        {
            if (!ct.IsCancellationRequested)
                await publish( new { type = "reset", message = "DG 重新連線中…" }, ct);
        }
        finally { if (budgetAcquired) BrowserSessionBudget.Gate.Release(); feed!.Connection(false); Interlocked.Decrement(ref active); }
    }
}
