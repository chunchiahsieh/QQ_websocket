using System.Text.Json;
using System.Text;

static void Check(bool ok, string message) { if (!ok) throw new Exception(message); }
static byte[] Varint(ulong number)
{
    var bytes = new List<byte>();
    while (number >= 128) { bytes.Add((byte)(number | 128)); number >>= 7; }
    bytes.Add((byte)number);
    return bytes.ToArray();
}
static byte[] FieldVar(int field, ulong value) => Varint((ulong)(field << 3)).Concat(Varint(value)).ToArray();
static byte[] FieldBytes(int field, byte[] value) => Varint((ulong)((field << 3) | 2)).Concat(Varint((ulong)value.Length)).Concat(value).ToArray();
static byte[] Packet(params byte[][] fields) => fields.SelectMany(field => field).ToArray();

var dgDecoder = new DgTableDecoder();
var dgTable = Packet(FieldVar(1, 100), FieldVar(2, 7), FieldVar(18, 1), FieldVar(16, 0), FieldBytes(10, Encoding.UTF8.GetBytes("1#5")));
var lobby739 = Packet(FieldVar(1, 100), FieldVar(2, 739));
var dgInitial = dgDecoder.Accept(Packet(FieldVar(1, 207), FieldBytes(17, dgTable), FieldBytes(16, lobby739)));
Check(dgInitial.Count == 1 && (ulong)dgInitial[0]["onlineCount"] == 739 && (string)dgInitial[0]["shoeId"] == "7", "DG same-packet lobby count 739 must be merged before one complete table is published");
Check(((List<string>)dgInitial[0]["roads"]).Single() == "1#5", "DG lobby occupancy must preserve table roads");
var dgOldTableCount = dgDecoder.Accept(Packet(FieldBytes(17, Packet(FieldVar(1, 100), FieldVar(16, 0)))));
Check(dgOldTableCount.Count == 1 && (ulong)dgOldTableCount[0]["onlineCount"] == 739, "DG later Table zero must not overwrite authoritative lobby occupancy");
var dgUnknownPush = dgDecoder.Accept(Packet(FieldVar(1, 207), FieldBytes(16, Packet(FieldVar(1, 999), FieldVar(2, 50)))));
Check(dgUnknownPush.Count == 0, "DG lobby count for an unknown table must not emit a partial table");
var dgLateTable = dgDecoder.Accept(Packet(FieldBytes(17, Packet(FieldVar(1, 999), FieldVar(18, 1)))));
Check(dgLateTable.Count == 1 && (ulong)dgLateTable[0]["onlineCount"] == 50, "DG lobby count arriving before table details must be applied when the table appears");
Check(dgDecoder.LastPacketHadLobbyCount, "DG collector must recognize a cached lobby count when its table arrives");
var dgPartialPush = dgDecoder.Accept(Packet(FieldVar(1, 207), FieldBytes(16, Packet(FieldVar(1, 100)))));
Check(dgPartialPush.Count == 0, "DG lobby push without count must leave existing count unchanged");
var dgZero = dgDecoder.Accept(Packet(FieldVar(1, 207), FieldBytes(16, Packet(FieldVar(1, 100), FieldVar(2, 0)))));
Check(dgZero.Count == 1 && (ulong)dgZero[0]["onlineCount"] == 0 && (string)dgZero[0]["shoeId"] == "7", "DG explicit lobby zero must update the full table state");
var dgAfterZero = dgDecoder.Accept(Packet(FieldBytes(17, Packet(FieldVar(1, 100), FieldVar(16, 739)))));
Check(dgAfterZero.Count == 1 && (ulong)dgAfterZero[0]["onlineCount"] == 0, "DG later Table count must not revert explicit lobby zero");

