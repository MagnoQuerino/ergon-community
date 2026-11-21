/**
 * As Salas (services/salas) entre os computadores dos colaboradores, pela sincronia cifrada do World.
 *
 * Todo colaborador tem a chave do workspace e abre todas as mudanças do log; a sala é só de quem está nela. Por isso a
 * sala e as mensagens não vão no corpo da mudança: vão em PACOTES selados para cada aparelho dos membros (sealForDevice:
 * X25519 efêmera + HKDF → AES-GCM, amarrado ao workspace, a quem manda e a quem recebe). Quem não está na sala recebe a
 * mudança, mas não consegue abrir o pacote de ninguém.
 * - Chaves públicas: cada aparelho anuncia a sua (X25519 de sincronia) no corpo de uma mudança que ele mesmo assina; quem
 *   recebe só aceita o anúncio cujo aparelho é o mesmo que o World registrou como autor da mudança, e guarda a conta que
 *   o World registrou (salas_aparelhos). O World não lê nada disso; ele já é quem diz quem mandou cada mudança.
 * - Cada aparelho manda o que NASCEU nele (as mensagens escritas ali e as respostas de agente que rodaram ali) e a versão
 *   dele da sala; nada vai duas vezes ao mesmo aparelho (salas_enviados). Membro novo recebe o histórico de cada autor na
 *   próxima vez que o aparelho dele sincronizar; quem saiu não recebe mais nada (só a versão da sala que diz que saiu).
 * - A governança das salas (cessão de conexões, quem cria) vai no corpo comum (não é segredo) e só vale vinda de quem
 *   administra o workspace.
 * - Nunca viajam: cessões, avisos, leituras, a fila de agentes e credenciais (ficam no aparelho de quem são).
 * Aparelho na versão anterior ignora os campos novos (parseContent de lá reconstrói o corpo sem eles).
 */
import crypto from 'node:crypto';
import type { Db } from '../db/db.ts';
import { now } from '../lib/util.ts';
import type { PSala, PSalaMsg, Salas } from '../services/salas/servico.ts';
import { openForDevice, sealForDevice } from './sync-crypto.ts';

export interface Anuncio { deviceId: string; x25519Public: string }
export interface Pacote { para: string; selado: string }
export interface GovSalas { cessao: boolean; criar: 'admins' | 'todos'; at: string }
/** o que vai junto do corpo de uma mudança de conteúdo */
export interface ExtraSalas { aparelho?: Anuncio; salas?: Pacote[]; salasGov?: GovSalas }

const PACOTES_MAX = 40;
/** teto do que vai selado numa mudança (antes de cifrar): com as duas camadas de base64, fica abaixo dos 2 MB do World */
const TOTAL_MAX = 650_000;
const sha = (x: string) => crypto.createHash('sha256').update(x).digest('hex');
const isDev = (v: unknown) => typeof v === 'string' && /^dev_[A-Za-z0-9]{8,64}$/.test(v);
const b64 = (v: unknown, max: number) => typeof v === 'string' && v.length > 0 && v.length <= max && /^[A-Za-z0-9+/=]+$/.test(v);

/** Confere os campos das salas num corpo decifrado (fora do formato: o corpo inteiro é recusado, como o resto). */
export function checarExtra(b: Record<string, unknown>): ExtraSalas | null {
  const out: ExtraSalas = {};
  if (b.aparelho !== undefined) {
    const a = b.aparelho as Record<string, unknown>;
    if (!a || !isDev(a.deviceId) || !b64(a.x25519Public, 200)) return null;
    out.aparelho = { deviceId: a.deviceId as string, x25519Public: a.x25519Public as string };
  }
  if (b.salas !== undefined) {
    if (!Array.isArray(b.salas) || b.salas.length > 500) return null;
    const ps: Pacote[] = [];
    for (const x of b.salas as Array<Record<string, unknown>>) {
      if (!x || !isDev(x.para) || typeof x.selado !== 'string' || x.selado.length > 1_200_000) return null;
      ps.push({ para: x.para as string, selado: x.selado });
    }
    out.salas = ps;
  }
  if (b.salasGov !== undefined) {
    const g = b.salasGov as Record<string, unknown>;
    if (!g || typeof g.cessao !== 'boolean' || (g.criar !== 'admins' && g.criar !== 'todos') || typeof g.at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(g.at)) return null;
    out.salasGov = { cessao: g.cessao, criar: g.criar, at: g.at };
  }
  return out;
}

