namespace CollectorDesktop;

internal static class DgCardMapper
{
    // DG's official V3.3.3 client decrements its lobby countdown when
    // Laya.Browser.now() - starTime reaches 950 ms, then resets starTime.
    // Keep this platform-specific interval out of MT/AB countdowns.
    internal const long OfficialCountdownTickMilliseconds = 950;

    internal static Dictionary<string, object?> ToCard(Dictionary<string, object> source, string pageUrl)
    {
        var id = Convert.ToString(source.GetValueOrDefault("tableId"))!;
        var row = new Dictionary<string, object?> {
            ["id"] = "DG:" + id, ["name"] = Convert.ToString(source.GetValueOrDefault("tableName")) ?? id, ["gameType"] = "BAC",
            ["room"] = Convert.ToString(source.GetValueOrDefault("tableName")) ?? "—", ["shoe"] = Convert.ToString(source.GetValueOrDefault("shoeId")) ?? "—",
            ["round"] = Convert.ToString(source.GetValueOrDefault("playId")) ?? "—", ["players"] = Convert.ToString(source.GetValueOrDefault("onlineCount")) ?? "—",
        };
        foreach (var road in DgRoadNormalizer.Normalize(source)) row[road.Key] = road.Value;
        if (source.TryGetValue("countDown", out var countdown) && long.TryParse(Convert.ToString(countdown), out var seconds)) {
            // The decoder retains the timestamp of the actual DG countdown
            // packet. Occupancy/road updates reuse a complete cached table;
            // rebasing on every such update makes an old 19-second value
            // jump back to 19 instead of counting down with the official UI.
            var receivedAt = source.TryGetValue("receivedAt", out var timestamp) && long.TryParse(Convert.ToString(timestamp), out var parsed)
                ? parsed : DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            row["countdownValue"] = Math.Max(0, seconds);
            row["countdownDeadline"] = receivedAt + Math.Max(0, seconds) * OfficialCountdownTickMilliseconds;
            row["countdownReceivedAt"] = receivedAt;
        }
        // DG V3.3.3 uses state 8 for shuffling. States 2 (opening),
        // 3 (revoke), and 4 (insurance) remain in dealing. An explicit
        // later state clears the phase on merge.
        // A packet without state must leave the current phase untouched.
        if (source.TryGetValue("state", out var state))
            row["tablePhase"] = Convert.ToString(state) switch {
                "2" or "3" or "4" => "dealing",
                "8" => "shuffling",
                _ => null,
            };
        if (source.TryGetValue("dealer", out var dealerValue) && dealerValue is Dictionary<string, object> dealer) {
            row["dealer"] = Convert.ToString(dealer.GetValueOrDefault("name")) ?? "未指派";
            var photo = Convert.ToString(dealer.GetValueOrDefault("photo"));
            if (!string.IsNullOrWhiteSpace(photo) && !photo.Contains("..") && !photo.Contains(':')) row["dealerPhoto"] = new Uri(new Uri(pageUrl).GetLeftPart(UriPartial.Authority) + "/vd/vd/image/Image/dealer/" + photo.TrimStart('/')).ToString();
        }
        return row;
    }
}
