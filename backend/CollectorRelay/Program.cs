using CollectorRelay;

var builder = WebApplication.CreateBuilder(args);
var port = Environment.GetEnvironmentVariable("PORT");
builder.WebHost.UseUrls($"http://0.0.0.0:{(string.IsNullOrWhiteSpace(port) ? "5093" : port)}");
// Keep auth headers and producer payloads out of provider logs.
builder.Logging.ClearProviders();

var settings = RelaySettings.Load(builder.Configuration);
builder.Services.AddSingleton(settings);
builder.Services.AddSingleton<CollectorSessionRegistry>();
builder.Services.AddHttpClient<AccountAdminClient>((services, client) => {
    var configured = services.GetRequiredService<RelaySettings>();
    client.BaseAddress = configured.AccountAdminBaseUri;
    client.Timeout = TimeSpan.FromSeconds(8);
    client.DefaultRequestHeaders.Add("X-Internal-Key", configured.AccountAdminKey);
});

var app = builder.Build();
app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(15) });

app.MapGet("/health", (CollectorSessionRegistry sessions) => Results.Json(sessions.Health()));
app.MapGet("/api/collector/demand", async (HttpContext context, RelaySettings relay, AccountAdminClient accountAdmin) => {
    if (!relay.IsIngestAuthorized(context.Request)) return Results.Json(new { message = "採集端驗證失敗。" }, statusCode: StatusCodes.Status401Unauthorized);
    try {
        var demand = await accountAdmin.GetDemandAsync(context.RequestAborted);
        return Results.Json(demand, statusCode: StatusCodes.Status200OK);
    }
    catch (AccountAdminUnavailableException) {
        return Results.Json(new { message = "觀看需求服務暫時無法使用。" }, statusCode: StatusCodes.Status503ServiceUnavailable);
    }
});
app.Map("/ws/ingest", IngestWebSocket.HandleAsync);

app.Run();
