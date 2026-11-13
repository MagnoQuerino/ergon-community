/**
 * Aplicativos conectados pela pessoa (rc.29): Conexões › Conectar outro aplicativo. Um servidor MCP ("um jeito padrão de
 * um aplicativo oferecer ferramentas à equipe de IA") que o catálogo de aplicativos prontos não traz: por endereço (HTTP
 * ou SSE) ou por um programa que roda dentro do ambiente isolado da equipe (stdio, no motor; nunca no computador da pessoa).
 *
 * Quem conecta é o motor, pela ponte de controle (rotas conectores-proprio do plugin do Ergon); as chaves vão direto ao
 * cofre do motor e nunca voltam. Aqui ficam o que a tela mostra (aplicativo, apelido da conta, ícone, como conecta, os
 * nomes das chaves) e a classe de cada ferramenta que o teste encontrou — leitura, escrita ou envio em nome da pessoa —,
 * que vai na política de cada sessão: o mesmo padrão dos outros aplicativos (consulta liberada, escrita só onde a pessoa
 * liberar em Conexões, envio com o sim dela a cada vez, pelo portão de aprovação do motor).
 *
 * Várias contas do mesmo aplicativo seguem o modelo geral das Conexões (services/integrations.ts, migração 0046): cada
 * conexão de um servidor próprio é uma conta do aplicativo, com o seu apelido (único dentro do aplicativo); a primeira é a
 * principal (conta ''), as outras têm o id curto (CONTA_RE); tirar a principal promove a mais antiga; quem pede por uma
 * conta (a coordenação, por exemplo) diz o apelido, e acharConta resolve como nas outras Conexões.
 *
 * As funções são do workspace, não da tela: a coordenação usa as mesmas (conectar, testar, classificar, remover).
 */
import type { Db } from '../db/db.ts';
import { HttpError, clip, fold, notFound, now } from '../lib/util.ts';
import { NOME_SERVIDOR, nomeDoServidor, type TransporteMcp } from '../../../shared/mcp-config.ts';
import { audit, type Bus } from './bus.ts';
import { reconhecer, type Texto } from '../lib/textos.ts';
import type { Recursos } from './recursos.ts';
import { acharConta, novaContaId } from './integrations.ts';

export type TipoFerramenta = 'leitura' | 'escrita' | 'envio';
export const TIPOS: readonly TipoFerramenta[] = ['leitura', 'escrita', 'envio'];
export interface FerramentaApp { nome: string; descricao: string; sugerido: TipoFerramenta; tipo: TipoFerramenta }
export interface ChaveApp { tipo: 'cabecalho' | 'variavel'; nome: string }
export interface AppConectado {
  nome: string; app: string; apelido: string | null;
  /** a conta dentro do aplicativo: '' = a principal (modelo das Conexões) */
  conta: string; principal: boolean; icone: string | null; transporte: TransporteMcp;
  /** o endereço, sem os valores do que vem depois de "?" (pode haver chave ali) */
  endereco: string | null; comando: string | null; argumentos: string[];
  chaves: ChaveApp[]; ferramentas: FerramentaApp[]; testadoEm: string | null; erro: string | null; erro_t?: Texto; criadoEm: string;
}
export interface PedidoApp {
  app: string; apelido?: string; icone?: string; transporte: TransporteMcp;
  endereco?: string; comando?: string; argumentos?: string[];
  cabecalhos?: Record<string, string>; variaveis?: Record<string, string>;
}
export interface ResultadoTeste { ok: boolean; erro: string; erro_t?: Texto; ferramentas: FerramentaApp[] }
/** a frase fixa do Ergon no erro do teste ("o aplicativo não respondeu"…) vai com o código, para a tela traduzir */
const erroT = (e: string | null): { erro_t?: Texto } => { const t = e ? reconhecer(e, 'erro.') : null; return t ? { erro_t: t } : {}; };

interface Linha {
  workspace_id: string; nome: string; app: string; chave_app: string; conta: string; apelido: string | null; icone: string | null; transporte: TransporteMcp;
  endereco: string | null; comando: string | null; argumentos: string; segredos: string; ferramentas: string;
  testado_em: string | null; erro: string | null; created_at: string;
}

