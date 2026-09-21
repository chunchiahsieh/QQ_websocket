using AccountAdmin;
using System.Text.Json;

static void Check(bool condition, string message)
{
    if (!condition) throw new InvalidOperationException(message);
}

var directory = Path.Combine(Path.GetTempPath(), "account-admin-feed-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(directory);
try {
    var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-09-21T05:00:00Z"));
    using var store = new SharedFeedStore(directory, clock);
    var first = "{\"type\":\"snapshot\",\"tables\":[{\"id\":\"B01\"}],\"receivedAt\":1}";
    Check(store.SaveSnapshot("MT", first, clock.GetUtcNow().ToUnixTimeMilliseconds(), 10, "collector-a"),
        "First collector must acquire the MT lease");

    clock.Advance(TimeSpan.FromSeconds(1));
    var second = "{\"type\":\"snapshot\",\"tables\":[{\"id\":\"B02\"}]}";
    Check(!store.SaveSnapshot("MT", second, clock.GetUtcNow().ToUnixTimeMilliseconds(), 1, "collector-b"),
        "A second collector must not replace an active MT lease");
    Check(!store.SaveStatus("MT", "{\"type\":\"status\",\"status\":\"connected\"}", clock.GetUtcNow().ToUnixTimeMilliseconds(), "collector-b"),
        "A second collector must not overwrite status while the lease is active");

    // A snapshot may be fresh for only 30 seconds even though its owner is
    // held for 45 seconds.  Viewers must receive an explicit offline/stale
    // state, never the old collector's last connected status.
    clock.Advance(TimeSpan.FromSeconds(30));
    using (var stale = JsonDocument.Parse(store.Current("MT"))) {
        Check(stale.RootElement.GetProperty("type").GetString() == "status", "Expired snapshot must not be returned");
        Check(stale.RootElement.GetProperty("status").GetString() == "offline", "Expired snapshot must be marked offline");
        Check(stale.RootElement.GetProperty("stale").GetBoolean(), "Expired snapshot must identify stale data");
    }

    // Once the old lease actually expires, a replacement collector can take
    // over.  Its own sequence begins independently of collector-a.
    clock.Advance(TimeSpan.FromSeconds(15));
    Check(store.SaveSnapshot("MT", second, clock.GetUtcNow().ToUnixTimeMilliseconds(), 1, "collector-b"),
        "Replacement collector must acquire MT after the old lease expires");
    using (var current = JsonDocument.Parse(store.Current("MT"))) {
        Check(current.RootElement.GetProperty("tables")[0].GetProperty("id").GetString() == "B02",
            "Replacement collector snapshot must be visible");
    }

    Console.WriteLine("PASS: shared feed uses TTL-based stale status and a per-platform single-writer collector lease");
}
finally {
    try { Directory.Delete(directory, recursive: true); } catch { }
}

sealed class ManualTimeProvider(DateTimeOffset current) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => current;
    public void Advance(TimeSpan elapsed) => current += elapsed;
}
