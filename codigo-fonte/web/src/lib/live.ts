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

// o estado só vai para a tela quando muda (ou, ao vivo, no máximo a cada 5 s): uma rajada de eventos não redesenha o app
let lastStatus: LiveStatus | null = null; let lastEmit = 0;
function emitStatus(s: LiveStatus) {
  const t = Date.now();
  if (s === lastStatus && t - lastEmit < 5000) return;
  lastStatus = s; lastEmit = t;
  statusListeners.forEach((l) => l(s, lastEventAt));
}

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
function fetchShared<T>(url: string, fresh = false): Promise<T> {
  const cur = inflight.get(url);
  // um evento que chega no meio de uma busca não pode ficar com o retrato de antes dele: busca de novo ao terminar
  if (cur) return (fresh ? cur.then(() => fetchShared<T>(url), () => fetchShared<T>(url)) : cur) as Promise<T>;
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
  const seq = useRef(0); const shown = useRef(0); const curUrl = useRef(url); curUrl.current = url;
  // fresh: pedido por um evento ou pela tela depois de uma ação (não reaproveita uma busca que começou antes)
  const load = useCallback((fresh = false) => {
    const my = ++seq.current;
    if (!url) { setLoading(false); return; }
    setLoading(true);
    // as buscas de um endereço terminam na ordem em que foram pedidas: mostra a mais nova que chegar
    fetchShared<T>(url, fresh).then((d) => { cache.set(url, d); if (curUrl.current === url && my > shown.current) { shown.current = my; setData(d); setError(null); } })
      .catch((e: Error) => { if (my === seq.current) setError(e.message); })
      .finally(() => { if (my === seq.current) setLoading(false); });
  }, [url]);
  useEffect(() => { setData(url ? (cache.get(url) as T | undefined) ?? null : null); load(); }, [load]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = types.join('|');
  useEffect(() => {
    const h: Handler = (t) => {
      if (t !== 'resync' && !types.includes(t)) return;
      if (timer.current !== null) return;
      timer.current = window.setTimeout(() => { timer.current = null; load(true); }, 150);
    };
    handlers.add(h);
    return () => { handlers.delete(h); if (timer.current !== null) clearTimeout(timer.current); timer.current = null; };
  }, [key, load]); // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, reload: useCallback(() => load(true), [load]), loading };
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
