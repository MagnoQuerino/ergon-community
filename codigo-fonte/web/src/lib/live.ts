import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

// Uma única conexão SSE por aba/workspace; componentes assinam tipos de evento e recarregam dados.
type Handler = (type: string, data: unknown) => void;
const handlers = new Set<Handler>();
export type LiveStatus = 'conectando' | 'ao_vivo' | 'reconectando';
const statusListeners = new Set<(s: LiveStatus, at: Date | null) => void>();
let source: EventSource | null = null;
let lastEventAt: Date | null = null;

const TYPES = ['tasks.changed', 'runs.changed', 'messages.changed', 'agents.changed', 'events.changed', 'audit.created', 'rules.changed', 'artifacts.changed', 'city.changed', 'proposals.changed', 'integrations.changed', 'routines.changed', 'resync'];

function emitStatus(s: LiveStatus) { statusListeners.forEach((l) => l(s, lastEventAt)); }

export function startLive(): () => void {
  if (source) return () => {};
  const es = new EventSource('/api/events');
  source = es;
  emitStatus('conectando');
  es.onopen = () => { emitStatus('ao_vivo'); handlers.forEach((h) => h('resync', {})); };
  es.onerror = () => emitStatus('reconectando');
  for (const t of TYPES) {
    es.addEventListener(t, (ev) => {
      lastEventAt = new Date();
      let data: unknown = {};
      try { data = JSON.parse((ev as MessageEvent).data); } catch { /* vazio */ }
      handlers.forEach((h) => h(t, data));
      emitStatus('ao_vivo');
    });
  }
  return () => { es.close(); source = null; };
}

export function useLiveStatus(): { status: LiveStatus; at: Date | null } {
  const [s, set] = useState<{ status: LiveStatus; at: Date | null }>({ status: 'conectando', at: null });
  useEffect(() => {
    const l = (status: LiveStatus, at: Date | null) => set({ status, at });
    statusListeners.add(l);
    return () => { statusListeners.delete(l); };
  }, []);
  return s;
}

/** Recurso REST recarregado quando chegam eventos dos tipos indicados (com pequena agregação). */
export function useResource<T>(url: string | null, types: string[]): { data: T | null; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | null>(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!url) return;
    const my = ++seq.current;
    setLoading(true);
    api.get<T>(url).then((d) => { if (my === seq.current) { setData(d); setError(null); } })
      .catch((e: Error) => { if (my === seq.current) setError(e.message); })
      .finally(() => { if (my === seq.current) setLoading(false); });
  }, [url]);
  useEffect(() => { setData(null); load(); }, [load]);
  const key = types.join('|');
  useEffect(() => {
    const h: Handler = (t) => {
      if (t !== 'resync' && !types.includes(t)) return;
      if (timer.current !== null) return;
      timer.current = window.setTimeout(() => { timer.current = null; load(); }, 150);
    };
    handlers.add(h);
    return () => { handlers.delete(h); if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  }, [key, load]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: load, loading };
}
