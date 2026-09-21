export type RoadSide = '1' | '2' | '3';
export type RoadSignal = { side?: '1' | '2'; sample: number; banker: number; player: number; reason: string; context?: string; usedOrder?: number; bankerProbability?: number };

const opposite = (side: '1' | '2') => side === '1' ? '2' : '1';
const lastDecisive = (rounds: readonly RoadSide[]) => [...rounds].reverse().find((side): side is '1' | '2' => side !== '3');
const result = (banker: number, player: number, sample: number, minimum: number, reason: string): RoadSignal => ({
  side: sample >= minimum && Math.abs(banker - player) / Math.max(1, banker + player) >= 0.15
    ? banker > player ? '2' : '1' : undefined,
  sample, banker, player, reason,
});

export function followRoad(rounds: readonly RoadSide[]): RoadSignal {
  const side = lastDecisive(rounds);
  return { side, sample: side ? 1 : 0, banker: Number(side === '2'), player: Number(side === '1'), reason: '延續最近一局非和局結果；和局略過。' };
}

export function reverseRoad(rounds: readonly RoadSide[]): RoadSignal {
  const previous = lastDecisive(rounds);
  const side = previous && opposite(previous);
  return { side, sample: previous ? 1 : 0, banker: Number(side === '2'), player: Number(side === '1'), reason: '與最近一局非和局結果相反；和局略過。' };
}

export function streakRoad(rounds: readonly RoadSide[], length: number, continuation: boolean): RoadSignal {
  const decisive = rounds.filter((side): side is '1' | '2' => side !== '3');
  const tail = decisive.slice(-length);
  const base = tail.length === length && tail.every(side => side === tail[0]) ? tail[0] : undefined;
  const side = base && (continuation ? base : opposite(base));
  return { side, sample: tail.length, banker: Number(side === '2'), player: Number(side === '1'), reason: `連續 ${length} 局後${continuation ? '延續' : '中斷'}；和局略過。` };
}

// Use only observations strictly before the current tail. Each matching
// historical context contributes its next decisive outcome exactly once.
function countTransitions(decisive: readonly ('1' | '2')[], order: number) {
  const tail = decisive.slice(-order).join('');
  let banker = 0, player = 0;
  for (let index = order; index < decisive.length; index++) {
    if (decisive.slice(index - order, index).join('') !== tail) continue;
    if (decisive[index] === '2') banker++; else player++;
  }
  return { banker, player, context: decisive.slice(-order).map(side => side === '2' ? '莊' : '閒').join(' → ') };
}

function conditional(rounds: readonly RoadSide[], order: number, minimum: number, label: string): RoadSignal {
  const decisive = rounds.filter((side): side is '1' | '2' => side !== '3');
  if (decisive.length < order + 1) return result(0, 0, 0, minimum, `${label}：資料不足。`);
  const { banker, player, context } = countTransitions(decisive, order);
  return { ...result(banker, player, banker + player, minimum, `${label}：找出歷史中相同的最近 ${order} 局排列，統計下一局；至少 ${minimum} 筆。`), context, usedOrder: order };
}

export const sequenceRoad = (rounds: readonly RoadSide[], order = 3) => conditional(rounds, order, 5, '序列比對');
export function markovRoad(rounds: readonly RoadSide[], order = 3): RoadSignal {
  const decisive = rounds.filter((side): side is '1' | '2' => side !== '3');
  for (let usedOrder = Math.min(order, decisive.length - 1); usedOrder >= 1; usedOrder--) {
    const { banker, player, context } = countTransitions(decisive, usedOrder);
    const sample = banker + player;
    if (sample < 10) continue;
    // Laplace smoothing keeps a zero-count side from being treated as certain.
    const bankerProbability = (banker + 1) / (sample + 2);
    const side = bankerProbability >= 0.58 ? '2' : bankerProbability <= 0.42 ? '1' : undefined;
    return { side, sample, banker, player, context, usedOrder, bankerProbability,
      reason: `依近 ${usedOrder} 局估計；樣本不足時自動縮短比對。` };
  }
  return { sample: 0, banker: 0, player: 0, reason: '樣本不足，暫無訊號。' };
}
