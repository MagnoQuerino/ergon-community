// O que o card e o detalhe mostram dos campos próprios e dos itens do cartão (rc.41): contas puras, sem tela.
import type { CampoQuadro, PessoaWs, ValorCampo } from './types.ts';

/** A paleta das etiquetas e opções: as cores de função do tema (styles.css: .tag--<nome>); o servidor guarda só o nome. */
export const PALETA = ['neutro', 'info', 'agua', 'sucesso', 'atencao', 'urgente', 'perigo', 'marca', 'dourado'] as const;
export const corDaPaleta = (c: string | null | undefined): string => ((PALETA as readonly string[]).includes(c ?? '') ? c! : 'neutro');
export const COMENTARIO_MAX = 240;
/** etiquetas à vista no card; o resto vira "+N" */
export const ETIQUETAS_NO_CARD = 3;
export const PESSOAS_NO_CARD = 3;

/** Conta como o servidor: por letra (um emoji ou uma letra acentuada conta 1). */
export const contarLetras = (s: string): number => [...s.trim()].length;

/** As etiquetas escolhidas (de todos os campos de etiquetas do quadro), na ordem das opções. */
export function etiquetasDe(fields: CampoQuadro[], values: Record<string, ValorCampo> | undefined): Array<{ id: string; name: string; color: string }> {
  if (!values) return [];
  return fields.filter((f) => f.type === 'labels').flatMap((f) => {
    const v = values[f.id];
    return Array.isArray(v) ? f.options.filter((o) => v.includes(o.id)).map((o) => ({ id: o.id, name: o.name, color: corDaPaleta(o.color) })) : [];
  });
}

/** O valor de um campo como texto para ler (null: sem valor, ou a opção/pessoa não existe mais). */
export function textoDoValor(f: CampoQuadro, v: ValorCampo | undefined, membros: PessoaWs[], fmt: { numero: (n: number) => string; data: (iso: string) => string }): string | null {
  if (v === null || v === undefined || v === '') return null;
  switch (f.type) {
    case 'text': return typeof v === 'string' ? v : null;
    case 'number': return typeof v === 'number' ? fmt.numero(v) : null;
    case 'date': return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? fmt.data(v) : null;
    case 'select': return f.options.find((o) => o.id === v)?.name ?? null;
    case 'person': return membros.find((m) => m.id === v)?.name ?? null;
    case 'labels': { const n = Array.isArray(v) ? f.options.filter((o) => v.includes(o.id)).map((o) => o.name) : []; return n.length ? n.join(', ') : null; }
  }
}

/** Os campos marcados "mostrar no cartão" que têm valor (as etiquetas vão à parte, coloridas). */
export function camposNoCard(fields: CampoQuadro[], values: Record<string, ValorCampo> | undefined, membros: PessoaWs[], fmt: Parameters<typeof textoDoValor>[3]): Array<{ id: string; name: string; texto: string; cor: string | null }> {
  if (!values) return [];
  return fields.filter((f) => f.showOnCard && f.type !== 'labels').flatMap((f) => {
    const texto = textoDoValor(f, values[f.id], membros, fmt);
    return texto === null ? [] : [{ id: f.id, name: f.name, texto, cor: f.type === 'select' ? corDaPaleta(f.options.find((o) => o.id === values[f.id])?.color) : null }];
  });
}

/** Só http e https viram link clicável (o servidor já confere; a tela não confia em link que veio de outro lugar). */
export function linkSeguro(url: string): string | null {
  try { const u = new URL(url); return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null; } catch { return null; }
}
/** O nome de um link sem título: o site e o começo do caminho. */
export function nomeDoLink(url: string, titulo?: string | null): string {
  if (titulo?.trim()) return titulo.trim();
  try { const u = new URL(url); const resto = `${u.pathname}${u.search}`.replace(/\/$/, ''); return `${u.hostname}${resto.length > 28 ? `${resto.slice(0, 27)}…` : resto}`; } catch { return url; }
}
/** As iniciais de uma pessoa para o avatar (uma ou duas letras). */
export function iniciais(nome: string): string {
  const p = nome.trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] ?? '?') + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}
/** O número digitado pela pessoa ("1.250,5", "1250.5"): null se não é número. */
export function lerNumero(s: string): number | null {
  const t = s.trim().replace(/\s/g, '');
  if (!t) return null;
  // vírgula decimal (pt): tira os pontos de milhar; ponto decimal (en): tira as vírgulas de milhar
  const n = Number(/,\d{1,}$/.test(t) && !/\.\d+$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
