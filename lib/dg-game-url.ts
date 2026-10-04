/** DG accepts its numeric table ID as a `tableId` launch parameter. */
export function dgGameUrlForTable(url: string, cardId: string): string {
  const tableId = cardId.startsWith("DG:") ? cardId.slice(3) : "";
  if (!/^[1-9]\d*$/.test(tableId)) return url;
  const launch = new URL(url);
  launch.searchParams.set("tableId", tableId);
  return launch.href;
}
