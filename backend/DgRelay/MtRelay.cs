using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.Playwright;

static class MtRelay
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
            (publish, ct) => Capture(app.Configuration, publish, ct), "MT");
        app.MapPost("/api/mt/start", async (HttpContext http) =>
        {
            if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(http.Request.Headers["X-Relay-Key"].ToString()), Encoding.UTF8.GetBytes(key)))
                return Results.Json(new { message = "內部驗證失敗。" }, statusCode: 401);
            if (http.Request.ContentLength is null or > 8192) return Results.StatusCode(413);
            LaunchRequest? input;
            try { input = await http.Request.ReadFromJsonAsync<LaunchRequest>(); }
            catch (JsonException) { return Results.BadRequest(); }
            if (input?.DirectLogin != true) return Results.BadRequest();
            if (string.IsNullOrWhiteSpace(app.Configuration["MT_BACKEND_USERNAME"]) || string.IsNullOrWhiteSpace(app.Configuration["MT_BACKEND_PASSWORD"]))
                return Results.Json(new { message = "MT後台專用帳密尚未設定。" }, statusCode: 503);
            foreach (var entry in Tickets.Where(e => e.Value.Expires < DateTimeOffset.UtcNow)) Tickets.TryRemove(entry.Key, out _);
            if (Tickets.Count >= 32) return Results.StatusCode(429);
            var ticket = Convert.ToHexString(RandomNumberGenerator.GetBytes(32));
            Tickets[ticket] = new(DateTimeOffset.UtcNow.AddMinutes(1));
            http.Response.Headers.CacheControl = "no-store";
            return Results.Json(new { ticket });
        });
        app.Map("/ws/mt", async (HttpContext http) =>
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
        Interlocked.Increment(ref active);
        try
        {
            using var playwright = await Playwright.CreateAsync();
            await using var browser = await playwright.Chromium.LaunchAsync(new() {
                // MT rejects headless Chromium. Keep a real browser session for
                // its WebSocket handshake, but move/minimize the window so the
                // frontend receives data without a visible popup.
                Headless = false,
                Channel = configuration["DG_BROWSER_CHANNEL"] ?? "msedge",
                Args = new[] { "--start-minimized", "--window-position=-32000,-32000" },
                Timeout = 30000
            });
            await using var context = await browser.NewContextAsync(new() { AcceptDownloads = false });
            using var cancellation = ct.Register(() => { _ = browser.CloseAsync(); });
            var page = await context.NewPageAsync();
            var packets = Channel.CreateBounded<string>(512);
            Microsoft.Playwright.IWebSocket? liveSocket = null;
            void Attach(IPage target) { target.WebSocket += (_, ws) => {
                if (!Uri.TryCreate(ws.Url, UriKind.Absolute, out var uri) || uri.Scheme != "wss"
                    || !uri.Host.EndsWith(".ofalive99.net", StringComparison.OrdinalIgnoreCase)) return;
                liveSocket = ws; feed!.Connection(true);
                // Keep the logged-in browser alive. A transient upstream close
                // should trigger page recovery instead of a full relogin.
                ws.Close += (_, _) => { if (ReferenceEquals(liveSocket, ws)) { liveSocket = null; feed!.Connection(false); } };
                ws.FrameReceived += (_, frame) => {
                    if (!ReferenceEquals(liveSocket, ws) || frame.Text is not {} text) return;
                    if (text.Length > 2 * 1024 * 1024 || !packets.Writer.TryWrite(text))
                        packets.Writer.TryComplete(new InvalidDataException());
                };
            };
            };
            Attach(page);
            context.Page += (_, opened) => Attach(opened);
            var navigation = await page.GotoAsync("https://jrk.tz6868.com/", new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 30000 });
            if (navigation?.Status == 403) throw new UpstreamAccessDeniedException();
            var notice = page.GetByText("確定", new() { Exact = true }).First;
            try
            {
                await notice.WaitForAsync(new() { State = WaitForSelectorState.Visible, Timeout = 5000 });
                await notice.ClickAsync(new() { Force = true, Timeout = 3000 });
            }
            catch (System.TimeoutException) { }
            await page.GetByPlaceholder("帳號", new() { Exact = true }).FillAsync(configuration["MT_BACKEND_USERNAME"]!);
            await page.GetByPlaceholder("密碼", new() { Exact = true }).FillAsync(configuration["MT_BACKEND_PASSWORD"]!);
            await page.GetByText("登入", new() { Exact = true }).First.ClickAsync(new() { Force = true });
            var loginReady = false;
            try { await page.GetByText("登出", new() { Exact = true }).WaitForAsync(new() { Timeout = 20000 }); loginReady = true; }
            catch (System.TimeoutException) { }
            if (!loginReady)
            {
                // Some official builds do not render a literal "登出" label
                // after login, but expose the 真人 entry immediately.
                try { await page.GetByText("真人", new() { Exact = true }).First.WaitForAsync(new() { Timeout = 3000 }); loginReady = true; }
                catch (System.TimeoutException) { }
            }
            if (!loginReady)
            {
                // Surface the official, non-sensitive reason when the site
                // rejects the credentials; do not mistake it for a socket
                // handshake failure.
                var body = await page.Locator("body").InnerTextAsync();
                if (body.Contains("密碼錯誤", StringComparison.Ordinal))
                    throw new DgLoginRequiredException("官方登入頁回報會員密碼錯誤（4401）。");
                throw new DgLoginRequiredException();
            }
            await page.GetByText("真人", new() { Exact = true }).First.ClickAsync(new() { Force = true });
            await Task.Delay(500);
            IPage platformPage;
            try
            {
                platformPage = await context.RunAndWaitForPageAsync(async () => {
                    await page.GetByText("MT真人", new() { Exact = true }).First.ClickAsync(new() { Force = true });
                }, new() { Timeout = 30000 });
            }
            catch (System.TimeoutException)
            {
                // MT真人 can reuse the current tab in some official builds.
                platformPage = context.Pages.LastOrDefault() ?? page;
            }
            // The popup is initially about:blank and navigates a moment later.
            // Waiting only for DOMContentLoaded would return too early and
            // leave the capture loop attached to an empty page.
            var platformReady = false;
            for (var wait = 0; wait < 15 && !ct.IsCancellationRequested; wait++)
            {
                if (platformPage.Url.Contains(".ofalive99.net/", StringComparison.OrdinalIgnoreCase)) { platformReady = true; break; }
                await Task.Delay(1000, ct);
            }
            if (!platformReady)
            {
                try { await platformPage.CloseAsync(); } catch (PlaywrightException) { }
                throw new InvalidOperationException("MT 遊戲頁未完成跳轉。");
            }
            try { await platformPage.WaitForLoadStateAsync(LoadState.DOMContentLoaded, new() { Timeout = 15000 }); }
            catch (System.TimeoutException) { }
            var platformText = await platformPage.Locator("body").InnerTextAsync();
            if (platformText.Contains("ACCESS RESTRICTED", StringComparison.OrdinalIgnoreCase)
                || platformText.Contains("訪問受限制", StringComparison.Ordinal))
                throw new UpstreamAccessDeniedException();
            var tables = new Dictionary<string, System.Text.Json.Nodes.JsonObject>();
            var recoveries = 0;
            while (!ct.IsCancellationRequested)
            {
                using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
                timeout.CancelAfter(TimeSpan.FromSeconds(45));
                string text;
                try { text = await packets.Reader.ReadAsync(timeout.Token); recoveries = 0; }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                {
                    if (++recoveries >= 3) throw;
                    try { await platformPage.ReloadAsync(new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 20000 }); }
                    catch (PlaywrightException) { }
                    continue;
                }
                System.Text.Json.Nodes.JsonNode? packet;
                try { packet = System.Text.Json.Nodes.JsonNode.Parse(text); } catch (JsonException) { continue; }
                feed!.Packet();
                var action = packet?["action"] is System.Text.Json.Nodes.JsonValue ? (string?)packet["action"] : null;
                var name = (string?)packet?["name"] ?? action ?? "";
                if (action == "/api/v1/authenticate" && (int?)packet?["err"] != 0)
                    throw new DgLoginRequiredException("官方 MT 工作階段驗證失敗。", permanent: false);
                if (name == "/api/v1/member/logout")
                    throw new DgLoginRequiredException("官方 MT 工作階段已登出。", permanent: false);
                var changed = new List<object>();
                void Visit(System.Text.Json.Nodes.JsonNode? node, int depth = 0)
                {
                    if (depth > 6 || node is null) return;
                    if (node is System.Text.Json.Nodes.JsonArray array) { foreach (var child in array) Visit(child, depth + 1); return; }
                    if (node is not System.Text.Json.Nodes.JsonObject row) return;
                    if (row["table_id"] is {} idNode)
                    {
                        var id = idNode.ToString();
                        if (!tables.TryGetValue(id, out var table)) table = new();
                        foreach (var pair in row)
                        {
                            if (pair.Key == "trend" && pair.Value is System.Text.Json.Nodes.JsonObject trend && table["trend"] is System.Text.Json.Nodes.JsonObject oldTrend)
                                foreach (var field in trend) oldTrend[field.Key] = field.Value?.DeepClone();
                            else table[pair.Key] = pair.Value?.DeepClone();
                        }
                        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        if (name.EndsWith("/wait") && int.TryParse(row["count"]?.ToString(), out var seconds))
                            table["countdownDeadline"] = timestamp + Math.Max(0, seconds) * 1000L;
                        if (new[] { "/show_poker", "/summary", "/result", "/end" }.Any(name.EndsWith))
                            table["countdownDeadline"] = timestamp;
                        tables[id] = table;
                        if (table["table_type"]?.ToString() is "BAC" or "BAS")
                            changed.Add(new { tableId = id, payload = table });
                    }
                    foreach (var child in row) Visit(child.Value, depth + 1);
                }
                Visit(packet);
                if (changed.Count > 0)
                {
                    await publish(new { type = "tables", tables = changed }, ct);
                }
            }
        }
        catch (Exception) { throw; }
        finally { Interlocked.Decrement(ref active); feed!.Connection(false); }
    }
}
