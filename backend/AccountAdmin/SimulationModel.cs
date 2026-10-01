using System.Text.Json;
using System.Text.RegularExpressions;
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("AccountAdmin.Tests")]

namespace AccountAdmin;

internal sealed record SimTable(string Platform, string Id, string Name, string Bead, string Big);
internal sealed record SimDecision(char? Prediction, char Outcome, int Agreement = 0);
internal sealed record SimChoice(SimTable Table, string Card, string Betting, string Action, double Score);
internal sealed class SimLedger {
    public int Step { get; set; }
    public decimal NextStake { get; set; } = 1;
    public decimal Profit { get; set; }
    public decimal TotalStake { get; set; }
    public int Bets { get; set; }
    public int Wins { get; set; }
    public int Losses { get; set; }
    public SimLedger Copy() => (SimLedger)MemberwiseClone();
}

internal static class SimulationModel {
    public static readonly string[] Cards = ["v", "cross", "points", "weighted", "weighted-consensus", "road-follow", "road-reverse", "road-streak", "road-sequence", "road-markov", "chartgpt", "gemini", "deepseek", "claude", "ai-consensus"];
    public static readonly string[] Betting = ["flat", "1326", "dalembert", "martingale", "reverse-dalembert", "reverse-1326", "reverse-martingale"];
    public static readonly string[] Actions = ["always", "ai-consensus", "confirm", "cooldown", "road"];
    public static readonly Dictionary<string, string> CardLabels = new() {
        ["v"]="V型牌卡", ["cross"]="十字牌卡", ["points"]="勝方點數分布牌卡", ["weighted"]="近局加權牌卡", ["weighted-consensus"]="近局加權共識牌卡",
        ["road-follow"]="跟路策略牌卡", ["road-reverse"]="反路策略牌卡", ["road-streak"]="連莊／連閒策略牌卡", ["road-sequence"]="序列比對牌卡", ["road-markov"]="馬可夫轉移牌卡",
        ["chartgpt"]="ChartGPT", ["gemini"]="Google Gemini", ["deepseek"]="DeepSeek", ["claude"]="Claude", ["ai-consensus"]="AI共識牌卡",
    };
    public static readonly Dictionary<string, string> BettingLabels = new() {
        ["flat"]="固定注碼", ["1326"]="1－3－2－6", ["dalembert"]="達朗貝爾", ["martingale"]="馬丁格爾",
        ["reverse-dalembert"]="反達朗貝爾", ["reverse-1326"]="反1－3－2－6", ["reverse-martingale"]="反馬丁格爾",
    };
    public static readonly Dictionary<string, string> ActionLabels = new() {
        ["always"]="每次出手", ["ai-consensus"]="AI 共識門檻", ["confirm"]="連續確認", ["cooldown"]="連錯冷卻", ["road"]="路勢確認",
    };
    public static string TableLabel(SimTable table) => (table.Platform == "AB" ? "歐博" : table.Platform) + "-" + (table.Platform == "MT" ? Regex.Replace(Regex.Replace(table.Id, "^BAV", "B", RegexOptions.IgnoreCase), "_LIVE$", "-L", RegexOptions.IgnoreCase) : table.Platform == "AB" ? table.Name : table.Id);
    public static string SideLabel(char side) => side == '2' ? "莊" : side == '1' ? "閒" : "和";
    public static string CanonicalKey(SimTable table) => table.Platform + ":" + (table.Platform == "MT" ? Regex.Replace(table.Id, "_LIVE$", "", RegexOptions.IgnoreCase) : table.Id).ToUpperInvariant();

