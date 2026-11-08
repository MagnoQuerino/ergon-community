/**
 * Login com a conta (SSO) parametrizado: cada provedor é uma ficha (endereços, permissões, identificador do app,
 * como ler o nome da conta) e o fluxo é um só — OAuth 2.0 com PKCE, `state` aleatório de uso único (10 min) e
 * renovação automática do acesso. Microsoft (Entra) e Google hoje; outro provedor = outra ficha.
 * Tokens só em /data/secrets (SecretStore), nunca no banco, no navegador ou no log.
 */
import crypto from 'node:crypto';
import type { Config } from '../config.ts';
import { HttpError } from '../lib/util.ts';
import { fetchWithPolicy, retryHint } from '../lib/http.ts';
import { ProviderError } from './mirror.ts';
import type { SecretStore } from './integrations.ts';

export type SsoKind = 'microsoft' | 'google';

export interface SsoProvider {
  kind: SsoKind;
  /** nome para mensagens ("a Microsoft recusou…") e o lugar do registro do app ("na Microsoft") */
  label: string;
  place: string;
  authorizeUrl: string;
  tokenUrl: string;
  scopes: string;
  /**
   * Permissões que só existem em conta de trabalho ou escola (Microsoft: Teams, Planner compartilhado, caixas
   * compartilhadas). Pedidas numa segunda etapa, só para essas contas: conta pessoal entra sem erro.
   */
  workScopes?: string;
  /** parâmetros extras do endereço de login (ex.: pedir refresh token no Google) */
  extra: Record<string, string>;
  /** a Microsoft quer `scope` também na troca do código; o Google não */
  scopeOnToken: boolean;
  clientId: (cfg: Config) => string | null;
  /** app "web" do Google exige segredo na troca; app público da Microsoft não tem */
  clientSecret: (cfg: Config) => string | null;
  /** variáveis que faltam para o botão funcionar (mensagem e guia) */
  needs: string;
  doc: string;
  /** nome da conta (e-mail) a partir do acesso recém-obtido */
  account: (accessToken: string) => Promise<string>;
}

async function getJson(url: string, token: string): Promise<any> {
  let res: Response;
  try { res = await fetchWithPolicy(() => fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(15000) })); }
  catch { throw new ProviderError('unavailable', 'o serviço não respondeu'); }
  if (!res.ok) throw new ProviderError(res.status === 401 || res.status === 403 ? 'forbidden' : 'unavailable', `o serviço respondeu ${res.status}`);
  return res.json();
}

export const SSO: Record<SsoKind, SsoProvider> = {
  microsoft: {
    kind: 'microsoft', label: 'a Microsoft', place: 'na Microsoft (Entra)',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // o que as ações de conexoes/acoes/microsoft.ts usam; valem para conta pessoal e de trabalho. Nenhum exige consentimento
    // de administrador pela tabela da Microsoft, mas a política da empresa pode exigir. Lidos aqui, na hora, por causa da ordem de carga
    get scopes() { return ['openid', 'profile', 'offline_access', ...ESCOPOS_MICROSOFT.base].join(' '); },
    // só conta de trabalho/escola (a Microsoft não tem Teams para conta pessoal)
    get workScopes() { return ESCOPOS_MICROSOFT.trabalho.join(' '); },
    extra: { response_mode: 'query', prompt: 'select_account' }, scopeOnToken: true,
    clientId: (c) => c.msClientId, clientSecret: () => null,
    needs: 'ERGON_MS_CLIENT_ID', doc: 'docs/MICROSOFT.md',
    account: async (t) => {
      const me = await getJson('https://graph.microsoft.com/v1.0/me?$select=displayName,userPrincipalName,mail', t);
      return String(me.mail ?? me.userPrincipalName ?? me.displayName ?? 'conta Microsoft');
    },
  },
  google: {
    kind: 'google', label: 'o Google', place: 'no Google Cloud',
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    // o que as ações de conexoes/acoes/google.ts usam: tarefas e agenda (sensíveis), Gmail e Drive (restritos: com o app em teste
    // valem só para os usuários de teste e o acesso vence em 7 dias; para outras pessoas o Google exige auditoria de segurança)
    get scopes() { return ['openid', 'email', 'profile', ...ESCOPOS_GOOGLE].join(' '); },
    // offline + consent: o Google só devolve refresh token assim (sem ele, o acesso cai em 1 hora)
    extra: { access_type: 'offline', prompt: 'consent select_account', include_granted_scopes: 'true' }, scopeOnToken: false,
    clientId: (c) => c.googleClientId, clientSecret: (c) => c.googleClientSecret,
    needs: 'ERGON_GOOGLE_CLIENT_ID e ERGON_GOOGLE_CLIENT_SECRET', doc: 'docs/GOOGLE.md',
    account: async (t) => {
      const me = await getJson('https://openidconnect.googleapis.com/v1/userinfo', t);
      return String(me.email ?? me.name ?? 'conta Google');
    },
  },
};
export const SSO_KINDS = Object.keys(SSO) as SsoKind[];
export const isSso = (k: string): k is SsoKind => (SSO_KINDS as string[]).includes(k);

