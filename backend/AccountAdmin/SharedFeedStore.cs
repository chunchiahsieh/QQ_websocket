using Microsoft.Data.Sqlite;
using System.Text.Json;

namespace AccountAdmin;

// The public Render service may execute each request in a different Worker
// isolate.  Latest table data therefore belongs on this private service's
// persistent disk, never in a public service global/static variable.
public sealed class SharedFeedStore : IDisposable
{
    const long SnapshotTtlMs = 30_000;
    // A collector republishes its full snapshot every ten seconds.  Keep its
    // ownership for long enough to tolerate a transient HTTP failure, but not
    // indefinitely after that process is gone.  This prevents an old browser
    // collector and the desktop collector from taking turns replacing a feed.
    const long CollectorLeaseTtlMs = 45_000;
    const long StatusTtlMs = 45_000;
    const long ViewerHeartbeatTtlMs = 45_000;
    const long IdleGraceMs = 15 * 60_000;
    readonly string connectionString;
    readonly TimeProvider clock;
    readonly object gate = new();

    public SharedFeedStore(string directory, TimeProvider? timeProvider = null)
    {
        clock = timeProvider ?? TimeProvider.System;
        var database = Path.Combine(directory, "shared-feed.db");
        connectionString = new SqliteConnectionStringBuilder {
            DataSource = database,
            Mode = SqliteOpenMode.ReadWriteCreate,
            Cache = SqliteCacheMode.Shared,
        }.ToString();
        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = """
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = FULL;
            CREATE TABLE IF NOT EXISTS shared_feeds (
              platform TEXT PRIMARY KEY,
              snapshot_json TEXT NULL,
              snapshot_at INTEGER NOT NULL DEFAULT 0,
              snapshot_sequence INTEGER NULL,
              snapshot_collector TEXT NULL,
              lease_collector TEXT NULL,
              lease_until INTEGER NOT NULL DEFAULT 0,
              status_json TEXT NULL,
              status_at INTEGER NOT NULL DEFAULT 0,
              status_collector TEXT NULL
            );
            CREATE TABLE IF NOT EXISTS feed_viewers (
              viewer_id TEXT PRIMARY KEY,
              last_seen INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_feed_viewers_last_seen ON feed_viewers(last_seen);
            CREATE TABLE IF NOT EXISTS feed_road_state (
              platform TEXT NOT NULL, table_id TEXT NOT NULL, shoe TEXT NOT NULL,
              segment INTEGER NOT NULL, observed_road TEXT NOT NULL, last_total INTEGER NULL,
              PRIMARY KEY(platform, table_id)
            );
            CREATE TABLE IF NOT EXISTS feed_rounds (
              platform TEXT NOT NULL, table_id TEXT NOT NULL, segment INTEGER NOT NULL,
              position INTEGER NOT NULL, shoe TEXT NOT NULL, winner TEXT NOT NULL,
              observed_at INTEGER NOT NULL,
              PRIMARY KEY(platform, table_id, segment, position)
            );
            CREATE INDEX IF NOT EXISTS idx_feed_rounds_table ON feed_rounds(platform, table_id, segment, position);
            """;
        command.ExecuteNonQuery();
        // Existing Render disks already have this table.  CREATE TABLE IF NOT
        // EXISTS cannot add columns, so make lease support an in-place
        // migration instead of requiring a reset of the shared feed database.
        EnsureColumn(connection, "lease_collector", "TEXT NULL");
        EnsureColumn(connection, "lease_until", "INTEGER NOT NULL DEFAULT 0");
        EnsureColumn(connection, "status_collector", "TEXT NULL");
        EnsureRoadColumn(connection, "last_total", "INTEGER NULL");
    }

    static void EnsureColumn(SqliteConnection connection, string column, string definition)
        => EnsureTableColumn(connection, "shared_feeds", column, definition);

    static void EnsureRoadColumn(SqliteConnection connection, string column, string definition)
        => EnsureTableColumn(connection, "feed_road_state", column, definition);

