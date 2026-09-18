using System.Security.Cryptography;
using System.Text;

// MT is intentionally a browser-side connection now. The browser receives
// the short-lived launch URL from the user, derives the official WebSocket
// endpoint, and renders the public table feed itself. Keep these legacy
// routes as explicit compatibility responses so an old client cannot start
// an Edge/Playwright process on the relay host.
static class MtRelay
{
    public static object Health => new
    {
        enabled = false,
        mode = "frontend-websocket",
        activeSessions = 0,
    };

    public static int Active => 0;

    public static void Map(WebApplication app, string key)
    {
        app.MapPost("/api/mt/start", (HttpContext http) =>
        {
            if (!CryptographicOperations.FixedTimeEquals(
                    Encoding.UTF8.GetBytes(http.Request.Headers["X-Relay-Key"].ToString()),
                    Encoding.UTF8.GetBytes(key)))
            {
                return Results.Json(new { message = "內部驗證失敗。" }, statusCode: 401);
            }

            return Results.Json(new
            {
                message = "MT 已改由前端 WebSocket 連線，後端不再啟動 Edge。",
                mode = "frontend-websocket",
            }, statusCode: 410);
        });

        app.Map("/ws/mt", async (HttpContext http) =>
        {
            http.Response.StatusCode = StatusCodes.Status410Gone;
            await http.Response.WriteAsJsonAsync(new
            {
                message = "MT 已改由前端 WebSocket 連線，請在前台貼上登入後的新授權網址。",
                mode = "frontend-websocket",
            });
        });
    }
}
