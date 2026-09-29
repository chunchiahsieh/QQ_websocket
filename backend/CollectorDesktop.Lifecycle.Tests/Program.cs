using System.Text.Json;
using CollectorDesktop;

static CollectorDemand Parse(string json)
{
    using var document = JsonDocument.Parse(json);
    if (!CollectorDemand.TryParse(document.RootElement, out var demand))
        throw new Exception("Expected a valid demand response.");
    return demand;
}

static void Reject(string json)
{
    using var document = JsonDocument.Parse(json);
    if (CollectorDemand.TryParse(document.RootElement, out _))
        throw new Exception("Expected an invalid demand response to be rejected.");
}

static void Expect(bool condition, string message)
{
    if (!condition) throw new Exception(message);
}

static void ExpectAction(ViewerLifecycleAction actual, ViewerLifecycleAction expected, string message) =>
    Expect(actual == expected, $"{message} Expected {expected}, got {actual}.");

// DG's official lobby advances one visible second after approximately 950 ms,
// whereas MT/AB intentionally keep their existing countdown contracts.
const long dgReceivedAt = 1_000_000;
var dgCountdown = DgCardMapper.ToCard(new Dictionary<string, object> {
    ["tableId"] = "RB01", ["countDown"] = 19L, ["receivedAt"] = dgReceivedAt,
}, "https://new-dd-cn.dingdangmail.com/ddnewpc/index.html");
Expect((long)dgCountdown["countdownReceivedAt"]! == dgReceivedAt,
    "DG must preserve the timestamp of the actual official countdown frame.");
Expect((long)dgCountdown["countdownDeadline"]! == dgReceivedAt + 19 * 950,
    "DG deadline must use the official 950 ms visible-second interval.");
var dgRepeatedSnapshot = DgCardMapper.ToCard(new Dictionary<string, object> {
    ["tableId"] = "RB01", ["countDown"] = 19L, ["receivedAt"] = dgReceivedAt,
    ["onlineCount"] = 739UL,
}, "https://new-dd-cn.dingdangmail.com/ddnewpc/index.html");
Expect((long)dgRepeatedSnapshot["countdownDeadline"]! == (long)dgCountdown["countdownDeadline"]!,
    "An occupancy-only snapshot must not restart the DG countdown.");
var dgZero = DgCardMapper.ToCard(new Dictionary<string, object> {
    ["tableId"] = "RB01", ["countDown"] = 0L, ["receivedAt"] = dgReceivedAt,
}, "https://new-dd-cn.dingdangmail.com/ddnewpc/index.html");
Expect((long)dgZero["countdownDeadline"]! == dgReceivedAt,
    "A zero countdown must remain zero without a negative deadline.");
var dgWithoutCountdown = DgCardMapper.ToCard(new Dictionary<string, object> {
    ["tableId"] = "RB01",
}, "https://new-dd-cn.dingdangmail.com/ddnewpc/index.html");
Expect(!dgWithoutCountdown.ContainsKey("countdownDeadline"),
    "A DG frame without a timer must not manufacture a countdown.");
var dgShuffle = DgCardMapper.ToCard(new Dictionary<string, object> {
    ["tableId"] = "RB01", ["state"] = 8,
}, "https://new-dd-cn.dingdangmail.com/ddnewpc/index.html");
Expect((string)dgShuffle["tablePhase"]! == "shuffling",
    "DG official state 8 must show the shuffling overlay.");
Expect(!dgShuffle.ContainsKey("tableState"),
    "DG shuffling must use an explicit phase instead of an MT state code.");
var dgOpening = DgCardMapper.ToCard(new Dictionary<string, object> {
    ["tableId"] = "RB01", ["state"] = 2,
}, "https://new-dd-cn.dingdangmail.com/ddnewpc/index.html");
Expect((string)dgOpening["tablePhase"]! == "dealing",
    "DG official state 2 must continue to show the dealing overlay.");
