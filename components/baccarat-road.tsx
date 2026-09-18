'use client';

import { memo, useEffect, useRef, useState } from 'react';

type Kind = 'bead' | 'big' | 'eye' | 'small' | 'cockroach';
const labels = { bead: '珠盤路', big: '大路', eye: '大眼路', small: '小路', cockroach: '曱甴路' };

export const BaccaratRoad = memo(function BaccaratRoad({ raw = '', kind }: { raw?: string; kind: Kind }) {
  const host = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const rowHeight = kind === 'bead' ? 30 : kind === 'big' ? 16 : 8;
  const height = rowHeight * 6;
  const scale = size.height > 0 ? size.height / height : 1;
  const width = size.width / scale;
  // Match the reference's 15-column big-road window without resizing the card.
  const cell = kind === 'big' ? Math.max(1, width) / 15 : kind === 'bead' ? 20 : 8;
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
  // # separates columns; empty comma-delimited cells preserve turns and dragon tails.
  const columns = raw.split('#').map(column => kind === 'bead'
    ? (/^(?:[0-3][1-3])*$/.test(column) ? column.match(/.{2}/g) ?? [] : [])
    : column.split(','));
  // Allow subpixel rounding when six bead columns are scaled to fit the card.
  const capacity = kind === 'big' ? 15 : Math.max(1, Math.floor(width / cell + 0.001));
  const offset = Math.max(0, columns.length - capacity);
  const derived = kind !== 'bead' && kind !== 'big';
  return <div ref={host} className="h-full min-h-0 min-w-0 overflow-hidden" style={{ background: 'white' }}>
    <svg className="block" width="100%" height="100%" viewBox={`0 0 ${Math.max(1, width)} ${height}`} preserveAspectRatio="none" role="img" aria-label={labels[kind]}>
      {Array.from({ length: Math.ceil(width / cell) + 1 }, (_, col) =>
        <path key={`v${col}`} d={`M${col * cell + .5} 0V${height}`} stroke="#d9dfe5" strokeWidth=".6" />)}
      {Array.from({ length: 7 }, (_, row) =>
        <path key={`h${row}`} d={`M0 ${row * rowHeight + .5}H${width}`} stroke="#d9dfe5" strokeWidth=".6" />)}
      {columns.slice(offset).flatMap((column, col) => column.slice(0, 6).map((code, row) => {
        if (!(kind === 'bead' ? /^[0-3][1-3]$/ : kind === 'big' ? /^\d[\d?]\d[1-3]$/ : /^[12]$/).test(code)) return null;
        const result = code.at(-1);
        const color = derived ? (result === '1' ? '#ef3535' : '#2864e8')
          : result === '1' ? '#2864e8' : result === '2' ? '#ef3535' : '#269148';
        const x = col * cell + cell / 2, y = row * rowHeight + rowHeight / 2;
        const radius = kind === 'bead' ? 8.5 : kind === 'big' ? 6 : 2.4;
        const ties = kind === 'big' ? Number(code[0]) : 0;
        return <g key={`${col}:${row}`}>
          <title>{labels[kind]}：{code}</title>
          {kind === 'cockroach'
            ? <path d={`M${x - 2} ${y + 2}l4 -4`} stroke={color} strokeWidth="1.4" />
            : <circle cx={x} cy={y} r={radius} stroke={color} strokeWidth={derived ? 1 : 1.3}
                fill={kind === 'bead' || kind === 'small' ? color : 'white'} />}
          {!derived && <text x={x} y={y} textAnchor="middle" dominantBaseline="central"
            fill={kind === 'bead' ? 'white' : color} fontSize={kind === 'bead' ? 12 : 10} fontWeight="bold">
            {kind === 'bead' ? (result === '1' ? '閒' : result === '2' ? '莊' : '和') : code[1] === '?' ? '' : code[1]}
          </text>}
          {ties > 0 && <><path d={`M${x - 5} ${y + 5}l10 -10`} stroke="#229943" strokeWidth="1.5" />
            <text x={x + 5} y={y - 4} fill="#168235" fontSize="6">{ties}</text></>}
        </g>;
      }))}
    </svg>
  </div>;
});
