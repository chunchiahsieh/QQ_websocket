using System.Text.Json;
using System.Text.RegularExpressions;

namespace CollectorDesktop;

// AB packets are decoded by the same verified decoder as the browser relay.
// Only the viewer's normalized baccarat card contract leaves this computer.
internal static class AbCardMapper
{
    static readonly Regex ResultPattern = new("^[0-6][0-9]{2}[0-6][A-Za-z0-9]{8}$", RegexOptions.Compiled);

    internal static Dictionary<string, object?> ToCard(Dictionary<string, object> source)
    {
        var id = Convert.ToString(source.GetValueOrDefault("tableId")) ?? "";
        var name = Convert.ToString(source.GetValueOrDefault("tableName"));
        var row = new Dictionary<string, object?> {
            ["id"] = "AB:" + id,
            ["name"] = string.IsNullOrWhiteSpace(name) ? id : name,
            ["gameType"] = "BAC",
            ["dealer"] = DealerName(source.GetValueOrDefault("dealer")),
            ["dealerPhoto"] = source.GetValueOrDefault("dealerPhoto"),
            ["videoUrl"] = source.GetValueOrDefault("videoUrl"),
            ["room"] = name ?? "",
            ["shoe"] = "—",
            ["round"] = Convert.ToString(source.GetValueOrDefault("playId")) ?? "—",
            ["players"] = "—", // AB has no verified live online-player metric.
        };
        if (source.TryGetValue("state", out var state))
        {
            var stateCode = Convert.ToString(state);
            // A verified countdown expiry starts opening. Keep it through
            // result confirmation (101), until the next betting countdown.
            var openingStarted = source.TryGetValue("openingStarted", out var opening)
                && opening is bool started && started;
            row["tablePhase"] = openingStarted && stateCode != "102" ? "dealing" : null;
            if (stateCode == "102") row["tableState"] = "2"; // Verified AB shuffle state.
        }
        if (source.TryGetValue("countDown", out var remaining) && long.TryParse(Convert.ToString(remaining), out var seconds))
        {
            var receivedAt = source.TryGetValue("receivedAt", out var received)
                && long.TryParse(Convert.ToString(received), out var timestamp)
                    ? timestamp : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            row["countdownReceivedAt"] = receivedAt;
            row["countdownDeadline"] = receivedAt + Math.Max(0, seconds) * 1000;
        }
        var results = source.TryGetValue("results", out var value) && value is IEnumerable<string> history
            ? history.Where(result => ResultPattern.IsMatch(result)).ToArray()
            : Array.Empty<string>();
        foreach (var road in AbRoadNormalizer.Normalize(results)) row[road.Key] = road.Value;
        return row;
    }

    static string DealerName(object? value)
    {
        if (value is null) return "";
        var dealer = JsonSerializer.SerializeToElement(value);
        return dealer.ValueKind == JsonValueKind.Object
            && dealer.TryGetProperty("name", out var name) && name.ValueKind == JsonValueKind.String
                ? name.GetString() ?? "" : "";
    }
}
