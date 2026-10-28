// Cliente HTTP: mesma origem, cookie HttpOnly e token CSRF em cabeçalho. Nenhum segredo no navegador.
let csrf = '';
export function setCsrf(t: string) { csrf = t; }

export class ApiError extends Error {
  status: number; code: string;
  constructor(status: number, code: string, message: string) { super(message); this.status = status; this.code = code; }
}

/**
 * Guarda da sessão: tela trancada (423 locked) e confirmação de identidade (401 reauth) pausam o pedido até a
 * pessoa destrancar/confirmar, e então ele é refeito uma vez. Os demais (sem sessão, proteger, 2º fator) só avisam.
 */
type Guard = (code: string) => Promise<boolean>;
let guard: Guard | null = null;
export function setGuard(g: Guard | null) { guard = g; }

async function call<T>(method: string, url: string, body?: unknown, headers: Record<string, string> = {}, retried = false): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: { ...headers } };
  if (method !== 'GET') (init.headers as Record<string, string>)['X-CSRF-Token'] = csrf;
  if (body instanceof Blob) init.body = body;
  else if (body !== undefined) { init.body = JSON.stringify(body); (init.headers as Record<string, string>)['Content-Type'] = 'application/json'; }
  const res = await fetch(url, init);
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  if (!res.ok) {
    const j = (json ?? {}) as { error?: string; message?: string };
    const code = j.error ?? 'erro';
    if (guard && !retried && ((res.status === 423 && code === 'locked') || (res.status === 401 && code === 'reauth'))) {
      if (await guard(code)) return call<T>(method, url, body, headers, true);
    } else if (guard && (res.status === 428 || (res.status === 401 && code === 'unauthenticated') || (res.status === 423 && (code === 'sealed' || code === 'person_sealed')))) void guard(code);
    throw new ApiError(res.status, code, j.message ?? `HTTP ${res.status}`);
  }
  return json as T;
}

export const api = {
  get: <T>(url: string) => call<T>('GET', url),
  post: <T>(url: string, body?: unknown) => call<T>('POST', url, body ?? {}),
  patch: <T>(url: string, body: unknown) => call<T>('PATCH', url, body),
  put: <T>(url: string, body: unknown) => call<T>('PUT', url, body),
  del: <T>(url: string, body?: unknown) => call<T>('DELETE', url, body),
  upload: <T>(file: File, taskId?: string) => call<T>('POST', '/api/artifacts', file, {
    'Content-Type': 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name), 'X-File-Type': file.type || 'application/octet-stream',
    ...(taskId ? { 'X-Task-Id': taskId } : {}),
  }),
};

/** POST que devolve arquivo (ex.: o .ergon montado pelo editor). */
export async function postForBlob(url: string, body: unknown): Promise<Blob> {
  const res = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
  if (!res.ok) { const j = await res.json().catch(() => ({})) as { error?: string; message?: string }; throw new ApiError(res.status, j.error ?? 'erro', j.message ?? `HTTP ${res.status}`); }
  return res.blob();
}

export function requestId(): string {
  return crypto.randomUUID();
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
