using System.Globalization;

namespace CollectorDesktop;

// Shared by the browser and raw-socket collectors. Presentation IDs remain
// distinct; only an official table_id_t mapping shares the game's clock/state.
public static class MtTableState
{
    static readonly string[] SharedFields = [
        "countdownDeadline", "countdownReceivedAt", "countdownValue", "countdownSource", "countdownRound",
        "tableState", "tablePhase", "shoe", "round", "mtEvent", "mtReceivedAt",
    ];

    public static void Merge(Dictionary<string, Dictionary<string, object?>> tables,
        IEnumerable<Dictionary<string, object?>> updates)
    {
        foreach (var update in updates) MergeOne(tables, update);

        // Resolve aliases after the whole packet so the lobby's record order
        // cannot change the result, and a newly seen alias inherits a wait
        // received before the lobby supplied its metadata.
        foreach (var (id, table) in tables)
        {
            var sourceId = Text(table, "sourceTableId");
            if (string.IsNullOrWhiteSpace(sourceId) || sourceId == id || !tables.TryGetValue(sourceId, out var source)) continue;
            foreach (var key in SharedFields)
                if (source.TryGetValue(key, out var value)) table[key] = value;
        }
    }

    static void MergeOne(Dictionary<string, Dictionary<string, object?>> tables, IReadOnlyDictionary<string, object?> update)
    {
        var id = Text(update, "id");
        if (string.IsNullOrWhiteSpace(id)) return;
        if (!tables.TryGetValue(id, out var current))
        {
            tables[id] = new Dictionary<string, object?>(update, StringComparer.Ordinal);
            return;
        }

        var eventName = Text(update, "mtEvent") ?? "update";
        var passive = eventName is "snapshot" or "update";
        var authoritativeClock = Text(current, "countdownSource") is "wait" or "end";
        var olderRound = IsOlderRound(current, update);
        var previousRound = Text(current, "countdownRound");
        var nextRound = Text(update, "countdownRound");
        var newRound = previousRound is { Length: > 0 } && nextRound is { Length: > 0 }
            && !string.Equals(previousRound, nextRound, StringComparison.Ordinal);
        var previousValue = Number(current, "countdownValue");
        var nextValue = Number(update, "countdownValue");
        var backwardsWait = eventName == "wait" && authoritativeClock && !newRound
            && previousValue is not null && nextValue > previousValue;
        var protectClock = olderRound || (passive && authoritativeClock) || backwardsWait;
        var previousDealer = Text(current, "dealer");
        var nextDealer = Text(update, "dealer");
        var previousDeadline = Number(current, "countdownDeadline");
        var nextDeadline = Number(update, "countdownDeadline");
        var previousReceivedAt = Number(current, "countdownReceivedAt");

        if (!protectClock && newRound && eventName is "wait" or "show_poker" or "complete")
        {
            foreach (var key in SharedFields.Where(key => key.StartsWith("countdown", StringComparison.Ordinal))) current.Remove(key);
            current["tablePhase"] = null;
        }

        foreach (var (key, value) in update)
        {
            if (protectClock && IsClockField(key)) continue;
            if (olderRound && IsRoadField(key)) continue;
            // A partial event normally omits table_id_t. Its default self-ID
            // must not erase an alias already established by the lobby.
            if (key == "sourceTableId" && eventName != "snapshot" && Equals(value, id)
                && Text(current, "sourceTableId") is { Length: > 0 } knownSource && knownSource != id) continue;
            current[key] = value;
        }

        if (!protectClock && !newRound && previousDeadline is not null && nextDeadline is not null)
        {
            // Repeated frames and delayed lower counts cannot move the same
            // game's deadline forward. A first /wait may replace a placeholder
            // snapshot (including snapshot count=0), so only clamp established
            // authoritative clocks or repeated snapshot values.
            var clamp = authoritativeClock || (passive && previousValue == nextValue);
            if (clamp)
            {
                current["countdownDeadline"] = Math.Min(previousDeadline.Value, nextDeadline.Value);
                if (previousValue == nextValue && previousReceivedAt is not null)
                    current["countdownReceivedAt"] = previousReceivedAt.Value;
            }
        }
        if (nextDealer is not null && !string.Equals(nextDealer, previousDealer, StringComparison.Ordinal) && !update.ContainsKey("dealerPhoto"))
            current.Remove("dealerPhoto");
    }

    static bool IsClockField(string key) => key.StartsWith("countdown", StringComparison.Ordinal)
        || key is "tableState" or "tablePhase" or "shoe" or "round" or "mtEvent" or "mtReceivedAt";

    static bool IsRoadField(string key) => key is "beadPlate" or "bigRoad" or "bigEyeRoad" or "smallRoad" or "cockroachRoad"
        or "banker" or "player" or "tie";

    static bool IsOlderRound(IReadOnlyDictionary<string, object?> current, IReadOnlyDictionary<string, object?> update)
    {
        var previousShoe = Text(current, "shoe");
        var nextShoe = Text(update, "shoe");
        if (long.TryParse(previousShoe, out var oldShoe) && long.TryParse(nextShoe, out var newShoe) && oldShoe != newShoe)
            return newShoe < oldShoe;
        if (previousShoe is { Length: > 0 } && nextShoe is { Length: > 0 } && previousShoe != nextShoe) return false;
        return Number(current, "round") is { } previousRound && Number(update, "round") is { } nextRound && nextRound < previousRound;
    }

    static string? Text(IReadOnlyDictionary<string, object?> source, string name) => source.TryGetValue(name, out var value) ? Convert.ToString(value, CultureInfo.InvariantCulture) : null;
    static long? Number(IReadOnlyDictionary<string, object?> source, string name) => long.TryParse(Text(source, name), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) ? value : null;
}
