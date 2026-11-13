// Tradução da tela: t('area.chave') no lugar do texto escrito no componente. Ver COMO-TRADUZIR.md (o passo a passo) e
// GLOSSARIO.md (os termos fixos).
//
//   const t = useT();                                  // no componente: troca de idioma redesenha na hora
//   t('geral.barra.modoFoco')                          // 'Modo Foco' / 'Focus Mode'
//   t('geral.barra.pedirA', { nome: 'Aristóteles' })   // 'Pedir a Aristóteles' / 'Ask Aristóteles'
//   t('geral.estado.avisos', { n: 3 })                 // plural: '3 avisos' / '3 warnings'
//   tn('geral.x', { nome: <b>{nome}</b> })             // a frase com uma parte em negrito, na ordem de cada idioma
//   fmtData(d) · fmtHora(d) · fmtNumero(n) · fmtDracmas(n) …   // no lugar de toLocaleString('pt-BR')
//
// O TypeScript confere tudo: a chave tem de existir no dicionário e os valores têm de ser os marcadores dela.
import { createElement, Fragment, useSyncExternalStore, type ReactNode } from 'react';
import { pt, type Dicionario } from './pt/index.ts';
import { IDIOMA_PADRAO, ehIdioma, idiomaDoNavegador, type Idioma } from './idiomas.ts';
import * as N from './nucleo.ts';
import type { Marcadores, Mensagem, Plural } from './tipos.ts';

export type { Idioma } from './idiomas.ts';
export { IDIOMAS, NOME_DO_IDIOMA, ehIdioma } from './idiomas.ts';

type Areas = { readonly [area: string]: { readonly [chave: string]: Mensagem } };
// o português vem junto com a tela; o inglês só é baixado por quem usa (quem fala português não paga nada a mais)
const PT: Areas = pt;
const DICIONARIOS: Partial<Record<Idioma, Areas>> = { [IDIOMA_PADRAO]: PT };
const CARREGAR: Record<Idioma, () => Promise<Areas>> = {
  'pt-BR': () => Promise.resolve(pt),
  en: () => import('./en/index.ts').then((m) => m.en as Areas),
};
const carregando = new Map<Idioma, Promise<void>>();
/** Baixa o dicionário do idioma (uma vez). Falhou (sem rede no meio da troca): a próxima tentativa baixa de novo. */
function carregarIdioma(l: Idioma): Promise<void> {
  if (DICIONARIOS[l]) return Promise.resolve();
  let p = carregando.get(l);
  if (!p) {
    p = CARREGAR[l]().then((d) => { DICIONARIOS[l] = d; }).finally(() => carregando.delete(l));
    carregando.set(l, p);
  }
  return p;
}

/** Toda chave que existe: 'area.chave'. */
export type Chave = { [A in keyof Dicionario & string]: `${A}.${keyof Dicionario[A] & string}` }[keyof Dicionario & string];
type MensagemDe<K extends string> = K extends `${infer A}.${infer R}`
  ? A extends keyof Dicionario ? R extends keyof Dicionario[A] ? Dicionario[A][R] : never : never : never;
type NomesDe<M> = M extends Plural ? Marcadores<M['other']> | 'n' : Marcadores<M>;
/** Os valores que a chave pede: um por marcador; no plural, `n` é o número. */
export type ValoresDe<K extends Chave> = MensagemDe<K> extends Plural
  ? { readonly n: number } & { readonly [P in Exclude<NomesDe<MensagemDe<K>>, 'n'>]: string | number }
  : { readonly [P in NomesDe<MensagemDe<K>>]: string | number };
type Args<K extends Chave> = [NomesDe<MensagemDe<K>>] extends [never] ? [] : [valores: ValoresDe<K>];
/** Para tn(): cada marcador pode ser um pedaço de tela (negrito, link, ícone). */
export type PedacosDe<K extends Chave> = MensagemDe<K> extends Plural
  ? { readonly n: number } & { readonly [P in Exclude<NomesDe<MensagemDe<K>>, 'n'>]: ReactNode }
  : { readonly [P in NomesDe<MensagemDe<K>>]: ReactNode };