    public static List<SimTable> ReadTables(SharedFeedStore feeds) {
        var tables = new List<SimTable>();
        foreach (var platform in new[] { "MT", "DG", "AB" }) {
            try {
                using var document = JsonDocument.Parse(feeds.Current(platform));
                var root = document.RootElement;
                if (!root.TryGetProperty("tables", out var items) || items.ValueKind != JsonValueKind.Array) continue;
                foreach (var item in items.EnumerateArray()) {
                    var id = ReadString(item, "id");
                    if (string.IsNullOrWhiteSpace(id)) continue;
                    tables.Add(new(platform, id, ReadString(item, "name") is { Length: > 0 } name ? name : id, ReadString(item, "beadPlate"), ReadString(item, "bigRoad")));
                }
            } catch (JsonException) { /* A partial collector snapshot is ignored. */ }
        }
        return tables.GroupBy(CanonicalKey).Select(group => group.OrderByDescending(table => BeadWinners(table.Bead).Count).ThenBy(table => table.Id.EndsWith("_LIVE", StringComparison.OrdinalIgnoreCase) ? 1 : 0).First()).ToList();
    }
    static string ReadString(JsonElement element, string name) => element.TryGetProperty(name, out var value) ? value.ToString() : "";
    public static List<char> BeadWinners(string raw) => Regex.Matches(raw, "0[123]").Select(match => match.Value[1]).ToList();

    static List<(char Side, int Points)> PointResults(string raw) {
        var result = new List<(char, int)>();
        foreach (var code in raw.Split('#').SelectMany(column => column.Split(',')))
            if (Regex.IsMatch(code, @"^\d[0-9]\d[12]$")) result.Add((code[3], code[1] - '0'));
        return result;
    }
    static char? StatisticalSide(double banker, double player, int sample, int minimum, double margin = .2) {
        var total = banker + player;
        return sample < minimum || total <= 0 || Math.Abs(banker - player) / total < margin ? null : banker > player ? '2' : '1';
    }
    static char? Weighted(IReadOnlyList<char> history) {
        double banker = 0, player = 0;
        var sample = 0;
        for (var i = 0; i < history.Count; i++) {
            if (history[i] == '3') continue;
            var weight = Math.Pow(.94, history.Count - 1 - i);
            if (history[i] == '2') banker += weight; else player += weight;
            sample++;
        }
        return StatisticalSide(banker, player, sample, 10);
    }
    static char? WeightedConsensus(IReadOnlyList<char> history) {
        var banker = 0; var player = 0;
        foreach (var size in new[] { 18, 24, 36 }) {
            if (history.Count < size) continue;
            var side = Weighted(history.Skip(Math.Max(0, history.Count - size)).ToList());
            if (side == '2') banker++; else if (side == '1') player++;
        }
        return banker >= 2 ? '2' : player >= 2 ? '1' : null;
    }
    static char? PointSide(IReadOnlyList<(char Side, int Points)> results) {
        double banker = 0, player = 0;
        for (var i = 0; i < results.Count; i++) {
            var weight = Math.Pow(.94, results.Count - 1 - i) * (1 + results[i].Points / 20d);
            if (results[i].Side == '2') banker += weight; else player += weight;
        }
        return StatisticalSide(banker, player, results.Count, 10);
    }
    static char? RoadSide(string mode, IReadOnlyList<char> history) {
        var decisive = history.Where(side => side != '3').ToArray();
        if (decisive.Length == 0) return null;
        var last = decisive[^1];
        if (mode == "road-follow") return last;
        if (mode == "road-reverse") return last == '1' ? '2' : '1';
        if (mode == "road-streak") return decisive.Length >= 3 && decisive[^2] == last && decisive[^3] == last ? last : null;
        for (var order = mode == "road-markov" ? Math.Min(3, decisive.Length - 1) : 3; order >= 1; order--) {
            if (mode == "road-sequence" && order != 3) break;
            var banker = 0; var player = 0;
            for (var i = order; i < decisive.Length; i++) {
                if (!decisive.Skip(i - order).Take(order).SequenceEqual(decisive.Skip(decisive.Length - order))) continue;
                if (decisive[i] == '2') banker++; else player++;
            }
            var sample = banker + player;
            if (mode == "road-sequence") return StatisticalSide(banker, player, sample, 5, .15);
            if (sample < 10) continue;
            var probability = (banker + 1d) / (sample + 2d);
            return probability >= .58 ? '2' : probability <= .42 ? '1' : null;
        }
        return null;
    }
    public static char? Predict(string card, SimTable table, IReadOnlyList<char> history, int historicalRound = -1) {
        if (card is "v" or "cross") return Graphical(history, card == "v");
        if (card == "points") {
            var points = PointResults(table.Big);
            if (historicalRound >= 0) points = points.Take(history.Count(side => side != '3')).ToList();
            return PointSide(points.TakeLast(36).ToList());
        }
        if (card == "weighted") return Weighted(history.TakeLast(36).ToList());
        if (card == "weighted-consensus") return WeightedConsensus(history.TakeLast(36).ToList());
        if (card.StartsWith("road-")) return RoadSide(card, history);
        return null;
    }