using (var mtFull = JsonDocument.Parse("""
{"action":{"name":"/api/v1/gametype/*/game/*/room/*/tables"},"body":{"tables":[{"table_id":"B01","table_name":"百家樂 B01","table_type":"BAC","totalplayers":417,"trend":{"current_shoe":7,"current_round":42,"total_round_banker":18,"total_round_player":24,"bead_plate2":"011202"}},{"table_id":"B02","table_name":"百家樂 B02","table_type":"BAC","trend":{"bead_plate2":"022101"}}]}}
"""))
{
    var rows = CollectorDesktop.MtTableNormalizer.Extract(mtFull.RootElement);
    Check(CollectorDesktop.MtTableNormalizer.IsTableSnapshot(mtFull.RootElement), "MT must recognize the authoritative lobby response");
    Check(rows.Count == 2 && (string)rows[0]["beadPlate"]! == "011202", "MT full lobby must retain both tables and the road");
    Check((string)rows[0]["players"]! == "417", "MT numeric fields must normalize to viewer text");
}
using (var mtWait = JsonDocument.Parse("""
{"action":{"name":"/api/v1/gametype/3/game/1/room/1/wait"},"body":{"table_id":"B01","game_sn":"42","count":19}}
"""))
{
    var update = CollectorDesktop.MtTableNormalizer.Extract(mtWait.RootElement).Single();
    Check((string)update["countdownSource"]! == "wait" && (long)update["countdownValue"]! == 19, "MT /wait event must supply live countdown");
    Check(update.ContainsKey("tablePhase") && update["tablePhase"] is null, "MT active betting clears the dealing overlay");
    Check(!update.ContainsKey("beadPlate"), "MT partial /wait update must not blank the full road");
}
using (var mtDealing = JsonDocument.Parse("""
{"action":{"name":"/api/v1/gametype/3/game/1/room/1/wait"},"body":{"table_id":"B01","game_sn":"42","count":0}}
"""))
{
    var update = CollectorDesktop.MtTableNormalizer.Extract(mtDealing.RootElement).Single();
    Check((string)update["tablePhase"]! == "dealing", "MT explicit /wait count=0 starts the opening overlay");
}
using (var mtReveal = JsonDocument.Parse("""
{"action":{"name":"/api/v1/gametype/3/game/1/room/1/show_poker"},"body":{"table_id":"B01"}}
"""))
{
    var update = CollectorDesktop.MtTableNormalizer.Extract(mtReveal.RootElement).Single();
    Check((string)update["tablePhase"]! == "dealing", "MT /show_poker keeps the opening overlay");
}
using (var mtResult = JsonDocument.Parse("""
{"action":{"name":"/api/v1/gametype/3/game/1/room/1/result"},"body":{"table_id":"B01"}}
"""))
{
    var update = CollectorDesktop.MtTableNormalizer.Extract(mtResult.RootElement).Single();
    Check(update.ContainsKey("tablePhase") && update["tablePhase"] is null, "MT result clears the opening overlay");
}
var dgRoads = CollectorDesktop.DgRoadNormalizer.Normalize(new Dictionary<string, object> {
    ["roads"] = new List<string> { "4#5", "3#9", "2#1", "1#2" },
});
Check((string)dgRoads["beadPlate"]! == "02020301", "DG bead road must retain historical results");
Check((string)dgRoads["banker"]! == "2" && (string)dgRoads["player"]! == "1" && (string)dgRoads["tie"]! == "1", "DG totals must be derived from roads");
Check((string)dgRoads["bigRoad"]! == "0?02,1?02,,,,#0?01,,,,,", "DG big road must match viewer format");
var dgLongStreak = CollectorDesktop.DgRoadNormalizer.Normalize(new Dictionary<string, object> {
    ["roads"] = Enumerable.Range(0, 8).Select(index => $"{8 - index}#1").ToList(),
});
var dgLongColumns = ((string)dgLongStreak["bigRoad"]!).Split('#');
Check(dgLongColumns.Length == 3 && dgLongColumns[1].Split(',')[5] == "0?02" && dgLongColumns[2].Split(',')[5] == "0?02", "DG long streak must turn at the bottom row");
var dgInvalid = CollectorDesktop.DgRoadNormalizer.Normalize(new Dictionary<string, object> {
    ["roads"] = new List<string> { "invalid", "1#99" }.Concat(Enumerable.Range(0, 50).Select(index => $"{index}#5")).ToList(),
});
Check(((string)dgInvalid["beadPlate"]!).Split('#').Length == 6 && (string)dgInvalid["player"]! == "50", "DG formatter must limit the bead window and ignore invalid results");
var dgDealingCard = CollectorDesktop.DgCardMapper.ToCard(new Dictionary<string, object> {
    ["tableId"] = "RB01", ["tableName"] = "百家樂 RB01", ["state"] = 2,
    ["countDown"] = 18, ["roads"] = new List<string> { "1#1" },
}, "https://new-dd-cn.dingdangmail.com/ddnewpc/index.html?token=test");
Check(!dgDealingCard.ContainsKey("tableState"), "DG state=2 must not trigger the MT-specific shuffle overlay");
Check((string)dgDealingCard["tablePhase"]! == "dealing", "DG state=2 must expose the verified dealing phase");
Check((long)dgDealingCard["countdownValue"]! == 18 && (string)dgDealingCard["beadPlate"]! == "02", "DG dealing must preserve live countdown and roads");
var dgCountdownOrigin = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() - 14_000;
var dgCountdownCard = CollectorDesktop.DgCardMapper.ToCard(new() {
    ["tableId"] = "RB01", ["countDown"] = 19, ["receivedAt"] = dgCountdownOrigin,
}, "https://example.com/");
Check((long)dgCountdownCard["countdownReceivedAt"]! == dgCountdownOrigin &&
      (long)dgCountdownCard["countdownDeadline"]! == dgCountdownOrigin + 19 * 950,
    "DG cached countdown must retain its origin and the official 950ms tick on later updates");
