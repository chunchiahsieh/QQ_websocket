export type Side = '1' | '2' | '3'; // 閒、莊、和
import type { PointResult } from './point-analysis';

export function beadWinners(raw: string): Side[] {
  return raw.split('#').flatMap(column => {
    const cells = column.match(/0[123]/g) ?? [];
    return cells.map(cell => cell[1] as Side);
  }).slice(-36);
}

export type CardSignal = { answer: '莊' | '閒' | '無訊號'; sample: number; banker: number; player: number; reason: string };
function decide(banker: number, player: number, sample: number, minimum: number, reason: string): CardSignal {
  const total = banker + player;
  const answer = sample < minimum || total === 0 || Math.abs(banker - player) / total < 0.2
    ? '無訊號' : banker > player ? '莊' : '閒';
  return { answer, sample, banker, player, reason };
}

export function weightedSignal(winners: readonly Side[], windowSize = 36): CardSignal {
  let banker = 0, player = 0, sample = 0;
  for (let i = 0; i < winners.length; i++) {
    const side = winners[i];
    if (side === '3') continue;
    const weight = Math.pow(0.94, winners.length - 1 - i);
    if (side === '2') banker += weight; else player += weight;
    sample++;
  }
  return decide(banker, player, sample, 10, `最近 ${windowSize} 局越近權重越高；和局不計。`);
}

export function weightedConsensus(winners: readonly Side[]) {
  const windows = ([18, 24, 36] as const).map(size => {
    const signal = weightedSignal(winners.slice(-size), size);
    return { size, ...signal, answer: winners.length >= size ? signal.answer : '無訊號' as const };
  });
  const bankerVotes = windows.filter(window => window.answer === '莊').length;
  const playerVotes = windows.filter(window => window.answer === '閒').length;
  const answer = bankerVotes >= 2 ? '莊' : playerVotes >= 2 ? '閒' : '無訊號';
  return { windows, answer };
}

export function winningPointSignal(results: readonly PointResult[]): CardSignal {
  let banker = 0, player = 0;
  for (const [index, result] of results.entries()) {
    // Recent winning-point observations carry more weight. The point digit is
    // retained as an observed feature, but no unobserved losing point is inferred.
    const weight = Math.pow(0.94, results.length - 1 - index) * (1 + result.points / 20);
    if (result.side === '2') banker += weight; else player += weight;
  }
  return decide(banker, player, results.length, 10, '依近期勝方點數與遠近加權；沒有敗方點數。');
}
