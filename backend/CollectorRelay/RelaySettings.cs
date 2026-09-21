using System.Security.Cryptography;
using System.Text;

namespace CollectorRelay;

/// <summary>
/// Settings are intentionally loaded only from Render/local environment
/// variables.  The relay never receives, stores, or logs an official-game
/// username/password; it receives already-normalized table snapshots only.
/// </summary>
public sealed class RelaySettings
{
    public const int ProtocolVersion = 1;
    public const int MaxMessageBytes = 1_500_000;
    public const int MaxTables = 300;

    public required string IngestKey { get; init; }
    public required string AccountAdminKey { get; init; }
    public required Uri AccountAdminBaseUri { get; init; }
    public TimeSpan ProducerIdleTimeout { get; init; } = TimeSpan.FromSeconds(45);

    public static RelaySettings Load(IConfiguration configuration)
    {
        var ingestKey = configuration["COLLECTOR_INGEST_KEY"]?.Trim();
        if (string.IsNullOrWhiteSpace(ingestKey) || ingestKey.Length < 32)
            throw new InvalidOperationException("COLLECTOR_INGEST_KEY must contain at least 32 characters.");

        var internalKey = configuration["ACCOUNT_ADMIN_INTERNAL_KEY"]?.Trim()
            ?? configuration["ADMIN_INTERNAL_KEY"]?.Trim();
        if (string.IsNullOrWhiteSpace(internalKey) || internalKey.Length < 32)
            throw new InvalidOperationException("ACCOUNT_ADMIN_INTERNAL_KEY must contain at least 32 characters.");

        var configuredUrl = configuration["ACCOUNT_ADMIN_URL"]?.Trim();
        if (string.IsNullOrWhiteSpace(configuredUrl)) configuredUrl = "http://127.0.0.1:5092";
        if (!configuredUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
            && !configuredUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            configuredUrl = "http://" + configuredUrl;
        if (!Uri.TryCreate(configuredUrl, UriKind.Absolute, out var accountAdmin)
            || accountAdmin.Scheme is not ("http" or "https"))
            throw new InvalidOperationException("ACCOUNT_ADMIN_URL must be an HTTP(S) URL or Render hostport.");

        var timeoutSeconds = 45;
        if (int.TryParse(configuration["COLLECTOR_RELAY_IDLE_SECONDS"], out var configuredTimeout))
            timeoutSeconds = Math.Clamp(configuredTimeout, 15, 300);

        // HttpClient resolves relative paths correctly only against a directory
        // base URI. Render's hostport has no path today, but normalizing it
        // here keeps the relay correct if a private service URL gains one.
        var baseUri = new Uri(accountAdmin.ToString().TrimEnd('/') + "/", UriKind.Absolute);
        return new RelaySettings {
            IngestKey = ingestKey,
            AccountAdminKey = internalKey,
            AccountAdminBaseUri = baseUri,
            ProducerIdleTimeout = TimeSpan.FromSeconds(timeoutSeconds),
        };
    }

    public bool IsIngestAuthorized(HttpRequest request)
    {
        // Hash before the constant-time comparison so a malformed or
        // differently sized request never exposes a length-dependent compare.
        var supplied = request.Headers["X-Collector-Ingest-Key"].ToString();
        var expectedHash = SHA256.HashData(Encoding.UTF8.GetBytes(IngestKey));
        var suppliedHash = SHA256.HashData(Encoding.UTF8.GetBytes(supplied));
        return CryptographicOperations.FixedTimeEquals(expectedHash, suppliedHash);
    }
}
