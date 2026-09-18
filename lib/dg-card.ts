import type { TableInfo } from '../components/baccarat-table-card';
import type { DgTable } from './dg-protobuf';

export type Winner = 1 | 2 | 3; // Shared card: player / banker / tie.
type Mark = { col: number; row: number; winner: Winner; ties: number; logicalCol: number; logicalRow: number; index: number };

function place(results: Winner[]) {
  const marks: Mark[] = [], lengths: number[] = [];
  const occupied = new Set<string>();
  let start = -1, logical = -1, previous: Mark | undefined, tail = false, pendingTies = 0;
  for (const [index, winner] of results.entries()) {
    if (winner === 3) { if (previous) previous.ties++; else pendingTies++; continue; }
    let col: number, row: number;
    const changed = !previous || previous.winner !== winner;
    if (changed) {
      logical++; lengths.push(0); start++;
      while (occupied.has(`${start}:0`)) start++;
      col = start; row = 0; tail = false;
    } else {
      col = previous!.col; row = previous!.row;
      if (!tail && row < 5 && !occupied.has(`${col}:${row + 1}`)) row++;
      else { tail = true; col++; while (occupied.has(`${col}:${row}`)) col++; }
    }
    const mark = { col, row, winner, ties: pendingTies, logicalCol: logical, logicalRow: lengths[logical]++, index };
    pendingTies = 0; marks.push(mark); occupied.add(`${col}:${row}`); previous = mark;
  }
  return { marks, lengths };
}
function encode(marks: Mark[], code: (mark: Mark) => string) {
  const columns: string[][] = [];
  for (const mark of marks) { columns[mark.col] ??= Array(6).fill(''); columns[mark.col][mark.row] = code(mark); }
  return Array.from({ length: columns.length }, (_, i) => (columns[i] || Array(6).fill('')).join(',')).join('#');
}
export function dgRoads(raw: string[] = []) {
  // Official history is newest first: gameNo#result. Codes 1–4 banker,
  // 5–8 player, 9–12 tie; variations describe pairs, not point scores.
  const winners = [...raw].reverse().flatMap(value => {
    const parts = value.split('#'); const result = Number(parts[1] ?? parts[0]);
    return Number.isInteger(result) && result >= 1 && result <= 12 ? [((result <= 4 ? 2 : result <= 8 ? 1 : 3) as Winner)] : [];
  });
  return baccaratRoads(winners);
}
export function baccaratRoads(winners: Winner[], details: { point: string; pair: string }[] = []) {
  const recent = winners.slice(-36);
  const beadPlate = Array.from({ length: Math.ceil(recent.length / 6) }, (_, col) => recent.slice(col * 6, col * 6 + 6).map(w => `0${w}`).join('')).join('#');
  const { marks, lengths } = place(winners);
  const derived = (gap: number) => {
    const colors: Winner[] = [];
    for (const mark of marks) {
      const c = mark.logicalCol, r = mark.logicalRow;
      if (r === 0) { if (c - gap - 1 >= 0) colors.push(lengths[c - 1] === lengths[c - gap - 1] ? 1 : 2); }
      else if (c - gap >= 0) { const length = lengths[c - gap]; colors.push((length > r) === (length > r - 1) ? 1 : 2); }
    }
    return encode(place(colors).marks, mark => String(mark.winner));
  };
  return { beadPlate, bigRoad: encode(marks, m => `${Math.min(9, m.ties)}${details[m.index]?.point ?? '?'}${details[m.index]?.pair ?? '0'}${m.winner}`),
    bigEyeRoad: derived(1), smallRoad: derived(2), cockroachRoad: derived(3),
    banker: String(winners.filter(w => w === 2).length), player: String(winners.filter(w => w === 1).length), tie: String(winners.filter(w => w === 3).length) };
}
export type LiveDgTable = DgTable & { dealerPhoto?: string; receivedAt?: number; countdownDeadline?: number };
export function dgCard(table: LiveDgTable): TableInfo {
  return { id: `DG:${table.tableId}`, name: table.tableName || table.tableId || '—', gameType: 'BAC',
    dealer: table.dealer?.name || '', dealerPhoto: table.dealerPhoto, room: table.tableName || '',
    shoe: table.shoeId || '—', round: table.playId || '—', players: String(table.onlineCount ?? '—'),
    countdownReceivedAt: table.receivedAt, countdownDeadline: table.countdownDeadline,
    // DG state codes are not assumed to be MT state codes.
    ...dgRoads(table.roads) };
}
