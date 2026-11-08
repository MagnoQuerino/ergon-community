/**
 * Login com a conta (SSO) parametrizado: cada provedor é uma ficha (endereços, permissões, identificador do app,
 * como ler o nome da conta) e o fluxo é um só — OAuth 2.0 com PKCE, `state` aleatório de uso único (10 min) e
 * renovação automática do acesso. Microsoft (Entra) e Google hoje; outro provedor = outra ficha.
 * Tokens só em /data/secrets (SecretStore), nunca no banco, no navegador ou no log.
 *
 * Microsoft em etapas (ESCOPOS_MICROSOFT, conexoes/acoes/microsoft.ts; docs/MICROSOFT.md): primeiro o que a política padrão da
 * Microsoft deixa o próprio usuário autorizar, depois a leitura (que na empresa costuma pedir o administrador) e, opcional, os
 * canais do Teams (sempre o administrador). Conferido em 08/11/2026:
 *   consentimento incremental: https://learn.microsoft.com/en-us/entra/identity-platform/permissions-consent-overview
 *   a renovação pede o "equivalent to or a subset of" do que foi dado: https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow
 *   pedido ao administrador (escopos explícitos, redirect igual a um registrado, state):
 *     https://learn.microsoft.com/en-us/entra/identity-platform/v2-admin-consent
 *   a porta não conta no redirect de localhost: https://learn.microsoft.com/en-us/entra/identity-platform/reply-url ("Localhost exceptions")
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
  /** o que o primeiro login pede (na Microsoft, a etapa A; as outras, em escoposDaEtapa) */
  scopes: string;
  /** parâmetros extras do endereço de login (ex.: pedir refresh token no Google) */
  extra: Record<string, string>;
  /** a Microsoft quer `scope` também na troca do código; o Google não */
  scopeOnToken: boolean;
  clientId: (cfg: Config) => string | null;
  /** app "web" do Google exige segredo na troca; app público da Microsoft não tem */
  clientSecret: (cfg: Config) => string | null;
  /** variáveis que faltam para o botão funcionar (para quem instala; a tela não mostra) */
  needs: string;
  /** onde quem instala vê o passo a passo: o texto que a tela mostra ("veja o guia de instalação") */
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

/** Escopos do OpenID e da renovação: entram em toda etapa e em toda renovação da Microsoft. */
const OIDC = ['openid', 'profile', 'offline_access'];

