/**
 * Moradores da Cidade sem a equipe inteira (docs/CIDADE_REGIOES.md, "Contrato da interface → Cidade").
 *  - Cidade inteira (até 1.200 ativos; só vira "por região" acima de 1.500 e volta com 1.200 ou menos): todos, em
 *    páginas (`all=1`), entregues de uma vez na ordem do servidor — a mesma lista, a mesma ordem de entrada no motor e,
 *    portanto, a mesma vida de sempre.
 *  - Por região: a unidade de carga é o andar (toda a vida de dentro é do mesmo andar). Quer os andares das
 *    construções que cruzam a tela + meia tela — o aberto, o do escolhido e depois pela distância ao centro visível —
 *    até 1.500 agentes; mantém os que cruzam a tela + uma tela inteira e, fora disso, mais 15 s; nunca passa de 2.500
 *    (descarrega primeiro o mais longe). No mapa não carrega nada novo e, depois de 20 s, descarrega. Pede 250 ms
 *    depois de a câmera parar, até 100 andares por pedido, e descarta a resposta de um pedido que outro mais novo já
 *    cobriu. Quem sai da lista vai embora no motor só quando estiver parado (engine.ts, `partial`).
 *  - Eventos: runs.changed {agentId} busca só esse agente (`ids=`), se carregado, juntando os pedidos; agents.changed
 *    (qualquer formato), city.changed e resync recarregam o overview e os andares carregados, no máximo 1 vez por
 *    segundo; o overview também recarrega em runs.changed, no máximo 1 vez por segundo.
 * A classe é pura (buscador e relógio injetáveis, testada sem navegador: cityData.test.ts); o hook a liga ao SSE e ao
 * cache das telas (voltar à Cidade já montada).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api.ts';
import { cachedResource, useLiveEvent, useResource } from './live.ts';
import type { CityAgent, CityAgentsPage, CityOverview } from './types.ts';
import type { SceneAgent, SceneWindow } from '../scene/types.ts';

export const OVERVIEW_URL = '/api/city/overview';
export const CITY_AGENTS_URL = '/api/city/agents';
/** até aqui, a cidade inteira (e volta para ela); acima de REGION_MIN, por região */
export const WHOLE_MAX = 1200;
export const REGION_MIN = 1500;
/** agentes carregados que se quer (por região) e o teto duro de carregados */
export const BUDGET = 1500;
export const HARD_CAP = 2500;
export const GRACE_MS = 15_000;
export const MAP_UNLOAD_MS = 20_000;
export const SETTLE_MS = 250;
export const FLOORS_PER_REQUEST = 100;
export const IDS_PER_REQUEST = 200;
/** eventos: juntados por COALESCE_MS e no máximo um recarregar a cada EVENT_GAP_MS */
export const EVENT_GAP_MS = 1000;
export const COALESCE_MS = 150;
export const RETRY_MS = 3000;

export type CityMode = 'cidade' | 'regiao';
export interface Clock { now(): number; after(ms: number, fn: () => void): unknown; cancel(h: unknown): void }
export interface CityLoaderDeps {
  /** GET /api/city/agents?<consulta>: `all=1[&cursor=…]`, `f=<andar>,…` ou `ids=<agente>,…` */
  agents(query: string): Promise<CityAgentsPage>;
  /** pede o overview de novo (a resposta chega por setOverview) */
  reloadOverview(): void;
  /** a lista, o modo ou a prontidão mudaram */
  changed(): void;
  clock?: Clock;
}