import { ESCOPOS_GOOGLE } from './conexoes/acoes/google.ts';
import { ESCOPOS_MICROSOFT } from './conexoes/acoes/microsoft.ts';

interface Tokens { /** conta pessoal da Microsoft (sem Teams) */ pessoal?: boolean; access_token: string; refresh_token: string; expires_at: number; account: string; /** permissões pedidas (a renovação pede as mesmas) */ scopes?: string; /** as que o serviço disse ter dado (a pessoa pode ter dado só parte) */ granted?: string }
/** "Locatário" das contas pessoais da Microsoft (Outlook, Hotmail, Live): o resto é conta de trabalho ou escola. */
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
/** Dados do id_token (já validado pelo canal TLS com o provedor; só para decidir a segunda etapa). */
function idClaims(t: string | undefined): Record<string, unknown> {
  try { return t ? JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown> : {}; } catch { return {}; }
}
const STATE_TTL = 10 * 60_000;

export class SsoAuth {
  private readonly cfg: Config;
  private readonly secrets: SecretStore;
  private pending = new Map<string, { kind: SsoKind; workspaceId: string; userId: string; verifier: string; at: number; stage: 'base' | 'work'; scopes: string }>();
  private readonly refreshing = new Map<string, Promise<string>>();
  /** login com outra conta neste workspace: quem usava a antiga em outros workspaces fica com ela */
  private readonly aoTrocarConta: (workspaceId: string, kind: SsoKind, antes: string, conta: string) => void;
  constructor(cfg: Config, secrets: SecretStore, aoTrocarConta: (workspaceId: string, kind: SsoKind, antes: string, conta: string) => void = () => undefined) { this.aoTrocarConta = aoTrocarConta; this.cfg = cfg; this.secrets = secrets; }

  /** O botão só funciona com o app registrado no provedor (identificador e, no Google, o segredo). */
  configured(kind: SsoKind): boolean {
    const p = SSO[kind];
    return !!p.clientId(this.cfg) && (kind !== 'google' || !!p.clientSecret(this.cfg));
  }

  redirectUri(kind: SsoKind): string {
    const base = (this.cfg.oauthRedirectBase ?? `http://localhost:${this.cfg.port}`).replace(/\/+$/, '');
    return `${base}/api/integrations/${kind}/callback`;
  }

  /** Etapa de um login em andamento (a segunda etapa recusada não desfaz a primeira). */
  stageOf(state: string): 'base' | 'work' | null { return this.pending.get(state)?.stage ?? null; }

