using System.Text;

// Field numbers verified against DG V3.3.3 res/proto/PublicBeanProto.proto.
// Only table and lobby occupancy data is forwarded; member, wallet and token fields are discarded.
sealed class DgTableDecoder
{
    readonly Dictionary<string, Dictionary<string, object>> tables = new();
    readonly HashSet<string> lobbyCountTables = new();
    readonly Dictionary<string, ulong> pendingLobbyCounts = new();
    public bool LastPacketHadLobbyCount { get; private set; }
    public List<Dictionary<string, object>> Accept(byte[] bytes)
    {
        LastPacketHadLobbyCount = false;
        var reader = new ProtoReader(bytes);
        var updates = new List<Dictionary<string, object>>();
        var lobbyPushes = new List<(string? TableId, ulong? OnlineCount)>();
        var roads = new List<string>(); ulong cmd = 0; string? tableId = null;
        while (!reader.Done)
        {
            var (field, wire) = reader.Tag();
            if (field == 1 && wire == 0) cmd = reader.UInt();
            else if (field == 6 && wire == 0) tableId = reader.UInt().ToString();
            else if (field == 12 && wire == 2) roads.Add(reader.Text());
            else if (field == 16 && wire == 2) lobbyPushes.Add(ReadLobbyPush(reader.Bytes()));
            else if (field == 17 && wire == 2) updates.Add(ReadTable(reader.Bytes()));
            else reader.Skip(wire);
        }
        if (cmd == 1004 && tableId != null && tables.ContainsKey(tableId))
            updates.Add(new() { ["tableId"] = tableId, ["roads"] = roads });
        var changed = new List<string>();
        var changedSet = new HashSet<string>();
        foreach (var update in updates)
        {
            if (!update.TryGetValue("tableId", out var id)) continue;
            var key = (string)id;
            if (!tables.TryGetValue(key, out var current))
            {
                if (!update.TryGetValue("gameId", out var game) || (ulong)game != 1 || tables.Count >= 300) continue;
                current = new(); tables[key] = current;
            }
            if (update.TryGetValue("gameId", out var kind) && (ulong)kind != 1) { tables.Remove(key); lobbyCountTables.Remove(key); pendingLobbyCounts.Remove(key); continue; }
            // Once the lobby reports occupancy, its count is authoritative.
            // Later Table frames can contain an older or default zero count.
            if (lobbyCountTables.Contains(key)) update.Remove("onlineCount");
            if (update.ContainsKey("countDown")) update["receivedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (update.TryGetValue("shoeId", out var newShoe) && current.TryGetValue("shoeId", out var oldShoe) && !Equals(newShoe, oldShoe))
                current["roads"] = new List<string>();
            foreach (var entry in update) current[entry.Key] = entry.Value;
            if (pendingLobbyCounts.Remove(key, out var pendingCount))
            {
                current["onlineCount"] = pendingCount;
                lobbyCountTables.Add(key);
                LastPacketHadLobbyCount = true;
            }
            if (changedSet.Add(key)) changed.Add(key);
        }
        if (cmd == 207)
        {
            foreach (var (id, count) in lobbyPushes)
            {
                if (id == null || count == null) continue;
                if (!tables.TryGetValue(id, out var current))
                {
                    // A lobby push can precede the table details. Keep only a
                    // bounded count cache; never publish a count-only table.
                    if (!pendingLobbyCounts.ContainsKey(id) && pendingLobbyCounts.Count >= 300)
                        pendingLobbyCounts.Remove(pendingLobbyCounts.Keys.First());
                    pendingLobbyCounts[id] = count.Value;
                    continue;
                }
                LastPacketHadLobbyCount = true;
                var firstLobbyCount = lobbyCountTables.Add(id);
                if (!firstLobbyCount && current.TryGetValue("onlineCount", out var previous) && (ulong)previous == count.Value) continue;
                current["onlineCount"] = count.Value;
                if (changedSet.Add(id)) changed.Add(id);
            }
        }
        // Return one complete state per table after every field in this packet
        // has been merged, including a Table and LobbyPush in the same packet.
        return changed.Where(tables.ContainsKey).Select(id => new Dictionary<string, object>(tables[id])).ToList();
    }
    static (string? TableId, ulong? OnlineCount) ReadLobbyPush(byte[] bytes)
    {
        var r = new ProtoReader(bytes); string? id = null; ulong? count = null;
        while (!r.Done)
        {
            var (f, w) = r.Tag();
            if (f == 1 && w == 0) id = r.UInt().ToString();
            else if (f == 2 && w == 0) count = r.UInt();
            else r.Skip(w);
        }
        return (id, count);
    }
    static Dictionary<string, object> ReadTable(byte[] bytes)
    {
        var r = new ProtoReader(bytes); var result = new Dictionary<string, object>();
        while (!r.Done)
        {
            var (f, w) = r.Tag();
            if (w == 0 && f is 1 or 2 or 3) result[f == 1 ? "tableId" : f == 2 ? "shoeId" : "playId"] = r.UInt().ToString();
            else if (w == 0 && f is 4 or 5 or 16 or 18) result[f == 4 ? "state" : f == 5 ? "countDown" : f == 16 ? "onlineCount" : "gameId"] = r.UInt();
            else if (w == 2 && f is 6 or 7 or 11 or 12 or 13) result[f == 6 ? "result" : f == 7 ? "poker" : f == 11 ? "gameNo" : f == 12 ? "fms" : "tableName"] = r.Text();
            else if (w == 2 && f == 10)
            { if (!result.ContainsKey("roads")) result["roads"] = new List<string>(); ((List<string>)result["roads"]).Add(r.Text()); }
            else if (w == 2 && f == 17) result["dealer"] = ReadDealer(r.Bytes());
            else r.Skip(w);
        }
        return result;
    }
    static Dictionary<string, object> ReadDealer(byte[] bytes)
    {
        var r = new ProtoReader(bytes); var result = new Dictionary<string, object>();
        while (!r.Done)
        {
            var (f, w) = r.Tag();
            if (w == 0 && f == 1) result["id"] = r.UInt().ToString();
            else if (w == 2 && f is 2 or 4) result[f == 2 ? "name" : "photo"] = r.Text();
            else r.Skip(w);
        }
        return result;
    }
}
sealed class ProtoReader(byte[] data)
{
    int offset;
    public bool Done => offset == data.Length;
    public ulong UInt()
    {
        ulong value = 0;
        for (var shift = 0; shift < 70 && offset < data.Length; shift += 7)
        { var next = data[offset++]; if (shift == 63 && next > 1) throw new InvalidDataException(); value |= (ulong)(next & 127) << shift; if ((next & 128) == 0) return value; }
        throw new InvalidDataException();
    }
    public (int, int) Tag() { var tag = UInt(); if (tag < 8 || tag > uint.MaxValue) throw new InvalidDataException(); return ((int)(tag >> 3), (int)(tag & 7)); }
    void Advance(int count) { if (count < 0 || count > data.Length - offset) throw new InvalidDataException(); offset += count; }
    public byte[] Bytes() { var size = UInt(); if (size > int.MaxValue) throw new InvalidDataException(); var start = offset; Advance((int)size); return data[start..offset]; }
    public string Text() => Encoding.UTF8.GetString(Bytes());
    public void Skip(int wire) { switch (wire) { case 0: UInt(); break; case 1: Advance(8); break; case 2: Bytes(); break; case 5: Advance(4); break; default: throw new InvalidDataException(); } }
}
