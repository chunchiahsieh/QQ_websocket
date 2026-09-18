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
        var packets = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(256) { SingleReader = true, FullMode = BoundedChannelFullMode.Wait });
        Interlocked.Increment(ref active);
        var budgetAcquired = false;
        try
        {
            await BrowserSessionBudget.Gate.WaitAsync(ct);
            budgetAcquired = true;
            await publish( new { type = "status", message = "正在啟動獨立 DG 瀏覽器…" }, ct);
            using var playwright = await Playwright.CreateAsync();
            await using var browser = await playwright.Chromium.LaunchAsync(new() {
                Headless = true, Channel = configuration["DG_BROWSER_CHANNEL"] ?? "msedge", Timeout = 30000,
            });
            await using var context = await browser.NewContextAsync(new() { AcceptDownloads = false });
            using var cancellation = ct.Register(() => { _ = browser.CloseAsync(); });
            IPage? gamePage = null;
            // DG opens a primary socket plus one or more fail-over sockets.
            // Keep all official sockets active: the last socket opened is not
            // guaranteed to be the one carrying baccarat table packets.
            var liveSockets = new HashSet<Microsoft.Playwright.IWebSocket>();
            void AttachPage(IPage observedPage) => observedPage.WebSocket += (_, ws) =>
            {
                if (!Uri.TryCreate(ws.Url, UriKind.Absolute, out var upstream) || upstream.Scheme != "wss"
                    || !(upstream.Host.EndsWith(".taxyss.com") || upstream.Host.EndsWith(".kindlestone.com") || upstream.Host.EndsWith(".ywjxi.com"))) return;
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
                    if (bytes is null || bytes.Length > 1024 * 1024) return;
                    if (!packets.Writer.TryWrite(bytes)) packets.Writer.TryComplete(new InvalidDataException("Packet queue exceeded"));
                };
            };
            context.Page += (_, openedPage) => AttachPage(openedPage);
            var page = await context.NewPageAsync();
            // Keep this explicit as well as subscribing to context.Page. This
            // avoids missing the initial page on Playwright/Edge combinations
            // that deliver the Page event before the handler is observed.
            AttachPage(page);
            await page.GotoAsync("https://dg18.cc/", new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 30000 });
            // DG currently renders icon-only inputs without stable placeholder
            // attributes. The login form contains exactly two text inputs:
            // account first, password second.
            var usernameInput = page.Locator("input").Nth(0);
            var passwordInput = page.Locator("input").Nth(1);
            await usernameInput.WaitForAsync(new() { State = WaitForSelectorState.Visible, Timeout = 15000 });
            await usernameInput.FillAsync(configuration["DG_BACKEND_USERNAME"]!);
            await passwordInput.FillAsync(configuration["DG_BACKEND_PASSWORD"]!);
            await page.Locator("#remember_input").UncheckAsync();
            // The official page fills the button label asynchronously and may
            // switch between simplified/traditional Chinese. Its class is
            // stable, so don't wait on the translated text.
            var loginButton = page.Locator("a.login-button:not(.free-button)");
            await loginButton.WaitForAsync(new() { State = WaitForSelectorState.Visible, Timeout = 15000 });
            await loginButton.ClickAsync(new() { Force = true });
            // The official site may render the post-login action in either
            // simplified or traditional Chinese, and it is not always a
            // semantic button (some versions use an anchor).  Login can also
            // open the account page in a second tab, so scan every page in
            // the context instead of assuming the original page is reused.
            IPage? entryPage = null;
            ILocator? enter = null;
            var entryDeadline = DateTimeOffset.UtcNow.AddSeconds(30);
            while (!ct.IsCancellationRequested && DateTimeOffset.UtcNow < entryDeadline && entryPage is null)
            {
                foreach (var candidate in context.Pages.Where(p => !p.IsClosed))
                {
                    var joinGame = candidate.Locator("[data-tag='joinGame']").First;
                    try
                    {
                        if (await joinGame.IsVisibleAsync())
                        {
                            entryPage = candidate;
                            enter = joinGame;
                            break;
                        }
                    }
                    catch (PlaywrightException) { }
                    foreach (var label in new[] { "進入遊戲", "进入游戏" })
                    {
                        var candidateEnter = candidate.GetByText(label, new() { Exact = true }).First;
                        try
                        {
                            if (await candidateEnter.IsVisibleAsync())
                            {
                                entryPage = candidate;
                                enter = candidateEnter;
                                break;
                            }
                        }
                        catch (PlaywrightException) { }
                    }
                    if (entryPage is not null) break;
                }
                if (entryPage is null) await Task.Delay(500, ct);
            }
            if (entryPage is null || enter is null)
            {
                await publish( new { type = "error", message = "dg18.cc 登入未完成，請確認專用帳密或是否需要人工驗證。" }, ct);
                throw new DgLoginRequiredException();
            }
            gamePage = entryPage;
            await enter.ClickAsync(new() { Force = true });
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
                    continue;
                }
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
        finally { if (budgetAcquired) BrowserSessionBudget.Gate.Release(); feed!.Connection(false); Interlocked.Decrement(ref active); }
    }
}
