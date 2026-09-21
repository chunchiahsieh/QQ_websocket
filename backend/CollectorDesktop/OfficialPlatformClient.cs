using System.Net.Http.Json;
using System.Text.Json;

namespace CollectorDesktop;

public sealed class OfficialPlatformClient : IDisposable
{
    readonly HttpClient http;
    readonly CollectorSettings settings;

    public OfficialPlatformClient(CollectorSettings settings)
    {
        this.settings = settings;
        if (!Uri.TryCreate(settings.OfficialUrl, UriKind.Absolute, out var baseUrl) || baseUrl.Scheme != Uri.UriSchemeHttps)
            throw new InvalidOperationException("官方網址必須是 HTTPS 完整網址。");
        http = new HttpClient { BaseAddress = baseUrl, Timeout = TimeSpan.FromSeconds(18) };
    }

    public async Task<(string MtUrl, string DgUrl)> AuthorizeAsync(CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(settings.Username) || string.IsNullOrWhiteSpace(settings.Password))
            throw new InvalidOperationException("請先填寫採集帳號與密碼。");
        using var login = await http.PostAsJsonAsync("api/v1/login", new { username = settings.Username, password = settings.Password, device_id = settings.DeviceId }, ct);
        using var loginJson = JsonDocument.Parse(await login.Content.ReadAsStreamAsync(ct));
        var token = FindText(loginJson.RootElement, "token") ?? FindText(loginJson.RootElement, "access_token");
        if (!login.IsSuccessStatusCode || string.IsNullOrWhiteSpace(token)) throw new InvalidOperationException($"官方登入失敗（HTTP {(int)login.StatusCode}）。");
        var mt = await AuthorizeGameAsync(token, "MTLI", ct);
        var dg = await AuthorizeGameAsync(token, "DGLI", ct);
        return (mt, dg);
    }

    async Task<string> AuthorizeGameAsync(string token, string code, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, $"api/v2/game/{code}/login") {
            Content = JsonContent.Create(new { game_return_url = settings.OfficialUrl, game_kind = "", game_type = "", game_device = "Desktop" })
        };
        request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", token);
        using var response = await http.SendAsync(request, ct);
        using var json = JsonDocument.Parse(await response.Content.ReadAsStreamAsync(ct));
        var gameUrl = FindText(json.RootElement, "game_url") ?? FindText(json.RootElement, "url");
        if (!response.IsSuccessStatusCode || !ValidLaunchUrl(gameUrl)) throw new InvalidOperationException($"{code} 授權未取得（HTTP {(int)response.StatusCode}）。");
        return gameUrl!;
    }

    static string? FindText(JsonElement value, string name)
    {
        if (value.ValueKind == JsonValueKind.Object) {
            foreach (var property in value.EnumerateObject()) {
                if (property.NameEquals(name) && property.Value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(property.Value.GetString())) return property.Value.GetString()?.Replace("\\/", "/").Trim(' ', '\"', '\'');
                var nested = FindText(property.Value, name);
                if (nested is not null) return nested;
            }
        } else if (value.ValueKind == JsonValueKind.Array) {
            foreach (var item in value.EnumerateArray()) { var nested = FindText(item, name); if (nested is not null) return nested; }
        }
        return null;
    }

    static bool ValidLaunchUrl(string? value) => Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps && !string.IsNullOrWhiteSpace(uri.Query) && uri.Query.Contains("token=", StringComparison.OrdinalIgnoreCase);
    public void Dispose() => http.Dispose();
}