// ---------------------------------------------------------------- o que vem dentro do pacote, conferido
const str = (v: unknown, max: number, min = 0) => typeof v === 'string' && v.length >= min && v.length <= max;
const isId = (v: unknown, p: string) => typeof v === 'string' && new RegExp(`^${p}_[A-Za-z0-9]{8,64}$`).test(v);
const date = (v: unknown) => typeof v === 'string' && v.length <= 40 && /^\d{4}-\d{2}-\d{2}T/.test(v);
const CHAVE = /^(acc:acc_[a-f0-9]{8,64}|usr:usr_[A-Za-z0-9]{8,64}|agt:.{1,80}|sys)$/;
function checarSala(x: Record<string, unknown>): PSala | null {
  if (!isId(x.id, 'cnv') || !str(x.nome, 200, 1) || typeof x.arquivada !== 'boolean' || !date(x.at) || !date(x.criadaEm) || !Array.isArray(x.membros) || x.membros.length > 100) return null;
  const membros: PSala['membros'] = [];
  for (const m of x.membros as Array<Record<string, unknown>>) {
    if (!m || (m.tipo !== 'pessoa' && m.tipo !== 'agente') || !str(m.chave, 200, 1) || !str(m.nome, 200, 1) || typeof m.admin !== 'boolean') return null;
    if (m.tipo === 'pessoa' && !/^acc:acc_[a-f0-9]{8,64}$/.test(m.chave as string)) return null; // entre aparelhos, só contas do World
    membros.push({ tipo: m.tipo, chave: m.chave as string, nome: m.nome as string, admin: m.admin });
  }
  return { id: x.id as string, nome: x.nome as string, arquivada: x.arquivada, at: x.at as string, criadaEm: x.criadaEm as string, membros };
}
function checarMsg(x: Record<string, unknown>): PSalaMsg | null {
  if (!isId(x.id, 'msg') || !isId(x.salaId, 'cnv') || !['user', 'agent', 'system'].includes(String(x.role)) || !str(x.autorChave, 200, 1) || !CHAVE.test(String(x.autorChave))
    || !str(x.autorNome, 200) || !(x.pedinteChave === null || str(x.pedinteChave, 200)) || !str(x.content, 400_000) || !date(x.createdAt) || !Array.isArray(x.anexos) || x.anexos.length > 20) return null;
  const anexos: PSalaMsg['anexos'] = [];
  for (const a of x.anexos as Array<Record<string, unknown>>) {
    if (!a || !str(a.filename, 300, 1) || !str(a.mime, 200) || !Number.isFinite(a.size) || (a.ref !== undefined && !isId(a.ref, 'art')) || (a.sha256 !== undefined && !(typeof a.sha256 === 'string' && /^[a-f0-9]{64}$/.test(a.sha256)))) return null;
    anexos.push({ filename: a.filename as string, mime: a.mime as string, size: Number(a.size), ...(a.ref ? { ref: a.ref as string, sha256: a.sha256 as string } : {}) });
  }
  // as marcas: só a estrutura que a tela forma (o serviço confere de novo o que usa)
  let marcas: unknown = null;
  if (Array.isArray(x.marcas)) marcas = (x.marcas as Array<Record<string, unknown>>).slice(0, 40).filter((m) => m && ['pessoa', 'agente', 'cessao'].includes(String(m.tipo)) && str(m.chave, 200, 1) && Number.isInteger(m.inicio) && Number.isInteger(m.fim))
    .map((m) => ({ tipo: m.tipo, chave: m.chave, inicio: m.inicio, fim: m.fim }));
  else if (x.marcas && typeof x.marcas === 'object' && x.role === 'agent') {
    const e = x.marcas as Record<string, unknown>;
    if (isId(e.complemento, 'msg') && str(e.dono, 200, 1)) marcas = { complemento: e.complemento, dono: e.dono };
  } else if (x.marcas && typeof x.marcas === 'object' && x.role === 'system') {
    const e = x.marcas as Record<string, unknown>;
    if (str(e.evento, 20, 1)) marcas = { evento: e.evento, ...(str(e.nome, 200) ? { nome: e.nome } : {}), ...(str(e.alvo, 200) ? { alvo: e.alvo } : {}), ...(str(e.prazo, 10) ? { prazo: e.prazo } : {}), ...(str(e.agente, 200) ? { agente: e.agente } : {}) };
  }
  return { id: x.id as string, salaId: x.salaId as string, role: x.role as PSalaMsg['role'], autorChave: x.autorChave as string, autorNome: x.autorNome as string, pedinteChave: (x.pedinteChave as string | null) ?? null, content: x.content as string, marcas, anexos, createdAt: x.createdAt as string };
}

