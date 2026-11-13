/**
 * Proteção da página (Content-Security-Policy) das telas do Ergon: a mesma na tela trancada (gate.ts) e no app aberto
 * (app.ts). As prévias de arquivo definem a própria política, mais fechada, e não passam por aqui.
 *
 * `media-src 'self' blob:` (rc.28): o "Ouvir" da conversa toca o áudio gerado a partir de um blob; sem essa linha o
 * `default-src 'self'` barrava o som. Nada mais se abre: scripts, conexões e molduras continuam só do próprio Ergon.
 */
export const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "font-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');