  start(kind: SsoKind, workspaceId: string, userId: string, opts: { stage?: 'base' | 'work'; loginHint?: string } = {}): string {
    const p = SSO[kind];
    if (!this.configured(kind)) throw new HttpError(409, 'sso_not_configured', `Falta registrar o aplicativo Ergon ${p.place} (${p.needs}). Veja ${p.doc}.`);
    for (const [k, v] of this.pending) if (Date.now() - v.at > STATE_TTL) this.pending.delete(k);
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const stage = opts.stage ?? 'base';
    const scopes = stage === 'work' && p.workScopes ? `${p.scopes} ${p.workScopes}` : p.scopes;
    this.pending.set(state, { kind, workspaceId, userId, verifier, at: Date.now(), stage, scopes });
    // segunda etapa: a mesma conta (sem escolher de novo), só o consentimento do que falta
    const extra = stage === 'work' ? { response_mode: 'query', ...(opts.loginHint ? { login_hint: opts.loginHint } : {}) } : p.extra;
    const q = new URLSearchParams({
      client_id: p.clientId(this.cfg)!, response_type: 'code', redirect_uri: this.redirectUri(kind), scope: scopes,
      state, code_challenge: challenge, code_challenge_method: 'S256', ...extra,
    });
    return `${p.authorizeUrl}?${q}`;
  }

  /** Volta do login: o `state` (aleatório, uso único) é a prova de quem começou o fluxo — e de qual provedor. */
  async finish(kind: SsoKind, state: string, code: string): Promise<{ workspaceId: string; userId: string; account: string; next?: string }> {
    const s = this.pending.get(state);
    this.pending.delete(state);
    if (!s || s.kind !== kind || Date.now() - s.at > STATE_TTL) throw new HttpError(400, 'sso_state', 'login expirado ou inválido; comece de novo em Conexões');
    const tok = await this.token(kind, { grant_type: 'authorization_code', code, redirect_uri: this.redirectUri(kind), code_verifier: s.verifier }, s.scopes);
    const account = await SSO[kind].account(tok.access_token);
    const { id_token: idToken, ...keep } = tok;
    // autorizar de novo sem vir renovação nova não pode derrubar a conexão: fica a anterior
    // (só a credencial deste workspace: a de outro, emprestada, é de outra conta e não se mistura)
    const antes = this.secrets.readOwn<Tokens>(s.workspaceId, kind);
    if (antes && antes.account !== account) this.aoTrocarConta(s.workspaceId, kind, antes.account, account);
    const tidLogin = idClaims(idToken).tid;
    // uma renovação da credencial anterior ainda andando não serve mais a ninguém (ela é descartada ao terminar)
    this.refreshing.delete(`${s.workspaceId}:${kind}`);
    this.secrets.writeOwn(s.workspaceId, kind, { ...keep, refresh_token: keep.refresh_token || (antes?.account === account ? antes?.refresh_token : '') || '', account, scopes: s.scopes,
      ...(kind === 'microsoft' && typeof tidLogin === 'string' ? { pessoal: tidLogin === MSA_TENANT } : {}) } satisfies Tokens);
    // conta de trabalho ou escola: já conectada; segue para pedir o que só existe nela (Teams, Planner compartilhado)
    const claims = idClaims(idToken);
    const tid = typeof claims.tid === 'string' ? claims.tid : null;
    if (s.stage === 'base' && SSO[kind].workScopes && tid && tid !== MSA_TENANT) {
      const hint = typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined;
      return { workspaceId: s.workspaceId, userId: s.userId, account, next: this.start(kind, s.workspaceId, s.userId, { stage: 'work', loginHint: hint }) };
    }
    return { workspaceId: s.workspaceId, userId: s.userId, account };
  }