    static char? LocalAiSignal(string raw, string source) {
        var offset = source switch { "chartgpt" => 17u, "gemini" => 31u, "deepseek" => 47u, _ => 61u };
        uint seed = unchecked(offset * 2654435761u);
        for (var i = 0; i < raw.Length; i++) seed = unchecked((seed ^ raw[i]) * 16777619u + (uint)i);
        seed = unchecked(seed + offset * 1013904223u);
        seed = unchecked(seed * 1664525u + 1013904223u);
        if (seed % 9 == 0) return null;
        return ((seed >> 28) & 1) == 0 ? '1' : '2';
    }
    static string CanonicalAiRoad(string raw) {
        var columns = BigColumns(raw);
        if (!columns.Any(column => column.Any(code => Regex.IsMatch(code, @"^\d[\d?]\d[1-3]$")))) return raw;
        return string.Join('#', columns.Select(column => {
            var last = Array.FindLastIndex(column, code => Regex.IsMatch(code, @"^\d[\d?]\d[1-3]$"));
            return last < 0 ? "" : string.Join(',', column.Take(last + 1)
                .Select(code => Regex.IsMatch(code, @"^\d[\d?]\d[1-3]$") ? "0" + code[1..] : ""));
        }).Where(column => column.Length > 0));
    }
    static (char? Side, int Agreement) AiPrediction(string raw, string card) {
        var sources = card == "ai-consensus" ? new[] { "chartgpt", "gemini", "deepseek", "claude" } : new[] { card };
        if (string.IsNullOrEmpty(raw)) return (null, 0);
        var canonical = CanonicalAiRoad(raw);
        var votes = sources.Select(source => LocalAiSignal(canonical, source)).ToArray();
        var banker = votes.Count(side => side == '2'); var player = votes.Count(side => side == '1');
        var active = banker + player; var required = active / 2 + 1;
        var side = banker >= required ? '2' : player >= required ? '1' : (char?)null;
        return (side, side == '2' ? banker : side == '1' ? player : 0);
    }
    static List<string[]> BigColumns(string raw) => raw.Split('#').Select(column => column.Contains(',') ? column.Split(',') : Enumerable.Range(0, column.Length / 4).Select(index => column.Substring(index * 4, 4)).ToArray()).Where(column => column.Length > 0).ToList();
    public static List<SimDecision> Decisions(SimTable table, string card) {
        if (card is "chartgpt" or "gemini" or "deepseek" or "claude" or "ai-consensus") {
            var columns = BigColumns(table.Big);
            var result = new List<SimDecision>();
            for (var columnIndex = 0; columnIndex < columns.Count; columnIndex++)
                for (var rowIndex = 0; rowIndex < columns[columnIndex].Length; rowIndex++) {
                    var code = columns[columnIndex][rowIndex];
                    if (!Regex.IsMatch(code, @"^\d[\d?]\d[1-3]$")) continue;
                    var prefix = string.Join('#', columns.Take(columnIndex + 1).Select((column, index) => string.Join(',', column.Take(index == columnIndex ? rowIndex : column.Length))).Where(value => value.Length > 0));
                    var (side, agreement) = AiPrediction(prefix, card);
                    result.Add(new(side, code[^1], agreement));
                }
            return result;
        }
        var outcomes = BeadWinners(table.Bead);
        var decisions = new List<SimDecision>(outcomes.Count);
        for (var i = 0; i < outcomes.Count; i++) decisions.Add(new(Predict(card, table, outcomes.Take(i).ToList(), i), outcomes[i]));
        return decisions;
    }
    public static (char? Side, int Agreement) CurrentPrediction(SimTable table, string card) =>
        card is "chartgpt" or "gemini" or "deepseek" or "claude" or "ai-consensus"
            ? AiPrediction(table.Big, card) : (Predict(card, table, BeadWinners(table.Bead)), 0);

