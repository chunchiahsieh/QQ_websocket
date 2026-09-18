using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Playwright;

static class AbBrowserRelay
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
            (publish, ct) => Capture(app.Configuration, publish, ct), "歐博");
        app.MapPost("/api/ab/start", async (HttpContext http) =>
        {
            if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(http.Request.Headers["X-Relay-Key"].ToString()), Encoding.UTF8.GetBytes(key)))
                return Results.Json(new { message = "內部驗證失敗。" }, statusCode: 401);
            if (http.Request.ContentLength is null or > 8192) return Results.StatusCode(413);
            LaunchRequest? input;
            try { input = await http.Request.ReadFromJsonAsync<LaunchRequest>(); }
            catch (JsonException) { return Results.BadRequest(); }
            if (input?.DirectLogin != true) return Results.BadRequest();
            if (string.IsNullOrWhiteSpace(app.Configuration["DG_BACKEND_USERNAME"]) || string.IsNullOrWhiteSpace(app.Configuration["DG_BACKEND_PASSWORD"]))
                return Results.Json(new { message = "歐博後台專用帳密尚未設定。" }, statusCode: 503);
            foreach (var entry in Tickets.Where(e => e.Value.Expires < DateTimeOffset.UtcNow)) Tickets.TryRemove(entry.Key, out _);
            if (Tickets.Count >= 32) return Results.StatusCode(429);
            var ticket = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            Tickets[ticket] = new(DateTimeOffset.UtcNow.AddMinutes(1));
            http.Response.Headers.CacheControl = "no-store";
            return Results.Json(new { ticket });
        });
        app.Map("/ws/ab", async (HttpContext http) =>
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
        var packets = Channel.CreateBounded<byte[]>(512);
        Interlocked.Increment(ref active);
        var budgetAcquired = false;
        try
        {
            await BrowserSessionBudget.Gate.WaitAsync(ct);
            budgetAcquired = true;
            var media = new AbMediaCatalog();
            try { media = await AbMediaCatalog.Load(ct); }
            catch (Exception ex) when (ex is HttpRequestException or TaskCanceledException or JsonException or CryptographicException or FormatException or ArgumentException) {
                if (ct.IsCancellationRequested) throw;
                // A media configuration outage must not stop the table feed.
                Console.WriteLine("AB media configuration unavailable; table feed continues.");
            }
            using var playwright = await Playwright.CreateAsync();
            await using var browser = await playwright.Chromium.LaunchAsync(new() {
                Headless = true,
                Channel = configuration["DG_BROWSER_CHANNEL"] ?? "msedge",
                Timeout = 30000,
                // The AB browser is a long-lived relay worker on the small
                // Render instance. Disable background Edge services so they
                // cannot compete with the page that supplies the table feed.
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
            await using var context = await browser.NewContextAsync(new() { AcceptDownloads = false });
            using var cancellation = ct.Register(() => { _ = browser.CloseAsync(); });
            var page = await context.NewPageAsync();
            page.PageError += (_, error) => Console.Error.WriteLine($"[歐博] page error: {error}");
            page.Console += (_, message) =>
            {
                if (message.Type is "error" or "warning")
                    Console.Error.WriteLine($"[歐博] browser console {message.Type}");
            };
            page.RequestFailed += (_, request) =>
            {
                if (Uri.TryCreate(request.Url, UriKind.Absolute, out var failed))
                    Console.Error.WriteLine($"[歐博] request failed: {failed.Host}{failed.AbsolutePath}");
            };
            Microsoft.Playwright.IWebSocket? liveSocket = null;
            page.WebSocket += (_, ws) => {
                if (!Uri.TryCreate(ws.Url,UriKind.Absolute,out var uri) || uri.Scheme != "wss"
                    || !(uri.Host.EndsWith(".maofeiyan.com") || uri.Host.EndsWith(".51shengce.com"))) return;
                liveSocket = ws; feed!.Connection(true);
                ws.Close += (_, _) => { if (ReferenceEquals(liveSocket,ws)) feed.Connection(false); };
                ws.FrameReceived += (_, frame) => {
                    if (!ReferenceEquals(liveSocket,ws)) return;
                    var bytes = frame.Text is {} text ? Encoding.UTF8.GetBytes(text) : frame.Binary;
                    if (bytes is null || bytes.Length > 2 * 1024 * 1024) return;
                    if (!packets.Writer.TryWrite(bytes)) packets.Writer.TryComplete(new InvalidDataException());
                };
            };
            await page.GotoAsync("https://www.cali7777.net/#/",new() { WaitUntil=WaitUntilState.DOMContentLoaded, Timeout=60000 });
            // Render can occasionally finish DOMContentLoaded before the AB
            // SPA has mounted its login form. Log only non-sensitive page
            // metadata so cloud diagnostics can distinguish a slow app from
            // an upstream challenge or blocked resource.
            var pageUri = Uri.TryCreate(page.Url, UriKind.Absolute, out var loadedUri)
                ? $"{loadedUri.Host}{loadedUri.AbsolutePath}" : "invalid-url";
            var pageTitle = await page.TitleAsync();
            var inputCount = await page.Locator("input").CountAsync();
            Console.WriteLine($"[歐博] login page loaded: {pageUri}; title={pageTitle}; inputs={inputCount}");
            // A delayed announcement layer can cover the login form.
            var notice = page.GetByText("確定", new() { Exact = true }).First;
            try
            {
                await notice.WaitForAsync(new() { State = WaitForSelectorState.Visible, Timeout = 5000 });
                await notice.ClickAsync(new() { Force = true, Timeout = 3000 });
            }
            catch (System.TimeoutException) { }
            // The login page no longer exposes the old #usernameInput and
            // #passwordInput IDs. It has exactly two text inputs in order.
            var usernameInput = page.Locator("input").Nth(0);
            var passwordInput = page.Locator("input").Nth(1);
            await usernameInput.WaitForAsync(new() { State = WaitForSelectorState.Visible, Timeout = 90000 });
            await usernameInput.FillAsync(configuration["DG_BACKEND_USERNAME"]!);
            await passwordInput.FillAsync(configuration["DG_BACKEND_PASSWORD"]!);
            var loginButton = page.GetByText("登入", new() { Exact = true }).First;
            await loginButton.WaitForAsync(new() { State = WaitForSelectorState.Visible, Timeout = 30000 });
            await loginButton.ClickAsync(new() { Force = true });
            try { await page.WaitForURLAsync(url => url.Contains("sessionId=", StringComparison.OrdinalIgnoreCase), new() { Timeout = 25000 }); }
            catch (System.TimeoutException)
            {
                if (!page.Url.Contains("sessionId=", StringComparison.OrdinalIgnoreCase))
                    throw new DgLoginRequiredException();
            }
            var decoder = new AbTableDecoder(media);
            var lastPacket = DateTimeOffset.UtcNow;
            var lastTables = lastPacket;
            var reloaded = false;
            while (!ct.IsCancellationRequested)
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(10));
                byte[] bytes;
                try { bytes = await packets.Reader.ReadAsync(timeout.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    if (DateTimeOffset.UtcNow-lastPacket > TimeSpan.FromSeconds(60) || DateTimeOffset.UtcNow-lastTables > TimeSpan.FromMinutes(3) || !browser.IsConnected || page.IsClosed)
                    {
                        feed!.Invalidate();
                        if (!reloaded && browser.IsConnected && !page.IsClosed)
                        {
                            reloaded = true; liveSocket = null; decoder = new AbTableDecoder(media);
                            while(packets.Reader.TryRead(out _)) { }
                            await page.ReloadAsync(new() { WaitUntil=WaitUntilState.DOMContentLoaded, Timeout=30000 });
                            lastPacket = lastTables = DateTimeOffset.UtcNow; continue;
                        }
                        return;
                    }
                    await publish(new { type="heartbeat" },ct); continue;
                }
                var tables = decoder.Accept(bytes);
                lastPacket = DateTimeOffset.UtcNow; feed!.Packet();
                if(tables.Count > 0) { lastTables = DateTimeOffset.UtcNow; await publish(new { type="tables",tables },ct); }
                else if(DateTimeOffset.UtcNow-lastTables > TimeSpan.FromMinutes(3)) return;
            }
        }
        finally { if (budgetAcquired) BrowserSessionBudget.Gate.Release(); feed!.Connection(false); Interlocked.Decrement(ref active); }
    }
}