export const SSO: Record<SsoKind, SsoProvider> = {
  microsoft: {
    kind: 'microsoft', label: 'a Microsoft', place: 'na Microsoft (Entra)',
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    // a etapa A: só o que a política padrão gerenciada pela Microsoft deixa o próprio usuário autorizar (nenhuma está na lista de
    // exceções de manage-app-consent-policies); a leitura vem depois (escoposDaEtapa). Lidos aqui, na hora, por causa da ordem de carga
    get scopes() { return [...OIDC, ...ESCOPOS_MICROSOFT.base].join(' '); },
    extra: { response_mode: 'query', prompt: 'select_account' }, scopeOnToken: true,
    clientId: (c) => c.msClientId, clientSecret: () => null,
    needs: 'ERGON_MS_CLIENT_ID', doc: 'o guia de instalação',
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
    needs: 'ERGON_GOOGLE_CLIENT_ID e ERGON_GOOGLE_CLIENT_SECRET', doc: 'o guia de instalação',
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

// ------------------------------------------------------------------------------------------------- etapas da Microsoft
/**
 * A: base (qualquer conta) e trabalho (Teams, conta de trabalho ou escola); B: leitura; C: canais (opcional, sempre o
 * administrador). A ordem do login encadeado é base → trabalho → leitura; os canais só com o botão.
 */
export type Etapa = 'base' | 'trabalho' | 'leitura' | 'canais';
export const ETAPAS: Etapa[] = ['base', 'trabalho', 'leitura', 'canais'];
export const isEtapa = (x: unknown): x is Etapa => typeof x === 'string' && (ETAPAS as string[]).includes(x);
/** Tempo de um login em andamento: o mesmo do `state`, e o do "conectando…" da tela. */
export const STATE_TTL = 10 * 60_000;

/** As outras formas com que a Microsoft escreve uma permissão do Graph (resposta do token, link do administrador). */
const PREFIXO_GRAPH = /^(?:https:\/\/graph\.microsoft\.com\/|00000003-0000-0000-c000-000000000000\/)/i;
/** "https://graph.microsoft.com/Mail.Read" e "00000003-…/Mail.Read" contam como "Mail.Read". */
export const normalizarEscopo = (e: string): string => e.trim().replace(PREFIXO_GRAPH, '');
/** A lista de uma resposta (separada por espaço; o exemplo oficial chega a vir percent-codificado), no nome curto. */
export function listaDeEscopos(s: string | null | undefined): string[] {
  return String(s ?? '').split(/\s+/).filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } })
    .flatMap((x) => x.split(/\s+/)).map(normalizarEscopo).filter(Boolean);
}
/** União sem repetir (sem diferença de maiúsculas), na ordem em que apareceram. */
export function uniaoDeEscopos(...listas: string[][]): string[] {
  const vistos = new Set<string>(); const out: string[] = [];
  for (const e of listas.flat()) { const k = e.toLowerCase(); if (!vistos.has(k)) { vistos.add(k); out.push(e); } }
  return out;
}
/** O que cada etapa acrescenta (conta pessoal não tem Teams: as etapas de trabalho e de canais ficam vazias para ela). */
export function proprioDaEtapa(etapa: Etapa, trabalho: boolean): string[] {
  const E = ESCOPOS_MICROSOFT;
  if (etapa === 'base') return [...E.base];
  if (etapa === 'trabalho') return trabalho ? [...E.trabalho] : [];
  if (etapa === 'leitura') return [...E.leitura, ...(trabalho ? E.leituraTrabalho : [])];
  return trabalho ? [...E.canais] : [];
}
/** O que o login de uma etapa pede: ela e as anteriores (o token que volta cobre tudo o que foi dado até ali). */
export function escoposDaEtapa(etapa: Etapa, trabalho: boolean): string[] {
  return uniaoDeEscopos(...ETAPAS.slice(0, ETAPAS.indexOf(etapa) + 1).map((e) => proprioDaEtapa(e, trabalho)));
}

/**
 * Conta pessoal da Microsoft (Outlook, Hotmail, Live): a marca gravada no login (pelo locatário do id_token) vale; credencial
 * antiga sem a marca é pessoal quando o domínio é de consumidor. Para ela, Teams e canais nem aparecem (o Graph não tem Teams
 * para conta pessoal): nunca há "autorizar de novo" impossível.
 */
const DOMINIO_DE_CONSUMIDOR = /@(?:outlook|hotmail|live|msn|passport)\.(?:com|com\.br|com\.ar|com\.mx|com\.au|com\.pt|co\.uk|pt|es|fr|de|it|nl|be|ca|jp|ie|at|ch)$/i;
export function contaPessoalMicrosoft(t: { pessoal?: boolean; account?: string } | null | undefined): boolean {
  if (!t) return false;
  if (typeof t.pessoal === 'boolean') return t.pessoal;
  return DOMINIO_DE_CONSUMIDOR.test(String(t.account ?? '').trim());
}

