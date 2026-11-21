/**
 * Números, dinheiro, percentuais e datas dos blocos visuais no padrão do idioma (pt-BR por padrão: R$ 1.234,56,
 * 12,5%, 21/11/2026). O mesmo na tela, no texto dos canais e no PNG. Percentual: o agente manda 0–100 (12.5 = 12,5%).
 */
import type { Formato, Moeda } from './esquema.ts';

export type Locale = 'pt-BR' | 'en';
const LOC: Record<Locale, string> = { 'pt-BR': 'pt-BR', en: 'en-US' };
const cache = new Map<string, Intl.NumberFormat>();
const nf = (l: Locale, o: Intl.NumberFormatOptions) => {
  const k = `${l}|${JSON.stringify(o)}`;
  let f = cache.get(k);
  if (!f) { f = new Intl.NumberFormat(LOC[l] ?? 'pt-BR', o); cache.set(k, f); }
  return f;
};

export interface OpcoesFmt { formato?: Formato; moeda?: Moeda; locale?: Locale; unidade?: string; curto?: boolean }

/** O valor como a pessoa lê. `curto`: números grandes abreviados (R$ 18,4 mil), para eixos e rótulos apertados. */
export function fmtValor(v: number | string | null | undefined, o: OpcoesFmt = {}): string {
  if (v === null || v === undefined || v === '') return '—';
  const l = o.locale ?? 'pt-BR';
  if (typeof v === 'string') return o.formato === 'data' ? fmtDataIso(v, l) : v;
  if (!Number.isFinite(v)) return '—';
  const curto = o.curto && Math.abs(v) >= 10_000;
  let s: string;
  switch (o.formato) {
    case 'moeda': s = nf(l, { style: 'currency', currency: o.moeda ?? 'BRL', ...(curto ? { notation: 'compact', maximumFractionDigits: 1 } : { minimumFractionDigits: Number.isInteger(v) && Math.abs(v) >= 1000 ? 0 : 2, maximumFractionDigits: 2 }) }).format(v); break;
    case 'percentual': s = nf(l, { style: 'percent', maximumFractionDigits: Math.abs(v) >= 100 ? 0 : 1 }).format(v / 100); break;
    case 'inteiro': s = nf(l, curto ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 0 }).format(v); break;
    case 'compacto': s = nf(l, { notation: 'compact', maximumFractionDigits: 1 }).format(v); break;
    default: s = nf(l, curto ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 2 }).format(v);
  }
  s = s.replace(/ /g, ' ');
  return o.unidade ? `${s} ${o.unidade}` : s;
}

/** A variação com sinal: +12,5% / −3,1% (o menos tipográfico). */
export function fmtVariacao(v: number, locale: Locale = 'pt-BR'): string {
  const s = nf(locale, { maximumFractionDigits: Math.abs(v) < 10 ? 1 : 0 }).format(Math.abs(v));
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${s}%`;
}

/** AAAA-MM-DD → 21/11/2026 (ou 21 nov., curto) */
export function fmtDataIso(iso: string, locale: Locale = 'pt-BR', curto = false): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return new Intl.DateTimeFormat(LOC[locale] ?? 'pt-BR', curto ? { day: 'numeric', month: 'short', timeZone: 'UTC' } : { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/** A variação é boa? (alta boa por padrão; gastos e prazos: "bom": "baixa") */
export const tomDaVariacao = (v: number | undefined, bom: 'alta' | 'baixa' = 'alta'): 'bom' | 'ruim' | 'neutro' =>
  !v ? 'neutro' : (v > 0) === (bom === 'alta') ? 'bom' : 'ruim';

/** Escala com valores "redondos" para o eixo: 0, 5 mil, 10 mil… */
export function escalaBonita(min: number, max: number, passos = 4): { min: number; max: number; passo: number; marcas: number[] } {
  if (min === max) { max = min === 0 ? 1 : min * 1.2; if (min > 0) min = 0; }
  const bruto = (max - min) / passos;
  const mag = 10 ** Math.floor(Math.log10(Math.abs(bruto)));
  const passo = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((p) => p >= bruto) ?? 10 * mag;
  const lo = Math.floor(min / passo) * passo; const hi = Math.ceil(max / passo) * passo;
  const marcas: number[] = [];
  for (let x = lo; x <= hi + passo / 2; x += passo) marcas.push(Math.round(x / passo) * passo);
  return { min: lo, max: hi, passo, marcas };
}
