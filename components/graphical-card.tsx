'use client';

import { useEffect, useRef, useState } from 'react';
import { BaccaratRoad, type RoadConnection, type RoadHighlight } from '@/components/baccarat-road';

type GraphicalMode = 'v3' | 'v5' | 'cross';
type ShapeOrientation = 'down' | 'up' | 'right' | 'left' | 'cross' | 'x';
type Outcome = '1' | '2' | '3';
type Side = '1' | '2';
type Point = { column: number; row: number };
type Cell = Outcome | undefined;
type Pattern = { score: number; points: Point[]; lines: Point[][]; side?: Side; orientation?: ShapeOrientation; candidates?: Pattern[] };

const outcomeView = {
  '1': { label: '閒', color: '#2864e8', fill: '#eef4ff' },
  '2': { label: '莊', color: '#ef3535', fill: '#fff0f0' },
  '3': { label: '和', color: '#269148', fill: '#effaf1' },
} as const;

function parseColumns(raw: string): Cell[][] {
  return raw.split('#').map(column => {
    const entries = column.includes(',') ? column.split(',') : column.match(/.{2}/g) ?? [];
    return entries.map(entry => {
      const value = entry.trim().at(-1);
      return value === '1' || value === '2' || value === '3' ? value : undefined;
    });
  }).filter(column => column.some(value => value !== undefined));
}

function predictNext(outcomes: Outcome[]): Side {
  const recent: Side[] = [];
  for (const outcome of outcomes.slice(-12)) {
    if (outcome === '1' || outcome === '2') recent.push(outcome);
    else if (recent.length) recent.push(recent.at(-1)!); // 和局歸入最近的莊／閒
    else recent.push('1');
  }
  if (!recent.length) return '1';
  const player = recent.filter(value => value === '1').length;
  const banker = recent.length - player;
  if (player === banker) return recent.at(-1) === '1' ? '2' : '1';
  return player > banker ? '1' : '2';
}

function encodeBead(columns: Cell[][]) {
  // BaccaratRoad's bead parser expects adjacent two-character cells. Demo
  // columns are built as contiguous prefixes, so no comma separators are
  // needed (and commas would make the whole column invalid).
  return columns.map(column => column.map(outcome => outcome ? `0${outcome}` : '').join('')).join('#');
}

function futureBeadPoints(columns: Cell[][], count: number): Point[] {
  const lengths = columns.map(column => {
    let last = -1;
    column.forEach((value, row) => { if (value !== undefined) last = row; });
    return last + 1;
  });
  const points: Point[] = [];
  for (let index = 0; index < count; index += 1) {
    if (!lengths.length) lengths.push(0);
    if (lengths.at(-1)! >= 6) lengths.push(0);
    const column = lengths.length - 1;
    const row = lengths[column];
    points.push({ column, row });
    lengths[column] += 1;
  }
  return points;
}

function shapeLines(mode: GraphicalMode, centerColumn: number, centerRow: number, orientation: ShapeOrientation): Point[][] {
  if (mode === 'cross' && orientation === 'x') return [
    Array.from({ length: 3 }, (_, index) => ({ column: centerColumn - 1 + index, row: centerRow - 1 + index })),
    Array.from({ length: 3 }, (_, index) => ({ column: centerColumn + 1 - index, row: centerRow - 1 + index })),
  ];
  if (mode === 'cross') return [
    Array.from({ length: 3 }, (_, index) => ({ column: centerColumn, row: centerRow - 1 + index })),
    Array.from({ length: 3 }, (_, index) => ({ column: centerColumn - 1 + index, row: centerRow })),
  ];
  if (mode === 'v5') {
    if (orientation === 'down') return [[{ column: centerColumn - 2, row: centerRow - 2 }, { column: centerColumn - 1, row: centerRow - 1 }, { column: centerColumn, row: centerRow }, { column: centerColumn + 1, row: centerRow - 1 }, { column: centerColumn + 2, row: centerRow - 2 }]];
    if (orientation === 'up') return [[{ column: centerColumn - 2, row: centerRow + 2 }, { column: centerColumn - 1, row: centerRow + 1 }, { column: centerColumn, row: centerRow }, { column: centerColumn + 1, row: centerRow + 1 }, { column: centerColumn + 2, row: centerRow + 2 }]];
    if (orientation === 'right') return [[{ column: centerColumn - 2, row: centerRow - 2 }, { column: centerColumn - 1, row: centerRow - 1 }, { column: centerColumn, row: centerRow }, { column: centerColumn - 1, row: centerRow + 1 }, { column: centerColumn - 2, row: centerRow + 2 }]];
    return [[{ column: centerColumn + 2, row: centerRow - 2 }, { column: centerColumn + 1, row: centerRow - 1 }, { column: centerColumn, row: centerRow }, { column: centerColumn + 1, row: centerRow + 1 }, { column: centerColumn + 2, row: centerRow + 2 }]];
  }
  // V-3 uses two known arm points and the next cell as the prediction.
  if (orientation === 'down') return [[
    { column: centerColumn - 1, row: centerRow - 1 },
    { column: centerColumn, row: centerRow },
    { column: centerColumn + 1, row: centerRow - 1 },
  ]];
  if (orientation === 'up') return [[
    { column: centerColumn - 1, row: centerRow + 1 },
    { column: centerColumn, row: centerRow },
    { column: centerColumn + 1, row: centerRow + 1 },
  ]];
  if (orientation === 'right') return [[
    { column: centerColumn - 1, row: centerRow - 1 },
    { column: centerColumn, row: centerRow },
    { column: centerColumn - 1, row: centerRow + 1 },
  ]];
  return [[
    { column: centerColumn + 1, row: centerRow - 1 },
    { column: centerColumn, row: centerRow },
    { column: centerColumn + 1, row: centerRow + 1 },
  ]];
}

