/**
 * Capacidades da equipe (rc.27): o que a equipe de IA já sabe fazer e o Ergon mostra num lugar só (Configurações ›
 * Capacidades da equipe), com o que é benefício ligado por padrão (regra do dono, 12/11) e o aviso de custo ou risco. Tudo passa pela ponte de controle do motor
 * (rotas fechadas /ergon/v1/recursos, conselho, loja, conectores, checkpoints, voz, do plugin do Ergon);
 * aqui ficam a escolha da pessoa que é do Ergon (escrita por conector), as mensagens em português e o registro.
 */
import type { Db } from '../db/db.ts';
import { HttpError } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { setConectoresLigados } from './characters.ts';
import type { PacoteCompetencia } from './competencias.ts';
import type { HermesControlClient } from './hermes.ts';
import { getSetting } from './sectors.ts';

/** Onde fica a lista dos conectores em que a pessoa liberou a escrita (workspace_settings). */
export const ESCRITA_CONECTORES = 'conectores.escrita';

type Metodo = 'GET' | 'PUT' | 'POST' | 'DELETE';
export interface RecursosDeps {
  db: Db; bus: Bus;
  /** a ponte de controle do motor do workspace (um motor por pessoa) */
  control: (workspaceId: string) => HermesControlClient | null;
  /** de qual motor é o workspace (para o estado das ferramentas) */
  scope: (workspaceId: string) => string;
  /** o modelo principal e as contas de IA conectadas, com os modelos de cada uma (para montar o conselho sozinho) */
  modelos?: (workspaceId: string) => Promise<OpcoesDeModelos>;
  /** a biblioteca de competências mudou (a lista guardada do motor fica velha) */
  aoMudarCompetencias?: (workspaceId: string) => void;
}
type Vaga = { provider: string; model: string };
export interface OpcoesDeModelos { principal: { provider: string | null; model: string | null }; contas: Array<{ id: string; models: Array<{ id: string }> }> }
/** no máximo quantos opinam no conselho montado sozinho (cada um é uma chamada a mais por revisão) */
export const CONSELHO_AUTO_MAX = 3;

/**
 * O conselho montado sozinho (regra do dono, 12/11: pronto para usar), como a reserva automática: quem opina é o modelo
 * principal e, de cada outra conta de IA conectada, um modelo (o mesmo do principal, se a conta o tem; senão o primeiro
 * dela); com uma conta só, outros modelos dela. Até CONSELHO_AUTO_MAX; o principal junta as opiniões. null = o conselho de
 * agora já serve (2 ou mais modelos de contas conectadas, e quem junta também) ou não há 2 modelos para montar um.
 */
export function conselhoAutomaticoDe(atual: { opinam: Vaga[]; agrega: Vaga } | null, o: OpcoesDeModelos): { opinam: Vaga[]; agrega: Vaga } | null {
  const existe = (v: Vaga) => o.contas.some((c) => c.id === v.provider && c.models.some((m) => m.id === v.model));
  if (atual && atual.opinam.filter(existe).length >= 2 && existe(atual.agrega)) return null;
  const out: Vaga[] = [];
  const incluir = (v: Vaga) => { if (out.length < CONSELHO_AUTO_MAX && existe(v) && !out.some((x) => x.provider === v.provider && x.model === v.model)) out.push(v); };
  const principal = o.principal.provider && o.principal.model ? { provider: o.principal.provider, model: o.principal.model } : null;
  if (principal) incluir(principal);
  for (const c of o.contas) {
    if (c.id === principal?.provider || !c.models.length) continue;
    incluir({ provider: c.id, model: principal && c.models.some((m) => m.id === principal.model) ? principal.model : c.models[0].id });
  }
  for (const c of o.contas) for (const m of c.models.slice(0, 5)) incluir({ provider: c.id, model: m.id });
  if (out.length < 2) return null;
  return { opinam: out, agrega: principal && existe(principal) ? principal : out[0] };
}