    static char? Graphical(IReadOnlyList<char> outcomes, bool vMode) {
        var columns = new List<List<char>>();
        for (var i = 0; i < outcomes.Count; i++) {
            if (i % 6 == 0) columns.Add([]);
            columns[^1].Add(outcomes[i]);
        }
        var targetColumn = columns.Count == 0 ? 0 : columns[^1].Count >= 6 ? columns.Count : columns.Count - 1;
        var targetRow = targetColumn == columns.Count ? 0 : columns[targetColumn].Count;
        var sides = new HashSet<char>();
        var orientationCount = vMode ? 4 : 2;
        for (var centerColumn = 2; centerColumn <= columns.Count; centerColumn++)
            for (var centerRow = 0; centerRow < 6; centerRow++)
                for (var orientation = 0; orientation < orientationCount; orientation++) {
                    var points = ShapePoints(centerColumn, centerRow, vMode, orientation).Distinct().ToArray();
                    if (points.Any(point => point.C < 0 || point.R is < 0 or > 5) || !points.Contains((targetColumn, targetRow))) continue;
                    var occupied = points.Where(point => point.C < columns.Count && point.R < columns[point.C].Count).Select(point => columns[point.C][point.R]).ToArray();
                    if (occupied.Length < (vMode ? 2 : 4)) continue;
                    foreach (var side in new[] { '1', '2' }) if (occupied.Contains(side) && occupied.All(value => value == side || value == '3')) sides.Add(side);
                }
        return sides.Count == 1 ? sides.First() : null;
    }
    static IEnumerable<(int C, int R)> ShapePoints(int c, int r, bool vMode, int orientation) {
        if (vMode) return orientation switch {
            0 => [(c - 1, r - 1), (c, r), (c + 1, r - 1)],
            1 => [(c + 1, r - 1), (c, r), (c + 1, r + 1)],
            2 => [(c - 1, r - 1), (c, r), (c - 1, r + 1)],
            _ => [(c - 1, r + 1), (c, r), (c + 1, r + 1)],
        };
        return orientation == 0
            ? [(c, r - 1), (c, r), (c, r + 1), (c - 1, r), (c + 1, r)]
            : [(c - 1, r - 1), (c, r), (c + 1, r + 1), (c + 1, r - 1), (c - 1, r + 1)];
    }

