using System.Text.Json;

namespace CollectorDesktop;

// This deliberately mirrors the viewer's normalized table contract. It keeps
// a countdown deadline (not a frozen number) so every viewer can count down
// locally even when snapshots arrive at different moments.
public static class MtTableNormalizer
{
    public static List<Dictionary<string, object?>> Extract(JsonElement root)
    {
        var records = new List<JsonElement>();
        Visit(root, records, 0);
        var result = new Dictionary<string, Dictionary<string, object?>>(StringComparer.Ordinal);
        foreach (var table in records) {
            var id = Text(table, "table_id");
            if (string.IsNullOrWhiteSpace(id)) continue;
            var trend = Object(table, "trend"); var dealer = Object(table, "dealer");
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var countdown = Number(table, "countDown") ?? Number(table, "countdown") ?? Number(table, "countdown_seconds") ?? Number(table, "remaining_seconds") ?? Number(table, "count");
            var deadline = Number(table, "countdownDeadline") ?? Number(table, "countdown_deadline") ?? Number(table, "deadline");
            if (deadline is { } seconds && seconds > 0 && seconds < 100_000_000_000) deadline = seconds * 1000;
            var row = new Dictionary<string, object?>(StringComparer.Ordinal) {
                ["id"] = id,
                ["name"] = Text(table, "table_name") ?? id,
                ["gameType"] = Text(table, "table_type") ?? "",
                ["dealer"] = Text(dealer, "nick_name") ?? Text(dealer, "nickname") ?? Text(dealer, "name") ?? Text(table, "dealer_name") ?? "未指派",
                ["room"] = Text(table, "room_id") ?? "—",
                ["shoe"] = Text(trend, "current_shoe") ?? "—",
                ["round"] = Text(table, "round") ?? Text(table, "round_id") ?? Text(trend, "current_round") ?? "—",
                ["banker"] = Text(trend, "total_round_banker") ?? "0",
                ["player"] = Text(trend, "total_round_player") ?? "0",
                ["tie"] = Text(trend, "total_round_tie") ?? "0",
                ["players"] = Text(table, "totalplayers") ?? "—",
                ["beadPlate"] = Text(trend, "bead_plate2") ?? "",
                ["bigRoad"] = Text(trend, "big2") ?? "",
                ["bigEyeRoad"] = Text(trend, "big_eye2") ?? "",
                ["smallRoad"] = Text(trend, "small2") ?? "",
                ["cockroachRoad"] = Text(trend, "cockroach2") ?? "",
            };
            var state = Text(table, "state"); if (state is not null) row["tableState"] = state;
            var gameRound = Text(table, "game_sn") ?? Text(table, "gameSn") ?? Text(table, "round") ?? Text(table, "round_id") ?? Text(trend, "current_round");
            if (gameRound is not null) row["countdownRound"] = gameRound;
            if (deadline is { } explicitDeadline && explicitDeadline > 0) { row["countdownDeadline"] = explicitDeadline; row["countdownReceivedAt"] = now; }
            else if (countdown is { } left) { row["countdownValue"] = Math.Max(0, left); row["countdownDeadline"] = now + Math.Max(0, left) * 1000; row["countdownReceivedAt"] = now; }
            var photo = Text(table, "dealer_image") ?? Text(table, "dealer_image_url") ?? Text(dealer, "avatar_url") ?? Text(dealer, "image") ?? Text(dealer, "photo");
            if (Uri.TryCreate(photo, UriKind.Absolute, out var photoUrl) && photoUrl.Scheme == Uri.UriSchemeHttps) row["dealerPhoto"] = photoUrl.ToString();
            result[id] = row;
        }
        return result.Values.ToList();
    }

    static void Visit(JsonElement value, List<JsonElement> records, int depth)
    {
        if (depth > 6) return;
        if (value.ValueKind == JsonValueKind.Array) foreach (var item in value.EnumerateArray()) Visit(item, records, depth + 1);
        if (value.ValueKind != JsonValueKind.Object) return;
        if (value.TryGetProperty("table_id", out var id) && id.ValueKind is JsonValueKind.String or JsonValueKind.Number) records.Add(value);
        foreach (var item in value.EnumerateObject()) Visit(item.Value, records, depth + 1);
    }

    static JsonElement Object(JsonElement value, string name) => value.TryGetProperty(name, out var field) && field.ValueKind == JsonValueKind.Object ? field : default;
    static string? Text(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var field) && field.ValueKind is JsonValueKind.String or JsonValueKind.Number ? field.ToString() : null;
    static long? Number(JsonElement value, string name) => value.ValueKind == JsonValueKind.Object && value.TryGetProperty(name, out var field) && field.TryGetInt64(out var number) ? number : null;
}
