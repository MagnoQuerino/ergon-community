/**
 * Registro estruturado dos serviços (execuções, rotinas, backup) com os identificadores que ligam uma coisa à outra:
 * `runId` (execução de agente), `routineRunId` e `routineId` (rotina). Só ids, estados, tempos e erros limpos —
 * nunca conteúdo do usuário. O servidor liga no registro do Fastify (o mesmo das requisições, com o `reqId` delas);
 * nos testes fica quieto. Nada é enviado para fora: o registro é o do contêiner.
 */
export interface Log { info(o: object, m: string): void; warn(o: object, m: string): void; error(o: object, m: string): void }
const quiet: Log = { info() {}, warn() {}, error() {} };
let current: Log = quiet;
export const log: Log = { info: (o, m) => current.info(o, m), warn: (o, m) => current.warn(o, m), error: (o, m) => current.error(o, m) };
export function setLog(l: Log | null): void { current = l ?? quiet; }

/** Tira de um texto o que pode identificar alguém ou abrir algo: e-mails, endereços, tokens, números longos. */
export function scrub(s: string | null | undefined, max = 160): string {
  return String(s ?? '')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<e-mail>')
    .replace(/\bhttps?:\/\/([^/\s?#]+)[^\s]*/gi, (_m, host: string) => `<endereço ${host}>`)
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9_\-+/=.]{24,}\b/g, '<token>')
    .replace(/\b\d{8,}\b/g, '<número>')
    .replace(/\s+/g, ' ').trim().slice(0, max);
}
