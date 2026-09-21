using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CollectorDesktop;

public sealed record CollectorSettings(
    string RenderUrl = "https://qq-websocket.onrender.com/",
    string OfficialUrl = "https://www.tz6868.com/",
    string DeviceId = "windows-collector-a",
    string IngestKey = "",
    string Username = "",
    string Password = "");

// Secrets live only on the backup PC and are encrypted with the Windows user
// profile. The .exe never reads Render environment variables and does not
// write credentials to log files.
public static class CollectorSettingsStore
{
    sealed record Persisted(string RenderUrl, string OfficialUrl, string DeviceId, string IngestKey, string Username, string Password);
    static readonly string Path = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JshenCollector", "settings.json");
    static string Protect(string value) => Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser));
    static string Unprotect(string value) => Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(value), null, DataProtectionScope.CurrentUser));

    public static CollectorSettings Load()
    {
        try {
            var item = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(Path));
            return item is null ? new() : new(item.RenderUrl, item.OfficialUrl, item.DeviceId, Unprotect(item.IngestKey), Unprotect(item.Username), Unprotect(item.Password));
        } catch { return new(); }
    }

    public static void Save(CollectorSettings settings)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        var item = new Persisted(settings.RenderUrl.Trim(), settings.OfficialUrl.Trim(), settings.DeviceId.Trim(), Protect(settings.IngestKey), Protect(settings.Username), Protect(settings.Password));
        File.WriteAllText(Path, JsonSerializer.Serialize(item));
    }
}
