import { aiConsensus, aiSources } from './ai-consensus.ts';
import type { PointResult } from './point-analysis.ts';
import { weightedConsensus, weightedSignal, winningPointSignal, type Side } from './statistical-cards.ts';

export type RegressionCardId = 'points' | 'weighted' | 'weighted-consensus' | 'ai-consensus';

// The input is the completed history before the tested round. Never pass the
// tested round's outcome or point value to a card signal.
export function regressionCardSignal(id: RegressionCardId, outcomes: readonly Side[], points: readonly PointResult[]): '莊' | '閒' | undefined {
  if (id === 'points') {
    const answer = winningPointSignal(points.slice(-36)).answer;
    return answer === '莊' || answer === '閒' ? answer : undefined;
  }
  if (id === 'weighted') {
    const answer = weightedSignal(outcomes.slice(-36), 36).answer;
    return answer === '莊' || answer === '閒' ? answer : undefined;
  }
  if (id === 'weighted-consensus') {
    const answer = weightedConsensus(outcomes.slice(-36)).answer;
    return answer === '莊' || answer === '閒' ? answer : undefined;
  }
  const recentOutcomes = outcomes.slice(-60);
  const recentPoints = points.slice(-recentOutcomes.filter(side => side !== '3').length);
  let pointIndex = 0;
  const raw = recentOutcomes.flatMap(side => {
    if (side === '3') return [];
    const point = recentPoints[pointIndex++]?.points ?? 0;
    return [`0${point}0${side}`];
  }).join('#');
  const side = aiConsensus(raw, aiSources).side;
  return side === '2' ? '莊' : side === '1' ? '閒' : undefined;
}