    static void EnsureTableColumn(SqliteConnection connection, string table, string column, string definition)
    {
        using var columns = connection.CreateCommand();
        columns.CommandText = $"PRAGMA table_info({table})";
        using var reader = columns.ExecuteReader();
        while (reader.Read()) {
            if (string.Equals(reader.GetString(1), column, StringComparison.OrdinalIgnoreCase)) return;
        }
        reader.Close();
        using var alter = connection.CreateCommand();
        // Both inputs are compile-time migration constants, never request data.
        alter.CommandText = $"ALTER TABLE {table} ADD COLUMN {column} {definition}";
        alter.ExecuteNonQuery();
    }

    SqliteConnection Open()
    {
        var connection = new SqliteConnection(connectionString);
        connection.Open();
        return connection;
    }

    public bool SaveSnapshot(string platform, string payload, long receivedAt, long? sequence, string? collector)
    {
        if (string.IsNullOrWhiteSpace(collector)) return false;
        lock (gate) {
            using var connection = Open();
            using var current = connection.CreateCommand();
            current.CommandText = "SELECT snapshot_sequence, snapshot_collector, lease_collector, lease_until FROM shared_feeds WHERE platform = $platform";
            current.Parameters.AddWithValue("$platform", platform);
            using var reader = current.ExecuteReader();
            var accepted = true;
            if (reader.Read()) {
                var previousSequence = reader.IsDBNull(0) ? (long?)null : reader.GetInt64(0);
                var previousCollector = reader.IsDBNull(1) ? null : reader.GetString(1);
                var leaseCollector = reader.IsDBNull(2) ? null : reader.GetString(2);
                var leaseUntil = reader.IsDBNull(3) ? 0 : reader.GetInt64(3);
                var sameCollector = string.Equals(collector, previousCollector, StringComparison.Ordinal);
                var ownsActiveLease = string.Equals(collector, leaseCollector, StringComparison.Ordinal);
                if ((sameCollector && sequence is >= 0 && previousSequence is >= 0 && sequence < previousSequence)
                    || (!ownsActiveLease && leaseUntil > receivedAt)) accepted = false;
            }
            reader.Close();
            if (!accepted) return false;
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO shared_feeds(platform, snapshot_json, snapshot_at, snapshot_sequence, snapshot_collector, lease_collector, lease_until)
                VALUES($platform, $payload, $receivedAt, $sequence, $collector, $collector, $leaseUntil)
                ON CONFLICT(platform) DO UPDATE SET
                  snapshot_json = excluded.snapshot_json,
                  snapshot_at = excluded.snapshot_at,
                  snapshot_sequence = excluded.snapshot_sequence,
                  snapshot_collector = excluded.snapshot_collector,
                  lease_collector = excluded.lease_collector,
                  lease_until = excluded.lease_until;
                """;
            command.Parameters.AddWithValue("$platform", platform);
            command.Parameters.AddWithValue("$payload", payload);
            command.Parameters.AddWithValue("$receivedAt", receivedAt);
            command.Parameters.AddWithValue("$sequence", (object?)sequence ?? DBNull.Value);
            command.Parameters.AddWithValue("$collector", (object?)collector ?? DBNull.Value);
            command.Parameters.AddWithValue("$leaseUntil", receivedAt + CollectorLeaseTtlMs);
            command.ExecuteNonQuery();
            try { SaveRoadHistory(connection, platform, payload, receivedAt); }
            catch (Exception error) when (error is JsonException or SqliteException) {
                // History is supplementary; never turn a valid live snapshot
                // into a failed collector ACK because history storage failed.
                Console.Error.WriteLine($"Road history write failed for {platform}: {error.GetType().Name}");
            }
            return true;
        }
    }

    static string[] RoadWinners(string road)
    {
        var result = new List<string>();
        foreach (var column in road.Split('#'))
            for (var i = 0; i + 1 < column.Length; i++)
                if (column[i] == '0' && column[i + 1] is '1' or '2' or '3') { result.Add(column[i + 1].ToString()); i++; }
        return result.ToArray();
    }

    static long? RoundTotal(JsonElement table)
    {
        long total = 0;
        foreach (var field in new[] { "banker", "player", "tie" }) {
            if (!table.TryGetProperty(field, out var value) || !long.TryParse(value.ToString(), out var count) || count < 0) return null;
            total += count;
        }
        return total;
    }

    // A snapshot contains a rolling road, not an event stream. Append only the
    // portion that overlaps the last accepted road. A gap starts a new segment:
    // transitions must never be inferred across missing rounds or a new shoe.
    static void SaveRoadHistory(SqliteConnection connection, string platform, string payload, long receivedAt)
    {
        using var document = JsonDocument.Parse(payload);
        if (!document.RootElement.TryGetProperty("tables", out var tables) || tables.ValueKind != JsonValueKind.Array) return;
        using var transaction = connection.BeginTransaction();
        foreach (var table in tables.EnumerateArray()) {
            if (table.ValueKind != JsonValueKind.Object) continue;
            var id = table.TryGetProperty("id", out var idValue) ? idValue.ToString() : "";
            var shoe = table.TryGetProperty("shoe", out var shoeValue) ? shoeValue.ToString() : "";
            var road = table.TryGetProperty("beadPlate", out var roadValue) && roadValue.ValueKind == JsonValueKind.String ? roadValue.GetString() : null;
            if (string.IsNullOrWhiteSpace(id) || string.IsNullOrWhiteSpace(road)) continue;
            var current = RoadWinners(road);
            if (current.Length == 0) continue;
            var currentTotal = RoundTotal(table);
            long segment = 1, position = 0;
            string[] previous = [];
            string previousShoe = "";
            long? previousTotal = null;
            using (var state = connection.CreateCommand()) {
                state.Transaction = transaction;
                state.CommandText = "SELECT shoe, segment, observed_road, last_total FROM feed_road_state WHERE platform=$p AND table_id=$t";
                state.Parameters.AddWithValue("$p", platform); state.Parameters.AddWithValue("$t", id);
                using var reader = state.ExecuteReader();
                if (reader.Read()) {
                    previousShoe = reader.GetString(0);
                    segment = reader.GetInt64(1);
                    previous = reader.GetString(2).Split(',', StringSplitOptions.RemoveEmptyEntries);
                    previousTotal = reader.IsDBNull(3) ? null : reader.GetInt64(3);
                }
            }
            var sameShoe = (shoe == previousShoe || string.IsNullOrWhiteSpace(shoe) || shoe == "—" || string.IsNullOrWhiteSpace(previousShoe) || previousShoe == "—")
                && !(currentTotal.HasValue && previousTotal.HasValue && currentTotal < previousTotal);
            var overlap = 0;
            if (sameShoe) {
                var max = Math.Min(previous.Length, current.Length);
                for (var size = max; size > 0; size--) {
                    if (previous.AsSpan(previous.Length - size, size).SequenceEqual(current.AsSpan(0, size))) { overlap = size; break; }
                }
                if (previous.SequenceEqual(current)) {
                    if (currentTotal.HasValue && previousTotal.HasValue && currentTotal == previousTotal + 1 && current.Length > 0) overlap = current.Length - 1;
                    else if (currentTotal.HasValue && previousTotal.HasValue && currentTotal > previousTotal + 1) overlap = 0;
                    else continue;
                }
                // A shorter road may be a reset or an out-of-order snapshot.
                if (previous.Length > 0 && current.Length < previous.Length && overlap == current.Length) continue;
            }
            if (previous.Length > 0 && (!sameShoe || overlap == 0)) segment++;
            using (var maxPosition = connection.CreateCommand()) {
                maxPosition.Transaction = transaction;
                maxPosition.CommandText = "SELECT COALESCE(MAX(position),0) FROM feed_rounds WHERE platform=$p AND table_id=$t AND segment=$s";
                maxPosition.Parameters.AddWithValue("$p", platform); maxPosition.Parameters.AddWithValue("$t", id); maxPosition.Parameters.AddWithValue("$s", segment);
                position = (long)(maxPosition.ExecuteScalar() ?? 0L);
            }
            for (var i = overlap; i < current.Length; i++) {
                using var insert = connection.CreateCommand();
                insert.Transaction = transaction;
                insert.CommandText = "INSERT OR IGNORE INTO feed_rounds(platform,table_id,segment,position,shoe,winner,observed_at) VALUES($p,$t,$s,$n,$shoe,$w,$at)";
                insert.Parameters.AddWithValue("$p", platform); insert.Parameters.AddWithValue("$t", id);
                insert.Parameters.AddWithValue("$s", segment); insert.Parameters.AddWithValue("$n", ++position);
                insert.Parameters.AddWithValue("$shoe", shoe); insert.Parameters.AddWithValue("$w", current[i]); insert.Parameters.AddWithValue("$at", receivedAt);
                insert.ExecuteNonQuery();
            }
            using var update = connection.CreateCommand();
            update.Transaction = transaction;
            update.CommandText = "INSERT INTO feed_road_state(platform,table_id,shoe,segment,observed_road,last_total) VALUES($p,$t,$shoe,$s,$road,$total) ON CONFLICT(platform,table_id) DO UPDATE SET shoe=excluded.shoe,segment=excluded.segment,observed_road=excluded.observed_road,last_total=excluded.last_total";
            update.Parameters.AddWithValue("$p", platform); update.Parameters.AddWithValue("$t", id);
            update.Parameters.AddWithValue("$shoe", shoe); update.Parameters.AddWithValue("$s", segment); update.Parameters.AddWithValue("$road", string.Join(',', current));
            update.Parameters.AddWithValue("$total", (object?)currentTotal ?? DBNull.Value);
            update.ExecuteNonQuery();
        }
        transaction.Commit();
    }

    public object RoadHistory(string platform, string tableId, int limit = 300)
    {
        lock (gate) {
            using var connection = Open();
            using var state = connection.CreateCommand();
            state.CommandText = "SELECT shoe,segment FROM feed_road_state WHERE platform=$p AND table_id=$t";
            state.Parameters.AddWithValue("$p", platform); state.Parameters.AddWithValue("$t", tableId);
            using var reader = state.ExecuteReader();
            if (!reader.Read()) return new { platform, tableId, shoe = "", segment = 0L, outcomes = Array.Empty<object>() };
            var shoe = reader.GetString(0); var segment = reader.GetInt64(1);
            reader.Close();
            using var rounds = connection.CreateCommand();
            rounds.CommandText = "SELECT position,winner,observed_at FROM feed_rounds WHERE platform=$p AND table_id=$t AND segment=$s ORDER BY position DESC LIMIT $limit";
            rounds.Parameters.AddWithValue("$p", platform); rounds.Parameters.AddWithValue("$t", tableId); rounds.Parameters.AddWithValue("$s", segment);
            rounds.Parameters.AddWithValue("$limit", Math.Clamp(limit, 1, 500));
            var outcomes = new List<object>();
            using var rows = rounds.ExecuteReader();
            while (rows.Read()) outcomes.Add(new { position = rows.GetInt64(0), winner = rows.GetString(1), observedAt = rows.GetInt64(2) });
            outcomes.Reverse();
            return new { platform, tableId, shoe, segment, outcomes };
        }
    }

    public bool SaveStatus(string platform, string payload, long receivedAt, string? collector)
    {
        if (string.IsNullOrWhiteSpace(collector)) return false;
        lock (gate) {
            using var connection = Open();
            using var current = connection.CreateCommand();
            current.CommandText = "SELECT lease_collector, lease_until FROM shared_feeds WHERE platform = $platform";
            current.Parameters.AddWithValue("$platform", platform);
            using var reader = current.ExecuteReader();
            if (reader.Read()) {
                var leaseCollector = reader.IsDBNull(0) ? null : reader.GetString(0);
                var leaseUntil = reader.IsDBNull(1) ? 0 : reader.GetInt64(1);
                // Status packets never acquire a lease.  A stale collector
                // therefore cannot overwrite the visible state while another
                // collector is supplying current snapshots.
                if (!string.IsNullOrEmpty(leaseCollector) && leaseUntil > receivedAt
                    && !string.Equals(collector, leaseCollector, StringComparison.Ordinal)) return false;
            }
            reader.Close();
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO shared_feeds(platform, status_json, status_at, status_collector)
                VALUES($platform, $payload, $receivedAt, $collector)
                ON CONFLICT(platform) DO UPDATE SET
                  status_json = excluded.status_json,
                  status_at = excluded.status_at,
                  status_collector = excluded.status_collector;
                """;
            command.Parameters.AddWithValue("$platform", platform);
            command.Parameters.AddWithValue("$payload", payload);
            command.Parameters.AddWithValue("$receivedAt", receivedAt);
            command.Parameters.AddWithValue("$collector", collector);
            command.ExecuteNonQuery();
            return true;
        }
    }