/** O que a ponte respondeu, em erro da tela: sem nomes por dentro. */
function erroDaPonte(status: number, json: any): HttpError {
  const d = typeof json?.error === 'string' ? json.error : typeof json?.detail === 'string' ? json.detail : '';
  if (status === 404) return new HttpError(409, 'recursos_atualizando', 'esta capacidade chega com a próxima atualização da equipe neste computador');
  if (status === 409 && json?.varredura?.politica === 'ask') return Object.assign(new HttpError(409, 'varredura_atencao', 'a varredura de segurança achou pontos de atenção: marque que entendeu o risco para instalar'), { varredura: json.varredura });
  if (status === 409 && json?.varredura) return Object.assign(new HttpError(409, 'varredura_barrou', 'a varredura de segurança barrou esta competência: ela não foi instalada'), { varredura: json.varredura });
  if (status >= 500) return new HttpError(503, 'recursos_indisponivel', d ? `a equipe de IA não concluiu agora: ${d.slice(0, 200)}` : 'a equipe de IA não respondeu agora; tente de novo');
  return new HttpError(400, 'recursos_recusado', d ? d.slice(0, 300) : 'a equipe de IA recusou o pedido');
}

export class Recursos {
  private readonly d: RecursosDeps;
  constructor(d: RecursosDeps) { this.d = d; }

  /** Chama a ponte; erro vira mensagem de tela. Sem motor (modo simulado, motor fechado): 503 claro. */
  async ponte(ws: string, method: Metodo, sub: string, body?: unknown, query?: Record<string, string>): Promise<any> {
    const c = this.d.control(ws);
    if (!c?.recursos) throw new HttpError(503, 'recursos_indisponivel', 'as capacidades da equipe ficam disponíveis quando a equipe de IA está ligada neste computador');
    const r = await c.recursos(method, sub, body, query);
    if (r.status !== 200) throw erroDaPonte(r.status, r.json);
    return r.json;
  }

  /** O estado do motor (proteções, conectores, voz, navegador) mais a escolha do Ergon; atualiza o estado da ferramenta. */
  async estado(ws: string) {
    const e = await this.ponte(ws, 'GET', 'recursos');
    const conectores: string[] = Array.isArray(e.conectores) ? e.conectores.map(String) : [];
    setConectoresLigados(conectores, this.d.scope(ws));
    return {
      checkpoints: e.checkpoints === true, codigoInseguro: e.codigo_inseguro === true, limpeza: e.limpeza === true,
      buscaFerramentas: e.busca_ferramentas === true, conectores,
      voz: { transcrever: typeof e.voz?.transcrever === 'string' ? e.voz.transcrever : null, falar: typeof e.voz?.falar === 'string' ? e.voz.falar : null },
      navegador: { chromium: e.navegador?.chromium === true, pronto: e.navegador?.pronto === true },
      escrita: this.escrita(ws),
    };
  }