const CABECALHO = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;
const VARIAVEL = /^[A-Za-z_][A-Za-z0-9_]{0,79}$/;
const COMANDO = /^[A-Za-z0-9_./@+-]{1,200}$/;
const ENDERECO = /^https?:\/\/[^\s"'<>`\\$]{3,2000}$/i;
/**
 * "$" no endereço ou num argumento: o motor troca ${VAR} pelo valor do ambiente (onde estão as chaves dos provedores e das
 * outras conexões) e o mandaria ao aplicativo. A chave vai num cabeçalho ou numa variável, que o cofre guarda.
 */
export const REFERENCIA = /\$/;
export const ERRO_REFERENCIA_ENDERECO = 'O endereço não pode trazer referências a chaves ($). Ponha a chave num cabeçalho.';
export const ERRO_REFERENCIA_ARGUMENTO = 'Os argumentos não podem trazer referências a chaves ($). Ponha a chave numa variável.';
const ICONE = /^[a-z0-9-]{1,40}$/;
const lista = <T>(v: string, padrao: T[] = []): T[] => { try { const x = JSON.parse(v); return Array.isArray(x) ? x as T[] : padrao; } catch { return padrao; } };
/** O que junta as contas de um aplicativo: o nome sem acento, maiúscula nem espaço repetido. */
export const chaveDoApp = (app: string): string => fold(app.replace(/\s+/g, ' ').trim());
const ehTipo = (v: unknown): v is TipoFerramenta => typeof v === 'string' && (TIPOS as readonly string[]).includes(v);

/** Trecho do caminho com cara de chave: prefixo conhecido, ou 20+ letras e números misturados (servidores que põem a chave no caminho). */
const trechoDeChave = (t: string): boolean => PREFIXO_DE_CHAVE.test(t) || (t.length >= 20 && /^[A-Za-z0-9_-]+$/.test(t) && /[A-Za-z]/.test(t) && /\d/.test(t));
/**
 * O endereço para a tela (e para a gestão): pode haver chave ali. Sai sem os valores depois de "?", sem o usuário e a senha
 * (user:senha@) e sem os trechos do caminho com cara de chave (https://mcp.exemplo/s/<segredo>/mcp).
 */
export function enderecoParaTela(u: string | null): string | null {
  if (!u) return null;
  const i = u.indexOf('?');
  const base = i < 0 ? u : u.slice(0, i);
  const m = /^(https?:\/\/)([^/]*)(.*)$/i.exec(base);
  const limpa = m ? `${m[1]}${m[2].includes('@') ? `•••@${m[2].slice(m[2].lastIndexOf('@') + 1)}` : m[2]}${m[3].split('/').map((t) => (trechoDeChave(t) ? '•••' : t)).join('/')}` : base;
  if (i < 0) return limpa;
  return `${limpa}?${u.slice(i + 1).split('&').map((p) => `${p.split('=')[0]}=•••`).join('&')}`;
}

const SENSIVEL = /key|token|secret|senha|pass(word)?|auth|bearer|credential|cookie/i;
const PREFIXO_DE_CHAVE = /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghs_|github_pat_|xox[abprs]-|glpat-|AKIA|ya29\.|Bearer\s)/;
/**
 * Os argumentos do programa para a tela (quem só vê o workspace também lista): muitos aplicativos publicam a chave no
 * meio deles ("--api-key", "TOKEN=…", "Authorization: Bearer …"). O valor depois de um nome que parece de chave, e o que
 * tem cara de chave, sai como •••; no motor, o programa recebe tudo como foi digitado.
 */
export function argumentosParaTela(args: string[]): string[] {
  return args.map((a, i) => {
    const antes = i > 0 ? args[i - 1] : '';
    if (/^-/.test(antes) && !antes.includes('=') && SENSIVEL.test(antes) && !/^-/.test(a)) return '•••';
    const par = /^(-{0,2}[A-Za-z0-9_.-]+)(\s*[=:]\s*)(.+)$/.exec(a);
    if (par && SENSIVEL.test(par[1])) return `${par[1]}${par[2]}•••`;
    if (PREFIXO_DE_CHAVE.test(a)) return '•••';
    return a;
  });
}