function buscar(idioma: Idioma, chave: string): Mensagem | undefined {
  const i = chave.indexOf('.');
  const area = chave.slice(0, i); const nome = chave.slice(i + 1);
  // sem a tradução (não deveria acontecer: o tipo e o teste de completude não deixam), vale o português
  return DICIONARIOS[idioma]?.[area]?.[nome] ?? PT[area]?.[nome];
}

// ——— o idioma atual ———

const CHAVE_LOCAL = 'ergon.idioma';
// A ORDEM (uma só, para todas as telas):
//   antes de entrar (tela de entrada): a última escolha feita neste navegador > o idioma do navegador.
//   depois de entrar: a escolha da pessoa (servidor, a mesma em todos os workspaces dela) > a escolha dela guardada
//     neste navegador (a gravação no servidor falhou: grava de novo) > o idioma do navegador.
// Na multiconta, a tela de entrada fica na língua de quem entrou por último neste navegador; depois de entrar, a tela
// da pessoa já abre na língua dela (o App espera o dicionário antes de desenhar: nada troca de língua no meio da tela).
const chaveDaPessoa = (quem: string) => `${CHAVE_LOCAL}:${quem}`;
const lerGuardado = (chave = CHAVE_LOCAL): Idioma | null => { try { const v = localStorage.getItem(chave); return ehIdioma(v) ? v : null; } catch { return null; } };
const guardarEm = (chave: string, l: Idioma) => { try { localStorage.setItem(chave, l); } catch { /* sem armazenamento: vale só nesta visita */ } };
/** quem entrou: a escolha dela também fica neste navegador, separada da de outras contas */
let pessoa: string | null = null;
const guardar = (l: Idioma) => { guardarEm(CHAVE_LOCAL, l); if (pessoa) guardarEm(chaveDaPessoa(pessoa), l); };
const linguaDoNavegador = (): string | undefined => (typeof navigator === 'undefined' ? undefined : navigator.language);

/** Sem escolha nenhuma: o idioma do navegador. */
const idiomaSemEscolha = (): Idioma => idiomaDoNavegador(linguaDoNavegador());
/** Ao abrir a página (antes de entrar): a última escolha feita neste navegador; sem ela, a do navegador. */
export function idiomaInicial(): Idioma { return lerGuardado() ?? idiomaSemEscolha(); }

/**
 * O idioma ao entrar, pela ORDEM acima. `lembrar`: guardar neste navegador. `gravar`: o que mandar ao servidor — a
 * escolha guardada aqui que não chegou lá.
 */
export function decidirAoEntrar(doServidor: unknown, quem: string | null): { idioma: Idioma; lembrar: boolean; gravar: Idioma | null } {
  if (ehIdioma(doServidor)) return { idioma: doServidor, lembrar: true, gravar: null };
  const daqui = quem ? lerGuardado(chaveDaPessoa(quem)) : null;
  if (daqui) return { idioma: daqui, lembrar: true, gravar: daqui };
  return { idioma: idiomaSemEscolha(), lembrar: false, gravar: null };
}

/** o idioma em que a tela está: só muda quando o dicionário do pedido já chegou (t() e a tela sempre na mesma língua) */
let atual: Idioma = IDIOMA_PADRAO;
/** o último idioma pedido (a troca espera o dicionário chegar; um pedido mais novo vence o antigo) */
let pedido: Idioma = idiomaInicial();
const subs = new Set<() => void>();

function aplicarNoDocumento() {
  if (typeof document !== 'undefined') document.documentElement.lang = atual;
}
aplicarNoDocumento();

export const idiomaAtual = (): Idioma => atual;

/** Antes de desenhar a tela pela primeira vez: o dicionário do idioma inicial já baixado (nada aparece em outra língua e depois troca). */
export const prepararIdioma = (): Promise<void> => setIdioma(pedido, { guardar: false });

function aplicar(l: Idioma) {
  if (l === atual) return;
  atual = l;
  aplicarNoDocumento();
  subs.forEach((f) => f());
}

/**
 * Troca o idioma na hora: todas as telas redesenham, sem recarregar. Se o dicionário ainda não chegou, a tela continua
 * como está até ele chegar (nunca meio a meio). `guardar`: lembrar neste navegador. A promessa resolve com a troca feita.
 */
