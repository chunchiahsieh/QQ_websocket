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

    var roadOne = "{\"type\":\"snapshot\",\"tables\":[{\"id\":\"B01\",\"shoe\":\"9\",\"beadPlate\":\"0102\"}]}";
    var roadTwo = "{\"type\":\"snapshot\",\"tables\":[{\"id\":\"B01\",\"shoe\":\"9\",\"beadPlate\":\"010203\"}]}";
    var newShoe = "{\"type\":\"snapshot\",\"tables\":[{\"id\":\"B01\",\"shoe\":\"10\",\"beadPlate\":\"0201\"}]}";
    Check(store.SaveSnapshot("DG", roadOne, clock.GetUtcNow().ToUnixTimeMilliseconds(), 1, "collector-a"), "History seed accepted");
    Check(store.SaveSnapshot("DG", roadTwo, clock.GetUtcNow().ToUnixTimeMilliseconds(), 2, "collector-a"), "History append accepted");
    Check(store.SaveSnapshot("DG", roadTwo, clock.GetUtcNow().ToUnixTimeMilliseconds(), 3, "collector-a"), "Duplicate snapshot accepted without duplicate rounds");
    using (var history = JsonDocument.Parse(JsonSerializer.Serialize(store.RoadHistory("DG", "B01")))) {
        Check(history.RootElement.GetProperty("outcomes").GetArrayLength() == 3, "History must append each round only once");
        Check(history.RootElement.GetProperty("outcomes")[2].GetProperty("winner").GetString() == "3", "History must preserve chronological outcomes");
    }
    Check(store.SaveSnapshot("DG", newShoe, clock.GetUtcNow().ToUnixTimeMilliseconds(), 4, "collector-a"), "New shoe accepted");
    using (var history = JsonDocument.Parse(JsonSerializer.Serialize(store.RoadHistory("DG", "B01")))) {
        Check(history.RootElement.GetProperty("segment").GetInt64() == 2, "New shoe must begin a new segment");
        Check(history.RootElement.GetProperty("outcomes").GetArrayLength() == 2, "New shoe must not combine old observations");
    }
    var repeatedOne = "{\"type\":\"snapshot\",\"tables\":[{\"id\":\"B02\",\"shoe\":\"10\",\"banker\":\"2\",\"player\":\"0\",\"tie\":\"0\",\"beadPlate\":\"0202\"}]}";
    var repeatedTwo = "{\"type\":\"snapshot\",\"tables\":[{\"id\":\"B02\",\"shoe\":\"10\",\"banker\":\"3\",\"player\":\"0\",\"tie\":\"0\",\"beadPlate\":\"0202\"}]}";
    Check(store.SaveSnapshot("DG", repeatedOne, clock.GetUtcNow().ToUnixTimeMilliseconds(), 5, "collector-a"), "Repeated road seed accepted");
    Check(store.SaveSnapshot("DG", repeatedTwo, clock.GetUtcNow().ToUnixTimeMilliseconds(), 6, "collector-a"), "Repeated road with changed count accepted");
    using (var history = JsonDocument.Parse(JsonSerializer.Serialize(store.RoadHistory("DG", "B02"))))
        Check(history.RootElement.GetProperty("outcomes").GetArrayLength() == 3, "Advancing count must preserve indistinguishable repeated road round");
    Console.WriteLine("PASS: shared feed lease, freshness, and de-duplicated per-shoe road history");
}
finally {
    try { Directory.Delete(directory, recursive: true); } catch { }
}

sealed class ManualTimeProvider(DateTimeOffset current) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => current;
    public void Advance(TimeSpan elapsed) => current += elapsed;
}