/** Confere o pedido da tela (ou da coordenação). Erro claro, sem mostrar valores. */
export function conferirPedido(p: PedidoApp): void {
  const app = (p.app ?? '').trim();
  if (!app || app.length > 60) throw new HttpError(400, 'app_nome', 'dê um nome ao aplicativo (até 60 letras)');
  if ((p.apelido ?? '').length > 40) throw new HttpError(400, 'app_apelido', 'o apelido da conta tem até 40 letras');
  if (p.icone && !ICONE.test(p.icone)) throw new HttpError(400, 'app_icone', 'ícone inválido');
  const cab = Object.entries(p.cabecalhos ?? {}); const vars = Object.entries(p.variaveis ?? {});
  const valorOk = (v: string) => typeof v === 'string' && v.trim().length > 0 && v.length <= 4000 && /^[\x20-\x7e]+$/.test(v.trim());
  if (p.transporte === 'stdio') {
    if (p.endereco) throw new HttpError(400, 'app_um_so', 'informe o programa OU o endereço, não os dois');
    if (!p.comando || !COMANDO.test(p.comando)) throw new HttpError(400, 'app_programa', 'programa inválido: só o nome (como npx ou uvx), sem espaços; o resto vai em argumentos');
    if ((p.argumentos ?? []).some((a) => typeof a === 'string' && REFERENCIA.test(a))) throw new HttpError(400, 'app_referencia', ERRO_REFERENCIA_ARGUMENTO);
    if ((p.argumentos ?? []).length > 40 || (p.argumentos ?? []).some((a) => typeof a !== 'string' || !a.length || a.length > 1000 || /[\x00-\x1f]/.test(a))) {
      throw new HttpError(400, 'app_argumentos', 'argumentos inválidos (até 40, um por linha)');
    }
    if (cab.length) throw new HttpError(400, 'app_cabecalhos', 'cabeçalhos valem só para endereço; num programa, use variáveis');
  } else {
    if (p.comando) throw new HttpError(400, 'app_um_so', 'informe o endereço OU o programa, não os dois');
    if (p.endereco && REFERENCIA.test(p.endereco)) throw new HttpError(400, 'app_referencia', ERRO_REFERENCIA_ENDERECO);
    if (!p.endereco || !ENDERECO.test(p.endereco)) throw new HttpError(400, 'app_endereco', 'endereço inválido: comece por https://');
    if (vars.length) throw new HttpError(400, 'app_variaveis', 'variáveis valem só para programa; num endereço, use cabeçalhos');
  }
  if (cab.length > 10 || vars.length > 20) throw new HttpError(400, 'app_chaves', 'chaves demais');
  for (const [k, v] of cab) {
    if (!CABECALHO.test(k)) throw new HttpError(400, 'app_cabecalho', `nome de cabeçalho inválido: ${clip(k, 40)}`);
    if (!valorOk(v)) throw new HttpError(400, 'app_valor', `preencha o valor de ${clip(k, 40)} (sem acentos)`);
  }
  for (const [k, v] of vars) {
    if (!VARIAVEL.test(k)) throw new HttpError(400, 'app_variavel', `nome de variável inválido: ${clip(k, 40)}`);
    if (!valorOk(v)) throw new HttpError(400, 'app_valor', `preencha o valor de ${clip(k, 40)} (sem acentos)`);
  }
}

/** O que o teste achou, com a escolha de antes da pessoa (a ferramenta que continua no aplicativo mantém a classe dela). */
export function juntarFerramentas(antes: FerramentaApp[], achadas: Array<{ nome: string; descricao?: string; sugerido?: string }>): FerramentaApp[] {
  const escolha = new Map(antes.map((f) => [f.nome, f]));
  return achadas.slice(0, 300).filter((f) => typeof f?.nome === 'string' && f.nome.trim()).map((f) => {
    const sugerido: TipoFerramenta = ehTipo(f.sugerido) ? f.sugerido : 'escrita';
    const velha = escolha.get(f.nome);
    // a pessoa tinha escolhido (diferente da sugestão de então): fica a dela; senão vale a sugestão nova
    const tipo = velha && velha.tipo !== velha.sugerido ? velha.tipo : sugerido;
    return { nome: clip(f.nome, 200), descricao: clip(f.descricao ?? '', 600), sugerido, tipo };
  });
}

