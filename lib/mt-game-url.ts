/** Preserve MT's existing URL-based selection; live-hall handling is separate. */
export function mtGameUrlForTable(url: string, tableId: string): string {
  if (!tableId) return url;
  const launch = new URL(url);
  launch.searchParams.set("game", tableId);
  return launch.href;
}
