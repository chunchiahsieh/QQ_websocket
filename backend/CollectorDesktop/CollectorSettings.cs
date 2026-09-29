using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CollectorDesktop;

public enum CollectorTarget { Production, Test, Lan }

// The default destination is production. Credentials and the shared ingest
// key are never compiled into the public release; this Windows station loads
// them from its DPAPI-protected settings file.
public static class CollectorDefaults
{
    public const string RenderUrl = "https://jshen.onrender.com/";
    public const string RelayUrl = "https://jshen-test-relay.onrender.com/";
    public const string TestRenderUrl = "https://jason-mt.onrender.com/";
    public const string TestRelayUrl = "https://jshen-collector-relay.onrender.com/";
    public const string OfficialUrl = "https://www.tz6868.com/";
    public const string DeviceId = "windows-collector-a";
    public const string IngestKey = "";
    public const string Username = "";
    public const string Password = "";
    public static CollectorSettings Create() => new(RenderUrl, OfficialUrl, DeviceId, IngestKey, Username, Password);
}

public sealed record CollectorSettings(
    string RenderUrl = CollectorDefaults.RenderUrl,
    string OfficialUrl = CollectorDefaults.OfficialUrl,
    string DeviceId = CollectorDefaults.DeviceId,
    string IngestKey = CollectorDefaults.IngestKey,
    string Username = CollectorDefaults.Username,
    string Password = CollectorDefaults.Password,
    string TestRenderUrl = CollectorDefaults.TestRenderUrl,
    string TestRelayUrl = CollectorDefaults.TestRelayUrl,
    CollectorTarget Target = CollectorTarget.Production);

// Secrets live only on the backup PC and are encrypted with the Windows user
// profile. The .exe never reads Render environment variables and does not
// write credentials to log files.
public static class CollectorSettingsStore
{
    sealed record Persisted(string RenderUrl, string OfficialUrl, string DeviceId, string IngestKey, string Username, string Password, string? TestRenderUrl = null, string? TestRelayUrl = null);
    static readonly string Path = System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "JshenCollector", "settings.json");
    public static string SettingsFilePath => Path;
    static string Protect(string value) => Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(value), null, DataProtectionScope.CurrentUser));
    static string Unprotect(string value) => Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(value), null, DataProtectionScope.CurrentUser));

    public static CollectorSettings Load(out string? warning)
    {
        try {
            var item = JsonSerializer.Deserialize<Persisted>(File.ReadAllText(Path));
            if (item is null) {
                warning = "找不到採集器設定；請完成欄位後按「啟動採集端」儲存。";
                return new();
            }
            var settings = new CollectorSettings(item.RenderUrl, item.OfficialUrl, item.DeviceId, Unprotect(item.IngestKey), Unprotect(item.Username), Unprotect(item.Password), item.TestRenderUrl ?? "", item.TestRelayUrl ?? "");
            warning = string.IsNullOrWhiteSpace(settings.Username)
                || string.IsNullOrWhiteSpace(settings.Password)
                || settings.IngestKey.Length < 32
                ? "設定檔已讀取，但帳號、密碼或採集器上傳金鑰不完整；不可啟動或覆寫。"
                : null;
            return settings;
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
        var item = new Persisted(settings.RenderUrl.Trim(), settings.OfficialUrl.Trim(), settings.DeviceId.Trim(), Protect(settings.IngestKey), Protect(settings.Username), Protect(settings.Password), settings.TestRenderUrl.Trim(), settings.TestRelayUrl.Trim());
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
