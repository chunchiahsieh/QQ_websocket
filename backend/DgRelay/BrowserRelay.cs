using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Playwright;

static class BrowserRelay
{
    record LaunchRequest(bool DirectLogin);
    record Ticket(DateTimeOffset Expires);
    static readonly ConcurrentDictionary<string, Ticket> Tickets = new();
    static SharedDgFeed? feed;
    public static object? Health => feed?.Health;
    static int active;
    public static int Active => Volatile.Read(ref active);

    public static void Map(WebApplication app, string key)
    {
        feed = new SharedDgFeed(app.Lifetime.ApplicationStopping,
            (publish, ct) => Capture(app.Configuration, publish, ct));
        app.MapPost("/api/dg/start", async (HttpContext http) =>
        {
            if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(http.Request.Headers["X-Relay-Key"].ToString()), Encoding.UTF8.GetBytes(key)))
                return Results.Json(new { message = "內部驗證失敗。" }, statusCode: 401);
            if (http.Request.ContentLength is null or > 8192) return Results.StatusCode(413);
            LaunchRequest? input;
            try { input = await http.Request.ReadFromJsonAsync<LaunchRequest>(); }
            catch (JsonException) { return Results.BadRequest(); }
            if (input?.DirectLogin != true) return Results.BadRequest();
            if (string.IsNullOrWhiteSpace(app.Configuration["DG_BACKEND_USERNAME"]) || string.IsNullOrWhiteSpace(app.Configuration["DG_BACKEND_PASSWORD"]))
                return Results.Json(new { message = "DG 後台專用帳密尚未設定。" }, statusCode: 503);
            foreach (var entry in Tickets.Where(e => e.Value.Expires < DateTimeOffset.UtcNow)) Tickets.TryRemove(entry.Key, out _);
            if (Tickets.Count >= 32) return Results.StatusCode(429);
            var ticket = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            Tickets[ticket] = new(DateTimeOffset.UtcNow.AddMinutes(1));
            http.Response.Headers.CacheControl = "no-store";
            return Results.Json(new { ticket });
        });
        app.Map("/ws/dg", async (HttpContext http) =>
        {
            var allowed = app.Configuration["DG_FRONTEND_ORIGIN"] ?? "http://localhost:3000";
            if (http.Request.Headers.Origin != allowed || !http.WebSockets.IsWebSocketRequest) { http.Response.StatusCode = 403; return; }
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
                var subscription = feed.Subscribe();
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

    static async Task Capture(IConfiguration configuration, Func<object, CancellationToken, Task> publish, CancellationToken ct)
    {
        var packets = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(256) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
        Interlocked.Increment(ref active);
        try
        {
            await publish( new { type = "status", message = "C# 正在啟動獨立 DG 瀏覽器…" }, ct);
            using var playwright = await Playwright.CreateAsync();
            await using var browser = await playwright.Chromium.LaunchAsync(new() {
                Headless = true, Channel = configuration["DG_BROWSER_CHANNEL"] ?? "msedge", Timeout = 30000,
            });
            await using var context = await browser.NewContextAsync(new() { AcceptDownloads = false });
            using var cancellation = ct.Register(() => { _ = browser.CloseAsync(); });
            IPage? gamePage = null;
            Microsoft.Playwright.IWebSocket? liveSocket = null;
            void AttachPage(IPage observedPage) => observedPage.WebSocket += (_, ws) =>
            {
                if (!Uri.TryCreate(ws.Url, UriKind.Absolute, out var upstream) || upstream.Scheme != "wss"
                    || !(upstream.Host.EndsWith(".taxyss.com") || upstream.Host.EndsWith(".kindlestone.com") || upstream.Host.EndsWith(".ywjxi.com"))) return;
                gamePage = observedPage;
                liveSocket = ws;
                feed!.Connection(true);
                ws.Close += (_, _) => { if (ReferenceEquals(liveSocket, ws)) feed.Connection(false); };
                ws.FrameReceived += (_, frame) =>
                {
                    var bytes = frame.Binary;
                    if (!ReferenceEquals(liveSocket, ws)) return;
                    if (bytes is null || bytes.Length > 1024 * 1024) return;
                    if (!packets.Writer.TryWrite(bytes)) packets.Writer.TryComplete(new InvalidDataException("Packet queue exceeded"));
                };
            };
            context.Page += (_, openedPage) => AttachPage(openedPage);
            var page = await context.NewPageAsync();
            await page.GotoAsync("https://dg18.cc/", new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 30000 });
            await page.GetByPlaceholder("账号", new() { Exact = true }).FillAsync(configuration["DG_BACKEND_USERNAME"]!);
            await page.GetByPlaceholder("登入密码", new() { Exact = true }).FillAsync(configuration["DG_BACKEND_PASSWORD"]!);
            await page.Locator("#remember_input").UncheckAsync();
            await page.GetByRole(AriaRole.Button, new() { Name = "登录", Exact = true }).ClickAsync();
            var enter = page.GetByRole(AriaRole.Button, new() { Name = "进入游戏", Exact = true });
            try { await enter.WaitForAsync(new() { Timeout = 20000 }); }
            catch (System.TimeoutException)
            {
                await publish( new { type = "error", message = "dg18.cc 登入未完成，請確認專用帳密或是否需要人工驗證。" }, ct);
                throw new DgLoginRequiredException();
            }
            await enter.ClickAsync();
            await publish( new { type = "status", message = "官方 DG 頁面已開啟，等待百家樂桌況…" }, ct);
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
                            liveSocket = null;
                            while (packets.Reader.TryRead(out _)) { }
                            await gamePage.ReloadAsync(new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 30000 });
                            lastPacket = lastTables = DateTimeOffset.UtcNow;
                            continue;
                        }
                        return;
                    }
                    await publish( new { type = "heartbeat" }, ct); continue;
                }
                var tables = decoder.Accept(bytes);
                lastPacket = DateTimeOffset.UtcNow;
                feed!.Packet();
                if (tables.Count > 0)
                {
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
        finally { feed!.Connection(false); Interlocked.Decrement(ref active); }
    }
}
