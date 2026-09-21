export const aiSources = ['chartgpt', 'gemini', 'deepseek', 'claude'] as const;
export type AiSource = typeof aiSources[number];
export type ConsensusSide = '1' | '2';

// These are deterministic local demo signals, not responses from the named AI services.
export function localSignal(raw: string, source: AiSource): ConsensusSide | undefined {
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
  const required = votes.length === 2 ? 2 : Math.floor(votes.length / 2) + 1;
  const side: ConsensusSide | undefined = !raw || !votes.length ? undefined
    : banker >= required ? '2' : player >= required ? '1' : undefined;
  return { votes, side, required };
}
