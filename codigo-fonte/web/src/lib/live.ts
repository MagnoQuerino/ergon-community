import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';

// Uma única conexão SSE por aba/workspace; componentes assinam tipos de evento e recarregam dados.
type Handler = (type: string, data: unknown) => void;
const handlers = new Set<Handler>();
export type LiveStatus = 'conectando' | 'ao_vivo' | 'reconectando';
const statusListeners = new Set<(s: LiveStatus, at: Date | null) => void>();
let source: EventSource | null = null;
let lastEventAt: Date | null = null;

const TYPES = ['tasks.changed', 'runs.changed', 'messages.changed', 'agents.changed', 'events.changed', 'audit.created', 'rules.changed', 'artifacts.changed', 'city.changed', 'proposals.changed', 'integrations.changed', 'routines.changed', 'runs.live', 'conversations.changed', 'resync'];

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

// Última resposta de cada endereço: ao voltar a uma tela ela abre já montada com o que se viu, e a atualização chega
// por baixo sem piscar. Some ao sair ou trancar (clearResourceCache).
const cache = new Map<string, unknown>();
export function clearResourceCache() { cache.clear(); inflight.clear(); }
/** Busca em andamento por endereço: várias telas (ou vários avatares) pedindo o mesmo levam uma resposta só. */
const inflight = new Map<string, Promise<unknown>>();
function fetchShared<T>(url: string): Promise<T> {
  const cur = inflight.get(url);
  if (cur) return cur as Promise<T>;
  const p = api.get<T>(url).finally(() => { if (inflight.get(url) === p) inflight.delete(url); });
  inflight.set(url, p);
  return p;
}
/** Já buscado antes (para quem quer esperar os dados antes de mostrar a tela). */
export function cachedResource<T>(url: string): T | undefined { return cache.get(url) as T | undefined; }

/** Recurso REST recarregado quando chegam eventos dos tipos indicados (com pequena agregação). */
export function useResource<T>(url: string | null, types: string[]): { data: T | null; error: string | null; reload: () => void; loading: boolean } {
  const [data, setData] = useState<T | null>(() => (url ? (cache.get(url) as T | undefined) ?? null : null));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const timer = useRef<number | null>(null);
  const seq = useRef(0);
  const load = useCallback(() => {
    if (!url) return;
    const my = ++seq.current;
    setLoading(true);
    fetchShared<T>(url).then((d) => { cache.set(url, d); if (my === seq.current) { setData(d); setError(null); } })
      .catch((e: Error) => { if (my === seq.current) setError(e.message); })
      .finally(() => { if (my === seq.current) setLoading(false); });
  }, [url]);
  useEffect(() => { setData(url ? (cache.get(url) as T | undefined) ?? null : null); load(); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
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

/** Busca em segundo plano o que as telas vão pedir, para abrirem já montadas. Sem pedir senha: o que estiver
 * trancado fica para quando a tela abrir. */
export function prefetchResources(urls: string[]): void {
  for (const url of urls) {
    if (cache.has(url)) continue;
    fetch(url, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : undefined))
      .then((d: unknown) => { if (d !== undefined && !cache.has(url)) cache.set(url, d); })
      .catch(() => { /* a tela busca de novo ao abrir */ });
  }
}

/** Ouve um tipo de evento com os dados dele (ex.: runs.live, com o id da execução que mudou). */
export function useLiveEvent(type: string, fn: (data: Record<string, unknown>) => void): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h: Handler = (t, data) => { if (t === type) ref.current((data ?? {}) as Record<string, unknown>); };
    handlers.add(h);
    return () => { handlers.delete(h); };
  }, [type]);
}

/** Avisa as telas abertas de uma mudança feita aqui mesmo (ex.: conta de IA conectada → o modelo padrão aparece). */
export function emitLocal(type: string): void { handlers.forEach((h) => h(type, {})); }
