import type { PredictionDecision } from '@/lib/prediction-performance';

export type ActionStrategy = 'always' | 'ai-consensus' | 'confirm' | 'cooldown' | 'road';
type ActionCondition = Exclude<ActionStrategy, 'always'>;
export type ActionConfig = { aiVotes: number; confirmRounds: number; missLimit: number; cooldownRounds: number; roadMode: 'follow' | 'reverse' };
export const defaultActionConfig: ActionConfig = { aiVotes: 3, confirmRounds: 2, missLimit: 3, cooldownRounds: 5, roadMode: 'follow' };
export const actionStrategyLabels: Record<ActionStrategy, string> = {
  always: '每次出手', 'ai-consensus': 'AI 共識門檻', confirm: '連續確認', cooldown: '連錯冷卻', road: '路勢確認',
};
function cooldownRemaining(history: readonly PredictionDecision[], config: ActionConfig) {
  let misses = 0, remaining = 0;
  for (const item of history) {
    if (remaining > 0) { remaining -= 1; continue; }
    if (!item.prediction || item.outcome === '3') continue;
    if (item.prediction === item.outcome) misses = 0;
    else if (++misses >= config.missLimit) { misses = 0; remaining = config.cooldownRounds; }
  }
  return remaining;
}
function condition(name: ActionCondition, prediction: '1' | '2', history: readonly PredictionDecision[], config: ActionConfig, isAiConsensus: boolean, agreement?: number) {
  if (name === 'ai-consensus') return isAiConsensus && (agreement ?? 0) >= config.aiVotes;
  if (name === 'confirm') {
    const recent = history.filter(item => item.prediction).slice(-(config.confirmRounds - 1));
    return recent.length === config.confirmRounds - 1 && recent.every(item => item.prediction === prediction);
  }
  if (name === 'cooldown') return cooldownRemaining(history, config) === 0;
  const previous = [...history].reverse().find(item => item.outcome !== '3')?.outcome;
  return config.roadMode === 'follow' ? previous === prediction : Boolean(previous && previous !== prediction);
}
export function shouldAct(strategy: ActionStrategy, prediction: '1' | '2' | undefined, history: readonly PredictionDecision[], config: ActionConfig, isAiConsensus: boolean, agreement?: number) {
  if (!prediction) return false;
  if (strategy === 'always') return true;
  return condition(strategy, prediction, history, config, isAiConsensus, agreement);
}
export function applyActionStrategy(strategy: ActionStrategy, decisions: readonly PredictionDecision[], config: ActionConfig, isAiConsensus: boolean) {
  const history: PredictionDecision[] = [];
  return decisions.map(item => {
    const filtered = { ...item, prediction: shouldAct(strategy, item.prediction, history, config, isAiConsensus, item.agreement) ? item.prediction : undefined };
    history.push(item);
    return filtered;
  });
}