var dgNoState = DgCardMapper.ToCard(new Dictionary<string, object> {
    ["tableId"] = "RB01", ["onlineCount"] = 739UL,
}, "https://new-dd-cn.dingdangmail.com/ddnewpc/index.html");
Expect(!dgNoState.ContainsKey("tablePhase"),
    "An occupancy update without state must preserve the current phase on merge.");
var dgAfterShuffle = DgCardMapper.ToCard(new Dictionary<string, object> {
    ["tableId"] = "RB01", ["state"] = 1,
}, "https://new-dd-cn.dingdangmail.com/ddnewpc/index.html");
Expect(dgAfterShuffle.ContainsKey("tablePhase") && dgAfterShuffle["tablePhase"] is null,
    "The next explicit DG state must clear the shuffling overlay.");

var grace = Parse("""{"shouldCollect":true,"viewerCount":0}""");
Expect(grace.ShouldCollect && grace.ViewerCount == 0,
    "A grace-period response must remain a zero-viewer sample.");
Reject("""{"shouldCollect":true}""");
Reject("""{"shouldCollect":true,"viewerCount":-1}""");
Reject("""{"shouldCollect":true,"viewerCount":"1"}""");

var occupiedClock = new ManualClock();
var viewerPresence = new ViewerPresenceTracker(occupiedClock);
ExpectAction(viewerPresence.Observe(3), ViewerLifecycleAction.None,
    "An occupied startup sample must only set the baseline.");
ExpectAction(viewerPresence.Observe(2), ViewerLifecycleAction.None,
    "Viewer count changes above zero must not restart.");
ExpectAction(viewerPresence.Observe(0), ViewerLifecycleAction.None,
    "The last viewer leaving must start the idle countdown.");
occupiedClock.Advance(TimeSpan.FromMinutes(4) + TimeSpan.FromSeconds(59));
ExpectAction(viewerPresence.Observe(0), ViewerLifecycleAction.None,
    "Capture must remain active before five minutes.");
occupiedClock.Advance(TimeSpan.FromSeconds(1));
ExpectAction(viewerPresence.Observe(0), ViewerLifecycleAction.Stop,
    "Capture must stop at five minutes of observed zero viewers.");
Expect(!viewerPresence.ShouldRunCapture, "The C# supervisor must remain in idle mode.");
ExpectAction(viewerPresence.Observe(0), ViewerLifecycleAction.None,
    "Repeated idle polls must not stop twice.");
ExpectAction(viewerPresence.Observe(1), ViewerLifecycleAction.Restart,
    "The first observed zero-to-positive edge must restart after idle stop.");
Expect(viewerPresence.ShouldRunCapture, "An arriving viewer must re-enable capture.");
ExpectAction(viewerPresence.Observe(4), ViewerLifecycleAction.None,
    "Repeated positive polls must not restart.");

var emptyClock = new ManualClock();
var emptyStartup = new ViewerPresenceTracker(emptyClock);
ExpectAction(emptyStartup.Observe(grace.ViewerCount), ViewerLifecycleAction.None,
    "An initial zero-viewer response must start the idle countdown.");
emptyClock.Advance(TimeSpan.FromMinutes(2));
ExpectAction(emptyStartup.Observe(Parse("""{"shouldCollect":true,"viewerCount":1}""").ViewerCount),
    ViewerLifecycleAction.Restart,
    "An arrival during the grace period must restart running capture once.");
ExpectAction(emptyStartup.Observe(0), ViewerLifecycleAction.None,
    "A later departure must reset the full five-minute countdown.");
emptyClock.Advance(TimeSpan.FromMinutes(5));
ExpectAction(emptyStartup.Observe(0), ViewerLifecycleAction.Stop,
    "The later zero interval must stop capture only after five minutes.");