const realClock: Clock = {
  now: () => performance.now(),
  after: (ms, fn) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Ordem do servidor: construção (comparação de código, como o BINARY do SQLite), andar e vaga. */
export function cityOrder(a: CityAgent, b: CityAgent): number {
  if (a.building_id !== b.building_id) return a.building_id < b.building_id ? -1 : 1;
  return a.level - b.level || a.slot - b.slot;
}

/** Linha do servidor → agente da cena (os mesmos campos de antes, com a casa vinda pronta). */
export function toScene(a: CityAgent): SceneAgent {
  return {
    id: a.id, name: a.name, color: a.color, role: a.role, key: a.char_key, seed: a.look_seed ?? null,
    building: a.building_id, level: a.level, slot: a.slot, run: a.run_status, outcome: a.last_outcome ?? null, house: a.house,
  };
}

interface FloorInfo { id: string; building: string; level: number; active: number }

export class CityLoader {
  private readonly d: CityLoaderDeps;
  private readonly clock: Clock;
  private ov: CityOverview | null = null;
  // andares do overview: por construção (pelo nível), por id e por (construção, nível)
  private floorsOf = new Map<string, FloorInfo[]>();
  private floorAt = new Map<string, FloorInfo>();
  private floorKey = new Map<string, string>();
  private _mode: CityMode | null = null;
  private agents = new Map<string, CityAgent>();
  // de que pedido veio o que se sabe de cada agente: o mais novo ganha (fica também depois de ele sair, para uma
  // resposta antiga não trazê-lo de volta)
  private seqOf = new Map<string, number>();
  // andares carregados → moradores (na cidade inteira, todos os andares com gente)
  private loaded = new Map<string, Set<string>>();
  private floorReq = new Map<string, number>();
  private inflight = new Set<string>();
  private redo = new Set<string>();
  private outSince = new Map<string, number>();
  private keepSet = new Set<string>();
  private seq = 0;
  private wholeReq = 0; private wholeBusy = false; private wholeDone = false; private wholeAgain = false;
  private everReady = false; private stale = false;
  private win: SceneWindow | null = null;
  private visible = true; private stopped = false;
  private mapSince: number | null = null;
  private pendingIds = new Set<string>();
  private timers = new Map<string, unknown>();
  private checkAt: number | null = null;
  private lastReload = -Infinity; private lastOverview = -Infinity;
  private sorted: CityAgent[] | null = null;
  private _error: string | null = null;
  /** muda a cada mudança entregue */
  version = 0;

  constructor(deps: CityLoaderDeps) { this.d = deps; this.clock = deps.clock ?? realClock; }

  get mode(): CityMode | null { return this._mode; }
  /** já dá para desenhar: cidade inteira com todos, ou por região com o overview (e fica assim) */
  get ready(): boolean { return this.everReady; }
  /** a lista não é a cidade inteira (por região, ou voltando para a inteira) */
  get partial(): boolean { return this._mode !== 'cidade' || !this.wholeDone; }
  get error(): string | null { return this._error; }
  /** carregados, na ordem do servidor (a mesma referência enquanto nada muda) */
  get list(): CityAgent[] { return (this.sorted ??= [...this.agents.values()].sort(cityOrder)); }
  get(id: string): CityAgent | undefined { return this.agents.get(id); }
  /** para testes e medição: andares carregados, a caminho e quantos agentes */
  stats(): { floors: string[]; inflight: string[]; agents: number } { return { floors: [...this.loaded.keys()], inflight: [...this.inflight], agents: this.agents.size }; }

  /** Começa com o que já se viu nesta sessão (voltar à Cidade já montada); o servidor confirma por baixo. */
  seed(list: CityAgent[], mode: CityMode): void {
    if (this._mode !== null) return;
    const s = ++this.seq;
    this._mode = mode; this.wholeDone = mode === 'cidade'; this.stale = true; this.everReady = true;
    for (const a of list) this.put(a, s, true);
  }

  setOverview(ov: CityOverview): void {
    if (ov === this.ov) return;
    this.ov = ov; this.index(ov);
    const prev = this._mode;
    // histerese: só vira "por região" acima de 1.500 e volta para a cidade inteira com 1.200 ou menos
    const next: CityMode = prev === 'regiao' ? (ov.total <= WHOLE_MAX ? 'cidade' : 'regiao') : ov.total > REGION_MIN ? 'regiao' : 'cidade';
    this._mode = next;
    if (next === 'cidade') {
      if (prev === 'regiao') this.wholeDone = false; // até a lista inteira chegar, a de agora é parcial
      if (prev !== 'cidade' || this.stale) this.loadWhole();
    } else {
      if (prev === 'cidade') { this.wholeReq = ++this.seq; this.wholeBusy = false; } // a carga inteira em andamento não vale mais
      if (this.stale && this.loaded.size) this.fetchFloors([...this.loaded.keys()]);
      this.everReady = true;
      this.evaluate();
    }
    this.stale = false;
    this.touch();
  }

  /** O que a cena tem perto da tela (engine.ts): decide 250 ms depois da última mudança (a câmera parou). */
  setWindow(w: SceneWindow): void {
    const wasMap = !!this.win?.map;
    this.win = w;
    if (w.map && !wasMap) { this.mapSince = this.clock.now(); this.outSince.clear(); }
    else if (!w.map) this.mapSince = null;
    if (this._mode !== 'regiao') return;
    this.cancel('settle');
    this.later('settle', SETTLE_MS, () => this.evaluate());
  }

  /** Cidade escondida (outra área do Ergon): o que está carregado continua se atualizando, mas nada entra nem sai. */
  setActive(on: boolean): void {
    if (on === this.visible) return;
    this.visible = on;
    if (on && this._mode === 'regiao') { this.cancel('settle'); this.later('settle', SETTLE_MS, () => this.evaluate()); }
  }

  /** Eventos do SSE (o payload de runs.changed traz agentId). */
  event(type: string, data: Record<string, unknown> = {}): void {
    if (type === 'runs.changed') {
      const id = typeof data.agentId === 'string' ? data.agentId : null;
      if (id && this.agents.has(id)) { this.pendingIds.add(id); this.later('ids', COALESCE_MS, () => this.flushIds()); }
      this.overviewSoon();
      return;
    }
    if (type === 'agents.changed' || type === 'city.changed' || type === 'resync') {
      // a primeira carga já está a caminho (o SSE avisa "resync" ao conectar): não precisa de outra
      if (type === 'resync' && !this.everReady) return;
      this.overviewSoon(); this.reloadSoon();
    }
  }

  /** Para os relógios (a tela saiu); start retoma o que estava esperando (React em modo estrito desmonta e monta). */
  stop(): void {
    this.stopped = true;
    for (const h of this.timers.values()) this.clock.cancel(h);
    this.timers.clear(); this.checkAt = null;
  }
  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    if (this._mode === 'cidade' && !this.wholeDone && !this.wholeBusy) this.loadWhole();
    if (this._mode === 'regiao') this.evaluate();
    if (this.pendingIds.size) this.flushIds();
  }

  // ------------------------------------------------------------------ cidade inteira
  private loadWhole(): void {
    if (this._mode !== 'cidade') return;
    if (this.wholeBusy) { this.wholeAgain = true; return; } // uma carga já vai: outra logo depois, com o que mudou
    const my = ++this.seq; this.wholeReq = my; this.wholeBusy = true; this.wholeAgain = false;
    const out: CityAgent[] = [];
    const page = (cursor: string | null): Promise<void> => this.d.agents(cursor ? `all=1&cursor=${encodeURIComponent(cursor)}` : 'all=1').then((p) => {
      if (this.wholeReq !== my) return;
      for (const a of p.agents) out.push(a);
      if (p.next) return page(p.next);
      this.wholeBusy = false;
      this.applyWhole(out, my);
      if (this.wholeAgain) this.loadWhole();
    });
    page(null).catch((e: unknown) => {
      if (this.wholeReq !== my) return;
      this.wholeBusy = false; this.fail(e);
      this.later('retry', RETRY_MS, () => { if (this.wholeReq === my) this.loadWhole(); });
    });
  }

  private applyWhole(list: CityAgent[], s: number): void {
    if (this._mode !== 'cidade') return;
    const ids = new Set<string>();
    for (const a of list) { ids.add(a.id); this.put(a, s, true); }
    for (const id of [...this.agents.keys()]) if (!ids.has(id) && (this.seqOf.get(id) ?? -1) < s) this.drop(id, s);
    this.wholeDone = true; this.everReady = true; this._error = null;
    this.touch();
  }

  // ------------------------------------------------------------------ por região
  /** Decide o que buscar, o que manter e o que descarregar (pela última janela da cena). */
  private evaluate(): void {
    this.cancel('settle');
    if (this._mode !== 'regiao' || !this.ov || this.stopped) return;
    const w = this.win; if (!w) return;
    const now = this.clock.now();
    // prioridade: 1. o andar aberto; 2. o andar do escolhido; 3. a distância ao centro visível
    const mandatory: string[] = [];
    const must = (b: string, l: number) => { const f = this.floorKey.get(`${b}|${l}`); if (f && !mandatory.includes(f)) mandatory.push(f); };
    if (w.open) must(w.open.building, w.open.level);
    if (w.selected) must(w.selected.building, w.selected.level);
    const dist = new Map<string, number>(); const keep = new Set<string>(mandatory); const near: string[] = [];
    if (!w.map) for (const b of w.buildings) {
      dist.set(b.id, b.dist);
      for (const f of this.floorsOf.get(b.id) ?? []) { keep.add(f.id); if (b.near) near.push(f.id); }
    }
    this.keepSet = keep;
    let changed = false;
    // o que saiu do que se mantém: 15 s de carência; no mapa, tudo depois de 20 s (escondida, nada sai)
    if (this.visible) {
      if (w.map) {
        if (this.mapSince !== null) {
          const at = this.mapSince + MAP_UNLOAD_MS;
          if (now >= at) { const s = ++this.seq; for (const f of [...this.loaded.keys()]) if (!keep.has(f)) { this.unload(f, s); changed = true; } }
          else this.checkLater(at);
        }
      } else {
        for (const f of this.loaded.keys()) if (keep.has(f)) this.outSince.delete(f); else if (!this.outSince.has(f)) this.outSince.set(f, now);
        let s = 0;
        for (const [f, t0] of [...this.outSince]) {
          if (!this.loaded.has(f) || keep.has(f)) { this.outSince.delete(f); continue; }
          if (now - t0 >= GRACE_MS) { s ||= ++this.seq; this.unload(f, s); changed = true; } else this.checkLater(t0 + GRACE_MS);
        }
      }
    }
    // o que se quer: no mapa ou escondida, nada novo
    if (this.visible && !w.map) {
      const cost = (f: string) => this.loaded.get(f)?.size ?? this.floorAt.get(f)?.active ?? 0;
      const want: string[] = [...mandatory]; const inWant = new Set(want);
      let sum = 0; for (const f of mandatory) sum += cost(f);
      for (const f of near) {
        if (inWant.has(f)) continue;
        const c = cost(f); if (!c) continue; // andar vazio: nada a buscar
        if (sum + c > BUDGET) break; // orçamento: o mais perto primeiro, sem pular para um mais longe que caiba
        sum += c; want.push(f); inWant.add(f);
      }
      const missing = want.filter((f) => (!this.loaded.has(f) || this.redo.has(f)) && !this.inflight.has(f));
      // teto duro: carregados + a caminho + o que falta, nunca acima de 2.500 (sai o mais longe, fora do que se mantém primeiro)
      let total = this.agents.size; for (const f of this.inflight) if (!this.loaded.has(f)) total += this.floorAt.get(f)?.active ?? 0;
      let need = 0; for (const f of missing) if (!this.loaded.has(f)) need += this.floorAt.get(f)?.active ?? 0;
      if (total + need > HARD_CAP) {
        const rank = (f: string) => { const b = this.floorAt.get(f)?.building; return keep.has(f) && b !== undefined ? dist.get(b) ?? Infinity : Infinity; };
        const far = [...this.loaded.keys()].filter((f) => !inWant.has(f)).sort((a, b) => rank(b) - rank(a));
        const s = ++this.seq;
        for (const f of far) { if (total + need <= HARD_CAP) break; total -= this.loaded.get(f)?.size ?? 0; this.unload(f, s); changed = true; }
        // ainda não cabe: fica de fora o fim da fila (menos prioridade); o aberto e o do escolhido sempre entram
        const fixed = missing.filter((f) => mandatory.includes(f)).length;
        while (missing.length > fixed && total + need > HARD_CAP) { const f = missing.pop()!; if (!this.loaded.has(f)) need -= this.floorAt.get(f)?.active ?? 0; }
      }
      if (missing.length) this.fetchFloors(missing);
    }
    if (changed) this.touch();
  }

  private fetchFloors(list: string[]): void {
    for (let i = 0; i < list.length; i += FLOORS_PER_REQUEST) {
      const chunk = list.slice(i, i + FLOORS_PER_REQUEST); const s = ++this.seq;
      for (const f of chunk) { this.floorReq.set(f, s); this.inflight.add(f); this.redo.delete(f); }
      this.d.agents(`f=${chunk.map(encodeURIComponent).join(',')}`).then((p) => this.applyFloors(chunk, p.agents, s), (e: unknown) => this.floorsFailed(chunk, s, e));
    }
  }

  private applyFloors(chunk: string[], list: CityAgent[], s: number): void {
    const by = new Map<string, CityAgent[]>();
    for (const a of list) { const l = by.get(a.floor_id); if (l) l.push(a); else by.set(a.floor_id, [a]); }
    let changed = false;
    for (const f of chunk) {
      if (this.floorReq.get(f) !== s) continue; // um pedido mais novo cobre este andar: resposta velha
      this.inflight.delete(f);
      // não se quer mais (a câmera foi embora enquanto a resposta vinha), ou a cidade voltou a ser inteira
      if (this._mode !== 'regiao' || (!this.loaded.has(f) && !this.keepSet.has(f))) continue;
      this.replaceFloor(f, by.get(f) ?? [], s); changed = true;
    }
    if (changed) { this._error = null; this.touch(); }
  }

  private floorsFailed(chunk: string[], s: number, e: unknown): void {
    for (const f of chunk) if (this.floorReq.get(f) === s) { this.inflight.delete(f); if (this.loaded.has(f)) this.redo.add(f); }
    this.fail(e);
    this.later('retry', RETRY_MS, () => { this.reloadRedo(); this.evaluate(); });
  }

  /** Andar carregado cuja recarga falhou: busca de novo (mesmo fora do orçamento, ele já está carregado). */
  private reloadRedo(): void {
    const list = [...this.redo].filter((f) => this.loaded.has(f) && !this.inflight.has(f));
    if (list.length && this._mode === 'regiao') this.fetchFloors(list);
  }

  /** Moradores de um andar = os da resposta (quem não veio saiu do andar, se nada mais novo disse o contrário). */
  private replaceFloor(f: string, list: CityAgent[], s: number): void {
    let set = this.loaded.get(f);
    if (!set) { set = new Set(); this.loaded.set(f, set); }
    const fresh = new Set(list.map((a) => a.id));
    for (const id of [...set]) if (!fresh.has(id) && (this.seqOf.get(id) ?? -1) < s) this.drop(id, s);
    for (const a of list) this.put(a, s, false);
  }

  private unload(f: string, s: number): void {
    const set = this.loaded.get(f);
    this.loaded.delete(f); this.outSince.delete(f); this.inflight.delete(f); this.redo.delete(f);
    this.floorReq.set(f, s); // uma resposta a caminho para este andar já não vale
    for (const id of set ?? []) if (this.agents.get(id)?.floor_id === f) { this.agents.delete(id); this.seqOf.set(id, s); this.sorted = null; }
  }

  // ------------------------------------------------------------------ eventos
  private flushIds(): void {
    const ids = [...this.pendingIds].filter((id) => this.agents.has(id));
    this.pendingIds.clear();
    for (let i = 0; i < ids.length; i += IDS_PER_REQUEST) {
      const chunk = ids.slice(i, i + IDS_PER_REQUEST); const s = ++this.seq;
      this.d.agents(`ids=${chunk.map(encodeURIComponent).join(',')}`).then((p) => this.applyIds(chunk, p.agents, s), (e: unknown) => this.fail(e));
    }
  }

  private applyIds(asked: string[], list: CityAgent[], s: number): void {
    const whole = this._mode === 'cidade'; const got = new Set<string>();
    for (const a of list) {
      got.add(a.id);
      // por região, só quem continua carregado (e no mesmo conjunto de andares)
      if (whole || this.agents.has(a.id)) this.put(a, s, whole);
    }
    // pedido e não veio: não é mais ativo
    for (const id of asked) if (!got.has(id) && (this.seqOf.get(id) ?? -1) < s) this.drop(id, s);
    this.touch();
  }

  private overviewSoon(): void {
    if (this.timers.has('overview')) return;
    const wait = Math.max(COALESCE_MS, this.lastOverview + EVENT_GAP_MS - this.clock.now());
    this.later('overview', wait, () => { this.lastOverview = this.clock.now(); this.d.reloadOverview(); });
  }

  private reloadSoon(): void {
    if (this.timers.has('reload')) return;
    const wait = Math.max(COALESCE_MS, this.lastReload + EVENT_GAP_MS - this.clock.now());
    this.later('reload', wait, () => {
      this.lastReload = this.clock.now();
      if (this._mode === 'cidade') this.loadWhole();
      else if (this._mode === 'regiao' && this.loaded.size) this.fetchFloors([...this.loaded.keys()]);
    });
  }

  // ------------------------------------------------------------------ peças
  /** Guarda o que veio do pedido `s`, se for mais novo que o que já se sabe dele. `create`: pode abrir o andar (cidade inteira). */
  private put(a: CityAgent, s: number, create: boolean): void {
    if ((this.seqOf.get(a.id) ?? -1) > s) return;
    this.seqOf.set(a.id, s);
    const prev = this.agents.get(a.id);
    if (prev && prev.floor_id !== a.floor_id) this.loaded.get(prev.floor_id)?.delete(a.id);
    let set = this.loaded.get(a.floor_id);
    if (!set) {
      // mudou para um andar que não está carregado (por região): sai
      if (!create) { if (prev) { this.agents.delete(a.id); this.sorted = null; } return; }
      set = new Set(); this.loaded.set(a.floor_id, set);
    }
    set.add(a.id); this.agents.set(a.id, a); this.sorted = null;
  }

  private drop(id: string, s: number): void {
    const a = this.agents.get(id); this.seqOf.set(id, s);
    if (!a) return;
    this.loaded.get(a.floor_id)?.delete(id); this.agents.delete(id); this.sorted = null;
  }

  private index(ov: CityOverview): void {
    this.floorsOf.clear(); this.floorAt.clear(); this.floorKey.clear();
    for (const st of ov.structures) {
      const list: FloorInfo[] = [];
      for (const f of st.floors) {
        const fi: FloorInfo = { id: f.id, building: st.id, level: f.level, active: f.active };
        list.push(fi); this.floorAt.set(f.id, fi);
        const k = `${st.id}|${f.level}`; if (!this.floorKey.has(k)) this.floorKey.set(k, f.id);
      }
      if (list.length) this.floorsOf.set(st.id, list.sort((a, b) => a.level - b.level));
    }
  }

  private fail(e: unknown): void { this._error = e instanceof Error ? e.message : String(e); }
  private touch(): void { this.version++; this.d.changed(); }

  private later(name: string, ms: number, fn: () => void): void {
    if (this.stopped || this.timers.has(name)) return;
    this.timers.set(name, this.clock.after(ms, () => { this.timers.delete(name); if (!this.stopped) fn(); }));
  }
  private cancel(name: string): void {
    const h = this.timers.get(name); if (h === undefined) return;
    this.clock.cancel(h); this.timers.delete(name);
    if (name === 'check') this.checkAt = null;
  }
  /** Confere de novo no instante `t` (carência ou mapa), o mais cedo pedido. */
  private checkLater(t: number): void {
    if (this.checkAt !== null && this.checkAt <= t && this.timers.has('check')) return;
    this.cancel('check'); this.checkAt = t;
    this.later('check', Math.max(0, t - this.clock.now()), () => { this.checkAt = null; this.evaluate(); });
  }
}

