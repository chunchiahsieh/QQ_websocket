using System.Collections.Concurrent;
using System.Net.Http.Headers;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
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
        Interlocked.Increment(ref active);
        try
        {
            using var playwright = await Playwright.CreateAsync();
            await using var browser = await playwright.Chromium.LaunchAsync(new() {
                // MT rejects headless Chromium. In diagnostic mode keep the
                // real browser visible so the login/token redirect can be
                // inspected while troubleshooting the upstream flow.
                Headless = false,
                Channel = configuration["DG_BROWSER_CHANNEL"] ?? "msedge",
                Args = new[] { "--start-maximized", "--disable-blink-features=AutomationControlled", "--disable-dev-shm-usage" },
                Timeout = 30000
            });
            await using var context = await browser.NewContextAsync(new() { AcceptDownloads = false });
            await context.AddInitScriptAsync("Object.defineProperty(navigator, 'webdriver', { get: () => undefined });");
            using var cancellation = ct.Register(() => { _ = browser.CloseAsync(); });
            var page = await context.NewPageAsync();
            var packets = Channel.CreateBounded<string>(512);
            Microsoft.Playwright.IWebSocket? liveSocket = null;
            void Attach(IPage target) { target.WebSocket += (_, ws) => {
                if (!Uri.TryCreate(ws.Url, UriKind.Absolute, out var uri) || uri.Scheme != "wss") return;
                Console.WriteLine($"[MT] websocket opened: {uri.Host}{uri.AbsolutePath}");
                if (!uri.Host.EndsWith("ofalive99.net", StringComparison.OrdinalIgnoreCase)
                    && !uri.AbsolutePath.Contains("/game/ws", StringComparison.OrdinalIgnoreCase)) return;
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
            // Use the same official API flow as the working MT web client:
            // authenticate at tz6868.cc, obtain the short-lived MTLI game URL,
            // then let Edge observe the official ofalive WebSocket. Opening
            // jrk.tz6868.com first is blocked with HTTP 403 from Render even
            // when the account and source IP are valid.
            var gameUrl = await ResolveMtGameUrl(page, configuration, ct);
            if (gameUrl is not null)
            {
                Console.WriteLine($"[MT] game URL obtained: {new Uri(gameUrl).Host}");
                var platformNavigation = await page.GotoAsync(gameUrl, new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 30000 });
                Console.WriteLine($"[MT] game page opened: {page.Url} status={platformNavigation?.Status}");
                if (platformNavigation?.Status == 403) throw new UpstreamAccessDeniedException();
                if (!page.Url.Contains(".ofalive99.net/", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidOperationException("MT 授權後未取得 ofalive 遊戲頁。");
                try { await page.WaitForLoadStateAsync(LoadState.DOMContentLoaded, new() { Timeout = 15000 }); }
                catch (System.TimeoutException) { }
                var platformText = await page.Locator("body").InnerTextAsync();
                if (platformText.Contains("ACCESS RESTRICTED", StringComparison.OrdinalIgnoreCase)
                    || platformText.Contains("訪問受限制", StringComparison.Ordinal))
                    throw new UpstreamAccessDeniedException();
            }
            else Console.WriteLine("[MT] browser client login submitted; waiting for its official WebSocket");
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
                    try { await page.ReloadAsync(new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 20000 }); }
                    catch (PlaywrightException) { }
                    continue;
                }
                System.Text.Json.Nodes.JsonNode? packet;
                try { packet = System.Text.Json.Nodes.JsonNode.Parse(text); } catch (JsonException) { continue; }
                feed!.Packet();
                var action = packet?["action"] is System.Text.Json.Nodes.JsonValue ? (string?)packet["action"] : null;
                var name = (string?)packet?["name"] ?? (string?)packet?["event"] ?? (string?)packet?["method"] ?? action ?? "";
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
                        var hadPrevious = tables.TryGetValue(id, out var existing);
                        var before = hadPrevious ? existing!.DeepClone().AsObject() : new System.Text.Json.Nodes.JsonObject();
                        var table = hadPrevious ? existing! : new();
                        foreach (var pair in row)
                        {
                            if (pair.Key == "trend" && pair.Value is System.Text.Json.Nodes.JsonObject trend && table["trend"] is System.Text.Json.Nodes.JsonObject oldTrend)
                                foreach (var field in trend) oldTrend[field.Key] = field.Value?.DeepClone();
                            else table[pair.Key] = pair.Value?.DeepClone();
                        }
                        var timestamp = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                        var waitEvent = name.EndsWith("/wait", StringComparison.OrdinalIgnoreCase);
                        var countdownValue = row["countDown"] ?? row["countdown"] ?? row["countdown_seconds"]
                            ?? row["countdownSeconds"] ?? row["remaining_seconds"] ?? row["remainingSeconds"]
                            ?? row["remain"] ?? row["remainSeconds"] ?? row["wait_time"] ?? row["waitTime"]
                            ?? (waitEvent ? row["count"] : null);
                        var hasIncomingCountdown = int.TryParse(countdownValue?.ToString(), out var seconds);
                        var hasPreviousCountdown = int.TryParse(table["countdownValue"]?.ToString(), out var previousSeconds);
                        var acceptsCountdown = !hasPreviousCountdown || !hasIncomingCountdown || seconds <= previousSeconds || waitEvent;
                        if (hasIncomingCountdown
                            && acceptsCountdown && (!hasPreviousCountdown || previousSeconds != seconds))
                        {
                            table["countdownValue"] = Math.Max(0, seconds);
                            table["countdownDeadline"] = timestamp + Math.Max(0, seconds) * 1000L;
                            table["countdownReceivedAt"] = timestamp;
                        }
                        if (new[] { "/show_poker", "/summary", "/result", "/end" }.Any(suffix => name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)))
                        {
                            table["countdownDeadline"] = timestamp;
                            table["countdownReceivedAt"] = timestamp;
                        }
                        tables[id] = table;
                        if (table["table_type"]?.ToString() is "BAC" or "BAS")
                        {
                            var changedFields = table
                                .Where(pair => !before.TryGetPropertyValue(pair.Key, out var oldValue)
                                    || oldValue?.ToJsonString() != pair.Value?.ToJsonString())
                                .Select(pair => pair.Key)
                                .ToArray();
                            // Send only tables whose snapshot really changed. This
                            // prevents every incoming heartbeat from rebuilding all
                            // cards, while countdown changes still pass through as
                            // changed countdownDeadline/countdownReceivedAt fields.
                            if (changedFields.Length > 0)
                                changed.Add(new { tableId = id, payload = table, changedFields, updatedAt = timestamp });
                        }
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

    static async Task<string?> ResolveMtGameUrl(IPage page, IConfiguration configuration, CancellationToken ct)
    {
        var baseUrl = "https://www.tz6868.cc";
        var deviceId = configuration["MT_BACKEND_DEVICE_ID"]
            ?? configuration["DG_BACKEND_DEVICE_ID"]
            ?? Guid.NewGuid().ToString();
        var username = configuration["MT_BACKEND_USERNAME"] ?? "";
        var password = configuration["MT_BACKEND_PASSWORD"] ?? "";
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(20) };
            client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
            client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("text/plain"));
            using var loginResponse = await client.PostAsync(
                $"{baseUrl}/api/v1/login",
                new StringContent(JsonSerializer.Serialize(new { username, password, device_id = deviceId }), Encoding.UTF8, "application/json"), ct);
            var loginText = await loginResponse.Content.ReadAsStringAsync(ct);
            if (loginResponse.StatusCode == System.Net.HttpStatusCode.Forbidden
                && loginText.TrimStart().StartsWith("<", StringComparison.Ordinal))
                throw new InvalidDataException("MT API returned an HTML access challenge.");
            var loginPayload = System.Text.Json.Nodes.JsonNode.Parse(loginText);
            if (loginResponse.StatusCode == System.Net.HttpStatusCode.Forbidden)
                throw new UpstreamAccessDeniedException();
            var memberToken = FirstString(loginPayload,
                "data.token", "token", "data.access_token", "access_token");
            if (!loginResponse.IsSuccessStatusCode || string.IsNullOrWhiteSpace(memberToken))
                throw new DgLoginRequiredException("MT 官方帳號驗證失敗。");

            using var gameRequest = new HttpRequestMessage(HttpMethod.Post, $"{baseUrl}/api/v2/game/MTLI/login");
            gameRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", memberToken);
            gameRequest.Content = new StringContent(JsonSerializer.Serialize(new {
                game_return_url = baseUrl,
                game_kind = "",
                game_type = "",
                game_device = "Desktop",
            }), Encoding.UTF8, "application/json");
            using var gameResponse = await client.SendAsync(gameRequest, ct);
            var gameText = await gameResponse.Content.ReadAsStringAsync(ct);
            if (gameResponse.StatusCode == System.Net.HttpStatusCode.Forbidden
                && gameText.TrimStart().StartsWith("<", StringComparison.Ordinal))
                throw new InvalidDataException("MT game API returned an HTML access challenge.");
            var gamePayload = System.Text.Json.Nodes.JsonNode.Parse(gameText);
            if (gameResponse.StatusCode == System.Net.HttpStatusCode.Forbidden)
                throw new UpstreamAccessDeniedException();
            var gameUrl = FirstString(gamePayload,
                "data.game_url", "data.url", "url", "game_url");
            if (!gameResponse.IsSuccessStatusCode || string.IsNullOrWhiteSpace(gameUrl))
                throw new DgLoginRequiredException("MT 官方未提供遊戲授權網址。");
            return ValidateMtGameUrl(gameUrl);
        }
        catch (InvalidDataException ex)
        {
            Console.WriteLine($"[MT] server-side API challenge; retrying through Edge: {ex.Message}");
        }
        catch (JsonException ex)
        {
            Console.WriteLine($"[MT] server-side API returned non-JSON; retrying through Edge: {ex.Message}");
        }
        catch (HttpRequestException ex)
        {
            Console.WriteLine($"[MT] server-side API unavailable; retrying through Edge: {ex.Message}");
        }

        // Render's server-side HTTP client can receive the official anti-bot
        // HTML challenge even when a real Edge context is allowed. Perform the
        // same two API calls from the browser context, then navigate that page
        // to the returned ofalive URL so the official WebSocket sees a normal
        // browser fingerprint.
        try
        {
            // Use the same public MT Assistant client that is already known to
            // work on Render. Its own login flow performs the browser-side API
            // calls and opens the official WebSocket with the right origin.
            const string browserOrigin = "https://mt-assistant-web-v3.onrender.com/";
            var navigation = await page.GotoAsync(browserOrigin, new() { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 30000 });
            Console.WriteLine($"[MT] API browser context opened: {page.Url} status={navigation?.Status}");
            // The public MT Assistant page does not expose stable placeholder
            // attributes (the visible labels are rendered separately).  Use
            // the two login inputs in DOM order so this keeps working across
            // the page's localized/React markup.
            var loginInputs = page.Locator("input");
            if (await loginInputs.CountAsync() < 2)
                throw new PlaywrightException("MT Assistant login inputs were not found.");
            await loginInputs.Nth(0).FillAsync(username, new() { Timeout = 5000 });
            await loginInputs.Nth(1).FillAsync(password, new() { Timeout = 5000 });
            await page.GetByText("安全登入", new() { Exact = true }).ClickAsync(new() { Force = true, Timeout = 5000 });
            // The MT Assistant keeps this page open and creates the official
            // WebSocket from its React client; no game URL navigation is needed.
            for (var wait = 0; wait < 60 && !ct.IsCancellationRequested; wait++)
            {
                var body = await page.Locator("body").InnerTextAsync();
                if (body.Contains("尚未取得使用權限", StringComparison.Ordinal)
                    || body.Contains("帳號或密碼不正確", StringComparison.Ordinal)
                    || body.Contains("密碼錯誤", StringComparison.Ordinal))
                    throw new DgLoginRequiredException("MT 官方帳號驗證失敗。");
                await Task.Delay(500, ct);
            }
            return null;
        }
        catch (PlaywrightException ex)
        {
            Console.WriteLine($"[MT] official browser API denied: {ex.Message}");
            throw new UpstreamAccessDeniedException();
        }
        catch (JsonException)
        {
            throw new UpstreamAccessDeniedException();
        }
    }

    static string ValidateMtGameUrl(string gameUrl)
    {
        if (!Uri.TryCreate(gameUrl.Replace("\\/", "/"), UriKind.Absolute, out var parsed)
            || parsed.Scheme != Uri.UriSchemeHttps
            || !parsed.Host.EndsWith("ofalive99.net", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(parsed.Query))
            throw new InvalidOperationException("MT 官方回傳的遊戲授權網址無效。");
        return parsed.ToString();
    }

    static string FirstString(System.Text.Json.Nodes.JsonNode? root, params string[] paths)
    {
        foreach (var path in paths)
        {
            var value = root;
            foreach (var segment in path.Split('.', StringSplitOptions.RemoveEmptyEntries))
            {
                value = value?[segment];
                if (value is null) break;
            }
            if (value is System.Text.Json.Nodes.JsonValue jsonValue
                && jsonValue.TryGetValue<string>(out var text)
                && !string.IsNullOrWhiteSpace(text)) return text.Trim();
        }
        return "";
    }
}