    public string Current(string platform)
    {
        lock (gate) {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT snapshot_json, snapshot_at, status_json, status_at FROM shared_feeds WHERE platform = $platform";
            command.Parameters.AddWithValue("$platform", platform);
            using var reader = command.ExecuteReader();
            var now = Now();
            if (reader.Read()) {
                var snapshot = reader.IsDBNull(0) ? null : reader.GetString(0);
                var snapshotAt = reader.GetInt64(1);
                if (!string.IsNullOrEmpty(snapshot)) {
                    if (now - snapshotAt <= SnapshotTtlMs) return snapshot;
                    // Do not fall back to an old "connected" status after the
                    // snapshot has expired.  That was how a dead collector
                    // could make viewers believe stale/partial tables were live.
                    return JsonSerializer.Serialize(new {
                        type = "status", status = "offline",
                        message = $"{platform} 即時資料更新逾時，正在等待採集端重新連線。",
                        receivedAt = now, stale = true,
                    });
                }
                var statusAt = reader.IsDBNull(3) ? 0 : reader.GetInt64(3);
                if (!reader.IsDBNull(2) && now - statusAt <= StatusTtlMs) return reader.GetString(2);
            }
            return JsonSerializer.Serialize(new {
                type = "status", status = "connecting", message = $"等待 {platform} 即時資料…", receivedAt = now,
            });
        }
    }