// o que se viu nesta sessão, para voltar à Cidade já montada: vale enquanto o overview estiver no cache das telas (que
// some ao trancar ou sair) e no mesmo workspace
let memo: { ws: string; mode: CityMode; agents: CityAgent[] } | null = null;

/**
 * A Cidade: overview (construções e contagens), moradores carregados (na ordem do servidor) e o aviso de janela da
 * cena. `ready` = já dá para desenhar (cidade inteira: overview e todos; por região: o overview).
 */
export function useCityData(workspace: string, active: boolean) {
  const ov = useResource<CityOverview>(OVERVIEW_URL, []);
  const [, setVer] = useState(0);
  const reloadOv = useRef(ov.reload); reloadOv.current = ov.reload;
  const make = () => {
    const l = new CityLoader({
      agents: (q) => api.get<CityAgentsPage>(`${CITY_AGENTS_URL}?${q}`),
      reloadOverview: () => reloadOv.current(),
      changed: () => setVer((v) => v + 1),
    });
    if (memo && (memo.ws !== workspace || cachedResource(OVERVIEW_URL) === undefined)) memo = null;
    if (memo) l.seed(memo.agents, memo.mode);
    return l;
  };
  const [box, setBox] = useState(() => ({ ws: workspace, loader: make() }));
  if (box.ws !== workspace) setBox({ ws: workspace, loader: make() }); // outro workspace: tudo de novo
  const loader = box.loader;
  useEffect(() => { loader.start(); return () => loader.stop(); }, [loader]);
  useEffect(() => { if (ov.data) loader.setOverview(ov.data); }, [loader, ov.data]);
  // ainda sem overview e a busca falhou: tenta de novo a cada pouco (a tela diz o motivo enquanto isso)
  const failing = !ov.data && !!ov.error;
  useEffect(() => { if (!failing) return; const t = setInterval(() => reloadOv.current(), RETRY_MS); return () => clearInterval(t); }, [failing]);
  useEffect(() => { loader.setActive(active); }, [loader, active]);
  useLiveEvent('runs.changed', (d) => loader.event('runs.changed', d));
  useLiveEvent('agents.changed', (d) => loader.event('agents.changed', d));
  useLiveEvent('city.changed', (d) => loader.event('city.changed', d));
  useLiveEvent('resync', (d) => loader.event('resync', d));
  const list = loader.list; const mode = loader.mode; const ready = loader.ready;
  useEffect(() => { if (ready && mode) memo = { ws: workspace, mode, agents: list }; }, [list, mode, ready, workspace]);
  const scene = useMemo(() => list.map(toScene), [list]);
  const onWindow = useCallback((w: SceneWindow) => loader.setWindow(w), [loader]);
  const get = useCallback((id: string) => loader.get(id), [loader]);
  return {
    overview: ov.data,
    /** ainda sem o que desenhar e uma busca falhou (a tela diz o motivo em vez de esperar calada; tenta de novo sozinha) */
    error: ov.data && ready ? null : ov.error ?? loader.error,
    ready: !!ov.data && ready,
    mode,
    partial: loader.partial,
    /** carregados, na ordem do servidor */
    agents: list,
    scene,
    get,
    onWindow,
    /** depois de uma ação aqui mesmo (construir, mover, andar novo): o overview de novo, sem esperar o evento */
    refresh: ov.reload,
  };
}
