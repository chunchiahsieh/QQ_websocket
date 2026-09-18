static class OriginPolicy
{
    public static bool IsAllowed(IConfiguration configuration, string? origin)
    {
        if (string.IsNullOrWhiteSpace(origin)) return false;
        var configured = configuration["DG_FRONTEND_ORIGIN"];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            var allowed = configured.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
            return allowed.Any(value => string.Equals(value, origin, StringComparison.OrdinalIgnoreCase));
        }
        // Development/LAN mode: accept the frontend host currently in use on
        // port 3000. The WebSocket still requires a short-lived relay ticket.
        return Uri.TryCreate(origin, UriKind.Absolute, out var uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
            && uri.Port == 3000;
    }
}
