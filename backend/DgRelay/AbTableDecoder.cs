using System.Text.Json;

// CaliBet V4.23.29 TableDO/BacRoadmap field mappings, verified against its public client.
// Only baccarat table fields are retained; login/member/bet/account messages are discarded.
sealed class AbTableDecoder
{
    readonly AbMediaCatalog media;
    public AbTableDecoder(AbMediaCatalog? media = null) { this.media = media ?? new(); }
    static readonly HashSet<int> BaccaratTypes = [101, 1011, 1012, 103, 104, 110, 111];
    readonly Dictionary<string, Dictionary<string, object>> tables = new();
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
                    if (tables.TryGetValue(id, out var table)) { Status(table, item); Touch(id); }
                }
                break;
            case "getCountDown":
                foreach (var item in Array(p,"C")) {
                    var id = Text(item,"AA");
                    if (tables.TryGetValue(id,out var table) && item.TryGetProperty("DD",out var seconds)) {
                        table["countDown"] = Math.Max(0, seconds.GetInt32());
                        table["receivedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); Touch(id);
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
                    var index = round.GetInt32() - 1;
                    // The shoe round indexes the result; duplicate updates replace, never append twice.
                    if (index >= 0 && index <= history.Count && newResults.Count == 1) {
                        if (index == history.Count) history.Add(newResults[0]); else history[index] = newResults[0];
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
        if (!tables.TryGetValue(id,out var table)) tables[id] = table = new() { ["tableId"] = id, ["results"] = new List<string>() };
        table["tableName"] = Text(item,"BB");
        Dealer(table, Text(item,"II"));
        table["videoUrl"] = media.Video(Text(item,"BB"));
        if (item.TryGetProperty("CC",out var count)) table["onlineCount"] = count.GetInt32();
        if (item.TryGetProperty("HH",out var status)) Status(table,status);
        if (item.TryGetProperty("Z3",out var state)) table["state"] = state.GetInt32();
        if (item.TryGetProperty("WW3",out var results)) table["results"] = Results(results);
        changed.Add(id);
    }
    void Dealer(Dictionary<string,object> table, string file)
    {
        table["dealer"] = new { name = file.Split('_')[0] };
        table["dealerPhoto"] = media.Photo(file);
    }
    static void Status(Dictionary<string,object> table, JsonElement status)
    {
        if (status.TryGetProperty("BB",out var round) && round.GetInt32() > 0) {
            var next = round.GetInt32();
            if (table.TryGetValue("playId",out var previous) && int.TryParse(previous.ToString(),out var old) && next < old)
                table["results"] = new List<string>();
            table["playId"] = next.ToString();
        }
        if (status.TryGetProperty("DD",out var state)) {
            table["state"] = state.GetInt32();
            if (state.GetInt32() != 100) { table["countDown"] = 0; table["receivedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
        }
        if (status.TryGetProperty("EE",out var countdown)) {
            table["countDown"] = Math.Max(0,countdown.GetInt32()); table["receivedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        }
    }
    static string Text(JsonElement e,string key) => e.TryGetProperty(key,out var v) ? v.ToString() : "";
    static IEnumerable<JsonElement> Array(JsonElement e,string key) => e.TryGetProperty(key,out var v) && v.ValueKind == JsonValueKind.Array ? v.EnumerateArray() : [];
    static List<string> Results(JsonElement rows) => rows.ValueKind == JsonValueKind.Array && rows.GetArrayLength()>0 && rows[0].ValueKind == JsonValueKind.Array
        ? rows[0].EnumerateArray().Where(v=>v.ValueKind==JsonValueKind.String).Select(v=>v.GetString()!).Where(v=>v.Length==12 && "0123456".Contains(v[0])).ToList() : [];
}