    public static bool ShouldAct(string action, char? side, IReadOnlyList<SimDecision> history, bool aiConsensus, int agreement) {
        if (side is null) return false;
        if (action == "always") return true;
        if (action == "ai-consensus") return aiConsensus && agreement >= 3;
        if (action == "confirm") {
            var previous = history.LastOrDefault(item => item.Prediction is not null);
            return previous?.Prediction == side;
        }
        if (action == "road") {
            var previous = history.LastOrDefault(item => item.Outcome != '3');
            return previous?.Outcome == side;
        }
        var misses = 0; var remaining = 0;
        foreach (var item in history) {
            if (remaining > 0) { remaining--; continue; }
            if (item.Prediction is null || item.Outcome == '3') continue;
            if (item.Prediction == item.Outcome) misses = 0;
            else if (++misses >= 3) { misses = 0; remaining = 5; }
        }
        return remaining == 0;
    }
    public static List<SimDecision> ApplyAction(string action, IReadOnlyList<SimDecision> decisions, bool aiConsensus) {
        var result = new List<SimDecision>(decisions.Count);
        var history = new List<SimDecision>(decisions.Count);
        foreach (var item in decisions) {
            result.Add(item with { Prediction = ShouldAct(action, item.Prediction, history, aiConsensus, item.Agreement) ? item.Prediction : null });
            history.Add(item);
        }
        return result;
    }
    public static decimal Stake(string strategy, SimLedger ledger) => strategy is "1326" or "reverse-1326"
        ? new decimal[] { 1, 3, 2, 6 }[Math.Clamp(ledger.Step, 0, 3)] : strategy == "flat" ? 1 : ledger.NextStake;
    public static decimal Settle(string strategy, SimLedger ledger, char side, char outcome) {
        if (outcome == '3') return 0;
        var stake = Stake(strategy, ledger);
        var won = side == outcome;
        var delta = won ? stake * (side == '2' ? .95m : 1m) : -stake;
        ledger.Profit = decimal.Round(ledger.Profit + delta, 2);
        ledger.TotalStake = decimal.Round(ledger.TotalStake + stake, 2);
        ledger.Bets++;
        if (won) ledger.Wins++; else ledger.Losses++;
        if (strategy == "flat") { ledger.Step = 0; ledger.NextStake = 1; }
        else if (strategy == "1326") { ledger.Step = won ? (ledger.Step + 1) % 4 : 0; ledger.NextStake = new decimal[] { 1, 3, 2, 6 }[ledger.Step]; }
        else if (strategy == "reverse-1326") { ledger.Step = won ? 0 : (ledger.Step + 1) % 4; ledger.NextStake = new decimal[] { 1, 3, 2, 6 }[ledger.Step]; }
        else if (strategy == "dalembert") { ledger.Step = 0; ledger.NextStake = won ? Math.Max(1, stake - 1) : stake + 1; }
        else if (strategy == "martingale") { ledger.Step = 0; ledger.NextStake = won ? 1 : stake * 2; }
        else if (strategy == "reverse-dalembert") { ledger.Step = 0; ledger.NextStake = won ? stake + 1 : Math.Max(1, stake - 1); }
        else if (!won || ledger.Step >= 2) { ledger.Step = 0; ledger.NextStake = 1; }
        else { ledger.Step++; ledger.NextStake = stake * 2; }
        return delta;
    }
    static SimLedger Replay(string strategy, IReadOnlyList<SimDecision> decisions) {
        var ledger = new SimLedger();
        foreach (var item in decisions) if (item.Prediction is char side && item.Outcome != '3') Settle(strategy, ledger, side, item.Outcome);
        return ledger;
    }
    static decimal Drawdown(string strategy, IReadOnlyList<SimDecision> decisions) {
        var ledger = new SimLedger();
        decimal peak = 0, drawdown = 0;
        foreach (var item in decisions) {
            if (item.Prediction is char side && item.Outcome != '3') Settle(strategy, ledger, side, item.Outcome);
            peak = Math.Max(peak, ledger.Profit);
            drawdown = Math.Max(drawdown, peak - ledger.Profit);
        }
        return drawdown;
    }
    static double Score(SimLedger whole, SimLedger recent, SimLedger recent10, decimal drawdown) {
        if (whole.Bets < 20 || recent.Bets < 10 || whole.Profit <= 0) return double.NegativeInfinity;
        var recentAccuracy = (recent.Wins + 5d) / (recent.Bets + 10d);
        var wholeAccuracy = (whole.Wins + 10d) / (whole.Bets + 20d);
        var recentRoi = recent.TotalStake > 0 ? (double)(recent.Profit / recent.TotalStake) : 0;
        var wholeRoi = whole.TotalStake > 0 ? (double)(whole.Profit / whole.TotalStake) : 0;
        var trend = recent10.Bets >= 5 ? (recent10.Wins + 3d) / (recent10.Bets + 6d) : .5;
        return Math.Round((recentAccuracy * 35 + wholeAccuracy * 20 + trend * 10 +
            Math.Clamp(recentRoi, -.5, .5) * 30 + Math.Clamp(wholeRoi, -.5, .5) * 15 -
            Math.Min((double)drawdown, 20) * 1.5) * 10) / 10;
    }
    public static List<SimChoice> Rank(IEnumerable<SimTable> tables) {
        var choices = new List<SimChoice>();
        foreach (var table in tables) {
            SimChoice? best = null;
            foreach (var card in Cards) {
                var raw = Decisions(table, card);
                foreach (var action in Actions) {
                    var filtered = ApplyAction(action, raw, card == "ai-consensus");
                    var effective = filtered.Where(item => item.Prediction is not null && item.Outcome != '3').ToList();
                    foreach (var betting in Betting) {
                        var whole = Replay(betting, filtered);
                        if (whole.Bets < 20 || whole.Profit <= 0) continue;
                        var recent = Replay(betting, effective.TakeLast(20).ToList());
                        if (recent.Bets < 10) continue;
                        var recent10 = Replay(betting, effective.TakeLast(10).ToList());
                        var score = Score(whole, recent, recent10, Drawdown(betting, filtered));
                        if (best is null || score > best.Score) best = new(table, card, betting, action, score);
                    }
                }
            }
            if (best is not null) choices.Add(best);
        }
        return choices.OrderByDescending(choice => choice.Score).ToList();
    }
}