  private async token(kind: SsoKind, params: Record<string, string>, scopes?: string): Promise<Omit<Tokens, 'account' | 'scopes'> & { id_token?: string }> {
    const p = SSO[kind];
    const body: Record<string, string> = { client_id: p.clientId(this.cfg) ?? '', ...params };
    const secret = p.clientSecret(this.cfg);
    if (secret) body.client_secret = secret;
    if (p.scopeOnToken) body.scope = scopes ?? p.scopes;
    let res: Response;
    // renovar pode repetir (o refresh token continua valendo); trocar o código de login, não (ele só vale uma vez)
    const httpKind = params.grant_type === 'refresh_token' ? 'read' : 'write';
    try {
      res = await fetchWithPolicy(() => fetch(p.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(15000) }), { kind: httpKind });
    } catch { throw new ProviderError('unavailable', `${p.label} não respondeu; a conexão continua, tente daqui a pouco`); }
    const j = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok && typeof j.access_token === 'string') return this.parse(j, params);
    // fora do ar ou limitando: passageiro — a conta continua conectada (não é para conectar de novo)
    if (res.status === 429 || res.status >= 500) throw new ProviderError('unavailable', `${p.label} está indisponível agora (${res.status}); a conexão continua, ${retryHint(res)}`);
    const code = String(j.error ?? res.status);
    if (/^(invalid_grant|interaction_required|consent_required|login_required)$/.test(code)) throw new ProviderError('forbidden', `${p.label} não aceita mais este acesso (${code}): conecte de novo em Conexões`, { reauth: true });
    throw new ProviderError('forbidden', `${p.label} recusou o acesso (${code})`, { reauth: true });
  }

  private parse(j: Record<string, unknown>, params: Record<string, string>): Omit<Tokens, 'account' | 'scopes'> & { id_token?: string } {
    // na renovação o Google não manda outro refresh token: fica o anterior
    return { access_token: String(j.access_token), refresh_token: String(j.refresh_token ?? params.refresh_token ?? ''), expires_at: Date.now() + Number(j.expires_in ?? 3600) * 1000,
      ...(typeof j.scope === 'string' ? { granted: j.scope } : {}), ...(typeof j.id_token === 'string' ? { id_token: j.id_token } : {}) };
  }

  /**
   * Acesso válido para chamar o provedor; renova sozinho com o refresh token quando está para vencer. `force`: o
   * serviço disse 401 com um acesso que ainda não venceu (senha trocada, sessão revogada) — renova agora.
   */
  /** De quem é o login em andamento (para registrar o motivo quando ele não termina). */
  workspaceOf(state: string): string | null { return this.pending.get(state)?.workspaceId ?? null; }

  async accessToken(workspaceId: string, kind: SsoKind, opts: { force?: boolean } = {}): Promise<string> {
    const t = this.secrets.read<Tokens>(workspaceId, kind);
    if (!t) throw new ProviderError('forbidden', `conta ${kind === 'google' ? 'Google' : 'Microsoft'} não conectada`);
    if (!opts.force && t.expires_at - Date.now() > 120_000) return t.access_token;
    if (!t.refresh_token) throw new ProviderError('forbidden', 'o acesso venceu e não há renovação: conecte de novo em Conexões', { reauth: true });
    // uma renovação por conta de cada vez: leituras em paralelo esperam a mesma (sem gastar o refresh token duas vezes)
    // workspaces que usam a mesma conta esperam a mesma renovação
    const key = `${this.secrets.origem(workspaceId, kind)}:${kind}`;
    const running = this.refreshing.get(key);
    if (running) return running;
    const p: Promise<string> = (async () => {
      const { id_token: _i, ...n } = await this.token(kind, { grant_type: 'refresh_token', refresh_token: t.refresh_token }, t.scopes);
      // desconectou ou entrou com outra conta enquanto a renovação andava: gravar agora desfaria isso (e a conta antiga
      // voltaria com o nome da nova)
      const atual = this.secrets.read<Tokens>(workspaceId, kind);
      if (!atual || atual.refresh_token !== t.refresh_token) throw new ProviderError('unavailable', 'a conta mudou durante a renovação do acesso; tente de novo');
      this.secrets.write(workspaceId, kind, { ...n, granted: n.granted ?? t.granted, account: t.account, ...(t.scopes ? { scopes: t.scopes } : {}), ...(t.pessoal !== undefined ? { pessoal: t.pessoal } : {}) });
      return n.access_token;
    })().finally(() => { if (this.refreshing.get(key) === p) this.refreshing.delete(key); });
    this.refreshing.set(key, p);
    return p;
  }
}