var countdownDecoder = new DgTableDecoder();
var countdownInitial = countdownDecoder.Accept(Packet(FieldBytes(17, Packet(
    FieldVar(1, 801), FieldVar(18, 1), FieldVar(4, 1), FieldVar(5, 19))))).Single();
var countdownStamp = (long)countdownInitial["receivedAt"];
var countdownOccupancy = countdownDecoder.Accept(Packet(FieldVar(1, 207), FieldBytes(16,
    Packet(FieldVar(1, 801), FieldVar(2, 413))))).Single();
Check((long)countdownOccupancy["receivedAt"] == countdownStamp &&
      (ulong)countdownOccupancy["onlineCount"] == 413,
    "DG online-count updates must not refresh the cached countdown timestamp");
foreach (var state in new[] { 3, 4 })
    Check((string)CollectorDesktop.DgCardMapper.ToCard(new() { ["tableId"] = "RB01", ["state"] = state }, "https://example.com/")["tablePhase"]! == "dealing", "DG revoke and insurance must retain the dealing phase");
Check((string)CollectorDesktop.DgCardMapper.ToCard(new() { ["tableId"] = "RB01", ["state"] = 8 }, "https://example.com/")["tablePhase"]! == "shuffling", "DG official state 8 must expose shuffling");
Check(CollectorDesktop.DgCardMapper.ToCard(new() { ["tableId"] = "RB01", ["state"] = 5 }, "https://example.com/")["tablePhase"] is null, "DG settlement must end dealing");
var dgNextState = CollectorDesktop.DgCardMapper.ToCard(new Dictionary<string, object> { ["tableId"] = "RB01", ["state"] = 1 }, "https://example.com/");
var dgPartial = CollectorDesktop.DgCardMapper.ToCard(new Dictionary<string, object> { ["tableId"] = "RB01", ["countDown"] = 5 }, "https://example.com/");
var dgMerged = new Dictionary<string, object?>(dgDealingCard);
foreach (var field in dgPartial) dgMerged[field.Key] = field.Value;
Check((string)dgMerged["tablePhase"]! == "dealing", "DG partial update without state must preserve the current phase on merge");
foreach (var field in dgNextState) dgMerged[field.Key] = field.Value;
Check(dgMerged.ContainsKey("tablePhase") && dgMerged["tablePhase"] is null, "DG explicit state change must clear stale dealing phase on merge");
using var mediaConfig = JsonDocument.Parse("""
{"urls":[{"type":"dealer","url":"${gcDomain}/dealer/"}],"videoUrls":[{"index":4,"url":"https://v-tx.pinpfz.com/live/"}],"videos":[{"id":"B201","name":"example.flv"},{"id":"B202","name":"../bad.flv"}]}
""");
var media = AbMediaCatalog.Parse(mediaConfig.RootElement,"https://www.axgglm.net");
Check(media.Photo("../secret") == "" && media.Video("B202") == "", "Media rejects path traversal");
var ab = new AbTableDecoder(media);
var abTables = ab.Accept(Encoding.UTF8.GetBytes("""
{"c":"getGameHall","p":{"D":[{"AA":10,"BB":"B201","CC":739,"DD":101,"II":"Dealer_123","HH":{"BB":2,"DD":100},"WW3":[["186060100000"]]},{"AA":20,"BB":"D201","DD":301,"WW3":[["1"]]}]}}
"""));
Check(abTables.Count == 1 && (string)abTables[0]["tableId"] == "10", "AB must exclude other games");
Check((string)abTables[0]["dealerPhoto"] == "https://www.axgglm.net/dealer/Dealer_123.jpg", "AB dealer photo keeps full filename");
Check((string)abTables[0]["videoUrl"] == "https://v-tx.pinpfz.com/live/example.flv", "AB video matches table name");
Check((int)abTables[0]["enterCount"] == 739 && !abTables[0].ContainsKey("onlineCount"), "AB CC is enterCount, not a verified live player count");
var abCard = CollectorDesktop.AbCardMapper.ToCard(abTables[0]);
Check((string)abCard["players"]! == "—", "AB must not label enterCount as online players");
Check((string)abCard["id"]! == "AB:10" && (string)abCard["beadPlate"]! == "02", "AB card must use the viewer's platform id and chronological road");
Check((string)abCard["bigRoad"]! == "0802,,,,,", "AB big road must preserve official result point digits");
Check((string)abCard["dealer"]! == "Dealer" && (string)abCard["dealerPhoto"]! == "https://www.axgglm.net/dealer/Dealer_123.jpg", "AB card must preserve dealer media without leaking the official token");
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
var abShuffleCard = CollectorDesktop.AbCardMapper.ToCard(abReset[0]);
Check((string)abShuffleCard["tableState"]! == "2" && abShuffleCard["tablePhase"] is null, "Only verified AB shuffle state 102 maps to viewer shuffle");
var abFinished = ab.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":10,"BB":1,"DD":101}]}}"""));
var abFinishedWithCountdown = new Dictionary<string, object>(abFinished[0]) { ["countDown"] = 18, ["receivedAt"] = 1000L };
var abFinishedCard = CollectorDesktop.AbCardMapper.ToCard(abFinishedWithCountdown);
Check(!abFinishedCard.ContainsKey("tableState") && abFinishedCard["tablePhase"] is null && (long)abFinishedCard["countdownDeadline"]! == 19000L,
    "AB state 101 must end opening with no overlay or shuffle");
