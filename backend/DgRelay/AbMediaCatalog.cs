using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// Public client configuration, not a member token. Never evaluates downloaded JavaScript.
sealed class AbMediaCatalog
{
    readonly string dealerBase;
    readonly Dictionary<string, string> videos;
    public AbMediaCatalog(string dealerBase = "", Dictionary<string, string>? videos = null)
    { this.dealerBase = dealerBase; this.videos = videos ?? new(); }

    public string Photo(string file) => dealerBase.Length > 0 && Regex.IsMatch(file, @"^[\p{L}\p{N}_-]{1,100}$")
        ? dealerBase + Uri.EscapeDataString(file) + ".jpg" : "";
    public string Video(string tableName) => videos.GetValueOrDefault(tableName, "");

    public static async Task<AbMediaCatalog> Load(CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        const string gc = "https://www.axgglm.net";
        var kp = await http.GetStringAsync(gc + "/h5/netbet_Desktop/conf/kp.js", ct);
        var encrypted = await http.GetStringAsync(gc + "/configs/system-ab-v9.json", ct);
        // Match the official DES3 CBC configuration format, using its published key/IV.
        var key = Regex.Match(kp, "key:\\s*\"([^\"]+)\"").Groups[1].Value;
        var iv = Regex.Match(kp, "pad:\\s*\"([^\"]+)\"").Groups[1].Value;
        using var cipher = TripleDES.Create();
        cipher.Key = Convert.FromBase64String(key); cipher.IV = Encoding.UTF8.GetBytes(iv);
        var bytes = Convert.FromBase64String(encrypted.Trim());
        using var doc = JsonDocument.Parse(cipher.CreateDecryptor().TransformFinalBlock(bytes, 0, bytes.Length));
        return Parse(doc.RootElement, gc);
    }

    public static AbMediaCatalog Parse(JsonElement config, string gc)
    {
        var photo = config.GetProperty("urls").EnumerateArray()
            .FirstOrDefault(x => x.GetProperty("type").GetString() == "dealer");
        var dealer = photo.ValueKind == JsonValueKind.Object
            ? photo.GetProperty("url").GetString()!.Replace("${gcDomain}", gc) : "";
        if (!Uri.TryCreate(dealer, UriKind.Absolute, out var dealerUri) || dealerUri.Scheme != "https"
            || dealerUri.Host != "www.axgglm.net" || dealerUri.AbsolutePath != "/dealer/") dealer = "";
        // HTTPS FLV works in the shared MSE player; prefer official line 4.
        var line = config.GetProperty("videoUrls").EnumerateArray()
            .FirstOrDefault(x => x.GetProperty("index").GetInt32() == 4);
        var prefix = line.ValueKind == JsonValueKind.Object ? line.GetProperty("url").GetString()! : "";
        if (!Uri.TryCreate(prefix, UriKind.Absolute, out var videoUri) || videoUri.Scheme != "https"
            || videoUri.Host != "v-tx.pinpfz.com" || videoUri.AbsolutePath != "/live/") prefix = "";
        var videos = new Dictionary<string, string>();
        if (prefix.Length > 0) foreach (var item in config.GetProperty("videos").EnumerateArray()) {
            var id = item.GetProperty("id").GetString()!;
            var name = item.GetProperty("name").GetString()!;
            if (Regex.IsMatch(name, @"^[A-Za-z0-9_-]+\.flv$")) videos[id] = prefix + name;
        }
        return new(dealer, videos);
    }
}
