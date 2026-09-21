import type { TablePhase } from './table-state';

export function abTablePhase(state?: number, openingStarted?: boolean): TablePhase | undefined {
  if (state === 102) return undefined;
  // Explicit decoder lifecycle is authoritative: a result can clear opening
  // before an old state=101 is replaced by the next round's status packet.
  if (openingStarted !== undefined) return openingStarted ? 'dealing' : undefined;
  return state === 101 ? 'dealing' : undefined;
}