// When several V shapes can be completed by the next bead, use the requested
// stable order instead of whichever loop happens to find a match first.
const vOrientationPriority: ShapeOrientation[] = ['down', 'left', 'right', 'up'];
const crossOrientationPriority: ShapeOrientation[] = ['cross', 'x'];

function findPattern(columns: Cell[][], mode: GraphicalMode, targetPoints: Point[]): Pattern {
  const candidates: Pattern[] = [];
  const isVMode = mode === 'v3' || mode === 'v5';
  const orientations: ShapeOrientation[] = isVMode ? vOrientationPriority : crossOrientationPriority;
  for (let centerColumn = 2; centerColumn <= columns.length - 3; centerColumn += 1) {
    // Include row 0: an inverted V can have its apex on the top bead row.
    for (const centerRow of [0, 1, 2, 3, 4, 5]) {
      for (const orientation of orientations) {
        const lines = shapeLines(mode, centerColumn, centerRow, orientation);
        const points = lines.flat().filter((point, index, all) => all.findIndex(item => item.column === point.column && item.row === point.row) === index);
        // Do not accept shapes that leave the six-row bead grid. This also
        // prevents negative rows from being treated as empty predictions.
        if (points.some(point => point.column < 0 || point.row < 0 || point.row > 5)) continue;
        for (const side of ['1', '2'] as Side[]) {
          const occupied = points.map(point => columns[point.column]?.[point.row]).filter((value): value is Outcome => value !== undefined);
          const compatible = occupied.length > 0 && occupied.some(value => value === side)
            && occupied.every(value => value === side || value === '3');
          const hasFutureGap = points.some(point => !columns[point.column]?.[point.row]
            && targetPoints.some(target => target.column === point.column && target.row === point.row));
          // Completed shapes are historical results, not predictions. Only
          // keep a compatible shape whose missing point is reachable soon.
          if (compatible && hasFutureGap) candidates.push({ score: occupied.length, points, lines, side, orientation });
        }
      }
    }
  }
  // V-3 uses three points (two existing points predict the third); V-5 and
  // cross use five points and require four existing points.
  const minimumScore = mode === 'v3' ? 2 : 4;
  const valid = candidates.filter(candidate => candidate.score >= minimumScore)
    .sort((left, right) => {
      const priority = isVMode ? vOrientationPriority : crossOrientationPriority;
      const leftOrder = left.orientation ? priority.indexOf(left.orientation) : 0;
      const rightOrder = right.orientation ? priority.indexOf(right.orientation) : 0;
      return leftOrder - rightOrder || right.score - left.score;
    });
  if (!valid.length) return { score: 0, points: [], lines: [], candidates: [] };
  return { ...valid[0], candidates: valid };
}

