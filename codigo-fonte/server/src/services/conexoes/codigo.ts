/**
 * Código de verdade no GitHub e no GitLab (rc.42, "mãos na massa"): o agente clona o repositório no Terminal do motor, cria
 * um ramo, edita, roda os testes, faz commit, envia e abre o pull request — sem nunca ver o token da conexão.
 *
 * Como o token fica longe do agente:
 *   - `codigo.preparar` abre uma CONCESSÃO: vale para UM repositório, UM trabalho (a execução que pediu) e pouco tempo
 *     (CONCESSAO_MIN). O motor recebe o endereço do Ergon (/internal/git/v1/<kind>/<repo>.git) e uma senha de uso curto, que
 *     o plugin entrega só ao git (credential helper) e tira da resposta antes de ela ir ao modelo. Só o hash fica no banco.
 *   - O Ergon conversa com o GitHub/GitLab com o token guardado (encaminhar). O token nunca vai ao motor, ao .git/config,
 *     a log ou ao histórico; a concessão morre com o trabalho (a execução que terminou não abre mais nada) ou em
 *     `codigo.encerrar`.
 *   - Outro repositório, outro workspace, outra execução: a concessão não vale (o caminho pedido tem de ser o concedido).
 *
 * O que o envio (git push) pode sem perguntar: ramos que não são o principal. Enviar ao ramo principal e apagar ramos pelo
 * envio exigem a aprovação da pessoa (codigo.liberar_principal, um cartão) ou o "Liberar tudo" de quem pediu. O resto que
 * pesa vai pela API, com o cartão: incorporar (merge), apagar ramo, disparar Actions/pipelines; apagar o repositório é
 * sempre-protegida (pede sempre, até com "Liberar tudo"). Segredos (Actions secrets, variáveis de CI) os agentes não mexem:
 * um segredo só passa pelo cartão seguro da pessoa (cartoes.ts), nunca pelo que o modelo escreve.
 *
 * Referências (conferidas em 21/11/2026):
 *   https://git-scm.com/docs/http-protocol (smart HTTP: info/refs, git-upload-pack, git-receive-pack)
 *   https://git-scm.com/docs/pack-protocol (pkt-line; comandos do receive-pack; report-status; side-band-64k)
 *   https://git-scm.com/docs/gitcredentials (credential helper)
 *   https://docs.github.com/en/rest/repos/repos#get-a-repository (default_branch, permissions)
 *   https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request   https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request
 *   https://docs.github.com/en/rest/git/refs#delete-a-reference   https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
 *   https://docs.github.com/en/rest/repos/repos#delete-a-repository (escopo delete_repo)
 *   https://docs.gitlab.com/api/projects/#get-a-single-project   https://docs.gitlab.com/api/merge_requests/#create-mr
 *   https://docs.gitlab.com/api/merge_requests/#merge-a-merge-request   https://docs.gitlab.com/api/branches/#delete-repository-branch
 *   https://docs.gitlab.com/api/pipelines/#create-a-new-pipeline   https://docs.gitlab.com/api/projects/#delete-a-project
 *   https://docs.gitlab.com/topics/git/troubleshooting_git/ (token pessoal como senha no HTTPS)
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import type { Db } from '../../db/db.ts';
import { clip, id, now } from '../../lib/util.ts';
import { audit, type Bus } from '../bus.ts';
import { neutral } from '../operations.ts';
import { semMencao } from './conectores/extras-github.ts';
import { hostSeguro } from './conectores/declarativo.ts';
import { MAX_ENVIO, MAX_TITULO, textoParaGitLab } from './conectores/gitlab.ts';
import { ErroAcao, num, precisa, seg, txt, type Acao, type Args, type CtxAcao, type Param } from './tipos.ts';

export type KindCodigo = 'github' | 'gitlab';
/** Quanto vale uma concessão (o trabalho que acabou antes leva a concessão junto). */
export const CONCESSAO_MIN = 60;
/** Quanto vale a liberação de enviar ao ramo principal (ou apagar ramos) depois do cartão. */
export const LIBERACAO_MIN = 30;
const PREFIXO = '/internal/git/v1';
/** Teto do que o envio (push) traz: um repositório grande passa disso só no primeiro envio, que é o clone, não o push. */
const TETO_ENVIO = 512 * 1024 * 1024;

interface Linha { id: string; workspace_id: string; run_id: string; agent_id: string | null; kind: KindCodigo; conta: string; repo: string; principal: string;
  expira_em: string; principal_ate: string | null; apagar_ramo_ate: string | null; revogada_em: string | null }

/** O que o agente recebe: o caminho no Ergon e, só para o git (o plugin tira antes do modelo), a senha de uso curto. */
export interface AcessoGit { caminho: string; usuario: string; senha: string; expira: string }

