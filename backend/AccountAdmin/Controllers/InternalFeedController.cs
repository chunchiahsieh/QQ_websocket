using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

namespace AccountAdmin.Controllers;

[ApiController, Route("internal/feeds")]
public sealed class InternalFeedController(SharedFeedStore store, IConfiguration config) : ControllerBase
{
    static readonly HashSet<string> Platforms = new(StringComparer.Ordinal) { "MT", "DG" };

    bool Authorized()
    {
        var key = config["ADMIN_INTERNAL_KEY"];
        var supplied = Request.Headers["X-Internal-Key"].ToString();
        if (key?.Length >= 32 && supplied.Length <= 256)
            return CryptographicOperations.FixedTimeEquals(SHA256.HashData(Encoding.UTF8.GetBytes(key)), SHA256.HashData(Encoding.UTF8.GetBytes(supplied)));
        return Environment.GetEnvironmentVariable("ASPNETCORE_ENVIRONMENT") == "Development"
            && HttpContext.Connection.RemoteIpAddress is { } address && System.Net.IPAddress.IsLoopback(address)
            && string.IsNullOrEmpty(supplied);
    }

    static bool ValidPlatform(string platform) => Platforms.Contains(platform.ToUpperInvariant());
    static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    static bool IsRecord(JsonElement value) => value.ValueKind == JsonValueKind.Object;
    static string? String(JsonElement value, string name) => value.TryGetProperty(name, out var item) && item.ValueKind == JsonValueKind.String ? item.GetString() : null;
    static long? Number(JsonElement value, string name) => value.TryGetProperty(name, out var item) && item.TryGetInt64(out var number) ? number : null;

    [HttpPost("{platform}"), RequestSizeLimit(1_600_000)]
    public IActionResult Write(string platform, [FromBody] JsonElement body)
    {
        platform = platform.ToUpperInvariant();
        if (!Authorized()) return Unauthorized();
        if (!ValidPlatform(platform) || !IsRecord(body)) return BadRequest(new { message = "共享桌況資料格式不正確。" });
        var type = String(body, "type");
        if (type is not ("snapshot" or "status")) return BadRequest(new { message = "共享桌況資料格式不正確。" });
        var receivedAt = Number(body, "receivedAt") is { } timestamp && timestamp > 0 ? timestamp : Now();
        var raw = body.GetRawText();
        if (raw.Length > 1_500_000) return BadRequest(new { message = "共享桌況快照過大。" });
        if (type == "snapshot") {
            if (!body.TryGetProperty("tables", out var tables) || tables.ValueKind != JsonValueKind.Array || tables.GetArrayLength() > 300)
                return BadRequest(new { message = "共享桌況資料格式不正確。" });
            var sequence = Number(body, "sequence");
            if (sequence is < 0) sequence = null;
            var collector = String(body, "collectorId");
            return Ok(new { ok = true, accepted = store.SaveSnapshot(platform, raw, receivedAt, sequence, collector) });
        }
        var status = String(body, "status");
        if (status is not ("connected" or "connecting" or "offline")) return BadRequest(new { message = "共享桌況狀態不正確。" });
        return Ok(new { ok = true, accepted = store.SaveStatus(platform, raw, receivedAt) });
    }

    [HttpGet("{platform}")]
    public IActionResult Read(string platform)
    {
        platform = platform.ToUpperInvariant();
        if (!Authorized()) return Unauthorized();
        if (!ValidPlatform(platform)) return NotFound();
        return Content(store.Current(platform), "application/json", Encoding.UTF8);
    }

    public record PresenceInput(string? ViewerId, bool? Online);

    [HttpPost("MT/presence"), RequestSizeLimit(4096)]
    public IActionResult Presence(PresenceInput input)
    {
        if (!Authorized()) return Unauthorized();
        var viewerId = input.ViewerId?.Trim();
        if (string.IsNullOrEmpty(viewerId) || viewerId.Length > 120) return BadRequest(new { message = "觀看者識別碼不正確。" });
        store.TouchViewer(viewerId, input.Online != false);
        return Ok(store.Demand());
    }

    [HttpGet("MT/demand")]
    public IActionResult Demand()
    {
        if (!Authorized()) return Unauthorized();
        return Ok(store.Demand());
    }
}