export interface Tokens {
  /** conta pessoal da Microsoft (sem Teams) */ pessoal?: boolean;
  /** locatário da conta (do id_token): o link do pedido ao administrador vai para ele */ tid?: string;
  access_token: string; refresh_token: string; expires_at: number; account: string;
  /** permissões pedidas no último login */ scopes?: string;
  /** as que a conta deu (a pessoa pode ter dado só parte); na Microsoft, a soma das etapas: é o que a renovação pede */ granted?: string;
}
/** "Locatário" das contas pessoais da Microsoft (Outlook, Hotmail, Live): o resto é conta de trabalho ou escola. */
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Dados do id_token (já validado pelo canal TLS com o provedor; só para decidir as etapas e o locatário). */
function idClaims(t: string | undefined): Record<string, unknown> {
  try { return t ? JSON.parse(Buffer.from(t.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown> : {}; } catch { return {}; }
}

export interface FimDoLogin { workspaceId: string; userId: string; account: string; etapa: Etapa; next?: string; proxima?: Etapa }

export class SsoAuth {
  private readonly cfg: Config;
  private readonly secrets: SecretStore;
  private pending = new Map<string, { kind: SsoKind; workspaceId: string; userId: string; verifier: string; at: number; etapa: Etapa; scopes: string }>();
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

  /** Etapa de um login em andamento (uma etapa recusada não desfaz as anteriores). */
  stageOf(state: string): Etapa | null { return this.pending.get(state)?.etapa ?? null; }

  /**
   * Endereço do login. Microsoft: `etapa` diz o que pedir (a base escolhe a conta; as outras seguem com a mesma, sem escolher de
   * novo, e mostram só o consentimento do que falta). `trabalho`: conta de trabalho ou escola (sem dizer, vale a credencial guardada).
   */
  start(kind: SsoKind, workspaceId: string, userId: string, opts: { etapa?: Etapa; loginHint?: string; trabalho?: boolean } = {}): string {
    const p = SSO[kind];
    if (!this.configured(kind)) throw new HttpError(409, 'sso_not_configured', `Falta registrar o aplicativo Ergon ${p.place}: é um passo único de quem instala o Ergon (veja ${p.doc}).`);
    for (const [k, v] of this.pending) if (Date.now() - v.at > STATE_TTL) this.pending.delete(k);
    const state = crypto.randomBytes(24).toString('base64url');
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const etapa: Etapa = kind === 'microsoft' ? opts.etapa ?? 'base' : 'base';
    let scopes = p.scopes;
    let extra = p.extra;
    if (etapa !== 'base') {
      const t = this.secrets.read<Tokens>(workspaceId, kind);
      const trabalho = opts.trabalho ?? !contaPessoalMicrosoft(t);
      scopes = [...OIDC, ...escoposDaEtapa(etapa, trabalho)].join(' ');
      const hint = opts.loginHint ?? (t?.account?.includes('@') ? t.account : undefined);
      extra = { response_mode: 'query', ...(hint ? { login_hint: hint } : {}) };
    }
    this.pending.set(state, { kind, workspaceId, userId, verifier, at: Date.now(), etapa, scopes });
    const q = new URLSearchParams({
      client_id: p.clientId(this.cfg)!, response_type: 'code', redirect_uri: this.redirectUri(kind), scope: scopes,
      state, code_challenge: challenge, code_challenge_method: 'S256', ...extra,
    });
    return `${p.authorizeUrl}?${q}`;
  }

  /** A próxima etapa do login encadeado: pula a que a conta já deu; leitura e canais terminam o encadeamento. */
  private proximaEtapa(etapa: Etapa, trabalho: boolean, dadas: string[]): Etapa | null {
    if (etapa === 'leitura' || etapa === 'canais') return null;
    const tem = new Set(dadas.map((e) => e.toLowerCase()));
    for (const e of ETAPAS.slice(ETAPAS.indexOf(etapa) + 1, ETAPAS.indexOf('leitura') + 1)) {
      const falta = proprioDaEtapa(e, trabalho).filter((x) => !tem.has(x.toLowerCase()));
      if (falta.length) return e;
    }
    return null;
  }

  /** Volta do login: o `state` (aleatório, uso único) é a prova de quem começou o fluxo — e de qual provedor. */
  async finish(kind: SsoKind, state: string, code: string): Promise<FimDoLogin> {
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
    // a mesma conta (até a emprestada de outro workspace seu): o que ela já deu soma ao desta etapa
    const conhecida = antes ?? this.secrets.read<Tokens>(s.workspaceId, kind);
    const mesma = conhecida?.account === account ? conhecida : null;
    const claims = idClaims(idToken);
    const tid = typeof claims.tid === 'string' ? claims.tid : mesma?.tid;
    // uma renovação da credencial anterior ainda andando não serve mais a ninguém (ela é descartada ao terminar)
    this.refreshing.delete(`${s.workspaceId}:${kind}`);
    let granted = keep.granted;
    if (kind === 'microsoft') {
      // sem `scope` na resposta, o token vale para o que foi pedido (v2-oauth2-auth-code-flow). A etapa base recomeça do que a conta
      // tem hoje (o que foi tirado dela não volta a ser pedido); as outras somam ao que já estava dado
      const agora = keep.granted !== undefined ? listaDeEscopos(keep.granted) : listaDeEscopos(s.scopes);
      granted = uniaoDeEscopos(s.etapa !== 'base' && mesma ? listaDeEscopos(mesma.granted ?? mesma.scopes) : [], agora).join(' ');
    }
    const pessoal = typeof tid === 'string' ? tid === MSA_TENANT : mesma?.pessoal;
    this.secrets.writeOwn(s.workspaceId, kind, {
      ...keep, ...(granted !== undefined ? { granted } : {}), refresh_token: keep.refresh_token || (antes?.account === account ? antes?.refresh_token : '') || '', account, scopes: s.scopes,
      ...(kind === 'microsoft' && pessoal !== undefined ? { pessoal } : {}), ...(kind === 'microsoft' && typeof tid === 'string' ? { tid } : {}),
    } satisfies Tokens);
    // conta de trabalho ou escola: já conectada; segue para o que falta (Teams; depois a leitura). Sem o locatário, não dá para saber
    if (kind === 'microsoft' && typeof claims.tid === 'string') {
      const trabalho = claims.tid !== MSA_TENANT;
      const proxima = this.proximaEtapa(s.etapa, trabalho, listaDeEscopos(granted));
      if (proxima) {
        const hint = typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined;
        return { workspaceId: s.workspaceId, userId: s.userId, account, etapa: s.etapa, proxima, next: this.start(kind, s.workspaceId, s.userId, { etapa: proxima, loginHint: hint, trabalho }) };
      }
    }
    return { workspaceId: s.workspaceId, userId: s.userId, account, etapa: s.etapa };
  }

  /** `scopes`: o que pedir na troca; null = sem `scope` (a renovação vale para o que foi pedido no login). */
  private async token(kind: SsoKind, params: Record<string, string>, scopes?: string | null): Promise<Omit<Tokens, 'account' | 'scopes'> & { id_token?: string }> {
    const p = SSO[kind];
    const body: Record<string, string> = { client_id: p.clientId(this.cfg) ?? '', ...params };
    const secret = p.clientSecret(this.cfg);
    if (secret) body.client_secret = secret;
    if (p.scopeOnToken && scopes !== null) body.scope = scopes ?? p.scopes;
    let res: Response;
    // renovar pode repetir (o refresh token continua valendo); trocar o código de login, não (ele só vale uma vez)
    const httpKind = params.grant_type === 'refresh_token' ? 'read' : 'write';
    try {
      res = await fetchWithPolicy(() => fetch(p.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body), signal: AbortSignal.timeout(15000) }), { kind: httpKind });
    } catch { throw new ProviderError('unavailable', `${p.label} não respondeu; a conexão continua, tente daqui a pouco`); }
    const j = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (res.ok && typeof j.access_token === 'string') return this.parse(j, params);
    // fora do ar ou limitando: passageiro — a conta continua conectada (não é para conectar de novo)
    // o texto vai para o cartão da conexão: o código do provedor fica só como referência para o suporte
    if (res.status === 429 || res.status >= 500) throw new ProviderError('unavailable', `${p.label} está indisponível agora; a conexão continua, ${retryHint(res)}`);
    const code = typeof j.error === 'string' && /^[\w.-]{1,60}$/.test(j.error) ? j.error : '';
    const ref = code ? ` (código ${code}, para o suporte)` : '';
    if (/^(invalid_grant|interaction_required|consent_required|login_required)$/.test(code)) throw new ProviderError('forbidden', `${p.label} não aceita mais este acesso: conecte de novo em Conexões${ref}`, { reauth: true });
    throw new ProviderError('forbidden', `${p.label} recusou o acesso${ref}`, { reauth: true });
  }

  private parse(j: Record<string, unknown>, params: Record<string, string>): Omit<Tokens, 'account' | 'scopes'> & { id_token?: string } {
    // na renovação o Google não manda outro refresh token: fica o anterior
    return { access_token: String(j.access_token), refresh_token: String(j.refresh_token ?? params.refresh_token ?? ''), expires_at: Date.now() + Number(j.expires_in ?? 3600) * 1000,
      ...(typeof j.scope === 'string' ? { granted: j.scope } : {}), ...(typeof j.id_token === 'string' ? { id_token: j.id_token } : {}) };
  }

  /**
   * O que a renovação da Microsoft pede: só o que a conta já deu (a soma das etapas), nunca uma permissão nova, que a renovação
   * não aceita. Credencial antiga sem nada guardado: sem `scope`, a renovação vale para o que foi pedido no login.
   */
  private escoposDaRenovacao(kind: SsoKind, t: Tokens): string | null | undefined {
    if (kind !== 'microsoft') return t.scopes;
    const dadas = listaDeEscopos(t.granted ?? t.scopes);
    return dadas.length ? uniaoDeEscopos(OIDC, dadas).join(' ') : null;
  }

  /** De quem é o login em andamento (para registrar o motivo quando ele não termina). */
  workspaceOf(state: string): string | null { return this.pending.get(state)?.workspaceId ?? null; }

  /**
   * Acesso válido para chamar o provedor; renova sozinho com o refresh token quando está para vencer. `force`: o
   * serviço disse 401 com um acesso que ainda não venceu (senha trocada, sessão revogada) — renova agora.
   */
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
      const { id_token: idToken, ...n } = await this.token(kind, { grant_type: 'refresh_token', refresh_token: t.refresh_token }, this.escoposDaRenovacao(kind, t));
      // desconectou ou entrou com outra conta enquanto a renovação andava: gravar agora desfaria isso (e a conta antiga
      // voltaria com o nome da nova)
      const atual = this.secrets.read<Tokens>(workspaceId, kind);
      if (!atual || atual.refresh_token !== t.refresh_token) throw new ProviderError('unavailable', 'a conta mudou durante a renovação do acesso; tente de novo');
      // Microsoft: o `scope` da resposta é o que o acesso cobre agora; e o id_token traz o locatário a quem conectou antes de ele ser guardado
      const tid = kind === 'microsoft' ? (typeof idClaims(idToken).tid === 'string' ? String(idClaims(idToken).tid) : t.tid) : undefined;
      const granted = n.granted !== undefined ? (kind === 'microsoft' ? listaDeEscopos(n.granted).join(' ') : n.granted) : t.granted;
      const pessoal = t.pessoal ?? (tid ? tid === MSA_TENANT : undefined);
      this.secrets.write(workspaceId, kind, { ...n, ...(granted !== undefined ? { granted } : {}), account: t.account, ...(t.scopes ? { scopes: t.scopes } : {}),
        ...(pessoal !== undefined ? { pessoal } : {}), ...(tid ? { tid } : {}) });
      return n.access_token;
    })().finally(() => { if (this.refreshing.get(key) === p) this.refreshing.delete(key); });
    this.refreshing.set(key, p);
    return p;
  }

  /**
   * Pedido ao administrador da empresa (v2-admin-consent): o locatário da pessoa (sem ele, "organizations"), o app, os escopos
   * EXPLÍCITOS da etapa e das anteriores (nunca /.default: o administrador vê exatamente o que aprova), o redirect registrado e um
   * `state`. A pessoa copia e envia ela mesma. Quem aprova abre noutro computador, e a página final tenta voltar para este
   * computador, por isso pode dar erro lá: nada depende dessa volta.
   */
  linkAdministrador(workspaceId: string, etapa: 'leitura' | 'canais', state: string): string | null {
    if (!this.configured('microsoft')) return null;
    const t = this.secrets.read<Tokens>(workspaceId, 'microsoft');
    if (contaPessoalMicrosoft(t)) return null; // conta pessoal não tem administrador: ela mesma autoriza
    const tenant = t?.tid && GUID.test(t.tid) && t.tid !== MSA_TENANT ? t.tid : 'organizations';
    // no pedido ao administrador, só os escopos do OpenID que a página aceita (openid, profile, email): offline_access não
    // serve ali e é um ponto a menos para dar errado num locatário estrito
    const scope = ['openid', 'profile', ...escoposDaEtapa(etapa, true).map((e) => `https://graph.microsoft.com/${e}`)].join(' ');
    const q = new URLSearchParams({ client_id: SSO.microsoft.clientId(this.cfg)!, scope, redirect_uri: this.redirectUri('microsoft'), state });
    return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/v2.0/adminconsent?${q}`;
  }
}
