/**
 * "Relatar um problema" (Ajuda): o relato sai daqui, limpo, para o receptor público do World (POST /v1/relatos),
 * só quando a pessoa clica em "Enviar relato". Não precisa de conta nem do World ligado.
 *
 *   POST /api/relatos/previa   o JSON exato que vai sair (já limpo)
 *   POST /api/relatos/enviar   monta pela MESMA função e manda; responde { id: "R-XXXXXX" }
 *   GET  /api/relatos          { disponivel }: sem endereço (ERGON_RELATOS_URL vazio), a tela desliga o envio
 *
 * Nunca entra: conversas, arquivos, memórias, nomes de agentes ou contatos, chaves, tokens, e-mails, caminhos com nome
 * de usuário. O texto passa pela varredura de segredos (as regras de scripts/scan-segredos.mjs, mais as do receptor),
 * e-mails e pastas pessoais viram [removido]. Os dados técnicos (desligados por padrão) são só as chaves fixas abaixo.
 * `instalacao` é um UUID v4 sorteado uma vez, só para relatos: não é o identificador da instalação no World.
 * Tempo máximo 10 s, sem tentar de novo sozinho.
 */
import crypto from 'node:crypto';
import os from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { HttpError } from '../lib/util.ts';
import { VERSION } from '../version.ts';
import type { AuthContext } from './auth.ts';
import { readLang } from './prefs.ts';
import { instanceSetting, setInstanceSetting } from './security.ts';

export const DEFAULT_RELATOS_URL = 'https://api.ergonworld.com/v1/relatos';
export const RELATO_TIMEOUT_MS = 10_000;

