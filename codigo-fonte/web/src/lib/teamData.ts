/**
 * Equipe por partes (docs/EQUIPE_VISUAL.md): listas paginadas por cursor, com o total contado no servidor, e
 * atualização incremental — uma mudança num agente busca só aquele agente e acerta as listas carregadas (tirar,
 * pôr na posição certa ou só ajustar o total), sem baixar a equipe inteira. Respostas atrasadas são descartadas.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { useLiveEvent } from './live.ts';

export interface TeamAgent {
  id: string; name: string; role: string; color: string; status: 'active' | 'archived'; demo: boolean; coordinator: boolean;
  char_key: string | null; look_seed: number | null; deactivation_note: string | null;
  sector_key: string; sector_name: string; building_id: string | null; building_name: string | null; floor_name: string | null;
  run_status: 'queued' | 'running' | 'waiting_user' | null;
}
export interface TeamSector { key: string; name: string; description: string | null; custom: boolean; count: number; sample: TeamAgent[] }
export interface TeamStructure {
  id: string; kind: string; kind_name: string; name: string; i: number; j: number;
  floors: number; max_floors: number; slots: number; active: number; free: number; can_grow: boolean; sample: TeamAgent[];
}
export interface Page<T> { items: T[]; total: number; next: string | null }
export interface TeamSummary {
  agents: { active: number; archived: number }; sectors: number; structures: number;
  capacity: { slots: number; active: number; free: number }; coordinatorId: string | null; themed: number; autoGrow: boolean;
}
export interface Placement { sectorKey: string; sectorName: string; structureId: string | null; structureName: string | null }
export type Destination = { kind: 'sector'; key: string; name: string } | { kind: 'structure'; id: string; name: string };

/** Igual ao `fold()` do banco (server/src/db/db.ts): sem acento e em minúsculas. */
export const fold = (v: string): string => v.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** A mesma ordem do servidor: Coordenador primeiro, depois o nome sem acento, depois o id. */
export function compareAgents(a: TeamAgent, b: TeamAgent): number {
  if (a.coordinator !== b.coordinator) return a.coordinator ? -1 : 1;
  return cmp(fold(a.name), fold(b.name)) || cmp(a.id, b.id);
}

export interface AgentFilter { q?: string; sector?: string; structure?: string; status?: 'active' | 'archived' | 'all' }
/** O agente cabe nesta lista? (o que o servidor filtra, para acertar a lista sem pedir de novo) */
export function matches(a: TeamAgent, f: AgentFilter): boolean {
  const status = f.structure ? 'active' : f.status ?? 'active';
  if (status !== 'all' && a.status !== status) return false;
  if (f.sector && a.sector_key !== f.sector) return false;
  if (f.structure && a.building_id !== f.structure) return false;
  if (f.q?.trim()) { const q = fold(f.q.trim()); if (!fold(a.name).includes(q) && !fold(a.role).includes(q)) return false; }
  return true;
}

export interface ListState { items: TeamAgent[]; total: number; next: string | null }
/**
 * Acerta uma lista carregada com a versão nova de um agente (ou null = sumiu). Pura (testada): fora do filtro, sai;
 * dentro e já presente, troca no lugar certo; dentro e ausente, entra se a posição cair no trecho já carregado (ou a
 * lista estiver completa) — senão só o total aumenta e ele aparece ao carregar mais.
 */
export function patchList(s: ListState, id: string, fresh: TeamAgent | null, f: AgentFilter): ListState {
  const at = s.items.findIndex((x) => x.id === id);
  const fits = !!fresh && matches(fresh, f);
  let items = s.items; let total = s.total;
  if (at >= 0) { items = items.filter((x) => x.id !== id); if (!fits) total = Math.max(0, total - 1); }
  else if (fits) total += 1;
  if (fits && fresh) {
    const pos = items.findIndex((x) => compareAgents(fresh, x) < 0);
    if (pos >= 0) items = [...items.slice(0, pos), fresh, ...items.slice(pos)];
    else if (!s.next) items = [...items, fresh];
  }
  return { items, total, next: s.next };
}

const qs = (o: Record<string, string | number | undefined | null | false>) =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== false && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const teamUrl = {
  agents: (f: AgentFilter, cursor?: string | null, limit = 48) => `/api/team/agents?${qs({ q: f.q?.trim(), sector: f.sector, structure: f.structure, status: f.status, cursor, limit })}`,
  sectors: (q?: string, cursor?: string | null, limit = 24) => `/api/team/sectors?${qs({ q: q?.trim(), cursor, limit })}`,
  structures: (o: { q?: string; free?: boolean }, cursor?: string | null, limit = 24) => `/api/team/structures?${qs({ q: o.q?.trim(), free: o.free ? 1 : false, cursor, limit })}`,
};

/** Busca de um agente só (a projeção leve), com a resposta mais nova ganhando. */
const agentSeq = new Map<string, number>();
export async function fetchTeamAgent(id: string): Promise<TeamAgent | null | 'stale'> {
  const my = (agentSeq.get(id) ?? 0) + 1; agentSeq.set(id, my);
  try {
    const a = await api.get<TeamAgent>(`/api/team/agents/${id}`);
    return agentSeq.get(id) === my ? a : 'stale';
  } catch (e) {
    if ((e as { status?: number }).status === 404) return agentSeq.get(id) === my ? null : 'stale';
    throw e;
  }
}

