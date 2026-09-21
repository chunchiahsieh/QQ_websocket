import type { TablePhase } from './table-state';

export function abTablePhase(state?: number, openingStarted?: boolean): TablePhase | undefined {
  // AB 101 confirms the end of opening; 102 is shuffling. Neither may
  // resurrect a stale phase flag from a delayed countdown packet.
  if (state === 101 || state === 102) return undefined;
  return openingStarted === true ? 'dealing' : undefined;
}
