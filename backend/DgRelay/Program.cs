using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
// Bind on all interfaces so LAN clients can open the browser WebSocket.
builder.WebHost.UseUrls("http://0.0.0.0:5091");
builder.Logging.ClearProviders(); // Never log signed upstream URLs or credentials.
var apiKey = builder.Configuration["DG_RELAY_API_KEY"];
if (string.IsNullOrWhiteSpace(apiKey) || apiKey.Length < 32)
    throw new InvalidOperationException("DG_RELAY_API_KEY must contain at least 32 characters.");
var app = builder.Build();
app.UseWebSockets();
BrowserRelay.Map(app, apiKey);
AbBrowserRelay.Map(app, apiKey);
MtRelay.Map(app, apiKey);
app.MapGet("/health/mt", () => Results.Json(new { status = "ok", activeSessions = MtRelay.Active, feed = MtRelay.Health }));
app.MapGet("/health/ab", () => Results.Json(new { status = "ok", activeSessions = AbBrowserRelay.Active, feed = AbBrowserRelay.Health }));
app.MapGet("/health", () => Results.Json(new { status = "ok", transport = "BrowserWebSocket", activeSessions = BrowserRelay.Active, feed = BrowserRelay.Health }));
app.MapPost("/api/dg/stream", async (HttpContext context) =>
{
    var supplied = context.Request.Headers["X-Relay-Key"].ToString();
    if (!CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(supplied), Encoding.UTF8.GetBytes(apiKey)))
    { context.Response.StatusCode = 401; return; }
    if (context.Request.ContentLength is > 8192) { context.Response.StatusCode = 413; return; }
    RelayRequest? input;
    try { input = await context.Request.ReadFromJsonAsync<RelayRequest>(context.RequestAborted); }
    catch (JsonException) { context.Response.StatusCode = 400; return; }
    if (input is null || string.IsNullOrWhiteSpace(input.Token) || input.Token.Length > 2048)
    { context.Response.StatusCode = 400; return; }
    // Hostnames are fixed: clients cannot turn this endpoint into an arbitrary proxy.
    var lines = new[] { "wss://hwdata-new.taxyss.com", "wss://appatw.kindlestone.com" };
    ClientWebSocket? connected = null;
    var errors = new List<string>();
    foreach (var line in lines)
    {
        if (context.RequestAborted.IsCancellationRequested) return;
        var socket = new ClientWebSocket();
        socket.Options.CollectHttpResponseDetails = true;
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(15);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
        timeout.CancelAfter(TimeSpan.FromSeconds(12));
        try
        {
            await socket.ConnectAsync(new Uri(line + "/?sign=" + DgProtocol.Encrypt(input.Token)), timeout.Token);
            connected = socket; break;
        }
        catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or HttpRequestException)
        {
            errors.Add($"{new Uri(line).Host}: HTTP {(int)socket.HttpStatusCode}");
            socket.Dispose();
        }
    }
    if (connected is null)
    {
        context.Response.StatusCode = 502;
        await context.Response.WriteAsJsonAsync(new { message = "C# DG 握手失敗：" + string.Join("；", errors) }, context.RequestAborted);
        return;
    }
    using var upstream = connected;
    context.Response.ContentType = "text/event-stream";
    context.Response.Headers.CacheControl = "no-store";
    async Task Send(object message)
    {
        await context.Response.WriteAsync("data: " + JsonSerializer.Serialize(message) + "\n\n", context.RequestAborted);
        await context.Response.Body.FlushAsync(context.RequestAborted);
    }
    try
    {
        await Send(new { type = "status", message = "C# 已建立 DG WebSocket，等待授權與桌況…" });
        await upstream.SendAsync(DgProtocol.Login(input.Token).AsMemory(), WebSocketMessageType.Binary, true, context.RequestAborted);
        var buffer = new byte[16384];
        while (!context.RequestAborted.IsCancellationRequested && upstream.State == WebSocketState.Open)
        {
            using var frame = new MemoryStream();
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(context.RequestAborted);
            timeout.CancelAfter(TimeSpan.FromSeconds(30));
            ValueWebSocketReceiveResult result;
            do
            {
                result = await upstream.ReceiveAsync(buffer.AsMemory(), timeout.Token);
                if (result.MessageType == WebSocketMessageType.Close)
                { await Send(new { type = "error", message = "DG 上游關閉連線，授權或心跳協定需核對。" }); return; }
                if (frame.Length + result.Count > 1024 * 1024) throw new InvalidDataException();
                frame.Write(buffer, 0, result.Count);
            } while (!result.EndOfMessage);
            if (result.MessageType == WebSocketMessageType.Binary)
                await Send(new { type = "packet", data = Convert.ToBase64String(frame.ToArray()) });
        }
    }
    catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
    catch (Exception ex) when (ex is WebSocketException or OperationCanceledException or InvalidDataException)
    {
        if (!context.RequestAborted.IsCancellationRequested)
            await Send(new { type = "error", message = "DG 串流中斷、逾時或封包過大。" });
    }
    finally { upstream.Abort(); }
});
app.Run();

record RelayRequest(string Token);
static class DgProtocol
{
    public static string Encrypt(string value)
    {
        var reversed = new string("63dwReOhAlDbUoXiMFyZPgSvQc4JnTr7La0EjWf3Cu6NzBt9Ks1HxGq2Rd8Ym5Vp".Reverse().ToArray());
        using var cipher = TripleDES.Create();
        cipher.Key = Encoding.UTF8.GetBytes(reversed)[..24];
        cipher.Mode = CipherMode.ECB; cipher.Padding = PaddingMode.PKCS7;
        return Convert.ToBase64String(cipher.EncryptEcb(Encoding.UTF8.GetBytes(value), PaddingMode.PKCS7));
    }
    public static byte[] Login(string token)
    {
        var bytes = new List<byte>();
        void Varint(uint value) { while (value > 127) { bytes.Add((byte)((value & 127) | 128)); value >>= 7; } bytes.Add((byte)value); }
        void Int(uint field, uint value) { Varint(field << 3); Varint(value); }
        void Text(uint field, string value) { var text = Encoding.UTF8.GetBytes(value); Varint((field << 3) | 2); Varint((uint)text.Length); bytes.AddRange(text); }
        Int(1, 10086);
        Text(2, Encrypt(JsonSerializer.Serialize(new { cmd = 10086, token, time = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() })));
        Int(6, 1); Int(10, 0); Text(14, "PC");
        return bytes.ToArray();
    }
}
