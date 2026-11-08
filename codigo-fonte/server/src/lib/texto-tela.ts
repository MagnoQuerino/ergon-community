/**
 * Texto que vai para a tela da pessoa (Saúde, Atividade, cartões, erros das rotas): nada das peças por dentro do Ergon
 * nem do erro cru de rede ou do provedor. A web tem o mesmo filtro (web/src/lib/textos-tela.ts); aqui ele protege o
 * que o servidor grava e devolve. O texto técnico continua no registro do servidor (log), para quem investiga.
 */

/** Peças por dentro do Ergon e erros de rede: não dizem nada à pessoa. */
export const JARGAO_TELA = /\bmotor(?:es)?\b|\bgerente\b|ponte de controle|cont[eê]iner(?:es)?|\bpodman\b|\bdocker\b|\bimagem\b|\btoken\b|\bscopes?\b|\bGraph\b|AADSTS\d*|respondeu \d{3}|fetch failed|\bsocket\b|\btimeout\b|\baborted\b|\b\d{1,3}(?:\.\d{1,3}){3}\b/i;
/** códigos de erro do sistema (ECONNREFUSED, ETIMEDOUT…): em maiúsculas, para não pegar palavras como "ESTADO" com /i */
const ERRO_DE_REDE = /\bE[A-Z]{4,}\b/;

export const temJargao = (t: string | null | undefined): boolean => !!t && (JARGAO_TELA.test(t) || ERRO_DE_REDE.test(t));

/** O texto, se ele já for para a pessoa; com peça interna ou erro cru, o texto de reserva (ou null). */
export function paraTela(texto: string | null | undefined, reserva: string): string;
export function paraTela(texto: string | null | undefined, reserva?: null): string | null;
export function paraTela(texto: string | null | undefined, reserva: string | null = null): string | null {
  const t = (texto ?? '').trim();
  return t && !temJargao(t) ? t : reserva;
}

/** Número com vírgula decimal (51,4), como a pessoa lê. */
export const decimal = (n: number, casas = 1): string => n.toFixed(casas).replace('.', ',');
