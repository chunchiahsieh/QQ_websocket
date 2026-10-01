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
  aiOutcomes?: ('1' | '2' | '3')[];
};

const clockKeys = ['countdownDeadline', 'countdownReceivedAt', 'countdownValue', 'countdownRound', 'countdownSource', 'tableState', 'tablePhase', 'round', 'shoe', 'mtEvent', 'mtReceivedAt'] as const;
const gameKeys = [...clockKeys, 'round', 'shoe', 'banker', 'player', 'tie', 'beadPlate', 'bigRoad', 'bigEyeRoad', 'smallRoad', 'cockroachRoad', 'aiOutcomes'] as const;
const eventClock = (value?: MtState['countdownSource']) => value === 'wait' || value === 'end';
const numeric = (value?: string) => value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
const officialShoe = (value?: string) => Boolean(value?.trim()) && !/^(?:[-—–?]+|unknown|undefined|null|n\/a|0)$/i.test(value!.trim());
const changedOfficialShoe = (previous: MtState, update: MtState) => officialShoe(previous.shoe)
  && officialShoe(update.shoe) && previous.shoe !== update.shoe;
const olderGame = (previous: MtState, update: MtState) => {
  const oldShoe = numeric(previous.shoe), newShoe = numeric(update.shoe);
  const oldRound = numeric(previous.round), newRound = numeric(update.round);
  const changedShoe = previous.shoe !== undefined && update.shoe !== undefined && previous.shoe !== update.shoe;
  return oldShoe !== undefined && newShoe !== undefined && newShoe < oldShoe
    || !changedShoe && oldRound !== undefined && newRound !== undefined && newRound < oldRound;
};

/** After filtering stale updates, never use another shoe as a partial-update fallback. */
export function mtMergeBase<T extends MtState>(previous: T | undefined, update: MtState): T | undefined {
  if (!previous || !changedOfficialShoe(previous, update) || olderGame(previous, update)) return previous;
  const base = { ...previous };
  for (const key of gameKeys) delete base[key];
  return base;
}

/** Select valid incoming clock fields without letting a lobby refresh rewind a live event. */
export function filterMtUpdate<T extends MtState>(previous: MtState | undefined, update: T): T {
  if (!previous) return update;
  const patch = { ...update };
  if (patch.mtEvent !== 'snapshot' && previous.sourceTableId && previous.sourceTableId !== previous.id && patch.sourceTableId === patch.id)
    patch.sourceTableId = previous.sourceTableId;
  if (olderGame(previous, patch)) {
    for (const key of gameKeys) delete patch[key];
    return patch;
  }
  // Countdown protection applies within a shoe, not across a confirmed shoe
  // change. Otherwise new roads can be merged under the previous AI identity.
  if (changedOfficialShoe(previous, patch)) return patch;
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
    // An alias may receive the new shoe before its source's next packet.
    if (changedOfficialShoe(table, source) && olderGame(table, source)) return table;
    const base = mtMergeBase(table, source)!;
    const next = { ...base };
    if (base !== table) Object.assign(next, {
      banker: '0', player: '0', tie: '0', beadPlate: '', bigRoad: '',
      bigEyeRoad: '', smallRoad: '', cockroachRoad: '',
    });
    for (const key of [...clockKeys, 'round', 'shoe'] as const) {
      if (source[key] !== undefined) Object.assign(next, { [key]: source[key] });
    }
    return next;
  });
}