export class McpProprios {
  private readonly db: Db; private readonly bus: Bus; private readonly recursos: Recursos;
  constructor(d: { db: Db; bus: Bus; recursos: Recursos }) { this.db = d.db; this.bus = d.bus; this.recursos = d.recursos; }

  private linha(ws: string, nome: string): Linha {
    const l = this.db.get<Linha>('SELECT * FROM mcp_proprios WHERE workspace_id = ? AND nome = ?', ws, nome);
    if (!l) throw notFound('aplicativo conectado');
    return l;
  }
  private paraTela(l: Linha): AppConectado {
    return {
      nome: l.nome, app: l.app, apelido: l.apelido, conta: l.conta, principal: l.conta === '', icone: l.icone, transporte: l.transporte, endereco: enderecoParaTela(l.endereco), comando: l.comando,
      argumentos: argumentosParaTela(lista<string>(l.argumentos)), chaves: lista<ChaveApp>(l.segredos), ferramentas: lista<FerramentaApp>(l.ferramentas),
      testadoEm: l.testado_em, erro: l.erro, ...erroT(l.erro), criadoEm: l.created_at,
    };
  }

  /** Por aplicativo; dentro dele, a principal primeiro e as outras na ordem em que entraram (como contasDe). */
  listar(ws: string): AppConectado[] {
    return this.db.all<Linha>("SELECT * FROM mcp_proprios WHERE workspace_id = ? ORDER BY chave_app, CASE WHEN conta = '' THEN 0 ELSE 1 END, created_at, rowid", ws).map((l) => this.paraTela(l));
  }
  private contasDoApp(ws: string, chave: string): Linha[] {
    return this.db.all<Linha>("SELECT * FROM mcp_proprios WHERE workspace_id = ? AND chave_app = ? ORDER BY CASE WHEN conta = '' THEN 0 ELSE 1 END, created_at, rowid", ws, chave);
  }
  private apelidoRepetido(ws: string, chave: string, apelido: string | null | undefined, menos?: string): void {
    const novo = fold((apelido ?? '').replace(/\s+/g, ' ').trim());
    if (novo && this.contasDoApp(ws, chave).some((c) => c.nome !== menos && fold((c.apelido ?? '').trim()) === novo)) {
      throw new HttpError(409, 'apelido_repetido', 'Outra conta deste aplicativo já tem esse nome. Escolha outro.');
    }
  }
  /**
   * A conta pedida de um aplicativo (para a coordenação): pelo nome do aplicativo e o apelido, o id da conta ou "principal";
   * sem dizer a conta, a principal. Também aceita o nome do servidor na equipe. Não achou, ou ficou ambíguo: null.
   */
  achar(ws: string, app: string, conta?: string | null): AppConectado | null {
    const direto = this.db.get<Linha>('SELECT * FROM mcp_proprios WHERE workspace_id = ? AND nome = ?', ws, app);
    if (direto && !conta) return this.paraTela(direto);
    const contas = this.contasDoApp(ws, chaveDoApp(app)).map((l) => ({ ...l, account_label: null }));
    const l = acharConta(contas, conta);
    return l ? this.paraTela(l) : null;
  }
  um(ws: string, nome: string): AppConectado { return this.paraTela(this.linha(ws, nome)); }

