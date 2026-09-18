import type { TableInfo } from '../components/baccarat-table-card';
import { baccaratRoads, type Winner, type LiveDgTable } from './dg-card';

export type LiveAbTable = Omit<LiveDgTable, 'roads'> & { results?: string[]; videoUrl?: string };
export function abCard(table: LiveAbTable): TableInfo {
  // Official BacRoadmap: result[0] winner, [1] banker points, [2] player points.
  const results = (table.results ?? []).filter(r => /^[0-6][0-9]{2}[0-6][A-Za-z0-9]{8}$/.test(r));
  const winners: Winner[] = results.map(r => '15'.includes(r[0]) ? 2 : '26'.includes(r[0]) ? 1 : 3);
  const details = results.map((r, i) => ({ point: r[winners[i] === 1 ? 2 : 1], pair: '0' }));
  return { id: `AB:${table.tableId}`, name: table.tableName || table.tableId || '—', gameType: 'BAC',
    dealer: table.dealer?.name || '', dealerPhoto: table.dealerPhoto, videoUrl: table.videoUrl || undefined, room: table.tableName || '',
    shoe: '—', round: table.playId || '—', players: String(table.onlineCount ?? '—'),
    tableState: table.state === 102 ? '2' : undefined,
    countdownReceivedAt: table.receivedAt, countdownDeadline: table.countdownDeadline,
    ...baccaratRoads(winners, details) };
}
