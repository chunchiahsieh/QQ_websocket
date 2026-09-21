export function cardSearch(value: string, search: string): number {
  const [groupCode, cardCode, groupName, cardName] = value.split('|');
  const query = search.trim().toLowerCase();
  if (!query) return 1;
  if (/^\d+$/.test(query)) return query.length === 1 ? Number(groupCode === query) : Number(cardCode.startsWith(query));
  return Number(`${groupName} ${cardName}`.toLowerCase().includes(query));
}
