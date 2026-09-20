using Microsoft.Data.Sqlite;
using System.Text.Json;

namespace AccountAdmin;

// The public Render service may execute each request in a different Worker
// isolate.  Latest table data therefore belongs on this private service's
// persistent disk, never in a public service global/static variable.
public sealed class SharedFeedStore : IDisposable
{
    const long SnapshotTtlMs = 30_000;
    const long ViewerHeartbeatTtlMs = 45_000;
    const long IdleGraceMs = 15 * 60_000;
    readonly string connectionString;
    readonly object gate = new();

    public SharedFeedStore(string directory)
    {
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
              status_json TEXT NULL,
              status_at INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS feed_viewers (
              viewer_id TEXT PRIMARY KEY,
              last_seen INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_feed_viewers_last_seen ON feed_viewers(last_seen);
            """;
        command.ExecuteNonQuery();
    }

    SqliteConnection Open()
    {
        var connection = new SqliteConnection(connectionString);
        connection.Open();
        return connection;
    }

    public bool SaveSnapshot(string platform, string payload, long receivedAt, long? sequence, string? collector)
    {
        lock (gate) {
            using var connection = Open();
            using var current = connection.CreateCommand();
            current.CommandText = "SELECT snapshot_at, snapshot_sequence, snapshot_collector FROM shared_feeds WHERE platform = $platform";
            current.Parameters.AddWithValue("$platform", platform);
            using var reader = current.ExecuteReader();
            var accepted = true;
            if (reader.Read()) {
                var previousAt = reader.GetInt64(0);
                var previousSequence = reader.IsDBNull(1) ? (long?)null : reader.GetInt64(1);
                var previousCollector = reader.IsDBNull(2) ? null : reader.GetString(2);
                var sameCollector = !string.IsNullOrEmpty(collector) && string.Equals(collector, previousCollector, StringComparison.Ordinal);
                if ((sameCollector && sequence is >= 0 && previousSequence is >= 0 && sequence < previousSequence)
                    || (!sameCollector && receivedAt < previousAt)) accepted = false;
            }
            reader.Close();
            if (!accepted) return false;
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO shared_feeds(platform, snapshot_json, snapshot_at, snapshot_sequence, snapshot_collector)
                VALUES($platform, $payload, $receivedAt, $sequence, $collector)
                ON CONFLICT(platform) DO UPDATE SET
                  snapshot_json = excluded.snapshot_json,
                  snapshot_at = excluded.snapshot_at,
                  snapshot_sequence = excluded.snapshot_sequence,
                  snapshot_collector = excluded.snapshot_collector;
                """;
            command.Parameters.AddWithValue("$platform", platform);
            command.Parameters.AddWithValue("$payload", payload);
            command.Parameters.AddWithValue("$receivedAt", receivedAt);
            command.Parameters.AddWithValue("$sequence", (object?)sequence ?? DBNull.Value);
            command.Parameters.AddWithValue("$collector", (object?)collector ?? DBNull.Value);
            command.ExecuteNonQuery();
            return true;
        }
    }

    public bool SaveStatus(string platform, string payload, long receivedAt)
    {
        lock (gate) {
            using var connection = Open();
            using var current = connection.CreateCommand();
            current.CommandText = "SELECT status_at FROM shared_feeds WHERE platform = $platform";
            current.Parameters.AddWithValue("$platform", platform);
            var previous = current.ExecuteScalar();
            if (previous is long previousAt && receivedAt < previousAt) return false;
            using var command = connection.CreateCommand();
            command.CommandText = """
                INSERT INTO shared_feeds(platform, status_json, status_at)
                VALUES($platform, $payload, $receivedAt)
                ON CONFLICT(platform) DO UPDATE SET status_json = excluded.status_json, status_at = excluded.status_at;
                """;
            command.Parameters.AddWithValue("$platform", platform);
            command.Parameters.AddWithValue("$payload", payload);
            command.Parameters.AddWithValue("$receivedAt", receivedAt);
            command.ExecuteNonQuery();
            return true;
        }
    }

    public string Current(string platform)
    {
        lock (gate) {
            using var connection = Open();
            using var command = connection.CreateCommand();
            command.CommandText = "SELECT snapshot_json, snapshot_at, status_json FROM shared_feeds WHERE platform = $platform";
            command.Parameters.AddWithValue("$platform", platform);
            using var reader = command.ExecuteReader();
            if (reader.Read()) {
                var snapshot = reader.IsDBNull(0) ? null : reader.GetString(0);
                var snapshotAt = reader.GetInt64(1);
                if (!string.IsNullOrEmpty(snapshot) && Now() - snapshotAt <= SnapshotTtlMs) return snapshot;
                if (!reader.IsDBNull(2)) return reader.GetString(2);
            }
            return JsonSerializer.Serialize(new {
                type = "status", status = "connecting", message = $"等待 {platform} 即時資料…", receivedAt = Now(),
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

    static long Now() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
    public void Dispose() { }
}