var abReady = ab.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":10,"BB":1,"DD":100}]}}"""));
var abReadyCard = CollectorDesktop.AbCardMapper.ToCard(abReady[0]);
Check(!abReadyCard.ContainsKey("tableState") && abReadyCard["tablePhase"] is null, "AB state 100 must clear dealing with no overlay");
var abOpening = new AbTableDecoder(media);
var openingInitial = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"getGameHall","p":{"D":[{"AA":30,"BB":"B301","DD":101,"HH":{"BB":1,"DD":100,"EE":0}}]}}""")).Single();
Check(openingInitial["openingStarted"] is false, "AB initial lobby countdown zero must not start opening");
var zeroWithoutBet = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"getCountDown","p":{"C":[{"AA":30,"DD":0}]}}""")).Single();
Check(zeroWithoutBet["openingStarted"] is false, "AB live zero without a positive countdown must not start opening");
var positiveBet = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"getCountDown","p":{"C":[{"AA":30,"DD":5}]}}""")).Single();
Check(positiveBet["openingStarted"] is false, "AB positive betting countdown must leave opening off");
var firstZero = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"getCountDown","p":{"C":[{"AA":30,"DD":0}]}}""")).Single();
Check(firstZero["openingStarted"] is true &&
      (string)CollectorDesktop.AbCardMapper.ToCard(firstZero)["tablePhase"]! == "dealing",
    "AB official countdown zero after betting must start opening before state 101");