  /** Conecta (o motor grava o servidor e guarda as chaves no cofre) e já testa. O nome sai do aplicativo e do apelido. */
  async conectar(ws: string, userId: string, p: PedidoApp, actor: 'user' | 'agent' = 'user'): Promise<{ app: AppConectado; teste: ResultadoTeste | null }> {
    conferirPedido(p);
    const chave = chaveDoApp(p.app);
    this.apelidoRepetido(ws, chave, p.apelido);
    // a primeira conta do aplicativo é a principal; as outras ganham o id curto (o modelo das Conexões)
    const conta = this.contasDoApp(ws, chave).length ? novaContaId() : '';
    const existentes = new Set(this.db.all<{ nome: string }>('SELECT nome FROM mcp_proprios WHERE workspace_id = ?', ws).map((x) => x.nome));
    // os aplicativos prontos instalados também têm nome no motor: o novo não pode coincidir
    try { for (const s of (await this.recursos.conectores(ws)).servidores ?? []) existentes.add(String(s.nome)); } catch { /* o motor diz 409 se coincidir */ }
    const nome = nomeDoServidor(p.app, p.apelido, existentes);
    if (!NOME_SERVIDOR.test(nome)) throw new HttpError(400, 'app_nome', 'não consegui montar um nome para este aplicativo');
    const cabecalhos = p.transporte === 'stdio' ? {} : Object.fromEntries(Object.entries(p.cabecalhos ?? {}).map(([k, v]) => [k, v.trim()]));
    const variaveis = p.transporte === 'stdio' ? Object.fromEntries(Object.entries(p.variaveis ?? {}).map(([k, v]) => [k, v.trim()])) : {};
    await this.recursos.ponte(ws, 'POST', 'conectores-proprio', p.transporte === 'stdio'
      ? { nome, comando: p.comando, argumentos: p.argumentos ?? [], variaveis }
      : { nome, url: p.endereco, transporte: p.transporte, cabecalhos });
    const chaves: ChaveApp[] = [...Object.keys(cabecalhos).map((n) => ({ tipo: 'cabecalho' as const, nome: n })), ...Object.keys(variaveis).map((n) => ({ tipo: 'variavel' as const, nome: n }))];
    const t = now();
    this.db.run(`INSERT INTO mcp_proprios (workspace_id, nome, app, chave_app, conta, apelido, icone, transporte, endereco, comando, argumentos, segredos, ferramentas, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)`, ws, nome, p.app.trim(), chave, conta, this.db.seal(ws, p.apelido?.trim() || null), p.icone || null, p.transporte,
      this.db.seal(ws, p.transporte === 'stdio' ? null : p.endereco ?? null), p.transporte === 'stdio' ? p.comando ?? null : null,
      this.db.seal(ws, JSON.stringify(p.transporte === 'stdio' ? p.argumentos ?? [] : [])), JSON.stringify(chaves), userId, t, t);
    audit(this.db, this.bus, { workspaceId: ws, actorType: actor, actorId: userId, action: 'conexoes.app_proprio.conectar', targetType: 'mcp', targetId: nome,
      evidence: { app: p.app, apelido: p.apelido ?? null, conta: conta || 'principal', transporte: p.transporte, chaves: chaves.map((c) => c.nome) },
      result: `aplicativo ${p.app}${p.apelido ? ` (${p.apelido})` : ''} conectado: a equipe consulta; mudar dados só depois de liberar a escrita` });
    this.bus.publish(ws, 'agents.changed', {});
    let teste: ResultadoTeste | null = null;
    try { teste = await this.testar(ws, userId, nome, actor); } catch { teste = null; }
    return { app: this.um(ws, nome), teste };
  }

  /** Conecta, lista as ferramentas e desconecta. Guarda a lista com a classe de cada uma (a da pessoa fica). */
  async testar(ws: string, userId: string, nome: string, actor: 'user' | 'agent' = 'user'): Promise<ResultadoTeste> {
    const l = this.linha(ws, nome);
    const r = await this.recursos.ponte(ws, 'POST', `conectores-proprio/${nome}/testar`, {});
    const ok = r?.ok === true;
    const erro = ok ? '' : clip(String(r?.erro ?? '') || 'o aplicativo não respondeu', 400);
    const ferramentas = ok ? juntarFerramentas(lista<FerramentaApp>(l.ferramentas), Array.isArray(r?.ferramentas) ? r.ferramentas : []) : lista<FerramentaApp>(l.ferramentas);
    this.db.run('UPDATE mcp_proprios SET ferramentas = ?, testado_em = ?, erro = ?, updated_at = ? WHERE workspace_id = ? AND nome = ?',
      JSON.stringify(ferramentas), now(), ok ? null : this.db.seal(ws, erro), now(), ws, nome);
    audit(this.db, this.bus, { workspaceId: ws, actorType: actor, actorId: userId, action: 'conexoes.app_proprio.testar', targetType: 'mcp', targetId: nome,
      evidence: { ok, ferramentas: ferramentas.length }, result: ok ? `${l.app}: ${ferramentas.length} ferramenta(s) encontrada(s)` : `${l.app}: o teste não conectou` });
    this.bus.publish(ws, 'agents.changed', {});
    return { ok, erro, ...erroT(erro), ferramentas };
  }