interface Eu { deviceId: string; x25519Public: string; abrir: (sealed: string, a: { ws: string; from: string }) => Buffer }
interface Registro { device: string; kind: 'sala' | 'msg' | 'cessao'; id: string; hash: string }
/** o que vai dentro de um pacote (aberto só pelo aparelho de destino) */
interface Corpo { salas: PSala[]; mensagens: PSalaMsg[]; pedidos?: Array<{ ref: string; salaId: string }>; partes?: Array<{ ref: string; parte: number; total: number; dados: string }>; cessoes?: ReturnType<Salas['cessoesParaSync']> }

export class SalasSync {
  readonly db: Db; readonly salas: Salas;
  log: (o: Record<string, unknown>, msg: string) => void = () => undefined;
  constructor(db: Db, salas: Salas) { this.db = db; this.salas = salas; }

  private setting(ws: string, k: string): string | null { return this.db.get<{ v: string }>('SELECT value AS v FROM workspace_settings WHERE workspace_id = ? AND key = ?', ws, k)?.v ?? null; }
  private set(ws: string, k: string, v: string) { this.db.run('INSERT INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at', ws, k, v, now()); }

  /**
   * O que vai na próxima mudança deste aparelho: o anúncio da chave pública (uma vez por chave), a governança (se mudou
   * aqui) e os pacotes selados para cada aparelho de membro que ainda não tem o que nasceu aqui. `marcar` grava o que foi,
   * depois que o World aceitou.
   */
  saida(ws: string, sws: string, eu: Eu, comConteudo: boolean): { extra: ExtraSalas; marcar: () => void; resumo: string } | null {
    const extra: ExtraSalas = {}; const regs: Registro[] = []; const depois: Array<() => void> = [];
    const anuncio = sha(`${eu.deviceId}|${eu.x25519Public}`);
    // o anúncio vai junto de um envio que já ia; sozinho, só quando a pessoa usa as Salas aqui (sem isso, quem nunca abriu
    // as Salas não ganha uma mudança a mais no log a cada aparelho novo)
    if (this.setting(ws, 'salas.anunciado') !== anuncio && (comConteudo || this.salas.nuvem || this.setting(ws, 'salas.usa') === '1')) { extra.aparelho = { deviceId: eu.deviceId, x25519Public: eu.x25519Public }; depois.push(() => this.set(ws, 'salas.anunciado', anuncio)); }
    const g = this.salas.governanca(ws);
    if (g.at && this.setting(ws, 'salas.gov_enviado') !== g.at) { extra.salasGov = { cessao: g.cessao, criar: g.criar, at: g.at }; depois.push(() => this.set(ws, 'salas.gov_enviado', g.at!)); }
    const aparelhos = this.db.all<{ device_id: string; account_id: string; x25519_public: string }>('SELECT device_id, account_id, x25519_public FROM salas_aparelhos WHERE workspace_id = ? AND device_id != ?', ws, eu.deviceId);
    const ao: Array<() => void> = [];
    if (aparelhos.length) {
      const enviados = new Map(this.db.all<{ k: string; h: string }>("SELECT device_id || '|' || kind || '|' || record_id AS k, hash AS h FROM salas_enviados WHERE workspace_id = ? AND device_id != 'recebido'", ws).map((r) => [r.k, r.h]));
      const porAparelho = new Map<string, Corpo & { tamanho: number }>();
      const pac = (dev: string) => { let x = porAparelho.get(dev); if (!x) { x = { salas: [], mensagens: [], tamanho: 0 }; porAparelho.set(dev, x); } return x; };
      // o total desta mudança tem teto (o World aceita até ~2 MB cifrados): o que não coube vai na próxima
      let total = 0;
      const cabe = (n: number) => total + n <= TOTAL_MAX;
      for (const s of this.salas.salasParaSync(ws)) {
        const ativos = new Set(s.membros.filter((m) => m.tipo === 'pessoa').map((m) => m.chave));
        // quem saiu recebe só a versão da sala que diz que saiu (nenhuma mensagem)
        const sairam = new Set(this.db.all<{ chave: string }>("SELECT chave FROM salas_membros WHERE conversation_id = ? AND tipo = 'pessoa' AND removed_at IS NOT NULL", s.id).map((r) => r.chave));
        const hs = sha(JSON.stringify(s)); const ts = JSON.stringify(s).length;
        let msgs: PSalaMsg[] | null = null;
        for (const d of aparelhos) {
          const conta = `acc:${d.account_id}`;
          if (!ativos.has(conta) && !sairam.has(conta)) continue;
          if (enviados.get(`${d.device_id}|sala|${s.id}`) !== hs && cabe(ts)) { const p = pac(d.device_id); p.salas.push(s); p.tamanho += ts; total += ts; regs.push({ device: d.device_id, kind: 'sala', id: s.id, hash: hs }); }
          if (!ativos.has(conta)) continue;
          msgs ??= this.salas.mensagensParaSync(ws, s.id);
          for (const m of msgs) {
            if (enviados.has(`${d.device_id}|msg|${m.id}`)) continue;
            const n = JSON.stringify(m).length;
            if (!cabe(n)) break;
            const p = pac(d.device_id); p.mensagens.push(m); p.tamanho += n; total += n; regs.push({ device: d.device_id, kind: 'msg', id: m.id, hash: '' });
          }
        }
      }
      const minha = this.salas.chaveDaPessoa(ws);
      for (const d of aparelhos) {
        // anexos pedidos daqui ao aparelho onde nasceram
        const pedidos = this.salas.pedidosDeAnexoPara(ws, d.device_id);
        if (pedidos.length && cabe(300 * pedidos.length)) { pac(d.device_id).pedidos = pedidos; total += 300 * pedidos.length; ao.push(() => { for (const x of pedidos) this.salas.pedidoDeAnexoFoi(ws, x.ref); }); }
        // as cessões que a pessoa deu, para os outros aparelhos DELA (a nuvem do workspace atende com elas)
        if (minha && `acc:${d.account_id}` === minha) {
          const cs = this.salas.cessoesParaSync(ws).filter((c) => enviados.get(`${d.device_id}|cessao|${c.id}`) !== sha(JSON.stringify(c)));
          if (cs.length && cabe(JSON.stringify(cs).length)) { pac(d.device_id).cessoes = cs; total += JSON.stringify(cs).length; for (const c of cs) regs.push({ device: d.device_id, kind: 'cessao', id: c.id, hash: sha(JSON.stringify(c)) }); }
        }
      }
      // partes de anexo por último (são as maiores): o que sobrou do teto
      for (const d of aparelhos) {
        if (total >= TOTAL_MAX) break;
        const x = this.salas.partesPara(ws, d.device_id, TOTAL_MAX - total);
        if (!x.partes.length) continue;
        pac(d.device_id).partes = x.partes; total += x.partes.reduce((n, p) => n + p.dados.length + 100, 0);
        ao.push(x.marcar);
      }
      const pacotes: Pacote[] = [];
      for (const [dev, p] of [...porAparelho].filter(([, p]) => p.salas.length || p.mensagens.length || p.pedidos?.length || p.partes?.length || p.cessoes?.length).slice(0, PACOTES_MAX)) {
        const d = aparelhos.find((x) => x.device_id === dev)!;
        const { tamanho: _t, ...corpo } = p;
        try { pacotes.push({ para: dev, selado: sealForDevice(Buffer.from(JSON.stringify(corpo)), d.x25519_public, { ws: sws, from: eu.deviceId, to: dev }) }); }
        catch { this.log({ ws, aparelho: dev }, 'salas: a chave pública do aparelho não serve (pacote não selado)'); for (let i = regs.length - 1; i >= 0; i--) if (regs[i].device === dev) regs.splice(i, 1); }
      }
      const foram = new Set(pacotes.map((p) => p.para));
      for (let i = regs.length - 1; i >= 0; i--) if (!foram.has(regs[i].device)) regs.splice(i, 1);
      if (pacotes.length) extra.salas = pacotes;
      // um aparelho sem pacote (chave estragada) perde as partes/pedidos desta vez: o "marcar" só vale para quem foi
      if (!pacotes.length) ao.length = 0;
    }
    if (!extra.aparelho && !extra.salas && !extra.salasGov) return null;
    // o resumo é do que vai (não do selado, que muda a cada vez): o mesmo envio repetido tem o mesmo código de operação
    const resumo = sha(JSON.stringify([extra.aparelho ?? null, extra.salasGov ?? null, regs.map((r) => `${r.device}|${r.kind}|${r.id}|${r.hash}`)]));
    return { extra, resumo, marcar: () => this.db.tx(() => {
      for (const r of regs) this.db.run('INSERT INTO salas_enviados (workspace_id, device_id, kind, record_id, hash) VALUES (?, ?, ?, ?, ?) ON CONFLICT (workspace_id, device_id, kind, record_id) DO UPDATE SET hash = excluded.hash', ws, r.device, r.kind, r.id, r.hash);
      for (const f of depois) f();
      for (const f of ao) f();
    }) };
  }