  async protecoes(ws: string, userId: string, p: { checkpoints?: boolean; codigoInseguro?: boolean; limpeza?: boolean }) {
    const body: Record<string, boolean> = {};
    if (typeof p.checkpoints === 'boolean') body.checkpoints = p.checkpoints;
    if (typeof p.codigoInseguro === 'boolean') body.codigo_inseguro = p.codigoInseguro;
    if (typeof p.limpeza === 'boolean') body.limpeza = p.limpeza;
    if (!Object.keys(body).length) throw new HttpError(400, 'vazio', 'nada a mudar');
    const r = await this.ponte(ws, 'PUT', 'recursos', body);
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'recursos.protecoes', evidence: body, result: 'proteções do Terminal atualizadas' });
    return { reiniciar: r.reiniciar === true };
  }

  // ---- conselho de modelos
  async conselho(ws: string) { return this.ponte(ws, 'GET', 'conselho'); }
  /**
   * Na hora de uma revisão em conselho (só custa quando a pessoa pede): sem conselho que sirva, monta um com as contas
   * conectadas (conselhoAutomaticoDe) e registra. A pessoa troca quando quiser em Capacidades da equipe. Devolve se montou.
   */
  async conselhoAutomatico(ws: string, userId: string): Promise<boolean> {
    if (!this.d.modelos) return false;
    const atual = await this.conselho(ws).catch(() => null);
    const novo = conselhoAutomaticoDe(atual && Array.isArray(atual.opinam) ? atual : null, await this.d.modelos(ws));
    if (!novo) return false;
    await this.ponte(ws, 'PUT', 'conselho', novo);
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'system', actorId: userId, action: 'recursos.conselho', evidence: { opinam: novo.opinam.map((x) => x.model), agrega: novo.agrega.model, automatico: true },
      result: 'conselho de modelos montado sozinho com as contas de IA conectadas (troque em Configurações › Capacidades da equipe)' });
    return true;
  }
  async setConselho(ws: string, userId: string, c: { opinam: Array<{ provider: string; model: string }>; agrega: { provider: string; model: string } }) {
    const r = await this.ponte(ws, 'PUT', 'conselho', c);
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'recursos.conselho', evidence: { opinam: c.opinam.map((x) => x.model), agrega: c.agrega.model }, result: 'conselho de modelos montado' });
    return r;
  }

  // ---- loja de competências
  async loja(ws: string, q: string) { return this.ponte(ws, 'GET', 'loja', undefined, q ? { q } : {}); }
  async previa(ws: string, id: string) { return this.ponte(ws, 'GET', 'loja/previa', undefined, { id }); }
  async varredura(ws: string, id: string) { return this.ponte(ws, 'GET', 'loja/varredura', undefined, { id }); }
  /** Instalar depois que a pessoa viu a varredura: o motor varre de novo e o que ela barra não instala. */
  async instalar(ws: string, userId: string, id: string) {
    const r = await this.ponte(ws, 'POST', 'loja/instalar', { id });
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'recursos.competencia.instalar', evidence: { id, veredito: r?.varredura?.veredito ?? null },
      result: `competência instalada da loja: ${id}` });
    this.mudouBiblioteca(ws);
    return r;
  }

  // ---- competências enviadas pela pessoa (Adicionar competência, rc.29)
  private mudouBiblioteca(ws: string) { this.d.aoMudarCompetencias?.(ws); this.d.bus.publish(ws, 'agents.changed', {}); }
  /** A varredura de segurança do motor sobre os arquivos (nada é gravado). */
  async varrerEnvio(ws: string, p: Pick<PacoteCompetencia, 'nome' | 'arquivos'>) { return this.ponte(ws, 'POST', 'loja/varrer', { nome: p.nome, arquivos: p.arquivos }); }
  /** Grava na biblioteca da equipe; o motor varre de novo e o que ela barra (ou o que tem atenção sem o aceite) não entra. */
  async enviar(ws: string, userId: string, p: PacoteCompetencia, riscoAceito: boolean) {
    const r = await this.ponte(ws, 'POST', 'loja/enviar', { nome: p.nome, arquivos: p.arquivos, risco_aceito: riscoAceito });
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'recursos.competencia.enviar',
      evidence: { nome: p.nome, arquivos: Object.keys(p.arquivos), veredito: r?.varredura?.veredito ?? null, riscoAceito, atualizada: r?.atualizada === true },
      result: `competência ${r?.atualizada ? 'atualizada' : 'adicionada'} na biblioteca da equipe: ${p.nome}` });
    this.mudouBiblioteca(ws);
    return r;
  }
  async removerCompetencia(ws: string, userId: string, nome: string) {
    await this.ponte(ws, 'POST', 'loja/remover', { nome });
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'recursos.competencia.remover', evidence: { nome }, result: `competência removida da biblioteca: ${nome}` });
    this.mudouBiblioteca(ws);
  }
  async conteudo(ws: string, nome: string) { return this.ponte(ws, 'GET', 'loja/conteudo', undefined, { nome }); }

  // ---- conectores prontos
  escrita(ws: string): string[] {
    try { const v = JSON.parse(getSetting(this.d.db, ws, ESCRITA_CONECTORES) ?? '[]'); return Array.isArray(v) ? v.map(String).slice(0, 100) : []; } catch { return []; }
  }
  setEscrita(ws: string, userId: string, nome: string, liberada: boolean): string[] {
    const atual = new Set(this.escrita(ws));
    if (liberada) atual.add(nome); else atual.delete(nome);
    const lista = [...atual].sort();
    this.d.db.run('INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, ?, ?, ?)', ws, ESCRITA_CONECTORES, JSON.stringify(lista), new Date().toISOString());
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'recursos.conector.escrita', evidence: { nome, liberada },
      result: liberada ? `escrita liberada no conector ${nome}` : `conector ${nome} só para consulta` });
    return lista;
  }
  async conectores(ws: string) {
    const r = await this.ponte(ws, 'GET', 'conectores');
    const ligados = (Array.isArray(r.servidores) ? r.servidores : []).filter((s: any) => s.ligado).map((s: any) => String(s.nome));
    setConectoresLigados(ligados, this.d.scope(ws));
    return { ...r, escrita: this.escrita(ws) };
  }
  async instalarConector(ws: string, userId: string, nome: string, campos: Record<string, string>, retorno: string | null) {
    const r = await this.ponte(ws, 'POST', 'conectores/instalar', { nome, campos, ...(retorno ? { retorno } : {}) });
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'recursos.conector.instalar', evidence: { nome, campos: Object.keys(campos) }, result: `conector ${nome} instalado` });
    await this.conectores(ws).catch(() => null);
    this.d.bus.publish(ws, 'agents.changed', {});
    return r;
  }
  async ligarConector(ws: string, userId: string, nome: string, ligado: boolean) {
    const r = await this.ponte(ws, 'PUT', `conectores/${nome}`, { ligado });
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'recursos.conector.ligar', evidence: { nome, ligado }, result: `conector ${nome} ${ligado ? 'ligado' : 'desligado'}` });
    await this.conectores(ws).catch(() => null);
    this.d.bus.publish(ws, 'agents.changed', {});
    return r;
  }
  async removerConector(ws: string, userId: string, nome: string) {
    await this.ponte(ws, 'DELETE', `conectores/${nome}`);
    if (this.escrita(ws).includes(nome)) this.setEscrita(ws, userId, nome, false);
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'recursos.conector.remover', evidence: { nome }, result: `conector ${nome} removido` });
    await this.conectores(ws).catch(() => null);
    this.d.bus.publish(ws, 'agents.changed', {});
  }
  async entrarConector(ws: string, nome: string) { return this.ponte(ws, 'POST', `conectores/${nome}/entrar`, {}); }
  async fluxoConector(ws: string, fluxo: string) { return this.ponte(ws, 'GET', `conectores-entrada/${fluxo}`); }
  async retornoConector(ws: string, nome: string, campos: Record<string, string>) { return this.ponte(ws, 'POST', `conectores-retorno/${nome}`, campos); }

  // ---- voltar atrás e voz
  async checkpoints(ws: string) { return this.ponte(ws, 'GET', 'checkpoints'); }
  async voltar(ws: string, userId: string, pasta: string, id: string) {
    const r = await this.ponte(ws, 'POST', 'checkpoints/voltar', { pasta, id });
    audit(this.d.db, this.d.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'recursos.voltar', evidence: { pasta, id, ok: r.ok === true },
      result: r.ok ? `pasta ${pasta} de volta ao ponto ${id.slice(0, 8)}` : `não voltou: ${String(r.motivo ?? '')}` });
    return r;
  }
  async transcrever(ws: string, audio: Buffer, nome: string) { return this.ponte(ws, 'POST', 'voz/transcrever', { audio: audio.toString('base64'), nome }); }
  async falar(ws: string, texto: string) { return this.ponte(ws, 'POST', 'voz/falar', { texto }); }
}

/** Revisão em conselho: o pedido que vai ao conselho de modelos (na conversa, como mensagem da pessoa). */
export const PEDIDO_CONSELHO = 'Revisão em conselho: revise criticamente a sua última resposta nesta conversa. Aponte erros, lacunas e premissas não declaradas, diga o que mudaria e entregue a versão revisada.';
/** Um áudio que dá para transcrever (o tipo do arquivo anexado). */
export const ehAudio = (mime: string, nome: string): boolean => /^audio\//.test(mime) || /\.(ogg|oga|opus|mp3|m4a|wav|webm|flac|aac)$/i.test(nome);
