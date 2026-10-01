export const aiSources = ['chartgpt', 'gemini', 'deepseek', 'claude'] as const;
export type AiSource = typeof aiSources[number];
export type ConsensusSide = '1' | '2';

const bigRoadCode = /^\d[\d?]\d[1-3]$/;

// The collector can pad each road column to six cells, while historical
// prefixes omit those empty cells. Tie counters can also change a previously
// displayed mark. Neither difference should change a prediction for the same
// settled history.
export function canonicalAiRoad(raw: string): string {
  const columns = raw.split('#').map(column => column.includes(',') ? column.split(',') : column.match(/.{4}/g) ?? []);
  if (!columns.some(column => column.some(code => bigRoadCode.test(code)))) return raw;
  return columns.map(column => {
    const last = column.findLastIndex(code => bigRoadCode.test(code));
    return last < 0 ? '' : column.slice(0, last + 1)
      .map(code => bigRoadCode.test(code) ? `0${code.slice(1)}` : '').join(',');
  }).filter(Boolean).join('#');
}

// These are deterministic local demo signals, not responses from the named AI services.
export function localSignal(raw: string, source: AiSource): ConsensusSide | undefined {
  raw = canonicalAiRoad(raw);
  const offset = { chartgpt: 17, gemini: 31, deepseek: 47, claude: 61 }[source];
  let seed = (offset * 2654435761) >>> 0;
  for (let index = 0; index < raw.length; index += 1)
    seed = (Math.imul(seed ^ raw.charCodeAt(index), 16777619) + index) >>> 0;
  seed = (seed + Math.imul(offset, 1013904223)) >>> 0;
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  // A source may abstain. Keep this tied to the input so refreshing the page
  // cannot turn an abstention into a vote for the same round.
  if (seed % 9 === 0) return undefined;
  return ((seed >>> 28) & 1) === 0 ? '1' : '2';
}

export function aiConsensus(raw: string, selected: readonly AiSource[]) {
  const votes = selected.map(source => ({ source, side: localSignal(raw, source) }));
  const banker = votes.filter(vote => vote.side === '2').length;
  const player = votes.filter(vote => vote.side === '1').length;
  const active = banker + player;
  const required = Math.floor(active / 2) + 1;
  const side: ConsensusSide | undefined = !raw || !votes.length ? undefined
    : banker >= required ? '2' : player >= required ? '1' : undefined;
  return { votes, side, required, active };
}

// Direction-required card mode. Keep actual source votes/confidence intact;
// only resolve an absent direction, using the same past-road input every time.
export function completeAiConsensus(raw: string, selected: readonly AiSource[]) {
  const consensus = aiConsensus(raw, selected);
  if (consensus.side || !selected.length) return consensus;
  // On the opening round aiConsensus deliberately leaves side unset. If the
  // selected sources already agree, preserve their direction in this mode.
  const banker = consensus.votes.filter(vote => vote.side === '2').length;
  const player = consensus.votes.filter(vote => vote.side === '1').length;
  if (banker >= consensus.required) return { ...consensus, side: '2' as const };
  if (player >= consensus.required) return { ...consensus, side: '1' as const };
  const input = JSON.stringify([canonicalAiRoad(raw), aiSources.filter(source => selected.includes(source))]);
  let seed = 2166136261;
  for (let index = 0; index < input.length; index += 1)
    seed = Math.imul(seed ^ input.charCodeAt(index), 16777619) >>> 0;
  const side: ConsensusSide = (seed & 1) === 0 ? '1' : '2';
  return { ...consensus, side };
}
