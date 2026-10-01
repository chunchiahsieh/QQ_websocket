import type { PickPlatform } from './jshen-platform-filter.ts';

// Ranking snapshots may stay frozen between refreshes. A displayed prediction
// must use the live record for this exact platform and presentation table ID.
// Missing records deliberately return undefined instead of replaying a stale
// ranked snapshot or substituting the related international/live-hall table.
export function findLivePickTable<T extends { id: string }>(
  tablesByPlatform: Partial<Record<PickPlatform, readonly T[]>>,
  platform: PickPlatform,
  tableId: string,
): T | undefined {
  return tablesByPlatform[platform]?.find(table => table.id === tableId);
}