Check(abOpening.AdvanceTime((long)firstZero["receivedAt"] + 60_000).Count == 0,
    "AB official zero consumes the pending deadline without a duplicate opening update");
var resultBeforeStatus = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameTableResults","p":{"A":30,"C":1,"G":[["186060100000"]]}}""")).Single();
Check(resultBeforeStatus["openingStarted"] is true &&
      (string)CollectorDesktop.AbCardMapper.ToCard(resultBeforeStatus)["tablePhase"]! == "dealing",
    "AB roadmap result must not end opening before official status 101");
var delayedBetCountdown = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"getCountDown","p":{"C":[{"AA":30,"DD":3}]}}""")).Single();
Check(delayedBetCountdown["openingStarted"] is true,
    "AB delayed positive countdown must not hide opening before status 101");
var openingFinished = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":30,"BB":1,"DD":101}]}}""")).Single();
Check(openingFinished["openingStarted"] is true &&
      (string)CollectorDesktop.AbCardMapper.ToCard(openingFinished)["tablePhase"]! == "dealing",
    "AB state 101 must keep opening visible until the next countdown");
abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":30,"BB":1,"DD":100,"EE":4}]}}"""));
var lateZero = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"getCountDown","p":{"C":[{"AA":30,"DD":0}]}}""")).Single();
Check(lateZero["openingStarted"] is true && abOpening.AdvanceTime((long)lateZero["receivedAt"] + 60_000).Count == 0,
    "AB late countdown zero after state 101 must not change the same round's overlay");
var settled = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameTableResults","p":{"A":30,"C":1,"G":[["186060100000"]]}}""")).Single();
Check(settled["openingStarted"] is true,
    "AB result must keep opening until the next countdown");
var sameRound = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":30,"BB":1,"DD":100,"EE":4}]}}""")).Single();
abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"getCountDown","p":{"C":[{"AA":30,"DD":0}]}}"""));
Check(sameRound["openingStarted"] is true &&
      abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":30,"BB":1,"DD":101}]}}""")).Single()["openingStarted"] is true,
    "AB stale countdown and status for the same round must not dismiss the overlay");
var nextRoundStatus = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":30,"BB":2,"DD":100}]}}""")).Single();
Check(nextRoundStatus["openingStarted"] is true,
    "AB next round status without a countdown must keep the overlay");
var nextRound = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"getCountDown","p":{"C":[{"AA":30,"DD":4}]}}""")).Single();
Check(nextRound["openingStarted"] is false, "AB next positive countdown clears the previous opening");
var nextZero = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":30,"BB":2,"DD":100,"EE":0}]}}""")).Single();
Check(nextZero["openingStarted"] is true, "AB pushGameStatus official zero also starts opening");
var shuffled = abOpening.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":30,"BB":2,"DD":102}]}}""")).Single();
Check(shuffled["openingStarted"] is false &&
      (string)CollectorDesktop.AbCardMapper.ToCard(shuffled)["tableState"]! == "2",
    "AB shuffle clears opening and retains its shuffle overlay");