/**
 * Lista de agentes por partes: carrega a primeira página, "mais" quando a tela pede (rolagem), e se acerta sozinha
 * com as mudanças: eventos com o id do agente buscam só ele (agrupados em rajadas); sem id, ou muitos de uma vez,
 * recomeça. `scope` (ex.: o workspace) muda = tudo de novo, e respostas da consulta antiga são ignoradas.
 */
export function useAgentList(f: AgentFilter | null, scope: string, pageSize = 48) {
  const key = f ? `${scope}|${f.q ?? ''}|${f.sector ?? ''}|${f.structure ?? ''}|${f.status ?? ''}` : null;
  const [s, setS] = useState<ListState & { loading: boolean; error: string | null; ready: boolean }>({ items: [], total: 0, next: null, loading: false, error: null, ready: false });
  const epoch = useRef(0); const busy = useRef(false); const fref = useRef(f); fref.current = f;
  const stateRef = useRef(s); stateRef.current = s;

  const load = useCallback((reset: boolean) => {
    const filter = fref.current; if (!filter) return;
    if (!reset && (busy.current || !stateRef.current.next)) return;
    const my = reset ? ++epoch.current : epoch.current;
    busy.current = true; setS((x) => ({ ...x, loading: true }));
    api.get<Page<TeamAgent>>(teamUrl.agents(filter, reset ? null : stateRef.current.next, pageSize))
      .then((p) => {
        if (my !== epoch.current) return;
        setS((x) => {
          const base = reset ? [] : x.items; const seen = new Set(base.map((a) => a.id));
          return { items: [...base, ...p.items.filter((a) => !seen.has(a.id))], total: p.total, next: p.next, loading: false, error: null, ready: true };
        });
      })
      .catch((e: Error) => { if (my === epoch.current) setS((x) => ({ ...x, loading: false, error: e.message })); })
      .finally(() => { if (my === epoch.current) busy.current = false; });
  }, [pageSize]);

  useEffect(() => { if (key) { busy.current = false; setS({ items: [], total: 0, next: null, loading: false, error: null, ready: false }); load(true); } }, [key, load]);

  // mudanças: rajadas agrupadas; com id, só aquele agente
  const pending = useRef<Set<string> | 'all'>(new Set()); const timer = useRef<number | null>(null);
  const flush = useCallback(async () => {
    timer.current = null;
    const ids = pending.current; pending.current = new Set();
    const filter = fref.current; if (!filter) return;
    if (ids === 'all' || ids.size > 20) { load(true); return; }
    const my = epoch.current;
    for (const id of ids) {
      try {
        const fresh = await fetchTeamAgent(id);
        if (fresh === 'stale' || my !== epoch.current) continue;
        setS((x) => ({ ...x, ...patchList(x, id, fresh, filter) }));
      } catch { /* a próxima mudança ou a rolagem acerta */ }
    }
  }, [load]);
  const onChange = useCallback((data: Record<string, unknown>) => {
    if (!fref.current) return;
    const id = typeof data.id === 'string' ? data.id : null;
    if (!id) pending.current = 'all'; else if (pending.current !== 'all') pending.current.add(id);
    if (timer.current === null) timer.current = window.setTimeout(() => { void flush(); }, 200);
  }, [flush]);
  useLiveEvent('agents.changed', onChange);
  useLiveEvent('resync', useCallback(() => { pending.current = 'all'; if (timer.current === null) timer.current = window.setTimeout(() => { void flush(); }, 200); }, [flush]));
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);

  /** Ajuste local imediato (ex.: o movimento que a pessoa acabou de fazer), confirmado depois pelo evento. */
  const patch = useCallback((id: string, fresh: TeamAgent | null) => { const filter = fref.current; if (filter) setS((x) => ({ ...x, ...patchList(x, id, fresh, filter) })); }, []);
  return { ...s, more: () => load(false), reload: () => load(true), patch };
}

/** Uma página de grupos (setores ou construções) com cursor; recarrega a página atual quando a equipe muda. */
export function useGroupPages<T>(urlOf: (cursor: string | null) => string | null, deps: string, types: string[] = ['agents.changed', 'city.changed']) {
  const [pages, setPages] = useState<Array<string | null>>([null]); // cursores visitados: voltar é instantâneo
  const [at, setAt] = useState(0);
  const [data, setData] = useState<Page<T> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0); const urlRef = useRef(urlOf); urlRef.current = urlOf;
  const cursor = pages[at] ?? null;
  const load = useCallback(() => {
    const url = urlRef.current(cursor); if (!url) return;
    const my = ++seq.current;
    api.get<Page<T>>(url).then((p) => { if (my === seq.current) { setData(p); setError(null); } }).catch((e: Error) => { if (my === seq.current) setError(e.message); });
  }, [cursor]);
  useEffect(() => { setPages([null]); setAt(0); }, [deps]);
  useEffect(() => { load(); }, [load, deps]);
  const timer = useRef<number | null>(null);
  const bump = useCallback(() => { if (timer.current === null) timer.current = window.setTimeout(() => { timer.current = null; load(); }, 250); }, [load]);
  for (const t of types) useLiveEvent(t, bump); // eslint-disable-line react-hooks/rules-of-hooks
  useLiveEvent('resync', bump);
  useEffect(() => () => { if (timer.current !== null) clearTimeout(timer.current); }, []);
  return {
    data, error, page: at, reload: load,
    next: data?.next ? () => { setPages((p) => [...p.slice(0, at + 1), data.next]); setAt(at + 1); } : null,
    prev: at > 0 ? () => setAt(at - 1) : null,
  };
}
