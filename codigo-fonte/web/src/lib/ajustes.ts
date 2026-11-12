// rc.27: os textos e as contas dos ajustes da equipe de IA (plano B, limites da conta, pausa), fora do componente para o
// teste (ajustes.test.ts) conferir números e palavras nas duas línguas. Os textos vêm do dicionário (área configuracoes).
import type { ContaDeIa, JanelaDeUso, ModeloReserva } from './types.ts';
import { fmtDataHora, fmtLista, fmtMoeda, t } from '../i18n/index.ts';

/** quantos modelos cabem na lista de reserva (o servidor aceita até 5) */
export const RESERVA_MAX = 5;

// nomes de marca: não se traduzem
// i18n-ok: nomes de marca das contas de IA, não se traduzem
const CONTAS: Record<string, string> = { 'openai-codex': 'ChatGPT', nous: 'Nous Portal', anthropic: 'Claude', openrouter: 'OpenRouter' };
/** O nome da conta de IA para a tela (o nome que veio do servidor, ou a marca conhecida, ou o que veio). */
export const nomeDaConta = (id: string, nome?: string | null): string => nome || CONTAS[id] || id;

/** "anthropic/claude-sonnet-4.5" → "claude-sonnet-4.5" quando não há rótulo pronto (a lista de modelos traz o rótulo). */
export const nomeDoModelo = (id: string, rotulo?: string | null): string => rotulo || id.split('/').slice(-1)[0] || id;

const NOME_DA_COTA = {
  sessao: 'configuracoes.ajustes.cota.nome.sessao', semana: 'configuracoes.ajustes.cota.nome.semana', semana_modelo: 'configuracoes.ajustes.cota.nome.semana_modelo',
  assinatura: 'configuracoes.ajustes.cota.nome.assinatura', chave: 'configuracoes.ajustes.cota.nome.chave', outro: 'configuracoes.ajustes.cota.nome.outro',
} as const;

/** "Restam 39% da cota semanal, renova em 14/11/2026, 07:00" — o que resta, nunca estimado (o provedor informou). */
export function fraseDaJanela(w: JanelaDeUso): string {
  const cota = t(NOME_DA_COTA[w.kind] ?? NOME_DA_COTA.outro);
  const pct = String(Math.max(0, Math.min(100, Math.round(w.leftPercent))));
  return w.resetsAt ? t('configuracoes.ajustes.cota.restaRenova', { pct, cota, quando: fmtDataHora(w.resetsAt) }) : t('configuracoes.ajustes.cota.resta', { pct, cota });
}

export interface LinhaDeConta { titulo: string; frases: string[]; /** a menor sobra entre as janelas da conta (0 a 100), para a barra; null = sem janela */ resta: number | null }
/** Uma conta de IA em linhas para a tela: o título (conta e plano) e as frases (cada janela, o saldo, a renovação). */
export function linhasDaConta(c: ContaDeIa): LinhaDeConta {
  const conta = nomeDaConta(c.provider);
  const frases = c.windows.map(fraseDaJanela);
  if (c.unlimited) frases.push(t('configuracoes.ajustes.cota.saldoIlimitado'));
  else if (c.balanceUsd !== null) frases.push(t('configuracoes.ajustes.cota.saldo', { valor: fmtMoeda(c.balanceUsd, 'USD', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) }));
  if (c.renewsAt) frases.push(t('configuracoes.ajustes.cota.renovaAssinatura', { quando: fmtDataHora(c.renewsAt) }));
  const daConta = c.windows.filter((w) => w.scope === 'conta');
  return { titulo: c.plan ? t('configuracoes.ajustes.cota.conta', { conta, plano: c.plan }) : conta, frases,
    resta: daConta.length ? Math.min(...daConta.map((w) => w.leftPercent)) : null };
}

/** A frase curta para o balão do Estado: a janela mais apertada da primeira conta ("Restam 39% da cota semanal, renova em …"). */
export function fraseCurtaDaCota(contas: ContaDeIa[] | null | undefined): string | null {
  const c = (contas ?? []).find((x) => x.windows.length);
  if (!c) return null;
  const daConta = c.windows.filter((w) => w.scope === 'conta');
  const w = [...(daConta.length ? daConta : c.windows)].sort((a, b) => a.leftPercent - b.leftPercent)[0];
  return fraseDaJanela(w);
}

/** "claude-sonnet-4.5 e gpt-5-mini" — os modelos de reserva em uso, na ordem, para a frase "De reserva agora". */
export function listaDeReserva(lista: ModeloReserva[], rotulo: (m: ModeloReserva) => string): string {
  return fmtLista(lista.map(rotulo));
}

/** Troca dois vizinhos da lista (subir/descer); fora do intervalo, a mesma lista. */
export function mover<T>(lista: T[], i: number, para: -1 | 1): T[] {
  const j = i + para;
  if (i < 0 || j < 0 || i >= lista.length || j >= lista.length) return lista;
  const out = [...lista];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** "Equipe em pausa desde 10/11/2026, 09:30" (ou só "Equipe em pausa", sem a hora). */
export function textoDaPausa(p: { pausada: boolean; desde: string | null } | null | undefined): string {
  if (!p?.pausada) return t('configuracoes.ajustes.pausa.trabalhando');
  return p.desde ? t('configuracoes.ajustes.pausa.emPausaDesde', { quando: fmtDataHora(p.desde) }) : t('configuracoes.ajustes.pausa.emPausa');
}
