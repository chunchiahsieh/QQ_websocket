'use client';

import { createContext, useContext, useMemo, useRef, useState, type ReactNode } from 'react';
import { createObservationSessions, updateObservationSessions } from '@/lib/ai-observation-session';
import type { TableInfo } from '@/components/baccarat-table-card';

const ObservationContext = createContext<ReadonlyMap<string, string>>(new Map());
let providerSequence = 0;

export function AiObservationProvider({ tablesByPlatform, connectedByPlatform, children }: {
  tablesByPlatform: Record<'MT' | 'DG' | 'AB', TableInfo[]>;
  connectedByPlatform: Record<'MT' | 'DG' | 'AB', boolean>;
  children: ReactNode;
}) {
  const [scope] = useState(() => `feed-${Date.now()}-${++providerSequence}`);
  const sessions = useRef(createObservationSessions(scope));
  const observedInputs = useRef<Partial<typeof tablesByPlatform>>({});
  const epochs = useMemo(() => {
    for (const platform of ['MT', 'DG', 'AB'] as const) {
      const tables = tablesByPlatform[platform];
      if (!connectedByPlatform[platform] || observedInputs.current[platform] === tables) continue;
      sessions.current = updateObservationSessions(sessions.current, tables, Date.now());
      observedInputs.current[platform] = tables;
    }
    return new Map([...sessions.current.tables].map(([id, session]) => [id, session.epoch]));
  }, [tablesByPlatform, connectedByPlatform]);
  return <ObservationContext.Provider value={epochs}>{children}</ObservationContext.Provider>;
}

export const useAiObservationSession = (tableId: string) => useContext(ObservationContext).get(tableId);
