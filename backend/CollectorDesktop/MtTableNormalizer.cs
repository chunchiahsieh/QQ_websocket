using System.Globalization;
using System.Text.Json;

namespace CollectorDesktop;

// Keep this normalizer deliberately aligned with the browser collector in
// app/page.tsx. MT emits a full /tables response followed by partial /wait,
// /summary and /result records. A partial record must never blank the road
// data that arrived in the full response.
public static class MtTableNormalizer
{
    public static List<Dictionary<string, object?>> Extract(JsonElement root, long? receivedAtMilliseconds = null)
    {
        var records = new List<JsonElement>();
        Visit(root, records, 0);
        var actionName = ActionName(root);
        var receivedAt = receivedAtMilliseconds ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        var result = new Dictionary<string, Dictionary<string, object?>>(StringComparer.Ordinal);

        foreach (var table in records)
        {
            var id = Text(table, "table_id");
            if (string.IsNullOrWhiteSpace(id)) continue;

            var trend = Object(table, "trend");
            var dealer = Object(table, "dealer");
            var row = result.TryGetValue(id, out var existing)
                ? existing
                : result[id] = new Dictionary<string, object?>(StringComparer.Ordinal) { ["id"] = id };

            var explicitDeadline = Number(table, "countdownDeadline")
                ?? Number(table, "countdown_deadline")
                ?? Number(table, "deadline");
            if (explicitDeadline is > 0 and < 100_000_000_000) explicitDeadline *= 1000;
            var waitEvent = actionName.Contains("/wait", StringComparison.OrdinalIgnoreCase)
                || actionName.Contains(":wait", StringComparison.OrdinalIgnoreCase);
            var countdown = Number(table, "countDown")
                ?? Number(table, "countdown")
                ?? Number(table, "countdown_seconds")
                ?? Number(table, "countdownSeconds")
                ?? Number(table, "remaining_seconds")
                ?? Number(table, "remainingSeconds")
                ?? Number(table, "remain")
                ?? Number(table, "remainSeconds")
                ?? Number(table, "wait_time")
                ?? Number(table, "waitTime")
                ?? (waitEvent ? Number(table, "count") : null);
            var countdownRound = Text(table, "game_sn") ?? Text(table, "gameSn")
                ?? Text(table, "round") ?? Text(table, "round_id") ?? Text(trend, "current_round");
            var showPokerEvent = actionName.EndsWith("/show_poker", StringComparison.OrdinalIgnoreCase);
            var completedEvent = actionName.EndsWith("/summary", StringComparison.OrdinalIgnoreCase)
                || actionName.EndsWith("/result", StringComparison.OrdinalIgnoreCase)
                || actionName.EndsWith("/end", StringComparison.OrdinalIgnoreCase);
            var endEvent = showPokerEvent || completedEvent;
            // LIVE is a separate presentation of the game named by table_id_t.
            // Never infer this relationship from a display-name suffix.
            row["sourceTableId"] = Text(table, "table_id_t") is { Length: > 0 } sourceId ? sourceId : id;
            row["mtEvent"] = IsTableSnapshot(root) ? "snapshot" : waitEvent ? "wait"
                : showPokerEvent ? "show_poker" : completedEvent ? "complete" : "update";
            row["mtReceivedAt"] = receivedAt;

            if (explicitDeadline is > 0)
            {
                row["countdownDeadline"] = explicitDeadline;
                row["countdownReceivedAt"] = receivedAt;
                row["countdownSource"] = waitEvent ? "wait" : "explicit";
            }
            else if (countdown is { } seconds)
            {
                row["countdownValue"] = Math.Max(0, seconds);
                row["countdownDeadline"] = receivedAt + Math.Max(0, seconds) * 1000;
                row["countdownReceivedAt"] = receivedAt;
                row["countdownSource"] = waitEvent ? "wait" : "snapshot";
            }
            if (endEvent)
            {
                row["countdownValue"] = 0L;
                row["countdownDeadline"] = receivedAt;
                row["countdownReceivedAt"] = receivedAt;
                row["countdownSource"] = "end";
            }
            Put(row, "countdownRound", countdownRound);
            Put(row, "name", Text(table, "table_name"));
            Put(row, "gameType", Text(table, "table_type"));
            var sourceState = Text(table, "state");
            Put(row, "tableState", sourceState);
            // /wait normally has no state field. A positive official countdown
            // is itself proof that the preceding shuffle has ended.
            if (waitEvent && countdown is > 0) row["tableState"] = "0";
            // /wait count=0 is an explicit official end-of-betting event;
            // /show_poker confirms the reveal phase. The next positive /wait
            // or result clears the overlay. Never infer it from a locally
            // expired timer, which can be stale after a missed packet.
            if (showPokerEvent || (waitEvent && countdown == 0))
                row["tablePhase"] = "dealing";
            else if (sourceState == "2" || completedEvent || (waitEvent && countdown is > 0))
                row["tablePhase"] = null;
            Put(row, "room", Text(table, "room_id"));
            Put(row, "shoe", Text(table, "shoe") ?? Text(table, "shoe_id") ?? Text(trend, "current_shoe"));
            Put(row, "round", Text(table, "round") ?? Text(table, "round_id") ?? Text(trend, "current_round"));
            Put(row, "banker", Text(trend, "total_round_banker"));
            Put(row, "player", Text(trend, "total_round_player"));
            Put(row, "tie", Text(trend, "total_round_tie"));
            Put(row, "players", Text(table, "totalplayers"));
            Put(row, "beadPlate", Text(trend, "bead_plate2"));
            Put(row, "bigRoad", Text(trend, "big2"));
            Put(row, "bigEyeRoad", Text(trend, "big_eye2"));
            Put(row, "smallRoad", Text(trend, "small2"));
            Put(row, "cockroachRoad", Text(trend, "cockroach2"));

            var dealerName = Text(dealer, "nick_name") ?? Text(dealer, "nickname")
                ?? Text(dealer, "name") ?? Text(dealer, "username") ?? Text(table, "dealer_name");
            Put(row, "dealer", dealerName);
            var photo = Text(table, "dealer_image") ?? Text(table, "dealer_image_url")
                ?? Text(dealer, "avatar_url") ?? Text(dealer, "image") ?? Text(dealer, "avatar") ?? Text(dealer, "photo");
            if (Uri.TryCreate(photo, UriKind.Absolute, out var photoUrl) && photoUrl.Scheme == Uri.UriSchemeHttps)
                row["dealerPhoto"] = photoUrl.ToString();

            var video = VideoUrl(table);
            if (video is not null) row["videoUrl"] = video;
        }
        return result.Values.ToList();
    }

