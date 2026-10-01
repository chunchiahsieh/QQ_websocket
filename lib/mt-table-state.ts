type MtState = {
  id: string;
  sourceTableId?: string;
  mtEvent?: 'snapshot' | 'wait' | 'show_poker' | 'complete' | 'update';
  mtReceivedAt?: number;
  countdownDeadline?: number;
  countdownReceivedAt?: number;
  countdownValue?: number;
  countdownRound?: string;
  countdownSource?: 'wait' | 'snapshot' | 'explicit' | 'end';
  tableState?: string;
  tablePhase?: string | null;
  round?: string;
  shoe?: string;
  banker?: string;
  player?: string;
  tie?: string;
  beadPlate?: string;
  bigRoad?: string;
  bigEyeRoad?: string;
  smallRoad?: string;
  cockroachRoad?: string;
};

const clockKeys = ['countdownDeadline', 'countdownReceivedAt', 'countdownValue', 'countdownRound', 'countdownSource', 'tableState', 'tablePhase', 'round', 'shoe', 'mtEvent', 'mtReceivedAt'] as const;
const gameKeys = [...clockKeys, 'round', 'shoe', 'banker', 'player', 'tie', 'beadPlate', 'bigRoad', 'bigEyeRoad', 'smallRoad', 'cockroachRoad'] as const;
const eventClock = (value?: MtState['countdownSource']) => value === 'wait' || value === 'end';
const numeric = (value?: string) => value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;

/** Select valid incoming clock fields without letting a lobby refresh rewind a live event. */
export function filterMtUpdate<T extends MtState>(previous: MtState | undefined, update: T): T {
  if (!previous) return update;
  const patch = { ...update };
  if (patch.mtEvent !== 'snapshot' && previous.sourceTableId && previous.sourceTableId !== previous.id && patch.sourceTableId === patch.id)
    patch.sourceTableId = previous.sourceTableId;
  const oldShoe = numeric(previous.shoe), newShoe = numeric(patch.shoe);
  const oldRound = numeric(previous.round), newRound = numeric(patch.round);
  const changedShoe = previous.shoe !== undefined && patch.shoe !== undefined && previous.shoe !== patch.shoe;
  const staleGame = oldShoe !== undefined && newShoe !== undefined && newShoe < oldShoe
    || !changedShoe && oldRound !== undefined && newRound !== undefined && newRound < oldRound;
  if (staleGame) {
    for (const key of gameKeys) delete patch[key];
    return patch;
  }
  if (eventClock(previous.countdownSource) && !eventClock(patch.countdownSource)) {
    for (const key of clockKeys) delete patch[key];
    return patch;
  }
  const sameGame = !!previous.countdownRound && previous.countdownRound === patch.countdownRound;
  if (sameGame && patch.countdownSource === 'wait' && eventClock(previous.countdownSource)
      && previous.countdownValue !== undefined && patch.countdownValue !== undefined) {
    if (patch.countdownValue > previous.countdownValue) {
      for (const key of clockKeys) delete patch[key];
    } else if (patch.countdownValue === previous.countdownValue) {
      delete patch.countdownDeadline;
      delete patch.countdownReceivedAt;
    } else if (previous.countdownDeadline !== undefined && patch.countdownDeadline !== undefined) {
      patch.countdownDeadline = Math.min(previous.countdownDeadline, patch.countdownDeadline);
    }
  }
  return patch;
}

/** MT's official table_id_t links a live presentation to its game's actual event stream. */
export function synchronizeMtClocks<T extends MtState>(tables: T[]): T[] {
  const byId = new Map(tables.map(table => [table.id, table]));
  return tables.map(table => {
    if (!table.sourceTableId || table.sourceTableId === table.id) return table;
    const source = byId.get(table.sourceTableId);
    if (!source) return table;
    const next = { ...table };
    for (const key of [...clockKeys, 'round', 'shoe'] as const) {
      if (source[key] !== undefined) Object.assign(next, { [key]: source[key] });
    }
    return next;
  });
}
