using System.Net.Http.Json;
using System.Text.Json;

namespace CollectorDesktop;

public sealed class RenderCollectorClient : IDisposable
{
    readonly HttpClient http;
    readonly string collectorId;
    long mtSequence, dgSequence;

    public RenderCollectorClient(CollectorSettings settings)
    {
        if (!Uri.TryCreate(settings.RenderUrl, UriKind.Absolute, out var baseUrl) || baseUrl.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("Render 網址必須是 HTTPS 完整網址。");
        if (settings.IngestKey.Length < 32) throw new InvalidOperationException("採集端金鑰至少需要 32 個字元。");
        collectorId = string.IsNullOrWhiteSpace(settings.DeviceId) ? "windows-collector-a" : settings.DeviceId;
        http = new HttpClient { BaseAddress = baseUrl, Timeout = TimeSpan.FromSeconds(12) };
        http.DefaultRequestHeaders.Add("X-Collector-Ingest-Key", settings.IngestKey);
    }

    public async Task<bool> ShouldCollectAsync(CancellationToken ct)
    {
        using var response = await http.GetAsync("api/collector/demand", ct);
        response.EnsureSuccessStatusCode();
        using var json = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(ct));
        return json.RootElement.TryGetProperty("shouldCollect", out var value) && value.ValueKind is JsonValueKind.True;
    }

    public Task PublishStatusAsync(string platform, string status, string message, CancellationToken ct) =>
        PostAsync(platform, new { type = "status", status, message }, ct);

    public Task PublishSnapshotAsync(string platform, IReadOnlyCollection<Dictionary<string, object?>> tables, CancellationToken ct) =>
        PostAsync(platform, new { type = "snapshot", tables }, ct);

    async Task PostAsync(string platform, object payload, CancellationToken ct)
    {
        var sequence = platform == "MT" ? Interlocked.Increment(ref mtSequence) : Interlocked.Increment(ref dgSequence);
        var body = new Dictionary<string, object?> {
            ["collectorId"] = collectorId,
            ["sequence"] = sequence,
            ["receivedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
        };
        foreach (var property in JsonSerializer.SerializeToElement(payload).EnumerateObject()) body[property.Name] = property.Value.Clone();
        using var response = await http.PostAsJsonAsync($"api/collector/ingest/{platform}", body, cancellationToken: ct);
        response.EnsureSuccessStatusCode();
    }

    public void Dispose() => http.Dispose();
}