    public static string ActionName(JsonElement value)
    {
        var direct = Text(value, "name") ?? Text(value, "event");
        if (!string.IsNullOrWhiteSpace(direct)) return direct;
        var action = Object(value, "action");
        return Text(action, "name") ?? Text(value, "action") ?? Text(value, "method") ?? "";
    }

    public static bool IsTableSnapshot(JsonElement value) => string.Equals(
        ActionName(value), "/api/v1/gametype/*/game/*/room/*/tables", StringComparison.Ordinal);

    static void Put(Dictionary<string, object?> target, string name, object? value)
    {
        if (value is string text && !string.IsNullOrWhiteSpace(text)) target[name] = text;
        else if (value is not null) target[name] = value;
    }

    static string? VideoUrl(JsonElement table)
    {
        var alias = Text(table, "table_id_t");
        var property = !string.IsNullOrWhiteSpace(alias) && alias != Text(table, "table_id") ? "video_live" : "video";
        if (!table.TryGetProperty(property, out var video) || video.ValueKind != JsonValueKind.Array) return null;
        foreach (var line in video.EnumerateArray())
        {
            if (line.ValueKind != JsonValueKind.Array || line.GetArrayLength() < 3) continue;
            var candidate = line[2].ValueKind == JsonValueKind.String ? line[2].GetString() : null;
            if (Uri.TryCreate(candidate, UriKind.Absolute, out var url) && url.Scheme == Uri.UriSchemeHttps && url.AbsolutePath.EndsWith(".flv", StringComparison.OrdinalIgnoreCase))
                return url.ToString();
        }
        return null;
    }

    static void Visit(JsonElement value, List<JsonElement> records, int depth)
    {
        if (depth > 6) return;
        if (value.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in value.EnumerateArray()) Visit(item, records, depth + 1);
            return;
        }
        if (value.ValueKind != JsonValueKind.Object) return;
        if (value.TryGetProperty("table_id", out var id) && id.ValueKind is JsonValueKind.String or JsonValueKind.Number) records.Add(value);
        foreach (var item in value.EnumerateObject()) Visit(item.Value, records, depth + 1);
    }

    static JsonElement Object(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object
        && value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.Object ? field : default;

    static string? Text(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object
        && value.TryGetProperty(name, out var field) && field.ValueKind is JsonValueKind.String or JsonValueKind.Number
            ? field.ToString() : null;

    static long? Number(JsonElement value, string name)
    {
        if (value.ValueKind != JsonValueKind.Object || !value.TryGetProperty(name, out var field)) return null;
        if (field.ValueKind == JsonValueKind.Number && field.TryGetInt64(out var number)) return number;
        return field.ValueKind == JsonValueKind.String
            && long.TryParse(field.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out number) ? number : null;
    }
}
