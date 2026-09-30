using Microsoft.Extensions.Hosting;

namespace AccountAdmin;

public sealed record SimulationChartPoint(DateTimeOffset At, decimal Profit);
public sealed record SimulationTableStat(string Table, string Card, string Betting, string Action, double Score, int Bets, int Wins, int Losses, decimal Profit,
    string? Prediction, decimal Stake, string State);
public sealed record SimulationStatus(int TableCount, int PendingCount, List<SimulationChartPoint> ProfitSeries, List<SimulationTableStat> Tables);

// The simulation belongs to the C# service, not to any logged-in browser.
// It consumes collector snapshots and never sends a real wagering request.
public sealed class SimulationWorker(AccountStore store, SharedFeedStore feeds, ILogger<SimulationWorker> logger) : BackgroundService {
    sealed class Position {
        public required int Slot { get; init; }
        public required SimChoice Choice { get; set; }
        public required int LastCount { get; set; }
        public SimLedger Ledger { get; } = new();
        public SimLedger StrategyLedger { get; set; } = new();
        public (char Side, decimal Stake, int DecisionCount)? Pending { get; set; }
        public int SelectionBets { get; set; }
        public int ConsecutiveLosses { get; set; }
        public List<bool> RecentResults { get; } = [];
        public int SwitchAfterBet { get; set; }
        public double SelectedScore { get; set; }
        public char? Prediction { get; set; }
        public decimal DisplayStake { get; set; } = 1;
        public string State { get; set; } = "等待牌桌資料";
    }
    readonly object gate = new();
    Guid activeSession;
    SimulationSummary? daily;
    List<Position> positions = [];
    List<SimChoice> candidates = [];
    DateTimeOffset lastRanked;
    List<SimulationChartPoint> profitSeries = [];

    public SimulationStatus Snapshot() {
        lock (gate) return new(positions.Count, positions.Count(position => position.Pending is not null), profitSeries.ToList(),
            positions.Select(position => new SimulationTableStat(SimulationModel.TableLabel(position.Choice.Table), SimulationModel.CardLabels[position.Choice.Card],
                SimulationModel.BettingLabels[position.Choice.Betting], SimulationModel.ActionLabels[position.Choice.Action], position.SelectedScore,
                position.StrategyLedger.Bets, position.StrategyLedger.Wins, position.StrategyLedger.Losses, position.StrategyLedger.Profit * 100,
                position.Prediction is char side ? SimulationModel.SideLabel(side) : null, position.DisplayStake, position.State)).ToList());
    }

