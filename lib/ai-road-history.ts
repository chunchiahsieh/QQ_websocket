export type AiRoadMark = { code: string; column: number; row: number };

export const isAiRoadCode = (code: string | undefined): code is string =>
  code !== undefined && /^\d[\d?]\d[12]$/.test(code);

export function parseAiRoad(raw: string): string[][] {
  return raw.split('#').map(column => column.includes(',') ? column.split(',') : column.match(/.{4}/g) ?? []);
}

// A display column is not a time series: an older dragon tail can sit below
// a newer streak. Walk the same placement rules used to create the road.
// An incomplete/inconsistent road is not sufficient evidence to invent order.
export function chronologicalAiRoad(raw: string, outcomes?: readonly ('1' | '2' | '3')[]): AiRoadMark[] | undefined {
  const columns = parseAiRoad(raw);
  const count = columns.reduce((total, column) => total + column.filter(isAiRoadCode).length, 0);
  const marks: AiRoadMark[] = [];
  const occupied = new Set<string>();
  if (outcomes) {
    let start = -1, column = 0, row = 0, tail = false, previous: string | undefined;
    for (const side of outcomes) {
      if (side === '3') continue;
      if (side !== previous) {
        start += 1;
        while (occupied.has(`${start}:0`)) start += 1;
        column = start; row = 0; tail = false;
      } else if (!tail && row < 5 && !occupied.has(`${column}:${row + 1}`)) row += 1;
      else {
        tail = true; column += 1;
        while (occupied.has(`${column}:${row}`)) column += 1;
      }
      const code = columns[column]?.[row];
      if (!isAiRoadCode(code) || code[3] !== side) return undefined;
      marks.push({ code, column, row });
      occupied.add(`${column}:${row}`);
      previous = side;
    }
    return marks.length === count ? marks : undefined;
  }
  let start = 0;
  while (marks.length < count) {
    while (occupied.has(`${start}:0`)) start += 1;
    const first = columns[start]?.[0];
    if (!isAiRoadCode(first)) return undefined;
    const side = first[3];
    let column = start, row = 0, tail = false;
    while (true) {
      const code = columns[column]?.[row];
      if (!isAiRoadCode(code) || code[3] !== side) break;
      // Touching same-colour tails from later streaks make the image ambiguous.
      // Only the chronological bead history can resolve ownership of this cell.
      if (tail && columns.slice(start + 1, column + 1).some(cells => isAiRoadCode(cells[0]) && cells[0][3] === side)) return undefined;
      marks.push({ code, column, row });
      occupied.add(`${column}:${row}`);
      if (!tail && row < 5 && !occupied.has(`${column}:${row + 1}`)) row += 1;
      else {
        tail = true;
        column += 1;
        while (occupied.has(`${column}:${row}`)) column += 1;
      }
    }
    start += 1;
  }
  return marks;
}

export function encodeAiRoad(marks: readonly AiRoadMark[]): string {
  const columns: string[][] = [];
  for (const mark of marks) {
    columns[mark.column] ??= [];
    while (columns[mark.column].length <= mark.row) columns[mark.column].push('');
    columns[mark.column][mark.row] = mark.code;
  }
  return Array.from({ length: columns.length }, (_, index) => (columns[index] ?? []).join(',')).join('#');
}

export function appendAiPrediction(raw: string, prediction?: '1' | '2', outcomes?: readonly ('1' | '2' | '3')[]) {
  if (!prediction) return { raw };
  const marks = chronologicalAiRoad(raw, outcomes);
  if (!marks) return { raw };
  const last = marks.at(-1);
  const occupied = new Set(marks.map(mark => `${mark.column}:${mark.row}`));
  let column = 0, row = 0;
  if (last) {
    const streakStart = marks.findLastIndex((mark, index) => index === 0 || marks[index - 1].code[3] !== mark.code[3]);
    if (last.code[3] !== prediction) {
      column = marks[streakStart].column + 1;
      while (occupied.has(`${column}:0`)) column += 1;
    } else {
      column = last.column;
      row = last.row;
      const tail = column !== marks[streakStart].column;
      if (!tail && row < 5 && !occupied.has(`${column}:${row + 1}`)) row += 1;
      else {
        column += 1;
        while (occupied.has(`${column}:${row}`)) column += 1;
      }
    }
  }
  const columns = parseAiRoad(raw);
  columns[column] ??= [];
  while (columns[column].length <= row) columns[column].push('');
  columns[column][row] = `0?0${prediction}`;
  return { raw: columns.map(cells => cells.join(',')).join('#'), position: { column, row } };
}