var outageClock = new ManualClock();
var afterOutage = new ViewerPresenceTracker(outageClock);
outageClock.Advance(TimeSpan.FromMinutes(20));
Expect(afterOutage.ShouldRunCapture, "No demand reading cannot start an idle timer.");
ExpectAction(afterOutage.Observe(0), ViewerLifecycleAction.None,
    "The first valid zero after an outage starts a fresh timer.");
outageClock.Advance(TimeSpan.FromMinutes(6));
Reject("""{"shouldCollect":false,"viewerCount":null}""");
Expect(afterOutage.ShouldRunCapture, "A malformed demand response cannot stop capture.");
ExpectAction(afterOutage.Observe(0), ViewerLifecycleAction.Stop,
    "The next valid zero sample may confirm an expired idle interval.");

var temporaryRoot = Path.Combine(Path.GetTempPath(), "collector-install-test-" + Guid.NewGuid().ToString("N"));
Directory.CreateDirectory(temporaryRoot);
try
{
    var path = Path.Combine(temporaryRoot, "installation.json");
    var sequenceClock = new ManualClock();
    var first = new CollectorInstallationState(path, "machine-one", sequenceClock);
    var firstId = first.MachineBoundSuffix;
    var firstSequence = first.NextSequence();
    var secondSequence = first.NextSequence();
    Expect(secondSequence > firstSequence, "Sequences must increase within one process.");

    // The previous process may have crashed before using its whole reserved
    // block, and the local clock may have moved backwards before restart.
    sequenceClock.Advance(TimeSpan.FromHours(-1));
    var restarted = new CollectorInstallationState(path, "machine-one", sequenceClock);
    Expect(restarted.MachineBoundSuffix == firstId,
        "The same installation must keep its collector identity after restart.");
    Expect(restarted.NextSequence() > secondSequence,
        "A restart must advance beyond all previously reserved sequence numbers.");

    var copiedPath = Path.Combine(temporaryRoot, "copied-installation.json");
    File.Copy(path, copiedPath);
    var copiedToOtherPc = new CollectorInstallationState(copiedPath, "machine-two", sequenceClock);
    Expect(copiedToOtherPc.MachineBoundSuffix != firstId,
        "Copying the installation file to another machine must not share an owner ID.");

    File.WriteAllText(path, "{broken state");
    var recovered = new CollectorInstallationState(path, "machine-one", sequenceClock);
    Expect(recovered.MachineBoundSuffix != firstId,
        "Corrupt state must get a new owner rather than reuse an unsafe sequence.");

    var mutexScope = "collector-test-" + Guid.NewGuid().ToString("N");
    using (var owner = CollectorInstanceGuard.TryAcquire(mutexScope))
    {
        Expect(owner is not null, "First local collector must acquire the instance guard.");
        var duplicate = Task.Run(() => CollectorInstanceGuard.TryAcquire(mutexScope)).GetAwaiter().GetResult();
        Expect(duplicate is null, "A concurrent second collector must not start.");
    }
    using var afterRelease = CollectorInstanceGuard.TryAcquire(mutexScope);
    Expect(afterRelease is not null, "The instance guard must be reusable after a clean exit.");
}
finally
{
    var exactDirectory = Path.GetFullPath(temporaryRoot);
    var tempDirectory = Path.GetFullPath(Path.GetTempPath());
    if (!exactDirectory.StartsWith(tempDirectory, StringComparison.OrdinalIgnoreCase)
        || !Path.GetFileName(exactDirectory).StartsWith("collector-install-test-", StringComparison.Ordinal))
        throw new InvalidOperationException("Refusing to clean an unexpected test directory.");
    Directory.Delete(exactDirectory, recursive: true);
}

Console.WriteLine("Collector DG phase/countdown mapper, demand, lifecycle, and installation handoff tests passed.");

sealed class ManualClock : TimeProvider
{
    DateTimeOffset now = new(2026, 9, 21, 0, 0, 0, TimeSpan.Zero);
    public override DateTimeOffset GetUtcNow() => now;
    public void Advance(TimeSpan duration) => now += duration;
}
