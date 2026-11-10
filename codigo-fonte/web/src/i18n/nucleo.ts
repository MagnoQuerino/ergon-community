// O miolo da tradução, sem React e sem a página: escolher a forma do plural, preencher os marcadores {nome} e formatar
// datas, horas, números e dinheiro pelo Intl no idioma pedido. index.ts liga isto ao idioma atual da tela; os testes
// usam direto (nucleo.test.ts).
import type { Idioma } from './idiomas.ts';
import type { Mensagem, Plural } from './tipos.ts';

export type Valores = Readonly<Record<string, string | number | null | undefined>>;
export type Data = Date | number | string;

// os formatadores do Intl custam para criar: um por idioma e jeito de formatar, reaproveitado
const cache = new Map<string, unknown>();
function intl<T>(tipo: string, idioma: Idioma, opcoes: object | undefined, criar: () => T): T {
  const k = `${tipo}|${idioma}|${opcoes ? JSON.stringify(opcoes) : ''}`;
  let f = cache.get(k) as T | undefined;
  if (!f) { f = criar(); if (cache.size > 300) cache.clear(); cache.set(k, f); }
  return f;
}

const comoData = (d: Data): Date | null => {
  const v = d instanceof Date ? d : new Date(d);
  return Number.isNaN(v.getTime()) ? null : v;
};

/** Número no idioma: 1.250,5 / 1,250.5. */
export function fmtNumero(idioma: Idioma, n: number, opcoes?: Intl.NumberFormatOptions): string {
  return intl('n', idioma, opcoes, () => new Intl.NumberFormat(idioma, opcoes)).format(n);
}

/** Número curto: 1,3 mil · 2,5 mi / 1.3K · 2.5M. */
export function fmtCompacto(idioma: Idioma, n: number): string {
  return fmtNumero(idioma, n, { notation: 'compact', maximumFractionDigits: 1 });
}

/** Dinheiro de verdade (real, dólar, euro), com o símbolo no jeito do idioma: US$ 1,50 / $1.50. */
export function fmtMoeda(idioma: Idioma, valor: number, moeda: 'BRL' | 'USD' | 'EUR', opcoes?: Intl.NumberFormatOptions): string {
  return fmtNumero(idioma, valor, { style: 'currency', currency: moeda, ...opcoes });
}

/** A moeda do World: o nome e o símbolo (₯) não se traduzem; só o número segue o idioma. */
export function fmtDracmas(idioma: Idioma, valor: number): string {
  return `₯ ${fmtNumero(idioma, valor, { maximumFractionDigits: 2 })}`;
}

/** Tamanho de arquivo: 820 B, 1,5 MB / 1.5 MB (as unidades são as mesmas nas duas línguas). */
export function fmtBytes(idioma: Idioma, bytes: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.max(0, bytes); let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${fmtNumero(idioma, v, { maximumFractionDigits: i === 0 ? 0 : 1 })} ${u[i]}`;
}

/** Data (curta por padrão): 09/11/2026 / 11/9/2026. Data inválida: texto vazio (nunca "Invalid Date"). */
export function fmtData(idioma: Idioma, d: Data, opcoes: Intl.DateTimeFormatOptions = { dateStyle: 'short' }): string {
  const v = comoData(d);
  return v ? intl('d', idioma, opcoes, () => new Intl.DateTimeFormat(idioma, opcoes)).format(v) : '';
}
/** Hora: 14:05 / 2:05 PM. */
export const fmtHora = (idioma: Idioma, d: Data) => fmtData(idioma, d, { timeStyle: 'short' });
/** Data e hora: 09/11/2026, 14:05 / 11/9/26, 2:05 PM. */
export const fmtDataHora = (idioma: Idioma, d: Data) => fmtData(idioma, d, { dateStyle: 'short', timeStyle: 'short' });

/** Tempo relativo: há 5 minutos, em 2 dias / 5 minutes ago, in 2 days ("agora" / "now" para o que acabou de acontecer). */
export function fmtRelativo(idioma: Idioma, d: Data, agora: number = Date.now()): string {
  const v = comoData(d);
  if (!v) return '';
  const s = (v.getTime() - agora) / 1000;
  const a = Math.abs(s);
  const [qtd, unidade]: [number, Intl.RelativeTimeFormatUnit] =
    a < 45 ? [0, 'second'] : a < 3600 ? [s / 60, 'minute'] : a < 86_400 ? [s / 3600, 'hour'] : a < 7 * 86_400 ? [s / 86_400, 'day']
      : a < 30 * 86_400 ? [s / (7 * 86_400), 'week'] : a < 365 * 86_400 ? [s / (30 * 86_400), 'month'] : [s / (365 * 86_400), 'year'];
  return intl('r', idioma, undefined, () => new Intl.RelativeTimeFormat(idioma, { numeric: 'auto' })).format(Math.round(qtd), unidade);
}

/** Lista: "a, b e c" / "a, b, and c" (ou "ou" / "or"). */
export function fmtLista(idioma: Idioma, itens: readonly string[], tipo: 'conjunction' | 'disjunction' = 'conjunction'): string {
  return intl('l', idioma, { tipo }, () => new Intl.ListFormat(idioma, { type: tipo })).format(itens);
}

/**
 * A forma do plural para este número. O 0 exato usa `zero`, quando há; sem ela, o 0 vai SEMPRE para `other`: o Intl põe
 * o 0 no singular em português (PluralRules('pt-BR').select(0) é 'one'), e a tela sempre disse "0 tarefas abertas". Em
 * inglês o 0 já é `other`: nada muda.
 */
export function formaDoPlural(idioma: Idioma, p: Plural, n: number): string {
  if (n === 0) return p.zero ?? p.other;
  const caso = intl('p', idioma, undefined, () => new Intl.PluralRules(idioma)).select(n) as keyof Plural;
  return p[caso] ?? p.other;
}

/**
 * Preenche os marcadores {nome}. Só o {n} (a quantidade do plural) sai formatado no idioma (1.250 / 1,250); os outros
 * números saem crus, como vieram: número do card, ano, porta e versão não ganham separador (#1234, 2026). Uma quantidade
 * em outro marcador: formate antes, com fmtNumero(). Marcador sem valor fica à vista (o teste pega).
 */
export function interpolar(idioma: Idioma, texto: string, valores?: Valores): string {
  if (!valores) return texto;
  return texto.replace(/\{(\w+)\}/g, (todo, nome: string) => {
    const v = valores[nome];
    return v === undefined || v === null ? todo : typeof v === 'number' ? (nome === 'n' ? fmtNumero(idioma, v) : String(v)) : v;
  });
}

/** O texto em pedaços: texto solto e o nome de cada marcador (para montar a frase com partes em negrito, links…). */
export function pedacos(texto: string): Array<string | { marca: string }> {
  const out: Array<string | { marca: string }> = [];
  let i = 0;
  for (const m of texto.matchAll(/\{(\w+)\}/g)) {
    if (m.index > i) out.push(texto.slice(i, m.index));
    out.push({ marca: m[1] });
    i = m.index + m[0].length;
  }
  if (i < texto.length) out.push(texto.slice(i));
  return out;
}

/** O texto final de uma mensagem (texto simples ou plural) com os valores. */
export function montar(idioma: Idioma, msg: Mensagem, valores?: Valores): string {
  if (typeof msg === 'string') return interpolar(idioma, msg, valores);
  const n = Number(valores?.n ?? 0);
  return interpolar(idioma, formaDoPlural(idioma, msg, n), valores);
}
