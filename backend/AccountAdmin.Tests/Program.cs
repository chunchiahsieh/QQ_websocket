using AccountAdmin;
using System.Text.Json;
using Microsoft.Extensions.Logging.Abstractions;

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
    var accountDirectory = Path.Combine(directory, "accounts");
    Guid firstId;
    string firstStamp;
    using (var accounts = new AccountStore(accountDirectory)) {
        accounts.Initialize("admin", "admin-pass");
        accounts.Create("viewer-one", "secret-one", DateTimeOffset.UtcNow.AddDays(1));
        accounts.Create("viewer-two", "secret-two", DateTimeOffset.UtcNow.AddDays(1));
        var firstAccount = accounts.Login("viewer-one", "secret-one")!;
        var secondAccount = accounts.Login("viewer-two", "secret-two")!;
        firstId = firstAccount.Id; firstStamp = firstAccount.Stamp;
        accounts.SetFocusedTables(firstId, firstStamp, ["MT::B01", "DG::DG:RB01", "MT::B01"]);
        Check(accounts.GetFocusedTables(firstId, firstStamp).SequenceEqual(["MT::B01", "DG::DG:RB01", "MT::B01"]),
            "Focused table order and duplicates must be retained");
        Check(accounts.GetFocusedTables(secondAccount.Id, secondAccount.Stamp).Count == 0,
            "Focused tables must be isolated by account");
    }
    using (var accounts = new AccountStore(accountDirectory)) {
        accounts.Initialize("admin", null);
        Check(accounts.GetFocusedTables(firstId, firstStamp).Count == 3,
            "Focused tables must persist across restarts");
    }
    Console.WriteLine("PASS: focused tables persist and are isolated by account");

    var ledger = new SimLedger();
    Check(SimulationModel.Stake("martingale", ledger) == 1, "Martingale starts at one unit");
    Check(SimulationModel.Settle("martingale", ledger, '2', '1') == -1, "Lost banker bet must debit one unit");
    Check(SimulationModel.Stake("martingale", ledger) == 2, "Martingale advances without a simulated stake cap");
    Check(SimulationModel.Settle("martingale", ledger, '2', '2') == 1.90m, "Banker win must apply five-percent commission");
    Check(SimulationModel.Stake("martingale", ledger) == 1, "A win must reset Martingale progression");
    Check(!SimulationModel.ShouldAct("confirm", '2', [], false, 0), "Consecutive confirmation needs a previous signal");
    Check(SimulationModel.ShouldAct("confirm", '2', [new SimDecision('2', '1')], false, 0), "Consecutive confirmation uses the current card's prior signal");
    Check(SimulationModel.ShouldAct("ai-consensus", '2', [], true, 3), "AI consensus threshold accepts three agreeing votes");
    Check(!SimulationModel.ShouldAct("ai-consensus", '2', [], false, 3), "AI consensus threshold must not activate another card");
    const string aiRoadBefore = "0102,,,,,";
    Check(SimulationModel.CurrentPrediction(new SimTable("AB", "B601", "B601", "", aiRoadBefore), "deepseek").Side == '2',
        "C# DeepSeek signal must match the browser's normalized banker signal");
    var aiRoadAfter = new SimTable("AB", "B601", "B601", "", aiRoadBefore + "#0101,,,,,");
    var lastAiDecision = SimulationModel.Decisions(aiRoadAfter, "deepseek")[^1];
    Check(lastAiDecision.Prediction == '2' && lastAiDecision.Outcome == '1',
        "C# simulation must count a live DeepSeek banker signal followed by player as a miss");
    var allBanker = new SimTable("MT", "B01", "B01", string.Join('#', Enumerable.Repeat("020202020202", 7)), "");
    Check(SimulationModel.Rank([allBanker]).Count == 1, "A positive shoe must produce a candidate without a browser");
    var startRanking = System.Diagnostics.Stopwatch.StartNew();
    var ranked = SimulationModel.Rank(Enumerable.Range(1, 14).Select(index => allBanker with { Id = $"B{index:00}" }));
    Check(ranked.Count == 14, "Candidate ranking must cover each available table");
    Console.WriteLine($"Simulation ranking: 14 tables in {startRanking.ElapsedMilliseconds} ms");
    Console.WriteLine("PASS: C# simulation strategy progression, action filters, and autonomous candidate ranking");
    var simulationDirectory = Path.Combine(directory, "simulation");
    Directory.CreateDirectory(Path.Combine(simulationDirectory, "feeds"));
    using (var accounts = new AccountStore(Path.Combine(simulationDirectory, "accounts")))
    using (var feed = new SharedFeedStore(Path.Combine(simulationDirectory, "feeds"))) {
        accounts.Initialize("admin", "admin-pass");
        feed.AdditionalDemand = () => accounts.GetSimulationControl().Running;
        var tableItems = Enumerable.Range(1, 14).Select(index => new { id = $"B{index:00}", name = $"B{index:00}", beadPlate = allBanker.Bead, bigRoad = "" }).ToArray();
        var initialSnapshot = JsonSerializer.Serialize(new { type = "snapshot", tables = tableItems });
        Check(feed.SaveSnapshot("MT", initialSnapshot, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), 1, "test-collector"), "Simulation feed must accept initial snapshot");
        accounts.StartSimulation();
        using var demand = JsonDocument.Parse(JsonSerializer.Serialize(feed.Demand()));
        Check(demand.RootElement.GetProperty("shouldCollect").GetBoolean(), "An active simulation must keep collection enabled without viewers");
        using var worker = new SimulationWorker(accounts, feed, NullLogger<SimulationWorker>.Instance);
        await worker.StartAsync(CancellationToken.None);
        for (var attempt = 0; attempt < 40 && worker.Snapshot().PendingCount < 6; attempt++) await Task.Delay(100);
        Check(worker.Snapshot().TableCount == 6 && worker.Snapshot().PendingCount == 6, "C# worker must place six pending simulations with no browser");
        Check(worker.Snapshot().Tables.All(table => table.Prediction is "莊" or "閒" && table.Stake > 0 && table.State == "已模擬下單・待結算"),
            "Table status must show the actual pending side and stake");
        var settledTables = Enumerable.Range(1, 14).Select(index => new { id = $"B{index:00}", name = $"B{index:00}", beadPlate = allBanker.Bead + "02", bigRoad = "" }).ToArray();
        var settledSnapshot = JsonSerializer.Serialize(new { type = "snapshot", tables = settledTables });
        Check(feed.SaveSnapshot("MT", settledSnapshot, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), 2, "test-collector"), "Simulation feed must accept next result");
        for (var attempt = 0; attempt < 60 && (accounts.GetSimulationControl().Summary?.Bets ?? 0) < 6; attempt++) await Task.Delay(100);
        Check(accounts.GetSimulationControl().Summary?.Bets == 6, "C# worker must settle pending bets without a browser");
        Check(worker.Snapshot().ProfitSeries.Count == 6, "C# worker must publish profit chart points");
        var stopped = worker.StopFromAdmin();
        Check(!stopped.Running && worker.Snapshot().TableCount == 0 && worker.Snapshot().PendingCount == 0,
            "Stopping from admin must immediately clear active simulated tables and bets");
        var stoppedSummary = accounts.GetSimulationControl().Summary;
        var stoppedLineCount = accounts.ListSimulationLines().Count;
        await Task.Delay(3300);
        Check(accounts.GetSimulationControl().Summary == stoppedSummary && accounts.ListSimulationLines().Count == stoppedLineCount,
            "The C# worker must not change simulation results after the stop action completes");
        await worker.StopAsync(CancellationToken.None);
    }
    Console.WriteLine("PASS: C# worker keeps collector demand, bets, and settles with no browser");
}
finally {
    try { Directory.Delete(directory, recursive: true); } catch { }
}

sealed class ManualTimeProvider(DateTimeOffset current) : TimeProvider
{
    public override DateTimeOffset GetUtcNow() => current;
    public void Advance(TimeSpan elapsed) => current += elapsed;
}
