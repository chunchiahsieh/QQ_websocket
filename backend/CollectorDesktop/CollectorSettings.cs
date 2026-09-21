using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CollectorDesktop;

public sealed record CollectorSettings(
    string RenderUrl = "https://jason-mt.onrender.com/",
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

    public static CollectorSettings Load(out string? warning)
    {
        try {
            var item = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(Path));
            warning = item is null ? "找不到採集器設定；請完成欄位後按「啟動採集端」儲存。" : null;
            return item is null ? new() : new(item.RenderUrl, item.OfficialUrl, item.DeviceId, Unprotect(item.IngestKey), Unprotect(item.Username), Unprotect(item.Password));
        }
        catch {
            // A DPAPI setting belongs to the Windows account that created it.
            // Never silently pretend this is a usable configuration: tell the
            // operator to replace it and save a new encrypted copy.
            warning = "舊採集器設定無法由目前 Windows 使用者解密；請重新設定後按「啟動採集端」儲存。";
            return new();
        }
    }

    public static CollectorSettings Load() => Load(out _);

    public static void Save(CollectorSettings settings)
    {
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
        var item = new Persisted(settings.RenderUrl.Trim(), settings.OfficialUrl.Trim(), settings.DeviceId.Trim(), Protect(settings.IngestKey), Protect(settings.Username), Protect(settings.Password));
        var content = JsonSerializer.Serialize(item);
        IOException? lastError = null;
        // The UI and setup command can be started nearly simultaneously.
        // Retry briefly instead of losing the requested configuration because
        // a Windows virus scanner or the earlier process still holds the file.
        for (var attempt = 0; attempt < 10; attempt++)
        {
            try { File.WriteAllText(Path, content); return; }
            catch (IOException exception) when (attempt < 9)
            {
                lastError = exception;
                Thread.Sleep(250);
            }
        }
        throw new IOException("採集器設定檔正被另一個程序使用，請關閉其他 CollectorDesktop 視窗後重試。", lastError);
    }
}
