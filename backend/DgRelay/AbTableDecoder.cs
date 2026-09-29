using System.Text.Json;

// CaliBet V4.23.29 TableDO/BacRoadmap field mappings, verified against its public client.
// Only baccarat table fields are retained; login/member/bet/account messages are discarded.
sealed class AbTableDecoder
{
    readonly AbMediaCatalog media;
    public AbTableDecoder(AbMediaCatalog? media = null) { this.media = media ?? new(); }
    static readonly HashSet<int> BaccaratTypes = [101, 1011, 1012, 103, 104, 110, 111];
    readonly Dictionary<string, Dictionary<string, object>> tables = new();
    readonly Dictionary<string, OpeningProgress> openings = new();
    sealed class OpeningProgress
    {
        public bool SawPositiveCountdown;
        public long? PositiveCountdownDeadline;
        public int? OpeningRound;
        public int? SettledRound;
    }
    // The official feed may send a positive countdown without a final zero.
    // Call this from the collector's clock to publish that verified deadline.
    public List<Dictionary<string, object>> AdvanceTime(long nowMs)
    {
        var changed = new List<Dictionary<string, object>>();
        foreach (var (id, opening) in openings)
        {
            if (!opening.SawPositiveCountdown || opening.PositiveCountdownDeadline is not long deadline || nowMs < deadline)
                continue;
            var table = tables[id];
            if (!table.TryGetValue("state", out var state) || Convert.ToString(state) != "100"
                || !table.TryGetValue("playId", out var round) || !int.TryParse(Convert.ToString(round), out var roundNumber)
                || opening.SettledRound == roundNumber)
                continue;
            table["openingStarted"] = true;
            opening.OpeningRound = roundNumber;
            table["countDown"] = 0;
            table["receivedAt"] = nowMs;
            opening.SawPositiveCountdown = false;
            opening.PositiveCountdownDeadline = null;
            changed.Add(new Dictionary<string, object>(table));
        }
        return changed;
    }
    public List<Dictionary<string, object>> Accept(byte[] bytes)
    {
        using var doc = JsonDocument.Parse(bytes);
        var root = doc.RootElement;
        if (!root.TryGetProperty("c", out var command) || !root.TryGetProperty("p", out var p)) return [];
        var changed = new HashSet<string>();
        void Touch(string id) { if (tables.ContainsKey(id)) changed.Add(id); }
        switch (command.GetString())
        {
            case "getGameHall":
                foreach (var item in Array(p, "D")) Upsert(item, changed);
                break;
            case "pushGHAdd":
                if (p.TryGetProperty("A", out var add)) Upsert(add, changed);
                break;
            case "pushGameStatus":
                foreach (var item in Array(p, "A")) {
                    var id = Text(item,"AA");
                    if (tables.TryGetValue(id, out var table)) { Status(table, openings[id], item, true); Touch(id); }
                }
                break;
            case "getCountDown":
                foreach (var item in Array(p,"C")) {
                    var id = Text(item,"AA");
                    if (tables.TryGetValue(id,out var table) && item.TryGetProperty("DD",out var seconds)) {
                        Countdown(table, openings[id], seconds.GetInt32(), true);
                        Touch(id);
                    }
                }
                break;
            case "getRoadData":
                var roadId = Text(p,"C");
                if (tables.TryGetValue(roadId,out var roadTable) && p.TryGetProperty("G",out var roads)) {
                    roadTable["results"] = Results(roads); Touch(roadId);
                }
                break;
            case "pushGameTableResults":
                var resultId = Text(p,"A");
                if (tables.TryGetValue(resultId,out var resultTable) && p.TryGetProperty("G",out var resultRows) && p.TryGetProperty("C",out var round)) {
                    var history = (List<string>)resultTable["results"];
                    var newResults = Results(resultRows);
                    var resultRound = round.GetInt32();
                    var index = resultRound - 1;
                    // The shoe round indexes the result; duplicate updates replace, never append twice.
                    if (index >= 0 && newResults.Count == 1) {
                        if (index <= history.Count) {
                            if (index == history.Count) history.Add(newResults[0]); else history[index] = newResults[0];
                        }
                        // Roadmap results update history only. The opening
                        // overlay remains until the next round's countdown.
                        Touch(resultId);
                    }
                }
                break;
            case "pushGHDealer":
                var dealerId = Text(p,"AA");
                if (tables.TryGetValue(dealerId,out var dealerTable)) {
                    Dealer(dealerTable, Text(p,"BB")); Touch(dealerId);
                }
                break;
        }
        return changed.Select(id => new Dictionary<string,object>(tables[id])).ToList();
    }
    void Upsert(JsonElement item, HashSet<string> changed)
    {
        if (!item.TryGetProperty("DD",out var kind) || !BaccaratTypes.Contains(kind.GetInt32())) return;
        var id = Text(item,"AA"); if (id.Length == 0) return;
        if (!tables.TryGetValue(id,out var table)) {
            tables[id] = table = new() { ["tableId"] = id, ["results"] = new List<string>(), ["openingStarted"] = false };
            openings[id] = new OpeningProgress();
        }
        table["tableName"] = Text(item,"BB");
        Dealer(table, Text(item,"II"));
        table["videoUrl"] = media.Video(Text(item,"BB"));
        // Official TableDO calls CC `enterCount`, not a live online-player count.
        if (item.TryGetProperty("CC",out var count)) table["enterCount"] = count.GetInt32();
        if (item.TryGetProperty("HH",out var status)) Status(table, openings[id], status, false);
        if (item.TryGetProperty("Z3",out var state)) State(table, openings[id], state.GetInt32());
        if (item.TryGetProperty("WW3",out var results)) table["results"] = Results(results);
        changed.Add(id);
    }
    void Dealer(Dictionary<string,object> table, string file)
    {
        table["dealer"] = new { name = file.Split('_')[0] };
        table["dealerPhoto"] = media.Photo(file);
    }
    static void Status(Dictionary<string,object> table, OpeningProgress opening, JsonElement status, bool live)
    {
        if (status.TryGetProperty("BB",out var round) && round.GetInt32() > 0) {
            var next = round.GetInt32();
            if (table.TryGetValue("playId",out var previous) && int.TryParse(previous.ToString(),out var old) && next < old)
                table["results"] = new List<string>();
            if (!table.TryGetValue("playId", out previous) || previous.ToString() != next.ToString()) {
                opening.SawPositiveCountdown = false;
                opening.PositiveCountdownDeadline = null;
                opening.SettledRound = null;
                // The new round status may precede its first positive
                // countdown, so keep the previous opening overlay for now.
            }
            table["playId"] = next.ToString();
        }
        if (status.TryGetProperty("DD",out var state)) {
            State(table, opening, state.GetInt32());
            if (state.GetInt32() != 100) { table["countDown"] = 0; table["receivedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
        }
        if (status.TryGetProperty("EE",out var countdown)) {
            Countdown(table, opening, countdown.GetInt32(), live);
        }
    }
    static void State(Dictionary<string,object> table, OpeningProgress opening, int state)
    {
        table["state"] = state;
        if (state == 101) {
            // 101 confirms the result, but the overlay remains until the
            // next round actually starts counting down.
            var currentRound = table.TryGetValue("playId", out var round)
                && int.TryParse(Convert.ToString(round), out var parsed) ? parsed : (int?)null;
            if (currentRound is not null) opening.SettledRound = currentRound;
            opening.SawPositiveCountdown = false;
            opening.PositiveCountdownDeadline = null;
        } else if (state != 100) {
            // Shuffle/other non-betting phases supersede the opening overlay.
            table["openingStarted"] = false;
            opening.OpeningRound = null;
            opening.SawPositiveCountdown = false;
            opening.PositiveCountdownDeadline = null;
        }
    }
    static void Countdown(Dictionary<string,object> table, OpeningProgress opening, int seconds, bool live)
    {
        seconds = Math.Max(0, seconds);
        table["countDown"] = seconds;
        table["receivedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (!table.TryGetValue("state", out var value) || Convert.ToString(value) != "100"
            || !table.TryGetValue("playId", out var round) || !int.TryParse(Convert.ToString(round), out var roundNumber)
            || opening.SettledRound == roundNumber) return;
        if (seconds > 0) {
            if (table.TryGetValue("openingStarted", out var started) && started is true) {
                // A late packet from the opening round is not a new betting
                // window. Only a positive countdown for a new round clears it.
                if (opening.OpeningRound == roundNumber) return;
                table["openingStarted"] = false;
                opening.OpeningRound = null;
            }
            opening.SawPositiveCountdown = true;
            opening.PositiveCountdownDeadline = (long)table["receivedAt"] + seconds * 1000L;
        } else if (live && opening.SawPositiveCountdown) {
            // An initial lobby snapshot with a placeholder zero cannot open a round.
            // A live official zero must follow a positive countdown for this round.
            table["openingStarted"] = true;
            opening.OpeningRound = roundNumber;
            opening.SawPositiveCountdown = false;
            opening.PositiveCountdownDeadline = null;
        }
    }
    static string Text(JsonElement e,string key) => e.TryGetProperty(key,out var v) ? v.ToString() : "";
    static IEnumerable<JsonElement> Array(JsonElement e,string key) => e.TryGetProperty(key,out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray() : [];
    static List<string> Results(JsonElement rows) => rows.ValueKind == JsonValueKind.Array && rows.GetArrayLength()>0 && rows[0].ValueKind == JsonValueKind.Array
        ? rows[0].EnumerateArray().Where(v=>v.ValueKind==JsonValueKind.String).Select(v=>v.GetString()!).Where(v=>v.Length==12 && "0123456".Contains(v[0])).ToList() : [];
}
