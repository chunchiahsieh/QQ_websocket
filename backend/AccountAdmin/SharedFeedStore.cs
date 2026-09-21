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
            """;
        command.ExecuteNonQuery();
        // Existing Render disks already have this table.  CREATE TABLE IF NOT
        // EXISTS cannot add columns, so make lease support an in-place
        // migration instead of requiring a reset of the shared feed database.
        EnsureColumn(connection, "lease_collector", "TEXT NULL");
        EnsureColumn(connection, "lease_until", "INTEGER NOT NULL DEFAULT 0");
        EnsureColumn(connection, "status_collector", "TEXT NULL");
    }

    static void EnsureColumn(SqliteConnection connection, string column, string definition)
    {
        using var columns = connection.CreateCommand();
        columns.CommandText = "PRAGMA table_info(shared_feeds)";
        using var reader = columns.ExecuteReader();
        while (reader.Read()) {
            if (string.Equals(reader.GetString(1), column, StringComparison.OrdinalIgnoreCase)) return;
        }
        reader.Close();
        using var alter = connection.CreateCommand();
        // Both inputs are compile-time migration constants, never request data.
        alter.CommandText = $"ALTER TABLE shared_feeds ADD COLUMN {column} {definition}";
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
            return true;
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