    public SimulationControl StopFromAdmin() {
        lock (gate) {
            var stopped = store.StopSimulation();
            activeSession = Guid.Empty;
            positions.Clear();
            candidates.Clear();
            return stopped;
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken) {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(3));
        while (!stoppingToken.IsCancellationRequested) {
            try { Tick(); }
            catch (Exception error) { logger.LogError(error, "Simulation worker tick failed"); }
            try { if (!await timer.WaitForNextTickAsync(stoppingToken)) break; }
            catch (OperationCanceledException) { break; }
        }
    }
    static string Day() => DateTimeOffset.UtcNow.AddHours(8).ToString("yyyy-MM-dd");
    static SimulationSummary EmptySummary(Guid sessionId) => new(sessionId, Day(), DateTimeOffset.UtcNow, 0, 0, 0, 0, 0, 0, 0, "");
    static string SignedUnits(decimal value) => (value >= 0 ? "+" : "-") + Math.Abs(value).ToString("N2") + " 注";
    static string ChoiceLabel(SimChoice choice) => $"{SimulationModel.TableLabel(choice.Table)}｜{SimulationModel.CardLabels[choice.Card]}｜{SimulationModel.BettingLabels[choice.Betting]}｜{SimulationModel.ActionLabels[choice.Action]}｜評分 {choice.Score:F1}";
    void Tick() {
        lock (gate) {
            var control = store.GetSimulationControl();
            if (!control.Running || control.SessionId == Guid.Empty) {
                activeSession = Guid.Empty;
                positions.Clear();
                candidates.Clear();
                return;
            }
            if (activeSession != control.SessionId) {
                activeSession = control.SessionId;
                positions = [];
                candidates = [];
                lastRanked = DateTimeOffset.MinValue;
                profitSeries = [];
                daily = control.Summary is { } saved && saved.SessionId == activeSession && saved.Day == Day() ? saved : EmptySummary(activeSession);
            }
            if (daily is null) daily = EmptySummary(activeSession);
            if (daily.Day != Day()) daily = EmptySummary(activeSession);
            var tables = SimulationModel.ReadTables(feeds);
            if (tables.Count == 0) return;
            var now = DateTimeOffset.UtcNow;
            if (candidates.Count == 0 || now - lastRanked >= TimeSpan.FromSeconds(15)) {
                candidates = SimulationModel.Rank(tables);
                lastRanked = now;
            }
            if (positions.Count == 0) {
                positions = candidates.Take(6).Select((choice, index) => new Position {
                    Slot = index + 1, Choice = choice, LastCount = SimulationModel.Decisions(choice.Table, choice.Card).Count, SelectedScore = choice.Score,
                }).ToList();
                if (positions.Count == 0) return;
            }
            var tableMap = tables.ToDictionary(SimulationModel.CanonicalKey);
            var changed = false;
            foreach (var position in positions) {
                if (!tableMap.TryGetValue(SimulationModel.CanonicalKey(position.Choice.Table), out var table)) {
                    position.Prediction = null;
                    position.State = "等待牌桌資料";
                    continue;
                }
                var choice = position.Choice with { Table = table };
                position.Choice = choice;
                var decisions = SimulationModel.Decisions(table, choice.Card);
                if (decisions.Count < position.LastCount) {
                    position.LastCount = decisions.Count;
                    position.Pending = null;
                    position.Prediction = null;
                    position.State = "等待新靴訊號";
                    continue;
                }
                if (decisions.Count > position.LastCount) {
                    var observed = decisions.Count - position.LastCount;
                    daily = daily with { Rounds = daily.Rounds + observed };
                    changed = true;
                    var pending = position.Pending;
                    if (pending is { } bet && bet.DecisionCount == position.LastCount) {
                        var outcome = decisions[position.LastCount].Outcome;
                        if (outcome == '3') {
                            store.AppendSimulationLinesTrusted(activeSession, [("settle-tie", $"[SETTLE {position.Slot}] {SimulationModel.TableLabel(table)}｜押{SimulationModel.SideLabel(bet.Side)} {bet.Stake}單位｜和局退回｜打平 0.00 注｜累計損益 {SignedUnits(position.Ledger.Profit)}")]);
                        } else {
                            var profit = SimulationModel.Settle(choice.Betting, position.StrategyLedger, bet.Side, outcome);
                            position.Ledger.Profit += profit;
                            position.Ledger.TotalStake += bet.Stake;
                            position.Ledger.Bets++;
                            if (profit > 0) position.Ledger.Wins++; else position.Ledger.Losses++;
                            position.SelectionBets++;
                            position.ConsecutiveLosses = profit < 0 ? position.ConsecutiveLosses + 1 : 0;
                            position.RecentResults.Add(profit > 0);
                            if (position.RecentResults.Count > 10) position.RecentResults.RemoveAt(0);
                            daily = daily with { Bets = daily.Bets + 1, Wins = daily.Wins + (profit > 0 ? 1 : 0), Losses = daily.Losses + (profit < 0 ? 1 : 0),
                                TotalStake = daily.TotalStake + bet.Stake * 100, Profit = daily.Profit + profit * 100 };
                            store.AppendSimulationLinesTrusted(activeSession, [(profit > 0 ? "settle-win" : "settle-loss",
                                $"[SETTLE {position.Slot}] {SimulationModel.TableLabel(table)}｜押{SimulationModel.SideLabel(bet.Side)} {bet.Stake}單位｜開獎 {SimulationModel.SideLabel(outcome)}｜{(profit > 0 ? "獲利" : "虧損")} {SignedUnits(profit)}｜累計損益 {SignedUnits(position.Ledger.Profit)}")]);
                            profitSeries.Add(new(now, daily.Profit));
                            if (profitSeries.Count > 200) profitSeries.RemoveAt(0);
                        }
                    }
                    position.LastCount = decisions.Count;
                    position.Pending = null;
                }
                if (position.Pending is null && ShouldSwitch(position)) {
                    var occupied = positions.Select(other => SimulationModel.CanonicalKey(other.Choice.Table)).ToHashSet();
                    var ownKey = SimulationModel.CanonicalKey(position.Choice.Table);
                    var replacement = candidates.FirstOrDefault(candidate => !occupied.Contains(SimulationModel.CanonicalKey(candidate.Table)))
                        ?? candidates.FirstOrDefault(candidate => SimulationModel.CanonicalKey(candidate.Table) == ownKey &&
                            (candidate.Card != position.Choice.Card || candidate.Betting != position.Choice.Betting || candidate.Action != position.Choice.Action));
                    var accuracy = position.RecentResults.Count == 0 ? 100d : position.RecentResults.Count(value => value) * 100d / position.RecentResults.Count;
                    var adjustedScore = position.SelectedScore + (accuracy - 60) * .8 - position.ConsecutiveLosses * 4;
                    if (replacement is not null && replacement.Score >= adjustedScore + 8) {
                        position.Choice = replacement;
                        position.LastCount = SimulationModel.Decisions(replacement.Table, replacement.Card).Count;
                        position.StrategyLedger = new();
                        position.SelectionBets = 0;
                        position.ConsecutiveLosses = 0;
                        position.RecentResults.Clear();
                        position.SwitchAfterBet = position.Ledger.Bets + 3;
                        position.SelectedScore = replacement.Score;
                        daily = daily with { Switches = daily.Switches + 1 };
                        changed = true;
                        table = replacement.Table;
                        choice = replacement;
                        decisions = SimulationModel.Decisions(table, choice.Card);
                    }
                }
                if (position.Pending is { } activeBet) {
                    position.Prediction = activeBet.Side;
                    position.DisplayStake = activeBet.Stake;
                    position.State = "已模擬下單・待結算";
                    continue;
                }
                var (side, agreement) = SimulationModel.CurrentPrediction(table, choice.Card);
                position.Prediction = side;
                position.DisplayStake = SimulationModel.Stake(choice.Betting, position.StrategyLedger);
                if (side is null) {
                    position.State = "等待預測訊號";
                } else if (!SimulationModel.ShouldAct(choice.Action, side, decisions, choice.Card == "ai-consensus", agreement)) {
                    position.State = "等待出手條件";
                } else {
                    position.Pending = (side.Value, position.DisplayStake, decisions.Count);
                    position.State = "已模擬下單・待結算";
                    store.AppendSimulationLinesTrusted(activeSession, [("bet", $"[BET {position.Slot}] {ChoiceLabel(choice)}｜押{SimulationModel.SideLabel(side.Value)}｜下注 {position.DisplayStake}單位｜待結算")]);
                }
            }
            if (changed) store.UpdateSimulationSummary(daily);
        }
    }
    static bool ShouldSwitch(Position position) {
        if (position.SelectionBets < 5 || position.Ledger.Bets < position.SwitchAfterBet) return false;
        var accuracy = position.RecentResults.Count == 0 ? 1 : position.RecentResults.Count(value => value) / (double)position.RecentResults.Count;
        return accuracy < .55 || position.ConsecutiveLosses >= 2;
    }
}
