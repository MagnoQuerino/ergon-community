/**
 * Política de falha das chamadas a serviços externos.
 *
 *   transitória  sem resposta, 429, 500, 502, 503, 504 → nova tentativa, com espera crescente e aleatória
 *                (≈0,5 s, ≈1,5 s) e respeitando o Retry-After; no máximo `attempts` vezes, dentro de `budgetMs`
 *   definitiva   401, 403, 404 e os outros 4xx → não repete (repetir não muda a resposta)
 *
 * Leitura (GET, ou consulta enviada por POST — GraphQL, Notion): repetir é seguro. **Escrita**: só repete quando a
 * requisição com certeza não saiu daqui (conexão recusada, nome não resolvido, conexão não aberta); tempo esgotado,
 * conexão caída no meio ou 5xx numa escrita = resultado desconhecido, e repetir poderia fazer duas vezes. Hoje o
 * Ergon só lê dos serviços externos; qualquer escrita nova precisa declarar `kind: 'write'`.
 */
export type HttpKind = 'read' | 'write';
export interface RetryPolicy {
  kind?: HttpKind;
  /** tentativas no total (padrão 3) */
  attempts?: number;
  /** tempo total que vale a pena gastar tentando (padrão 30 s); espera que passe disso não é feita */
  budgetMs?: number;
  /** espera máxima por um Retry-After (padrão 20 s); pedido para esperar mais = desiste já, dizendo quando */
  maxWaitMs?: number;
}

const TRANSIENT = new Set([429, 500, 502, 503, 504]);
/** códigos do Node/undici em que a requisição com certeza não chegou ao serviço */
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH']);

let sleeper = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
let jitter = () => 0.5 + Math.random();
/** Testes: espera e sorteio controlados (nada de esperar de verdade). */
export function setHttpClock(o: { sleep?: (ms: number) => Promise<void>; jitter?: () => number } | null): void {
  sleeper = o?.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  jitter = o?.jitter ?? (() => 0.5 + Math.random());
}

/** Retry-After em milissegundos (segundos ou data HTTP); null se ausente ou inválido. */
export function retryAfterMs(res: Response, now = Date.now()): number | null {
  const v = res.headers.get('retry-after');
  if (!v) return null;
  if (/^\d+$/.test(v.trim())) return Number(v.trim()) * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - now) : null;
}

const errCode = (e: unknown): string | null => {
  const c = (e as { cause?: { code?: string } })?.cause?.code ?? (e as { code?: string })?.code;
  return typeof c === 'string' ? c : null;
};
/** a requisição com certeza não saiu (repetir é seguro mesmo numa escrita) */
export const notSent = (e: unknown): boolean => { const c = errCode(e); return !!c && NOT_SENT.has(c); };

/** Falha de rede depois das tentativas. `unknownOutcome`: escrita que pode ter sido feita do outro lado. */
export class NetworkFailure extends Error {
  readonly unknownOutcome: boolean; readonly attempts: number;
  constructor(unknownOutcome: boolean, attempts: number, cause: unknown) {
    super(unknownOutcome ? 'o serviço não confirmou (pode ter feito ou não)' : 'o serviço não respondeu');
    this.unknownOutcome = unknownOutcome; this.attempts = attempts; this.cause = cause;
  }
}

/**
 * `fetch` com a política acima. Devolve a última resposta (inclusive 429/5xx depois das tentativas: quem chama
 * traduz para o usuário, e `retryAfterMs` diz quando tentar de novo). Lança `NetworkFailure` sem resposta.
 * `make` cria a requisição a cada tentativa (o tempo-limite de cada uma começa do zero).
 */
export async function fetchWithPolicy(make: () => Promise<Response>, p: RetryPolicy = {}): Promise<Response> {
  const kind = p.kind ?? 'read'; const attempts = Math.max(1, p.attempts ?? 3);
  const budget = p.budgetMs ?? 30_000; const maxWait = p.maxWaitMs ?? 20_000;
  const start = Date.now();
  for (let i = 1; ; i++) {
    const backoff = (500 * 3 ** (i - 1)) * jitter();
    let res: Response;
    try { res = await make(); } catch (e) {
      const safe = kind === 'read' || notSent(e);
      if (!safe) throw new NetworkFailure(true, i, e);
      if (i >= attempts || Date.now() - start + backoff > budget) throw new NetworkFailure(false, i, e);
      await sleeper(backoff);
      continue;
    }
    if (!TRANSIENT.has(res.status) || i >= attempts) return res;
    // escrita com 5xx: o serviço pode ter feito antes de falhar; 429 e 503 com Retry-After = recusou sem fazer
    if (kind === 'write' && !(res.status === 429 || (res.status === 503 && res.headers.has('retry-after')))) return res;
    const asked = retryAfterMs(res);
    const wait = asked ?? backoff;
    if (wait > maxWait || Date.now() - start + wait > budget) return res;
    await res.body?.cancel().catch(() => undefined);
    await sleeper(wait);
  }
}

/** "tente de novo às 14:05" a partir do Retry-After (ou um aviso genérico). */
export function retryHint(res: Response, tz = 'America/Sao_Paulo'): string {
  const ms = retryAfterMs(res);
  if (ms === null) return 'tente daqui a pouco';
  if (ms < 90_000) return `tente de novo em ${Math.max(1, Math.round(ms / 1000))} s`;
  const at = new Date(Date.now() + ms);
  return `tente de novo depois das ${at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', timeZone: tz })}`;
}