var abTimer = new AbTableDecoder(media);
var timerInitial = abTimer.Accept(Encoding.UTF8.GetBytes("""{"c":"getGameHall","p":{"D":[{"AA":31,"BB":"B302","DD":101,"HH":{"BB":1,"DD":100,"EE":0}}]}}""")).Single();
Check(abTimer.AdvanceTime((long)timerInitial["receivedAt"] + 60_000).Count == 0,
    "AB initial zero must not start opening when time advances");
var timerPositive = abTimer.Accept(Encoding.UTF8.GetBytes("""{"c":"getCountDown","p":{"C":[{"AA":31,"DD":2}]}}""")).Single();
var timerDeadline = (long)timerPositive["receivedAt"] + 2_000;
Check(abTimer.AdvanceTime(timerDeadline - 1).Count == 0,
    "AB positive countdown must remain betting before its deadline");
var timerOpened = abTimer.AdvanceTime(timerDeadline).Single();
Check(timerOpened["openingStarted"] is true &&
      (string)CollectorDesktop.AbCardMapper.ToCard(timerOpened)["tablePhase"]! == "dealing" &&
      (int)timerOpened["countDown"] == 0,
    "AB witnessed positive countdown must start opening at deadline without a zero packet");
Check(abTimer.AdvanceTime(timerDeadline + 1).Count == 0,
    "AB elapsed deadline must emit the opening update only once");
var timerRoadmap = abTimer.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameTableResults","p":{"A":31,"C":1,"G":[["186060100000"]]}}""")).Single();
Check(timerRoadmap["openingStarted"] is true,
    "AB timed opening must remain visible through roadmap result until status 101");
var timerFinished = abTimer.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":31,"BB":1,"DD":101}]}}""")).Single();
Check(timerFinished["openingStarted"] is true && abTimer.AdvanceTime(timerDeadline + 60_000).Count == 0,
    "AB state 101 must retain timed opening until the next countdown");
var timerSettled = abTimer.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameTableResults","p":{"A":31,"C":1,"G":[["186060100000"]]}}""")).Single();
Check(timerSettled["openingStarted"] is true && abTimer.AdvanceTime(timerDeadline + 60_000).Count == 0,
    "AB settlement must keep timed opening until the next countdown");
var abCancelledTimer = new AbTableDecoder(media);
var cancelInitial = abCancelledTimer.Accept(Encoding.UTF8.GetBytes("""{"c":"getGameHall","p":{"D":[{"AA":32,"BB":"B303","DD":101,"HH":{"BB":1,"DD":100,"EE":2}}]}}""")).Single();
var cancelledDeadline = (long)cancelInitial["receivedAt"] + 2_000;
abCancelledTimer.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":32,"BB":2,"DD":100}]}}"""));
Check(abCancelledTimer.AdvanceTime(cancelledDeadline + 1).Count == 0,
    "AB round change must discard the previous round's positive deadline");
var nextTimer = abCancelledTimer.Accept(Encoding.UTF8.GetBytes("""{"c":"getCountDown","p":{"C":[{"AA":32,"DD":2}]}}""")).Single();
var nextTimerDeadline = (long)nextTimer["receivedAt"] + 2_000;
abCancelledTimer.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":32,"BB":2,"DD":102}]}}"""));
Check(abCancelledTimer.AdvanceTime(nextTimerDeadline + 1).Count == 0,
    "AB shuffle must discard the current round's positive deadline");
var abEarlyResult = new AbTableDecoder(media);
var earlyPositive = abEarlyResult.Accept(Encoding.UTF8.GetBytes("""{"c":"getGameHall","p":{"D":[{"AA":33,"BB":"B304","DD":101,"HH":{"BB":1,"DD":100,"EE":2}}]}}""")).Single();
var earlyDeadline = (long)earlyPositive["receivedAt"] + 2_000;
var earlySettled = abEarlyResult.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameTableResults","p":{"A":33,"C":1,"G":[["186060100000"]]}}""")).Single();
Check(earlySettled["openingStarted"] is false &&
      abEarlyResult.AdvanceTime(earlyDeadline + 1).Single()["openingStarted"] is true,
    "AB roadmap result received before deadline must not cancel timed opening without status 101");