  /**
   * O que veio numa mudança de outro aparelho. `x`: o autor como o World registrou (aparelho e conta). O anúncio só vale
   * do próprio aparelho que assinou; o pacote só abre se for para este aparelho; a governança, só de quem administra.
   */
  entrada(ws: string, sws: string, x: { deviceId: string; accountId?: string }, extra: ExtraSalas, eu: Eu): void {
    if (!x.accountId) return; // World antigo sem o autor: nada das salas (não dá para saber de quem é)
    if (extra.aparelho && extra.aparelho.deviceId === x.deviceId) {
      this.db.run(`INSERT INTO salas_aparelhos (workspace_id, device_id, account_id, x25519_public, at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (workspace_id, device_id) DO UPDATE SET account_id = excluded.account_id, x25519_public = excluded.x25519_public, at = excluded.at`, ws, x.deviceId, x.accountId, extra.aparelho.x25519Public, now());
      // chave nova desse aparelho: o que já foi para a chave velha vai de novo (ele não abre mais aquilo)
      this.db.run('DELETE FROM salas_enviados WHERE workspace_id = ? AND device_id = ?', ws, x.deviceId);
    }
    if (extra.salasGov) {
      const p = this.salas.papel(ws, `acc:${x.accountId}`);
      if (p === 'owner' || p === 'admin') this.salas.gravarGovernanca(ws, extra.salasGov, extra.salasGov.at);
      else this.log({ ws, conta: x.accountId }, 'salas: governança vinda de quem não administra o workspace (ignorada)');
    }
    for (const p of extra.salas ?? []) {
      if (p.para !== eu.deviceId) continue;
      let corpo: { salas?: unknown; mensagens?: unknown; pedidos?: unknown; partes?: unknown; cessoes?: unknown };
      try { corpo = JSON.parse(eu.abrir(p.selado, { ws: sws, from: x.deviceId }).toString('utf8')) as typeof corpo; }
      catch { this.log({ ws, de: x.deviceId }, 'salas: um pacote para este aparelho não abriu (ignorado)'); continue; }
      const salas = Array.isArray(corpo.salas) ? corpo.salas.map((s) => checarSala(s as Record<string, unknown>)) : [];
      const mensagens = Array.isArray(corpo.mensagens) ? corpo.mensagens.map((m) => checarMsg(m as Record<string, unknown>)) : [];
      if (salas.includes(null) || mensagens.includes(null)) { this.log({ ws, de: x.deviceId }, 'salas: pacote fora do formato (ignorado inteiro)'); continue; }
      const n = this.salas.aplicarDoSync(ws, `acc:${x.accountId}`, { salas: salas as PSala[], mensagens: mensagens as PSalaMsg[] }, x.deviceId);
      if (n.salas || n.mensagens) this.log({ ws, de: x.deviceId, ...n }, 'salas: recebido de outro aparelho');
      const c = corpo as Record<string, unknown>;
      // pedidos de anexo: o arquivo daqui vai, em partes, só a quem está na sala (o serviço confere)
      if (Array.isArray(c.pedidos)) for (const p of c.pedidos.slice(0, 20) as Array<Record<string, unknown>>) {
        if (p && isId(p.ref, 'art') && isId(p.salaId, 'cnv')) this.salas.receberPedidoDeAnexo(ws, `acc:${x.accountId}`, x.deviceId, { ref: p.ref as string, salaId: p.salaId as string });
      }
      if (Array.isArray(c.partes)) for (const p of c.partes.slice(0, 40) as Array<Record<string, unknown>>) {
        if (p && isId(p.ref, 'art') && Number.isInteger(p.parte) && Number.isInteger(p.total) && b64(p.dados, 600_000)) {
          try { this.salas.receberParte(ws, x.deviceId, { ref: p.ref as string, parte: p.parte as number, total: p.total as number, dados: p.dados as string }); } catch (e) { this.log({ ws, erro: String((e as Error).message).slice(0, 120) }, 'salas: parte de anexo não guardada'); }
        }
      }
      if (Array.isArray(c.cessoes)) {
        const ok = (c.cessoes as Array<Record<string, unknown>>).slice(0, 500).filter((v) => v && isId(v.id, 'sce') && isId(v.salaId, 'cnv') && str(v.dono, 200, 1) && str(v.pedinte, 200, 1)
          && ['vez', '24h', '7d', '30d', 'sempre'].includes(String(v.prazo)) && (v.messageId === null || isId(v.messageId, 'msg')) && (v.expiraEm === null || date(v.expiraEm)) && date(v.createdAt) && (v.revogadaEm === null || date(v.revogadaEm)));
        this.salas.aplicarCessoes(ws, `acc:${x.accountId}`, ok as unknown as ReturnType<Salas['cessoesParaSync']>);
      }
    }
  }
}

export { openForDevice };