/** As concessões de um trabalho e de uma conta, como as ações de código as usam (CtxAcao.git). */
export interface PonteGit {
  abrir(repo: string, principal: string): AcessoGit;
  /** a pessoa aprovou (ou o modo "Liberar tudo"): por LIBERACAO_MIN, o envio pode o ramo principal e/ou apagar ramos */
  liberar(repo: string, o: { principal?: boolean; apagarRamo?: boolean }): boolean;
  /** troca a senha da concessão viva (depois de um cartão: a senha do clique nunca saiu do Ergon) */
  renovar(repo: string): AcessoGit | null;
  encerrar(repo?: string): number;
}

/** Repositório do GitHub: "dono/nome", só com os caracteres que o GitHub aceita. */
export function repoGitHub(v: unknown): string {
  const s = String(v ?? '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!/^[\w.-]{1,100}\/[\w.-]{1,100}$/.test(s) || s.split('/').some((p) => p === '.' || p === '..')) throw new ErroAcao('"repositorio" inválido: use dono/nome, como acme/app');
  return s;
}
/** Projeto do GitLab: "grupo/sub/projeto" (até 20 níveis). */
export function repoGitLab(v: unknown): string {
  const s = String(v ?? '').trim().replace(/^https?:\/\/[^/]+\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const partes = s.split('/');
  if (partes.length < 2 || partes.length > 20 || partes.some((p) => !/^[\w.-]{1,255}$/.test(p) || p === '.' || p === '..')) throw new ErroAcao('"repositorio" inválido: use grupo/projeto, como acme/app');
  return s;
}
const repoDe = (kind: KindCodigo, v: unknown): string => (kind === 'github' ? repoGitHub(v) : repoGitLab(v));
/** Nome de ramo que o git aceita e que não sai do lugar (git check-ref-format, o essencial). */
export function ramo(v: unknown, k = 'ramo'): string {
  const s = String(v ?? '').trim().replace(/^refs\/heads\//, '');
  if (!s || s.length > 200 || /[\s~^:?*[\\\u0000-\u001f\u007f]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^-|\.$/.test(s)) throw new ErroAcao(`"${k}" inválido: use um nome de ramo, como ergon/ajuste-x`);
  return s;
}
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export class ConcessoesGit {
  private readonly db: Db;
  private readonly bus: Bus;
  /** a execução ainda está trabalhando? (a concessão morre com ela) */
  private readonly ativa: (runId: string) => boolean;
  constructor(db: Db, bus: Bus, ativa?: (runId: string) => boolean) {
    this.db = db; this.bus = bus;
    this.ativa = ativa ?? ((runId) => !!db.get("SELECT 1 AS x FROM runs WHERE id = ? AND status IN ('queued', 'running', 'waiting_user')", runId));
  }

  ponte(ws: string, runId: string, agentId: string | null, kind: KindCodigo, conta: string): PonteGit {
    const caminho = (repo: string) => `${PREFIXO}/${kind}/${repo}.git`;
    const viva = (repo: string) => this.db.get<Linha>(`SELECT * FROM git_concessoes WHERE workspace_id = ? AND run_id = ? AND kind = ? AND conta = ? AND repo = ? AND revogada_em IS NULL AND expira_em > ?
      ORDER BY criada_em DESC LIMIT 1`, ws, runId, kind, conta, repo, now());
    const senhaNova = (linha: string, repo: string, expira: string): AcessoGit => {
      const senha = `ergit_${crypto.randomBytes(32).toString('hex')}`;
      this.db.run('UPDATE git_concessoes SET senha_hash = ? WHERE id = ?', hash(senha), linha);
      return { caminho: caminho(repo), usuario: 'ergon', senha, expira };
    };
    return {
      abrir: (repo, principal) => {
        // uma por repositório e trabalho: abrir de novo troca a senha e estende o prazo (o clone novo não deixa a antiga viva)
        const expira = new Date(Date.now() + CONCESSAO_MIN * 60_000).toISOString();
        const antes = viva(repo);
        const linha = antes?.id ?? id('gco');
        if (antes) this.db.run('UPDATE git_concessoes SET expira_em = ?, principal = ? WHERE id = ?', expira, principal, linha);
        else this.db.run(`INSERT INTO git_concessoes (id, workspace_id, run_id, agent_id, kind, conta, repo, principal, senha_hash, criada_em, expira_em) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          linha, ws, runId, agentId, kind, conta, repo, principal, hash(crypto.randomBytes(16).toString('hex')), now(), expira);
        audit(this.db, this.bus, { workspaceId: ws, actorType: 'agent', actorId: agentId, action: 'codigo.concessao', targetType: 'integration', targetId: kind,
          evidence: { repo, principal, run: runId, expira }, result: `acesso de ${CONCESSAO_MIN} min a ${repo}, só para este trabalho` });
        return senhaNova(linha, repo, expira);
      },
      liberar: (repo, o) => {
        const c = viva(repo);
        if (!c) return false;
        const ate = new Date(Date.now() + LIBERACAO_MIN * 60_000).toISOString();
        if (o.principal) this.db.run('UPDATE git_concessoes SET principal_ate = ? WHERE id = ?', ate, c.id);
        if (o.apagarRamo) this.db.run('UPDATE git_concessoes SET apagar_ramo_ate = ? WHERE id = ?', ate, c.id);
        return true;
      },
      renovar: (repo) => { const c = viva(repo); return c ? senhaNova(c.id, repo, c.expira_em) : null; },
      encerrar: (repo) => this.db.run(`UPDATE git_concessoes SET revogada_em = ? WHERE workspace_id = ? AND run_id = ? AND kind = ? AND revogada_em IS NULL${repo ? ' AND repo = ?' : ''}`,
        now(), ws, runId, kind, ...(repo ? [repo] : [])).changes,
    };
  }

  /** A concessão desta senha, se ainda vale: não revogada, no prazo e com o trabalho em andamento. */
  autenticar(senha: string): Linha | null {
    if (!/^ergit_[0-9a-f]{64}$/.test(senha)) return null;
    const c = this.db.get<Linha>('SELECT * FROM git_concessoes WHERE senha_hash = ?', hash(senha));
    if (!c || c.revogada_em || Date.parse(c.expira_em) <= Date.now()) return null;
    if (!this.ativa(c.run_id)) { this.db.run('UPDATE git_concessoes SET revogada_em = ? WHERE id = ?', now(), c.id); return null; }
    return c;
  }
  /** Terminou o trabalho: as concessões dele acabam (o plugin também apaga a senha guardada para o git). */
  revogarDaExecucao(runId: string): number {
    return this.db.run('UPDATE git_concessoes SET revogada_em = ? WHERE run_id = ? AND revogada_em IS NULL', now(), runId).changes;
  }
  usou(c: Linha): void { this.db.run('UPDATE git_concessoes SET usos = usos + 1 WHERE id = ?', c.id); }
}

// ------------------------------------------------------------------------------------------------- o envio (push)
interface Comando { antigo: string; novo: string; ref: string }
const ZERO = /^0{40}(?:0{24})?$/;
/** Os comandos do receive-pack (pkt-line até o flush), e as capacidades que o cliente pediu. */
export function comandosDoEnvio(corpo: Buffer): { comandos: Comando[]; caps: string[] } {
  const comandos: Comando[] = []; let caps: string[] = []; let p = 0;
  while (p + 4 <= corpo.length) {
    const n = parseInt(corpo.subarray(p, p + 4).toString('ascii'), 16);
    if (!Number.isFinite(n)) throw new Error('pkt-line inválido');
    if (n === 0) break;
    if (n < 4 || p + n > corpo.length) throw new Error('pkt-line inválido');
    let linha = corpo.subarray(p + 4, p + n).toString('utf8');
    p += n;
    const nul = linha.indexOf('\0');
    if (nul >= 0) { caps = linha.slice(nul + 1).trim().split(' ').filter(Boolean); linha = linha.slice(0, nul); }
    linha = linha.replace(/\n$/, '');
    if (linha.startsWith('shallow ')) continue;
    const m = /^([0-9a-f]{40,64}) ([0-9a-f]{40,64}) (\S+)$/.exec(linha);
    if (!m) throw new Error('comando de envio inválido');
    comandos.push({ antigo: m[1], novo: m[2], ref: m[3] });
  }
  return { comandos, caps };
}
const pkt = (s: string | Buffer): Buffer => { const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8'); return Buffer.concat([Buffer.from((b.length + 4).toString(16).padStart(4, '0'), 'ascii'), b]); };
/**
 * A recusa do jeito que o git mostra ("! [remote rejected] main -> main (motivo)"), com o aviso na linha "remote:". Sem
 * report-status pedido, o git só entende o erro HTTP: a recusa vai como 403 com o texto.
 */
export function recusaDoEnvio(comandos: Comando[], caps: string[], motivo: string): { status: number; tipo: string; corpo: Buffer } {
  if (!caps.includes('report-status') && !caps.includes('report-status-v2')) return { status: 403, tipo: 'text/plain; charset=utf-8', corpo: Buffer.from(`Ergon: ${motivo}\n`) };
  const curto = motivo.replace(/[\r\n]+/g, ' ').slice(0, 300);
  const relatorio = Buffer.concat([pkt('unpack ok\n'), ...comandos.map((c) => pkt(`ng ${c.ref} ${curto}\n`)), Buffer.from('0000')]);
  const lateral = caps.includes('side-band-64k') || caps.includes('side-band');
  const corpo = lateral ? Buffer.concat([pkt(Buffer.concat([Buffer.from([2]), Buffer.from(`Ergon: ${curto}\n`)])), pkt(Buffer.concat([Buffer.from([1]), relatorio])), Buffer.from('0000')]) : relatorio;
  return { status: 200, tipo: 'application/x-git-receive-pack-result', corpo };
}

interface DepsProxy {
  db: Db; bus: Bus; concessoes: ConcessoesGit;
  /** a credencial guardada da conexão (o token): só aqui, nunca vai ao motor */
  credencial(ws: string, kind: KindCodigo, conta: string): Record<string, string> | null;
  /** "Liberar tudo" de quem pediu este trabalho (o envio ao principal passa direto) */
  liberarTudo(ws: string, runId: string): boolean;
}
/** Onde está o repositório de verdade e como entrar nele com o token guardado. */
export function destinoGit(kind: KindCodigo, c: Record<string, string>, repo: string): { url: string; auth: string } {
  if (kind === 'github') return { url: `https://github.com/${repo}.git`, auth: `Basic ${Buffer.from(`x-access-token:${c.token}`).toString('base64')}` };
  return { url: `https://${c.site ? hostSeguro(c.site) : 'gitlab.com'}/${repo}.git`, auth: `Basic ${Buffer.from(`ergon:${c.token}`).toString('base64')}` };
}
const SERVICOS = new Set(['git-upload-pack', 'git-receive-pack']);

/**
 * O caminho do git no Ergon: /internal/git/v1/<kind>/<repo>.git/{info/refs, git-upload-pack, git-receive-pack}. Entra com a
 * senha da concessão (Basic, como o git manda pelo credential helper); sai para o serviço com o token guardado.
 */
export function registrarProxyGit(app: FastifyInstance, d: DepsProxy): void {
  app.register(async (escopo) => {
    for (const tipo of ['application/x-git-upload-pack-request', 'application/x-git-receive-pack-request']) {
      escopo.addContentTypeParser(tipo, { parseAs: 'buffer', bodyLimit: TETO_ENVIO }, (_req, corpo, feito) => feito(null, corpo));
    }
    escopo.route({ method: ['GET', 'POST'], url: `${PREFIXO}/:kind/*`, bodyLimit: TETO_ENVIO, handler: async (req, reply) => {
      const pedir = () => reply.code(401).header('WWW-Authenticate', 'Basic realm="Ergon"').type('text/plain; charset=utf-8').send('Ergon: acesso de código vencido ou inexistente; peça codigo.preparar de novo\n');
      const kind = (req.params as { kind: string }).kind;
      const resto = (req.params as { '*': string })['*'] ?? '';
      if (kind !== 'github' && kind !== 'gitlab') return reply.code(404).send();
      const m = /^(.+?)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(resto);
      if (!m) return reply.code(404).send();
      const [, repo, oQue] = m;
      const q = req.query as { service?: string };
      if (oQue === 'info/refs' && !SERVICOS.has(String(q.service ?? ''))) return reply.code(403).type('text/plain').send('Ergon: só o protocolo inteligente do git\n');
      const b = /^Basic\s+(.+)$/i.exec(String(req.headers.authorization ?? ''));
      const senha = b ? Buffer.from(b[1], 'base64').toString('utf8').split(':').slice(1).join(':') : '';
      const c = senha ? d.concessoes.autenticar(senha) : null;
      // outro repositório, outro aplicativo: a mesma resposta de quem não tem acesso (não diz o que existe)
      if (!c || c.kind !== kind || c.repo !== repo) return pedir();
      const servico = oQue === 'info/refs' ? String(q.service) : oQue;
      const corpo = req.method === 'POST' ? (Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)) : null;
      if (servico === 'git-receive-pack' && corpo) {
        let cmds: ReturnType<typeof comandosDoEnvio>;
        try { cmds = comandosDoEnvio(/gzip/i.test(String(req.headers['content-encoding'] ?? '')) ? zlib.gunzipSync(corpo) : corpo); } catch { return reply.code(400).type('text/plain').send('Ergon: envio ilegível\n'); }
        const agora = Date.now();
        const livre = d.liberarTudo(c.workspace_id, c.run_id);
        const principalOk = livre || (!!c.principal_ate && Date.parse(c.principal_ate) > agora);
        const apagarOk = livre || (!!c.apagar_ramo_ate && Date.parse(c.apagar_ramo_ate) > agora);
        const noPrincipal = cmds.comandos.filter((x) => x.ref === `refs/heads/${c.principal}`);
        const apagando = cmds.comandos.filter((x) => ZERO.test(x.novo));
        const motivo = noPrincipal.length && !principalOk ? `enviar direto ao ramo principal (${c.principal}) pede a aprovação da pessoa: envie a um ramo novo e abra um pull request (codigo.abrir_pr), ou peça codigo.liberar_principal`
          : apagando.length && !apagarOk ? 'apagar um ramo pede a aprovação da pessoa: use codigo.apagar_ramo' : null;
        audit(d.db, d.bus, { workspaceId: c.workspace_id, actorType: 'agent', actorId: c.agent_id, action: motivo ? 'codigo.envio.recusado' : 'codigo.envio', targetType: 'integration', targetId: kind,
          evidence: { repo, run: c.run_id, refs: cmds.comandos.map((x) => ({ ref: x.ref, de: x.antigo.slice(0, 12), para: x.novo.slice(0, 12) })), ...(livre ? { liberarTudo: true } : {}) },
          result: motivo ?? `enviado a ${repo}: ${cmds.comandos.map((x) => x.ref.replace(/^refs\/heads\//, '')).join(', ')}` });
        if (motivo) { const r = recusaDoEnvio(cmds.comandos, cmds.caps, motivo); return reply.code(r.status).type(r.tipo).send(r.corpo); }
      }
      const cred = d.credencial(c.workspace_id, c.kind, c.conta);
      if (!cred?.token) return reply.code(403).type('text/plain').send('Ergon: a conexão saiu ou caiu; conecte de novo em Conexões\n');
      d.concessoes.usou(c);
      const alvo = destinoGit(c.kind, cred, repo);
      const cab: Record<string, string> = { Authorization: alvo.auth, 'User-Agent': 'git/2 (Ergon)' };
      for (const h of ['content-type', 'accept', 'git-protocol', 'content-encoding']) { const v = req.headers[h]; if (typeof v === 'string') cab[h] = v; }
      let r: Response;
      try {
        // sem redirecionar: o cabeçalho com o token não segue para outro endereço
        r = await fetch(`${alvo.url}/${oQue}${oQue === 'info/refs' ? `?service=${servico}` : ''}`, { method: req.method, headers: cab, body: corpo ? new Uint8Array(corpo) : undefined, redirect: 'error' });
      } catch {
        return reply.code(502).type('text/plain').send(`Ergon: o ${kind === 'github' ? 'GitHub' : 'GitLab'} não respondeu; tente de novo daqui a pouco\n`);
      }
      // 401/403 do serviço viram 403 aqui: o git não pede senha de novo (a concessão está certa; é o token que não tem acesso)
      if (r.status === 401 || r.status === 403 || r.status === 404) return reply.code(403).type('text/plain').send(`Ergon: o ${kind === 'github' ? 'GitHub' : 'GitLab'} recusou o acesso a ${repo} com a conta conectada (${r.status})\n`);
      const dados = Buffer.from(await r.arrayBuffer());
      reply.code(r.status).header('Cache-Control', 'no-cache');
      const tipo = r.headers.get('content-type'); if (tipo) reply.type(tipo);
      return reply.send(dados);
    } });
  });
}

// ------------------------------------------------------------------------------------------------- ações
const P_REPO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'o repositório: dono/nome no GitHub, grupo/projeto no GitLab' };
const P_RAMO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'o nome do ramo, como ergon/ajuste-x' };
const P_NUM: Param = { tipo: 'numero', obrigatorio: true, descricao: 'o número do pull request (no GitLab, o !número do merge request)' };
const s = (a: Args, k: string): string => (typeof a[k] === 'string' || typeof a[k] === 'number' ? String(a[k]) : '');
const precisaPonte = (ctx: CtxAcao): PonteGit => {
  if (!ctx.git) throw new ErroAcao('o acesso ao código só funciona dentro de um trabalho em andamento no Ergon');
  return ctx.git;
};
const nomeApp = (k: KindCodigo) => (k === 'github' ? 'GitHub' : 'GitLab');
/** O passo a passo que o agente recebe com o acesso: o endereço sem segredo; a senha o git busca sozinho. */
const COMO = (url: string, principal: string) => [
  `Endereço para o git (sem senha: o git já recebe o acesso sozinho): ${url}`,
  `Ramo principal: ${principal}. Não envie a ele: crie um ramo (git switch -c ergon/<assunto>), faça o trabalho, rode os testes, commit e git push -u origin <ramo>; depois abra o pull request com codigo.abrir_pr.`,
  'Nunca escreva usuário, senha ou token no endereço, no .git/config ou em arquivo do repositório. Ao terminar, chame codigo.encerrar e apague a cópia (rm -rf da pasta).',
].join('\n');

interface InfoRepo { principal: string; escrita: boolean; web: string; idApi: string }
async function infoGitHub(ctx: CtxAcao, repo: string): Promise<InfoRepo> {
  const j = await ctx.http(`/repos/${repo.split('/').map(seg).join('/')}`);
  return { principal: String(j.default_branch || 'main'), escrita: !!(j.permissions?.push || j.permissions?.admin || j.permissions?.maintain), web: String(j.html_url ?? `https://github.com/${repo}`), idApi: repo.split('/').map(seg).join('/') };
}
async function infoGitLab(ctx: CtxAcao, repo: string): Promise<InfoRepo> {
  const j = await ctx.http(`/projects/${encodeURIComponent(repo)}`);
  const nivel = Math.max(Number(j.permissions?.project_access?.access_level ?? 0), Number(j.permissions?.group_access?.access_level ?? 0));
  return { principal: String(j.default_branch || 'main'), escrita: nivel >= 30, web: String(j.web_url ?? ''), idApi: encodeURIComponent(repo) };
}
const info = (k: KindCodigo, ctx: CtxAcao, repo: string) => (k === 'github' ? infoGitHub(ctx, repo) : infoGitLab(ctx, repo));

function acoesCodigo(k: KindCodigo): Acao[] {
  const app = nomeApp(k);
  const pr = k === 'github' ? 'pull request' : 'merge request';
  return [
    { id: 'codigo.preparar', risco: 'organizar', rotulo: `prepara o acesso de curta duração para clonar e enviar ramos a um repositório do ${app}`,
      descricao: `abre um acesso de ${CONCESSAO_MIN} min a UM repositório, só para este trabalho: devolve o endereço para git clone e o ramo principal. O git recebe o acesso sozinho (você nunca vê senha). Enviar a ramos novos vai direto; ao ramo principal, não`,
      params: { repositorio: P_REPO },
      resumo: (a) => `Dar ao agente, por ${CONCESSAO_MIN} minutos e só neste trabalho, acesso para clonar ${s(a, 'repositorio')} no ${app} e enviar ramos novos (o ramo principal continua protegido)`,
      async run(ctx, a) {
        const repo = repoDe(k, precisa(a, 'repositorio', 300));
        const i = await info(k, ctx, repo);
        if (!i.escrita) throw new ErroAcao(`a conta conectada não tem permissão de escrita em ${repo}: dá para ler, mas não para enviar. Peça à pessoa acesso de escrita, ou trabalhe num fork`);
        const acesso = precisaPonte(ctx).abrir(repo, i.principal);
        return { texto: `Acesso pronto a ${repo} (vale até ${acesso.expira.slice(11, 16)} UTC, só neste trabalho).\n${COMO('{{git_url}}', i.principal)}`, url: i.web || null, git: acesso };
      } },
    { id: 'codigo.abrir_pr', risco: 'enviar', rotulo: `abre um ${pr} de um ramo já enviado`,
      descricao: `abre um ${pr} do ramo que você enviou para o ramo principal (ou outro "destino"); quem acompanha o repositório recebe. O @ no texto não marca ninguém. Devolve o link`,
      params: { repositorio: P_REPO, ramo: P_RAMO, titulo: { tipo: 'texto', obrigatorio: true, descricao: 'título curto, até 500 caracteres', max: MAX_TITULO },
        texto: { tipo: 'texto', descricao: 'o que mudou, por que, e como foi testado (até 5000 caracteres)', max: MAX_ENVIO }, destino: { tipo: 'texto', descricao: 'ramo de destino; padrão: o principal' },
        rascunho: { tipo: 'booleano', descricao: 'abrir como rascunho (draft)' } },
      resumo: (a) => `Abrir em ${s(a, 'repositorio')} no ${app} o ${pr} "${s(a, 'titulo')}", do ramo ${s(a, 'ramo')} para ${s(a, 'destino') || 'o ramo principal'}:\n${s(a, 'texto') || '(sem descrição)'}`,
      async run(ctx, a) {
        const repo = repoDe(k, precisa(a, 'repositorio', 300)); const i = await info(k, ctx, repo);
        const origem = ramo(a.ramo); const destino = a.destino ? ramo(a.destino, 'destino') : i.principal;
        if (origem === destino) throw new ErroAcao('o ramo e o destino são o mesmo: envie o trabalho a um ramo novo antes');
        const titulo = precisa(a, 'titulo', MAX_TITULO).replace(/[\r\n]+/g, ' '); const corpo = txt(a, 'texto', MAX_ENVIO) ?? '';
        const rasc = a.rascunho === true || a.rascunho === 'true';
        if (k === 'github') {
          const j = await ctx.http(`/repos/${i.idApi}/pulls`, { method: 'POST', kind: 'write', body: { title: semMencao(titulo), head: origem, base: destino, body: semMencao(corpo), draft: rasc } });
          return { texto: `Pull request #${j.number} aberto: ${j.html_url}`, url: String(j.html_url) };
        }
        const j = await ctx.http(`/projects/${i.idApi}/merge_requests`, { method: 'POST', kind: 'write', body: { source_branch: origem, target_branch: destino, title: `${rasc ? 'Draft: ' : ''}${textoParaGitLab(titulo)}`, description: textoParaGitLab(corpo) } });
        return { texto: `Merge request !${j.iid} aberto: ${j.web_url}`, url: String(j.web_url) };
      } },
    { id: 'codigo.liberar_principal', risco: 'apagar', rotulo: 'libera, por 30 minutos, enviar direto ao ramo principal (pede a sua aprovação)',
      descricao: `pede à pessoa para liberar, por ${LIBERACAO_MIN} min, o envio direto ao ramo principal deste repositório (e, com apagar_ramos, apagar ramos pelo envio). Prefira sempre ramo + ${pr}`,
      params: { repositorio: P_REPO, motivo: { tipo: 'texto', obrigatorio: true, descricao: 'por que precisa enviar direto ao principal' }, apagar_ramos: { tipo: 'booleano', descricao: 'também apagar ramos pelo envio' } },
      resumo: (a) => `Deixar o agente enviar direto ao ramo principal de ${s(a, 'repositorio')} no ${app} por ${LIBERACAO_MIN} minutos${a.apagar_ramos === true ? ', e apagar ramos' : ''}. Motivo: ${s(a, 'motivo')}`,
      async run(ctx, a) {
        const repo = repoDe(k, precisa(a, 'repositorio', 300));
        if (!precisaPonte(ctx).liberar(repo, { principal: true, apagarRamo: a.apagar_ramos === true })) throw new ErroAcao('não há acesso aberto a este repositório neste trabalho: chame codigo.preparar antes');
        return { texto: `Liberado por ${LIBERACAO_MIN} min: o envio direto ao ramo principal de ${repo}${a.apagar_ramos === true ? ' e apagar ramos' : ''}.` };
      } },
    { id: 'codigo.incorporar', risco: 'apagar', rotulo: `incorpora (merge) um ${pr} (pede a sua aprovação)`,
      descricao: `incorpora (merge) um ${pr} ao destino dele; muda o ramo principal de verdade`, params: { repositorio: P_REPO, numero: P_NUM, metodo: { tipo: 'texto', descricao: 'como juntar', opcoes: ['merge', 'squash', 'rebase'], padrao: 'merge' } },
      resumo: (a) => `Incorporar (merge) o ${pr} ${k === 'github' ? '#' : '!'}${s(a, 'numero')} de ${s(a, 'repositorio')} no ${app}${a.metodo && a.metodo !== 'merge' ? ` (${s(a, 'metodo')})` : ''}`,
      async preparar(ctx, a) {
        const repo = repoDe(k, precisa(a, 'repositorio', 300)); const n = num(a, 'numero', 0, 1e9);
        const j = k === 'github' ? await ctx.http(`/repos/${repo.split('/').map(seg).join('/')}/pulls/${n}`) : await ctx.http(`/projects/${encodeURIComponent(repo)}/merge_requests/${n}`);
        return { detalhe: `${pr} ${k === 'github' ? '#' : '!'}${n}: ${neutral(String(j.title ?? ''), 200)} (${neutral(String(k === 'github' ? j.head?.ref : j.source_branch), 120)} → ${neutral(String(k === 'github' ? j.base?.ref : j.target_branch), 120)})` };
      },
      async run(ctx, a) {
        const repo = repoDe(k, precisa(a, 'repositorio', 300)); const n = num(a, 'numero', 0, 1e9);
        const metodo = ['merge', 'squash', 'rebase'].includes(String(a.metodo)) ? String(a.metodo) : 'merge';
        if (k === 'github') {
          const j = await ctx.http(`/repos/${repo.split('/').map(seg).join('/')}/pulls/${n}/merge`, { method: 'PUT', kind: 'write', body: { merge_method: metodo } });
          return { texto: `Pull request #${n} incorporado (commit ${String(j.sha ?? '').slice(0, 12)}).`, url: `https://github.com/${repo}/pull/${n}` };
        }
        const j = await ctx.http(`/projects/${encodeURIComponent(repo)}/merge_requests/${n}/merge`, { method: 'PUT', kind: 'write', body: metodo === 'squash' ? { squash: true } : {} });
        return { texto: `Merge request !${n} incorporado.`, url: j.web_url ? String(j.web_url) : null };
      } },
    { id: 'codigo.apagar_ramo', risco: 'apagar', rotulo: 'apaga um ramo do repositório (pede a sua aprovação)', descricao: 'apaga um ramo do repositório remoto (nunca o principal)',
      params: { repositorio: P_REPO, ramo: P_RAMO }, resumo: (a) => `Apagar o ramo ${s(a, 'ramo')} de ${s(a, 'repositorio')} no ${app}`,
      async run(ctx, a) {
        const repo = repoDe(k, precisa(a, 'repositorio', 300)); const r = ramo(a.ramo); const i = await info(k, ctx, repo);
        if (r === i.principal) throw new ErroAcao('o ramo principal não se apaga por aqui');
        if (k === 'github') await ctx.http(`/repos/${i.idApi}/git/refs/heads/${r.split('/').map(seg).join('/')}`, { method: 'DELETE', kind: 'write' });
        else await ctx.http(`/projects/${i.idApi}/repository/branches/${encodeURIComponent(r)}`, { method: 'DELETE', kind: 'write' });
        return { texto: `Ramo ${r} apagado de ${repo}.`, url: i.web || null };
      } },
    { id: 'codigo.disparar_ci', risco: 'apagar', rotulo: k === 'github' ? 'dispara um workflow do GitHub Actions (pede a sua aprovação)' : 'dispara um pipeline do GitLab CI (pede a sua aprovação)',
      descricao: k === 'github' ? 'dispara um workflow do GitHub Actions que aceite workflow_dispatch, num ramo' : 'dispara um pipeline do GitLab CI num ramo',
      params: { repositorio: P_REPO, ramo: P_RAMO, ...(k === 'github' ? { workflow: { tipo: 'texto' as const, obrigatorio: true, descricao: 'o arquivo do workflow, como ci.yml' } } : {}) },
      resumo: (a) => `Disparar ${k === 'github' ? `o workflow ${s(a, 'workflow')}` : 'o pipeline'} de ${s(a, 'repositorio')} no ${app}, no ramo ${s(a, 'ramo')}`,
      async run(ctx, a) {
        const repo = repoDe(k, precisa(a, 'repositorio', 300)); const r = ramo(a.ramo);
        if (k === 'github') {
          const wf = precisa(a, 'workflow', 200);
          if (!/^[\w.-]+\.ya?ml$/.test(wf) && !/^\d+$/.test(wf)) throw new ErroAcao('"workflow" inválido: use o nome do arquivo, como ci.yml');
          await ctx.http(`/repos/${repo.split('/').map(seg).join('/')}/actions/workflows/${seg(wf)}/dispatches`, { method: 'POST', kind: 'write', body: { ref: r } });
          return { texto: `Workflow ${wf} disparado no ramo ${r}.`, url: `https://github.com/${repo}/actions` };
        }
        const j = await ctx.http(`/projects/${encodeURIComponent(repo)}/pipeline`, { method: 'POST', kind: 'write', body: { ref: r } });
        return { texto: `Pipeline ${j.id} disparado no ramo ${r}.`, url: j.web_url ? String(j.web_url) : null };
      } },
    { id: 'codigo.apagar_repositorio', risco: 'apagar', protegida: 'apagar um repositório não tem volta: pede a sua aprovação sempre, mesmo com "Liberar tudo"', rotulo: 'apaga o repositório inteiro (sempre pede a sua aprovação)',
      descricao: 'apaga o repositório inteiro, sem volta. Só quando a pessoa pediu com todas as letras', params: { repositorio: P_REPO },
      resumo: (a) => `APAGAR DE VEZ o repositório ${s(a, 'repositorio')} no ${app}, com todo o histórico, issues e ${pr}s`,
      async run(ctx, a) {
        const repo = repoDe(k, precisa(a, 'repositorio', 300));
        if (k === 'github') await ctx.http(`/repos/${repo.split('/').map(seg).join('/')}`, { method: 'DELETE', kind: 'write' });
        else await ctx.http(`/projects/${encodeURIComponent(repo)}`, { method: 'DELETE', kind: 'write' });
        precisaPonte(ctx).encerrar(repo);
        return { texto: `Repositório ${repo} apagado.` };
      } },
    { id: 'codigo.encerrar', risco: 'ler', rotulo: 'encerra o acesso de código deste trabalho', descricao: 'encerra o acesso aberto por codigo.preparar (a um repositório, ou a todos deste trabalho). Chame ao terminar',
      params: { repositorio: { tipo: 'texto', descricao: 'um repositório só; vazio = todos deste trabalho' } }, resumo: (a) => `Encerrar o acesso de código${a.repositorio ? ` a ${s(a, 'repositorio')}` : ''}`,
      async run(ctx, a) {
        const n = precisaPonte(ctx).encerrar(a.repositorio ? repoDe(k, a.repositorio) : undefined);
        return { texto: n ? 'Acesso encerrado: o git deste trabalho não alcança mais o repositório.' : 'Não havia acesso aberto.', gitFim: true };
      } },
  ];
}
export const ACOES_CODIGO_GITHUB = acoesCodigo('github');
export const ACOES_CODIGO_GITLAB = acoesCodigo('gitlab');
/** Para o registro: nada do acesso (o endereço do Ergon ou a senha) aparece no que fica gravado. */
export const semAcesso = (t: string): string => clip(t.replace(/ergit_[0-9a-f]{64}/g, '***'), 6000);
