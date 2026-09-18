using System.Text.Json;
using System.Text;

static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
using var mediaConfig = JsonDocument.Parse("""
{"urls":[{"type":"dealer","url":"${gcDomain}/dealer/"}],"videoUrls":[{"index":4,"url":"https://v-tx.pinpfz.com/live/"}],"videos":[{"id":"B201","name":"example.flv"},{"id":"B202","name":"../bad.flv"}]}
""");
var media = AbMediaCatalog.Parse(mediaConfig.RootElement,"https://www.axgglm.net");
Check(media.Photo("../secret") == "" && media.Video("B202") == "", "Media rejects path traversal");
var ab = new AbTableDecoder(media);
var abTables = ab.Accept(Encoding.UTF8.GetBytes("""
{"c":"getGameHall","p":{"D":[{"AA":10,"BB":"B201","DD":101,"II":"Dealer_123","HH":{"BB":2,"DD":100},"WW3":[["186060100000"]]},{"AA":20,"BB":"D201","DD":301,"WW3":[["1"]]}]}}
"""));
Check(abTables.Count == 1 && (string)abTables[0]["tableId"] == "10", "AB must exclude other games");
Check((string)abTables[0]["dealerPhoto"] == "https://www.axgglm.net/dealer/Dealer_123.jpg", "AB dealer photo keeps full filename");
Check((string)abTables[0]["videoUrl"] == "https://v-tx.pinpfz.com/live/example.flv", "AB video matches table name");
var dealerChange = ab.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGHDealer","p":{"AA":10,"BB":"Next_456"}}"""));
Check((string)dealerChange[0]["dealerPhoto"] == "https://www.axgglm.net/dealer/Next_456.jpg", "AB updates photo on dealer change");
var dealerClear = ab.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGHDealer","p":{"AA":10,"BB":""}}"""));
Check((string)dealerClear[0]["dealerPhoto"] == "", "AB clears stale dealer photo");
var abUpdate = Encoding.UTF8.GetBytes("""{"c":"pushGameTableResults","p":{"A":10,"C":2,"G":[["27858A302000"]]}}""");
ab.Accept(abUpdate);
var abDuplicate = ab.Accept(abUpdate);
Check(((List<string>)abDuplicate[0]["results"]).Count == 2, "AB results must be idempotent");
var abReset = ab.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":10,"BB":1,"DD":102}]}}"""));
Check(((List<string>)abReset[0]["results"]).Count == 0, "AB shoe reset clears history");
Check(ab.Accept(Encoding.UTF8.GetBytes("""{"c":"login","p":{"password":"test"}}""")).Count == 0,"Account payload must not be forwarded");
static async Task<JsonElement> ReadTables(System.Threading.Channels.ChannelReader<byte[]> reader)
{
    using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
    while (true) {
        var message = JsonSerializer.Deserialize<JsonElement>(await reader.ReadAsync(timeout.Token));
        if (message.GetProperty("type").GetString() == "tables") return message;
    }
}

using var stop = new CancellationTokenSource();
var started = 0;
var done = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
SharedDgFeed? feed = null;
feed = new SharedDgFeed(stop.Token, async (publish, ct) => {
    Interlocked.Increment(ref started);
    feed!.Connection(true); feed.Packet();
    await publish(new { type = "tables", tables = new[] { new { tableId = "1", countDown = 5, receivedAt = 1000 } } }, ct);
    try { await Task.Delay(Timeout.Infinite, ct); } finally { done.SetResult(); }
});
var first = feed.Subscribe();
await ReadTables(first.Reader);
feed.Unsubscribe(first.Id);
Check(started == 1 && !done.Task.IsCompleted, "Unsubscribe must not stop browser");
var clients = await Task.WhenAll(Enumerable.Range(0, 20).Select(_ => Task.Run(feed.Subscribe)));
foreach (var client in clients) {
    var snapshot = await ReadTables(client.Reader);
    Check(snapshot.GetProperty("snapshot").GetBoolean(), "Must send full snapshot");
    Check(snapshot.GetProperty("tables")[0].GetProperty("receivedAt").GetInt64() == 1000, "Do not refresh old countdown timestamp");
    feed.Unsubscribe(client.Id);
}
Check(started == 1, "Concurrent subscriptions must share one capture");
feed.Connection(false);
var stale = feed.Subscribe();
var status = JsonSerializer.Deserialize<JsonElement>(await stale.Reader.ReadAsync());
Check(status.GetProperty("type").GetString() == "status", "Disconnected cache must not appear live");
feed.Unsubscribe(stale.Id);
stop.Cancel(); await done.Task.WaitAsync(TimeSpan.FromSeconds(3));

using var stopBlocked = new CancellationTokenSource();
var loginAttempts = 0;
var blocked = new SharedDgFeed(stopBlocked.Token, (_, _) => {
    Interlocked.Increment(ref loginAttempts); throw new DgLoginRequiredException();
});
var auth = blocked.Subscribe();
using var authTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
while (true) {
    var message = JsonSerializer.Deserialize<JsonElement>(await auth.Reader.ReadAsync(authTimeout.Token));
    if (message.GetProperty("type").GetString() == "error") break;
}
blocked.Unsubscribe(auth.Id);
var retry = blocked.Subscribe();
Check(JsonSerializer.Deserialize<JsonElement>(await retry.Reader.ReadAsync()).GetProperty("type").GetString() == "error", "Blocked login must stay blocked");
Check(loginAttempts == 1, "Do not repeatedly submit rejected credentials");
blocked.Unsubscribe(retry.Id);

using var stopRecovery = new CancellationTokenSource();
var attempts = 0;
var fault = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
SharedDgFeed? recovery = null;
recovery = new SharedDgFeed(stopRecovery.Token, async (publish, ct) => {
    var attempt = Interlocked.Increment(ref attempts);
    recovery!.Connection(true); recovery.Packet();
    await publish(new { type = "tables", tables = new[] { new { tableId = attempt.ToString() } } }, ct);
    if (attempt == 1) { await fault.Task.WaitAsync(ct); throw new Exception("Simulated browser failure"); }
    await Task.Delay(Timeout.Infinite, ct);
});
var recoveringClient = recovery.Subscribe();
await ReadTables(recoveringClient.Reader);
fault.SetResult();
using var recoveryTimeout = new CancellationTokenSource(TimeSpan.FromSeconds(9));
bool sawReset = false;
while (true) {
    var message = JsonSerializer.Deserialize<JsonElement>(await recoveringClient.Reader.ReadAsync(recoveryTimeout.Token));
    if (message.GetProperty("type").GetString() == "reset") sawReset = true;
    if (message.GetProperty("type").GetString() == "tables") {
        Check(sawReset, "Failure must invalidate visible cache before recovery");
        Check(message.GetProperty("tables").GetArrayLength() == 1 && message.GetProperty("tables")[0].GetProperty("tableId").GetString() == "2", "Recovery must not include previous generation's tables");
        break;
    }
}
Check(attempts == 2, "Recover with one replacement capture");
recovery.Unsubscribe(recoveringClient.Id); stopRecovery.Cancel();
Console.WriteLine("PASS: persistent capture, concurrent subscribers, cached snapshot, stale gating, shutdown, login retry protection, failure recovery");