  /** A pessoa (ou a coordenação, com o sim dela) muda a classe de uma ferramenta. */
  classificar(ws: string, userId: string, nome: string, ferramenta: string, tipo: TipoFerramenta, actor: 'user' | 'agent' = 'user'): AppConectado {
    if (!ehTipo(tipo)) throw new HttpError(400, 'tipo', 'escolha leitura, escrita ou envio');
    const l = this.linha(ws, nome);
    const fs = lista<FerramentaApp>(l.ferramentas);
    const f = fs.find((x) => x.nome === ferramenta);
    if (!f) throw notFound('ferramenta');
    f.tipo = tipo;
    this.db.run('UPDATE mcp_proprios SET ferramentas = ?, updated_at = ? WHERE workspace_id = ? AND nome = ?', JSON.stringify(fs), now(), ws, nome);
    audit(this.db, this.bus, { workspaceId: ws, actorType: actor, actorId: userId, action: 'conexoes.app_proprio.classificar', targetType: 'mcp', targetId: nome,
      evidence: { ferramenta, tipo, sugerido: f.sugerido }, result: `${l.app}: '${clip(ferramenta, 80)}' agora conta como ${tipo}` });
    this.bus.publish(ws, 'agents.changed', {});
    return this.paraTela({ ...l, ferramentas: JSON.stringify(fs) });
  }

  /** Troca o valor de chaves que o aplicativo já tem (só os nomes que foram guardados). */
  async trocarChaves(ws: string, userId: string, nome: string, valores: Record<string, string>, actor: 'user' | 'agent' = 'user'): Promise<void> {
    const l = this.linha(ws, nome);
    const chaves = lista<ChaveApp>(l.segredos);
    const cabecalhos: Record<string, string> = {}; const variaveis: Record<string, string> = {};
    for (const [k, v] of Object.entries(valores)) {
      const c = chaves.find((x) => x.nome === k);
      if (!c) throw new HttpError(400, 'app_chave', `este aplicativo não tem a chave ${clip(k, 40)}`);
      if (typeof v !== 'string' || !v.trim() || v.length > 4000 || !/^[\x20-\x7e]+$/.test(v.trim())) throw new HttpError(400, 'app_valor', `preencha o valor de ${clip(k, 40)} (sem acentos)`);
      (c.tipo === 'cabecalho' ? cabecalhos : variaveis)[k] = v.trim();
    }
    if (!Object.keys(cabecalhos).length && !Object.keys(variaveis).length) throw new HttpError(400, 'vazio', 'nada a trocar');
    await this.recursos.ponte(ws, 'PUT', `conectores-proprio/${nome}/segredos`, { cabecalhos, variaveis });
    audit(this.db, this.bus, { workspaceId: ws, actorType: actor, actorId: userId, action: 'conexoes.app_proprio.chaves', targetType: 'mcp', targetId: nome,
      evidence: { chaves: Object.keys(valores) }, result: `${l.app}: chave trocada` });
  }

