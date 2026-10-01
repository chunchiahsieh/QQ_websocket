import { aiObservationSnapshot, type AiObservationSnapshot } from './ai-observed-predictions.ts';

export type ObservationTable = {
  id: string; shoe: string; beadPlate: string; bigRoad: string;
  banker: string; player: string; tie: string;
  aiOutcomes?: ('1' | '2' | '3')[]; tablePhase?: string | null; tableState?: string;
};
type Session = { epoch: string; snapshot: AiObservationSnapshot; seenAt: number; resetCandidate?: AiObservationSnapshot };
export type ObservationSessions = { scope: string; sequence: number; tables: Map<string, Session> };
export const createObservationSessions = (scope: string): ObservationSessions => ({ scope, sequence: 0, tables: new Map() });
export const hasOfficialShoe = (shoe: string) => Boolean(shoe.trim()) && !/^(?:[-—–?]+|unknown|undefined|null|n\/a|0)$/i.test(shoe.trim());
const extendsHistory = (before: AiObservationSnapshot, after: AiObservationSnapshot) => after.total >= before.total
  && before.outcomes.every((outcome, index) => after.outcomes[index] === outcome);

/** Own unknown-shoe identities at feed level, independent of cards/strategies. */
export function updateObservationSessions(previous: ObservationSessions, tables: readonly ObservationTable[], now: number): ObservationSessions {
  const next = { ...previous, tables: new Map(previous.tables) };
  for (const table of tables) {
    if (hasOfficialShoe(table.shoe)) continue;
    const snapshot = aiObservationSnapshot(table.beadPlate, Number(table.banker) + Number(table.player) + Number(table.tie),
      table.tablePhase === 'shuffling' || table.tableState === '2', Number(table.banker) + Number(table.player),
      { fullOutcomes: table.aiOutcomes, road: table.bigRoad, bankerTotal: Number(table.banker) });
    if (!snapshot) continue;
    const before = next.tables.get(table.id);
    // No replay across an unobserved gap: identical opening results alone do
    // not prove the same shoe. Connected feeds refresh at least every 10 s.
    let changed = !before || now - before.seenAt > 30_000;
    if (before && !changed && !extendsHistory(before.snapshot, snapshot)) {
      // One delayed packet is not proof of a new shoe. Require a witnessed
      // shuffle or a new history that subsequently advances coherently.
      changed = before.snapshot.shuffling || Boolean(before.resetCandidate
        && snapshot.total > before.resetCandidate.total && extendsHistory(before.resetCandidate, snapshot));
      if (!changed) {
        next.tables.set(table.id, { ...before, seenAt: now, resetCandidate: snapshot });
        continue;
      }
    }
    const epoch = changed || !before ? `${next.scope}:${++next.sequence}` : before.epoch;
    next.tables.set(table.id, { epoch, snapshot, seenAt: now });
  }
  return next;
}