var abEarlyFinished = new AbTableDecoder(media);
var earlyStatusPositive = abEarlyFinished.Accept(Encoding.UTF8.GetBytes("""{"c":"getGameHall","p":{"D":[{"AA":34,"BB":"B305","DD":101,"HH":{"BB":1,"DD":100,"EE":2}}]}}""")).Single();
var earlyStatusDeadline = (long)earlyStatusPositive["receivedAt"] + 2_000;
var earlyStatusFinished = abEarlyFinished.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":34,"BB":1,"DD":101}]}}""")).Single();
Check(earlyStatusFinished["openingStarted"] is false && abEarlyFinished.AdvanceTime(earlyStatusDeadline + 1).Count == 0,
    "AB state 101 before a countdown deadline must cancel timed opening");
abEarlyFinished.Accept(Encoding.UTF8.GetBytes("""{"c":"pushGameStatus","p":{"A":[{"AA":34,"BB":1,"DD":100,"EE":2}]}}"""));
var earlyStatusLateZero = abEarlyFinished.Accept(Encoding.UTF8.GetBytes("""{"c":"getCountDown","p":{"C":[{"AA":34,"DD":0}]}}""")).Single();
Check(earlyStatusLateZero["openingStarted"] is false,
    "AB state 101 must keep a late positive and zero from reopening its round");
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

// A source-protocol burst is decoded in full before CollectorDesktop
// coalesces its full-state Render writes.  Verify that only the newest state
// becomes visible, a heartbeat can refresh that same state, and a failed post
// is retried rather than discarded.
var publishedSnapshots = new List<int>();
var firstSnapshot = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
var secondSnapshot = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
await using (var publisher = new CollectorDesktop.LatestSnapshotPublisher<int>(
    (snapshot, _) =>
    {
        lock (publishedSnapshots) publishedSnapshots.Add(snapshot);
        (publishedSnapshots.Count == 1 ? firstSnapshot : secondSnapshot).TrySetResult();
        return Task.CompletedTask;
    },
    _ => throw new Exception("A successful test publish must not fail"),
    TimeSpan.FromMilliseconds(70), TimeSpan.FromMilliseconds(20)))
{
    publisher.Submit(1);
    await Task.Delay(15);
    publisher.Submit(2);
    await Task.Delay(15);
    publisher.Submit(3);
    await firstSnapshot.Task.WaitAsync(TimeSpan.FromSeconds(2));
    lock (publishedSnapshots)
        Check(publishedSnapshots.SequenceEqual(new[] { 3 }), "Snapshot coalescing must not publish a partial burst after the newest full state");
    publisher.Pulse();
    await secondSnapshot.Task.WaitAsync(TimeSpan.FromSeconds(2));
    lock (publishedSnapshots)
        Check(publishedSnapshots.SequenceEqual(new[] { 3, 3 }), "Heartbeat must republish the newest full state without changing it");
}

var retryAttempts = 0;
var retryAccepted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
await using (var publisher = new CollectorDesktop.LatestSnapshotPublisher<int>(
    (_, _) =>
    {
        if (Interlocked.Increment(ref retryAttempts) == 1) throw new HttpRequestException("simulated transient failure");
        retryAccepted.TrySetResult();
        return Task.CompletedTask;
    },
    _ => { },
    TimeSpan.Zero, TimeSpan.FromMilliseconds(20)))
{
    publisher.Submit(13);
    await retryAccepted.Task.WaitAsync(TimeSpan.FromSeconds(2));
    Check(retryAttempts == 2, "Failed newest snapshot must be retried exactly once before acceptance");
}
Console.WriteLine("PASS: persistent capture, concurrent subscribers, cached snapshot, stale gating, shutdown, login retry protection, failure recovery");