  /** Desconecta: o motor tira o servidor e as chaves do cofre; a liberação da escrita sai junto. */
  async remover(ws: string, userId: string, nome: string, actor: 'user' | 'agent' = 'user'): Promise<void> {
    const l = this.linha(ws, nome);
    try { await this.recursos.removerConector(ws, userId, nome); } catch (e) {
      // o motor já não tem este servidor (refeito, ou removido por fora): a linha daqui sai do mesmo jeito
      if (!(e instanceof HttpError && e.code === 'recursos_atualizando')) throw e;
      if (this.recursos.escrita(ws).includes(nome)) this.recursos.setEscrita(ws, userId, nome, false);
    }
    this.db.tx(() => {
      this.db.run('DELETE FROM mcp_proprios WHERE workspace_id = ? AND nome = ?', ws, nome);
      // saiu a principal: a mais antiga das outras contas do aplicativo passa a ser a principal (como em Conexões)
      if (l.conta === '') {
        const prox = this.contasDoApp(ws, l.chave_app)[0];
        if (prox) this.db.run("UPDATE mcp_proprios SET conta = '', updated_at = ? WHERE workspace_id = ? AND nome = ?", now(), ws, prox.nome);
      }
    });
    audit(this.db, this.bus, { workspaceId: ws, actorType: actor, actorId: userId, action: 'conexoes.app_proprio.remover', targetType: 'mcp', targetId: nome,
      evidence: { app: l.app }, result: `aplicativo ${l.app}${l.apelido ? ` (${l.apelido})` : ''} desconectado e chaves apagadas do cofre` });
    this.bus.publish(ws, 'agents.changed', {});
  }

  /** O apelido da conta (vazio: sem apelido). Dois iguais no mesmo aplicativo confundiriam quem pede (como em Conexões). */
  renomear(ws: string, userId: string, nome: string, apelido: string, actor: 'user' | 'agent' = 'user'): AppConectado {
    const l = this.linha(ws, nome);
    const novo = apelido.replace(/\s+/g, ' ').trim().slice(0, 40);
    this.apelidoRepetido(ws, l.chave_app, novo, nome);
    this.db.run('UPDATE mcp_proprios SET apelido = ?, updated_at = ? WHERE workspace_id = ? AND nome = ?', this.db.seal(ws, novo || null), now(), ws, nome);
    audit(this.db, this.bus, { workspaceId: ws, actorType: actor, actorId: userId, action: 'conexoes.app_proprio.apelido', targetType: 'mcp', targetId: nome,
      evidence: { app: l.app }, result: novo ? 'apelido da conta atualizado' : 'apelido da conta removido' });
    this.bus.publish(ws, 'agents.changed', {});
    return this.um(ws, nome);
  }

  /** Esta conta passa a ser a principal do aplicativo: só o campo conta das duas linhas troca (o servidor e as chaves seguem cada uma). */
  tornarPrincipal(ws: string, userId: string, nome: string, actor: 'user' | 'agent' = 'user'): AppConectado {
    const l = this.linha(ws, nome);
    if (l.conta === '') return this.paraTela(l);
    const p = this.contasDoApp(ws, l.chave_app).find((c) => c.conta === '');
    this.db.tx(() => {
      if (p) this.db.run('UPDATE mcp_proprios SET conta = ? WHERE workspace_id = ? AND nome = ?', novaContaId(), ws, p.nome);
      this.db.run("UPDATE mcp_proprios SET conta = '', updated_at = ? WHERE workspace_id = ? AND nome = ?", now(), ws, nome);
      if (p) this.db.run('UPDATE mcp_proprios SET conta = ? WHERE workspace_id = ? AND nome = ?', l.conta, ws, p.nome);
    });
    audit(this.db, this.bus, { workspaceId: ws, actorType: actor, actorId: userId, action: 'conexoes.app_proprio.principal', targetType: 'mcp', targetId: nome,
      evidence: { app: l.app }, result: 'esta conta passou a ser a principal do aplicativo' });
    this.bus.publish(ws, 'agents.changed', {});
    return this.um(ws, nome);
  }

  /** Para a política de cada sessão: {servidor: {ferramenta: classe}}. Vazio = nada a mandar (vale a sugestão pelo nome). */
  politica(ws: string): Record<string, Record<string, TipoFerramenta>> {
    const out: Record<string, Record<string, TipoFerramenta>> = {};
    for (const l of this.db.all<{ nome: string; ferramentas: string }>('SELECT nome, ferramentas FROM mcp_proprios WHERE workspace_id = ?', ws)) {
      const fs = lista<FerramentaApp>(l.ferramentas).filter((f) => ehTipo(f.tipo));
      if (fs.length) out[l.nome] = Object.fromEntries(fs.map((f) => [f.nome, f.tipo]));
    }
    return out;
  }
}