export function setIdioma(l: Idioma, opcoes: { guardar?: boolean } = {}): Promise<void> {
  if (!ehIdioma(l)) return Promise.resolve();
  if (opcoes.guardar !== false) guardar(l);
  pedido = l;
  if (DICIONARIOS[l]) { aplicar(l); return Promise.resolve(); }
  return carregarIdioma(l).then(() => { if (pedido === l) aplicar(l); }).catch(() => { /* sem o dicionário: fica como está */ });
}

/**
 * Ao entrar: o idioma da pessoa pela ORDEM do começo do arquivo. `pronto` resolve com o dicionário já baixado; `gravar`
 * é o que o chamador manda ao servidor (lib/prefs.ts), quando há.
 */
export function usarIdiomaDaPessoa(doServidor: unknown, quem: string | null = null): { pronto: Promise<void>; gravar: Idioma | null } {
  pessoa = quem;
  const d = decidirAoEntrar(doServidor, quem);
  return { pronto: setIdioma(d.idioma, { guardar: d.lembrar }), gravar: d.gravar };
}

/** Avisa a cada troca de idioma (para o que não é React: a cidade redesenha os rótulos). Devolve o "parar de avisar". */
export function onIdioma(f: (l: Idioma) => void): () => void {
  const g = () => f(atual);
  subs.add(g);
  return () => { subs.delete(g); };
}

const assinar = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
/** O idioma atual, num componente: troca → redesenha. */
export function useIdioma(): Idioma { return useSyncExternalStore(assinar, idiomaAtual, idiomaAtual); }

// ——— os textos ———

/** O texto da chave no idioma atual, com os valores nos marcadores. */
export function t<K extends Chave>(chave: K, ...valores: Args<K>): string {
  const m = buscar(atual, chave);
  return m === undefined ? chave : N.montar(atual, m, valores[0] as N.Valores | undefined);
}

/** A frase com pedaços de tela nos marcadores (negrito, link, ícone), na ordem das palavras de cada idioma. */
export function tn<K extends Chave>(chave: K, pedacos: PedacosDe<K>): ReactNode {
  const m = buscar(atual, chave);
  if (m === undefined) return chave;
  const p = pedacos as Readonly<Record<string, ReactNode>>;
  const texto = typeof m === 'string' ? m : N.formaDoPlural(atual, m, Number(p.n ?? 0));
  const partes = N.pedacos(texto).map((x) => (typeof x === 'string' ? x : x.marca === 'n' && typeof p.n === 'number' ? N.fmtNumero(atual, p.n) : p[x.marca] ?? `{${x.marca}}`));
  return createElement(Fragment, null, ...partes);
}

/** No componente: o mesmo t(), e a troca de idioma redesenha o componente. */
export function useT(): typeof t { useIdioma(); return t; }

// ——— datas, horas, números e dinheiro no idioma atual (no lugar de toLocaleString('pt-BR')) ———

export const fmtNumero = (n: number, opcoes?: Intl.NumberFormatOptions) => N.fmtNumero(atual, n, opcoes);
export const fmtCompacto = (n: number) => N.fmtCompacto(atual, n);
export const fmtMoeda = (v: number, moeda: 'BRL' | 'USD' | 'EUR', opcoes?: Intl.NumberFormatOptions) => N.fmtMoeda(atual, v, moeda, opcoes);
export const fmtDracmas = (v: number) => N.fmtDracmas(atual, v);
export const fmtBytes = (b: number) => N.fmtBytes(atual, b);
export const fmtData = (d: N.Data, opcoes?: Intl.DateTimeFormatOptions) => N.fmtData(atual, d, opcoes);
export const fmtHora = (d: N.Data) => N.fmtHora(atual, d);
export const fmtDataHora = (d: N.Data) => N.fmtDataHora(atual, d);
export const fmtRelativo = (d: N.Data, agora?: number) => N.fmtRelativo(atual, d, agora);
export const fmtLista = (itens: readonly string[], tipo?: 'conjunction' | 'disjunction') => N.fmtLista(atual, itens, tipo);