export function GraphicalCard({ beadRaw, fallbackRaw, mode }: { beadRaw: string; fallbackRaw: string; mode: GraphicalMode }) {
  const modeLabel = mode === 'v3' ? 'V型-3' : mode === 'v5' ? 'V型-5' : '十字';
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize(previous => previous.width === width && previous.height === height ? previous : { width, height });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  // Match the bead-road renderer's 20×30 logical cells, then scale them to
  // the available card width and height instead of inventing a new geometry.
  const scale = size.height > 0 ? size.height / 180 : 1;
  const columnCount = size.width > 0 ? Math.max(1, Math.floor((size.width / scale) / 20)) : 16;
  const beadColumns = parseColumns(beadRaw);
  const fallbackColumns = parseColumns(fallbackRaw);
  const beadCount = beadColumns.reduce((total, column) => total + column.filter(Boolean).length, 0);
  // The graphical card must preserve the exact bead-road history and only add
  // an overlay. Re-encoding a valid bead payload can lose provider-specific
  // spacing, so use the original payload whenever it contains any cells.
  const useBeadSource = beadRaw.trim().length > 0;
  const sourceColumns = beadCount > 0 ? beadColumns : fallbackColumns;
  const columns = sourceColumns.slice(-columnCount);
  const displayRaw = useBeadSource ? beadRaw : encodeBead(columns);
  const outcomes = columns.flat().filter((value): value is Outcome => value !== undefined);
  const actual = outcomes.at(-1);
  const futurePoints = futureBeadPoints(columns, 1);
  // Include the next empty bead position in the search so a pattern can finish
  // at the next cell after the current six-row bead stack.
  const analysisColumns: Cell[][] = [...columns, [], [], []];
  const livePattern = findPattern(analysisColumns, mode, futurePoints);
  const pattern: Pattern = livePattern;
  const rawPatternCandidates = pattern.candidates?.length ? pattern.candidates : [pattern];
  // 當十字與 X 同時命中時，十字優先；只有沒有十字候選時才繪製 X。
  const patternCandidates = mode === 'cross' && rawPatternCandidates.some((candidate) => candidate.orientation === 'cross')
    ? rawPatternCandidates.filter((candidate) => candidate.orientation === 'cross')
    : rawPatternCandidates;
  const prediction = patternCandidates[0]?.side ?? predictNext(outcomes);
  const candidateEntries = patternCandidates.map(candidate => {
    const targetPoints = candidate.points.filter(point =>
      !columns[point.column]?.[point.row] && futurePoints.some(next => next.column === point.column && next.row === point.row));
    return { candidate, targetPoints };
  });
  // 若同一個下一局位置同時出現莊、閒兩種圖形命中，保留所有連線，
  // 但將預測格標成黑色表示「建議不打」，避免誤導使用者下注。
  const conflictingPrediction = new Set(candidateEntries.map(({ candidate, targetPoints }) =>
    targetPoints.length ? candidate.side : undefined).filter((side): side is Side => Boolean(side))).size > 1;
  const bankerDoubleHit = candidateEntries.filter(({ candidate, targetPoints }) =>
    candidate.side === '2' && targetPoints.length > 0).length >= 2;
  const playerDoubleHit = candidateEntries.filter(({ candidate, targetPoints }) =>
    candidate.side === '1' && targetPoints.length > 0).length >= 2;
  const matched = new Set(candidateEntries.flatMap(({ candidate, targetPoints }) => candidate.points
    .filter(point => !targetPoints.some(target => target.column === point.column && target.row === point.row))
    .filter(point => Boolean(columns[point.column]?.[point.row]))
    .map(point => `${point.column}:${point.row}`)));
  // Mark only the empty cell that can actually be reached in the next round;
  // rounds. An unrelated empty cell elsewhere in a V/cross is not a forecast.
  const predictionPoints = candidateEntries.flatMap(({ targetPoints }) => targetPoints)
    .filter((point, index, all) => all.findIndex(item => item.column === point.column && item.row === point.row) === index);
  const highlights: RoadHighlight[] = candidateEntries.flatMap(({ candidate, targetPoints }) => {
    if (!targetPoints.length) return [];
    const side = candidate.side ?? prediction;
    const lineColor = side === '2' ? '#ef3535' : '#2864e8';
    const predictionBackground = side === '2' ? '#fecaca' : '#bfdbfe';
    const matchedHighlights = candidate.points
      .filter(point => matched.has(`${point.column}:${point.row}`))
      .map(point => ({ column: point.column, row: point.row, color: predictionBackground, label: `預測${outcomeView[side].label}${modeLabel}線路` }));
    const strongHit = (bankerDoubleHit && side === '2') || (playerDoubleHit && side === '1');
    const targetColor = conflictingPrediction ? '#111827' : strongHit ? (side === '2' ? '#991b1b' : '#1d4ed8') : predictionBackground;
    const targetLabel = conflictingPrediction ? '莊閒衝突，建議不打' : strongHit ? `${outcomeView[side].label}連線兩次，高機率` : `下一局預測補上${outcomeView[side].label}`;
    return [...matchedHighlights, ...targetPoints.map(point => ({ column: point.column, row: point.row, color: targetColor, fillOpacity: .34, dashed: true, label: targetLabel }))];
  });
  const connections: RoadConnection[] = candidateEntries.flatMap(({ candidate, targetPoints }) => {
    if (!targetPoints.length) return [];
    const side = candidate.side ?? prediction;
    return candidate.lines.map(points => ({ points, color: side === '2' ? '#ef3535' : '#2864e8', label: `${outcomeView[side].label}${modeLabel}預測線` }));
  });
  return (
    <section className="graphical-card grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto]" aria-label={`${modeLabel}圖形牌卡`}>
      <div ref={host} className="relative min-h-0 min-w-0 overflow-hidden">
        <BaccaratRoad raw={displayRaw} kind="bead" columnLimit={columnCount} highlights={highlights} connections={connections} />
      </div>
      <footer className="graphical-card-footer grid gap-0.5 border-t border-slate-600 px-2 py-1 text-[11px] font-semibold leading-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{modeLabel}偵測：已標示 {matched.size} 個符號{predictionPoints.length ? '，下一局位置已標示' : ''}</span>
          <span className="flex items-center gap-2">
            <span>下一局預測：{conflictingPrediction ? <strong style={{ color: '#f8fafc' }}>不打</strong> : <strong style={{ color: outcomeView[prediction].color }}>{outcomeView[prediction].label}</strong>} · 實際：{actual ? outcomeView[actual].label : '等待'}</span>
          </span>
        </div>
      </footer>
    </section>
  );
}
