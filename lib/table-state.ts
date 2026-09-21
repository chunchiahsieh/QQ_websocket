export function isTableShuffling(tableId: string, tableState?: string, platformLabel?: string): boolean {
  // DG's protocol state codes are not MT's table state codes.
  return tableState === '2' && !tableId.startsWith('DG:') && platformLabel !== 'DG';
}

export type TablePhase = 'dealing' | 'shuffling';

export function tableOverlayLabel(
  tableId: string,
  tableState?: string,
  platformLabel?: string,
  phase?: TablePhase | null,
): '開牌中' | '洗牌中' | null {
  if (phase === 'dealing') return '開牌中';
  if (phase === 'shuffling') return '洗牌中';
  return isTableShuffling(tableId, tableState, platformLabel) ? '洗牌中' : null;
}