/** As regras de scripts/scan-segredos.mjs e as do receptor do World (world/src/relatos.ts, SECRET_RULES). */
export const SECRET_RULES: readonly RegExp[] = [
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END[^-]*-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bsk-(?:ant-[a-z0-9]+-|or-v1-|proj-)?[A-Za-z0-9_-]{32,}\b/g,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g,
  /\bwhsec_[A-Za-z0-9]{24,}\b/g,
  /\b[A-Za-z0-9_~.-]{3}8Q~[A-Za-z0-9_~.-]{31,34}\b/g,
  /\b(?:re|ergai|ergon)_[A-Za-z0-9_-]{24,}\b/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWT
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
// pasta pessoal: C:\Users\<nome>\… (o nome pode ter espaço), /home/<nome>/…, /Users/<nome>/… (inclusive \\wsl$\…\home\…)
const PASTA_WINDOWS = /\b[A-Za-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+(?:[^\\/\r\n"'<>|:*?]{1,64}?(?=[\\/])|[^\\/\s"'<>|:*?]+)[^\s"'<>|]*/gi;
const PASTA_PESSOAL = /[\\/](?:home|Users)[\\/]+[^\\/\s"'<>|:*?]+[^\s"'<>|]*/g;
// controle (menos \n e \t) e direção (bidi), como no receptor
const CONTROLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g;
export const REMOVIDO = '[removido]';

/** Limpa um texto do relato: segredos, e-mails e pastas pessoais viram [removido]. */
export function limparTexto(t: string): string {
  let o = t.normalize('NFC').replace(CONTROLE, '');
  for (const re of SECRET_RULES) o = o.replace(re, REMOVIDO);
  return o.replace(EMAIL, REMOVIDO).replace(PASTA_WINDOWS, REMOVIDO).replace(PASTA_PESSOAL, REMOVIDO).trim();
}

export const CATEGORIAS = ['erro', 'lento', 'aparencia', 'conexao', 'agentes', 'instalacao', 'sugestao', 'outro'] as const;
export const SISTEMAS = ['windows', 'linux', 'macos', 'outro'] as const;
/** As únicas chaves dos dados técnicos (as mesmas que o receptor aceita). */
export const CHAVES_DIAGNOSTICO = ['versaoMotor', 'motorAtivo', 'idioma', 'codigosErro', 'memoriaMb', 'arquitetura'] as const;
const LIMITES = { titulo: [5, 120], descricao: [10, 4000], passos: [0, 2000], esperado: [0, 1000] } as const;
const CODIGO = /^[a-z0-9_.]{1,60}$/;

export type Categoria = typeof CATEGORIAS[number];
export type Sistema = typeof SISTEMAS[number];
export interface PedidoRelato {
  categoria: Categoria; titulo: string; descricao: string; passos?: string; esperado?: string;
  /** "Incluir dados técnicos" (desligado por padrão) */
  dadosTecnicos?: boolean;
  /** os últimos códigos de erro que a tela viu (ex.: world_offline), só com os dados técnicos */
  codigosErro?: string[];
  /** o sistema de quem está na tela (o servidor pode rodar num Linux dentro do Windows) */
  sistema?: Sistema;
}
export interface Diagnostico { versaoMotor: string; motorAtivo: string; idioma: string; codigosErro: string[]; memoriaMb: number; arquitetura: string }
export interface Relato {
  versao: string; distribuicao: 'community' | 'proprietary'; sistema: Sistema; categoria: Categoria;
  titulo: string; descricao: string; passos?: string; esperado?: string; diagnostico?: Diagnostico; instalacao: string;
}
export interface ContextoRelato { versao: string; distribuicao: Relato['distribuicao']; instalacao: string; diagnostico: () => Omit<Diagnostico, 'codigosErro'> }

export const sistemaDe = (p: string): Sistema => (p === 'win32' ? 'windows' : p === 'linux' ? 'linux' : p === 'darwin' ? 'macos' : 'outro');

/** O relato que sai: a prévia e o envio usam esta função (o que a pessoa viu é o que vai). */
export function montarRelato(p: PedidoRelato, c: ContextoRelato): Relato {
  const campo = (k: keyof typeof LIMITES, v: string | undefined): string | undefined => {
    const t = limparTexto(v ?? '').slice(0, LIMITES[k][1]).trim();
    if (!t && !LIMITES[k][0]) return undefined;
    if (t.length < LIMITES[k][0]) throw new HttpError(400, 'relato_curto', `${k}: curto demais depois da limpeza`);
    return t;
  };
  const r: Relato = {
    versao: c.versao, distribuicao: c.distribuicao,
    sistema: p.sistema && (SISTEMAS as readonly string[]).includes(p.sistema) ? p.sistema : sistemaDe(process.platform),
    categoria: p.categoria, titulo: campo('titulo', p.titulo)!, descricao: campo('descricao', p.descricao)!,
    instalacao: c.instalacao,
  };
  const passos = campo('passos', p.passos); if (passos) r.passos = passos;
  const esperado = campo('esperado', p.esperado); if (esperado) r.esperado = esperado;
  if (p.dadosTecnicos === true) {
    const d = c.diagnostico();
    r.diagnostico = { versaoMotor: d.versaoMotor, motorAtivo: d.motorAtivo, idioma: d.idioma,
      codigosErro: [...new Set((p.codigosErro ?? []).filter((x) => typeof x === 'string' && CODIGO.test(x)))].slice(-20), memoriaMb: d.memoriaMb, arquitetura: d.arquitetura };
  }
  return r;
}

/** Endereço do receptor: ERGON_RELATOS_URL (vazio = envio indisponível), https (http só para teste local). */
export function relatosUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const raw = (env.ERGON_RELATOS_URL ?? DEFAULT_RELATOS_URL).trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
    return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? u.href : null;
  } catch { return null; }
}

/** UUID v4 desta instalação só para relatos (sorteado uma vez; sem ligação com conta nem com o World). */
export function instalacaoDoRelato(db: Db): string {
  const v = instanceSetting(db, 'relatos_instalacao');
  if (v && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)) return v;
  const n = crypto.randomUUID();
  setInstanceSetting(db, 'relatos_instalacao', n);
  return n;
}

const txt = (max: number) => ({ type: 'string', maxLength: max });
const corpo = {
  type: 'object', additionalProperties: false, required: ['categoria', 'titulo', 'descricao'],
  properties: {
    categoria: { enum: [...CATEGORIAS] }, titulo: txt(LIMITES.titulo[1]), descricao: txt(LIMITES.descricao[1]),
    passos: txt(LIMITES.passos[1]), esperado: txt(LIMITES.esperado[1]), dadosTecnicos: { type: 'boolean' },
    codigosErro: { type: 'array', maxItems: 20, items: { type: 'string', pattern: CODIGO.source } }, sistema: { enum: [...SISTEMAS] },
  },
};

interface RelatosDeps {
  db: Db; cfg: Pick<Config, 'distribution' | 'executor'>;
  auth: (req: FastifyRequest) => AuthContext;
  /** testes: outro endereço e outro tempo máximo */
  url?: string | null; timeoutMs?: number;
}

export function registerRelatosRoutes(app: FastifyInstance, d: RelatosDeps): void {
  const url = d.url !== undefined ? d.url : relatosUrl();
  const timeoutMs = d.timeoutMs ?? RELATO_TIMEOUT_MS;
  const montar = (req: FastifyRequest): Relato => {
    const a = d.auth(req);
    return montarRelato(req.body as PedidoRelato, {
      versao: VERSION, distribuicao: d.cfg.distribution, instalacao: instalacaoDoRelato(d.db),
      diagnostico: () => ({ versaoMotor: VERSION, motorAtivo: d.cfg.executor === 'hermes' ? 'ia' : 'simulado', idioma: readLang(d.db, a.userId) ?? 'pt-BR',
        memoriaMb: Math.round(os.totalmem() / 1048576), arquitetura: process.arch }),
    });
  };

  app.get('/api/relatos', async (req) => { d.auth(req); return { disponivel: !!url }; });
  app.post('/api/relatos/previa', { schema: { body: corpo } }, async (req) => ({ relato: montar(req) }));
  app.post('/api/relatos/enviar', { schema: { body: corpo } }, async (req) => {
    const relato = montar(req);
    if (!url) throw new HttpError(503, 'relato_indisponivel', 'Envio de relatos desligado nesta instalação.');
    let r: Response;
    try {
      r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(relato), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    } catch { throw new HttpError(503, 'relato_offline', 'O relato não foi enviado: sem resposta do servidor.'); }
    if (r.status === 429) throw new HttpError(429, 'relato_limite', 'Muitos relatos agora. Tente mais tarde.');
    const j = await r.json().catch(() => null) as { id?: unknown } | null;
    if (!r.ok || typeof j?.id !== 'string' || !/^R-[A-Z2-9]{6}$/.test(j.id)) throw new HttpError(502, 'relato_recusado', 'O relato não foi aceito.');
    return { id: j.id };
  });
}
