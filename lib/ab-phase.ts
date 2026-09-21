import type { TablePhase } from './table-state';

export function abTablePhase(state?: number, openingStarted?: boolean): TablePhase | undefined {
  // AB 101 confirms the result, but the opening overlay stays up until the
  // next round's positive countdown. State 102 switches to shuffling.
  if (state === 102) return undefined;
  return openingStarted === true ? 'dealing' : undefined;
}
