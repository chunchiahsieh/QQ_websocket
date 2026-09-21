using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace CollectorRelay;

public sealed class AccountAdminClient(HttpClient http)
{
    static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public async Task<ForwardResult> ForwardAsync(string platform, JsonObject payload, CancellationToken cancellationToken)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"internal/feeds/{platform}") {
            Content = new StringContent(payload.ToJsonString(Json), Encoding.UTF8, "application/json"),
        };
        using var response = await http.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new AccountAdminUnavailableException(response.StatusCode);

        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var body = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = body.RootElement;
        var accepted = root.TryGetProperty("accepted", out var acceptedValue) && acceptedValue.ValueKind is JsonValueKind.True;
        var receivedAt = root.TryGetProperty("receivedAt", out var receivedAtValue) && receivedAtValue.TryGetInt64(out var timestamp)
            ? timestamp : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        return new ForwardResult(accepted, receivedAt);
    }

    public async Task<DemandSnapshot> GetDemandAsync(CancellationToken cancellationToken)
    {
        using var response = await http.GetAsync("internal/feeds/MT/demand", cancellationToken);
        if (!response.IsSuccessStatusCode)
            throw new AccountAdminUnavailableException(response.StatusCode);
        await using var stream = await response.Content.ReadAsStreamAsync(cancellationToken);
        using var body = await JsonDocument.ParseAsync(stream, cancellationToken: cancellationToken);
        var root = body.RootElement;
        return new DemandSnapshot(
            root.TryGetProperty("shouldCollect", out var shouldCollect) && shouldCollect.ValueKind is JsonValueKind.True,
            root.TryGetProperty("viewerCount", out var viewerCount) && viewerCount.TryGetInt64(out var count) ? count : 0,
            root.TryGetProperty("lastViewerAt", out var lastViewerAt) && lastViewerAt.TryGetInt64(out var lastSeen) ? lastSeen : 0,
            root.TryGetProperty("idleForMs", out var idleFor) && idleFor.TryGetInt64(out var idle) ? idle : long.MaxValue);
    }
}

public sealed class AccountAdminUnavailableException(HttpStatusCode statusCode) : Exception("共享桌況儲存服務暫時無法使用。")
{
    public HttpStatusCode StatusCode { get; } = statusCode;
}

public sealed record ForwardResult(bool Accepted, long ReceivedAt);
public sealed record DemandSnapshot(bool ShouldCollect, long ViewerCount, long LastViewerAt, long IdleForMs);
