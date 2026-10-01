export const pickPlatforms = ['MT', 'DG', 'AB'] as const;
export type PickPlatform = (typeof pickPlatforms)[number];
export const pickPlatformStorageKey = 'jshen-picks-platforms-v1';

export function parsePickPlatforms(stored: string | null): PickPlatform[] {
  try {
    const value: unknown = stored ? JSON.parse(stored) : null;
    if (Array.isArray(value)) {
      const selected = pickPlatforms.filter(platform => value.includes(platform));
      if (selected.length) return selected;
    }
  } catch { /* Invalid preferences fall back to all platforms. */ }
  return [...pickPlatforms];
}

/** Keep at least one platform selected and a stable order for ranking scope. */
export function togglePickPlatform(selected: readonly PickPlatform[], platform: PickPlatform): PickPlatform[] {
  if (selected.includes(platform)) {
    return selected.length > 1 ? selected.filter(value => value !== platform) : [...selected];
  }
  return pickPlatforms.filter(value => value === platform || selected.includes(value));
}

/** Filter the ranking input, not its top-six output. Never backfill other platforms. */
export function selectedPlatformTables<T>(tables: Record<PickPlatform, T[]>, selected: readonly PickPlatform[]): Array<[PickPlatform, T[]]> {
  return pickPlatforms.filter(platform => selected.includes(platform)).map(platform => [platform, tables[platform]]);
}
