export function isTableShuffling(tableId: string, tableState?: string, platformLabel?: string): boolean {
  // DG's protocol state codes are not MT's table state codes.
  return tableState === '2' && !tableId.startsWith('DG:') && platformLabel !== 'DG';
}