    public void TouchViewer(string viewerId, bool online)
    {
        lock (gate) {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = online
                ? "INSERT INTO feed_viewers(viewer_id, last_seen) VALUES($viewerId, $now) ON CONFLICT(viewer_id) DO UPDATE SET last_seen = excluded.last_seen"
                : "DELETE FROM feed_viewers WHERE viewer_id = $viewerId";
            command.Parameters.AddWithValue("$viewerId", viewerId);
            if (online) command.Parameters.AddWithValue("$now", Now());
            command.ExecuteNonQuery();
        }
    }

    public object Demand()
    {
        lock (gate) {
            using var connection = Open();
            var now = Now();
            using (var prune = connection.CreateCommand()) {
                prune.CommandText = "DELETE FROM feed_viewers WHERE last_seen < $cutoff";
                prune.Parameters.AddWithValue("$cutoff", now - ViewerHeartbeatTtlMs);
                prune.ExecuteNonQuery();
            }
            long count;
            long? lastSeen;
            using (var command = connection.CreateCommand()) {
                command.CommandText = "SELECT COUNT(*), MAX(last_seen) FROM feed_viewers";
                using var reader = command.ExecuteReader();
                reader.Read();
                count = reader.GetInt64(0);
                lastSeen = reader.IsDBNull(1) ? null : reader.GetInt64(1);
            }
            var lastViewerAt = lastSeen ?? 0;
            return new {
                viewerCount = count,
                lastViewerAt,
                idleForMs = lastSeen is null ? long.MaxValue : Math.Max(0, now - lastSeen.Value),
                shouldCollect = count > 0 || (lastSeen is not null && now - lastSeen.Value <= IdleGraceMs),
            };
        }
    }

    long Now() => clock.GetUtcNow().ToUnixTimeMilliseconds();
    public void Dispose() { }
}
