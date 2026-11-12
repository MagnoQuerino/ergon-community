// Custo das chamadas (Configurações › Ferramentas da equipe): do que é feita cada chamada ao modelo, por agente, e o
// máximo de passos por pedido. Os textos vêm do dicionário (i18n, área configuracoes) por estas funções, fora do
// componente, para o teste (custo.test.ts) conferir números e palavras (sem as peças por dentro do Ergon).
import type { ComposicaoAgente } from './types.ts';
import { fmtNumero, t, type Chave } from '../i18n/index.ts';

/** as escolhas da tela (o servidor aceita de 5 a 150; o padrão é 90: a experiência completa, e a pessoa reduz para economizar) */
export const PASSOS_OPCOES = [5, 10, 20, 40, 60, 90, 120, 150];
export const PASSOS_PADRAO = 90;

export const passosAjuda = () => t('configuracoes.custo.passosAjuda');
export const passosDepois = () => t('configuracoes.custo.passosDepois');
/** um motor para vários workspaces: a escolha vale para todos eles (a tela mostra o que vale de fato) */
export const passosCompartilhado = (outros: number) => (outros > 0 ? t('configuracoes.custo.passosCompartilhado', { n: outros }) : '');

/** Resumir as conversas longas mais cedo (ligado por padrão): o texto ao lado da escolha */
export const compactarRotulo = () => t('configuracoes.custo.compactarRotulo');
export const compactarAjuda = () => t('configuracoes.custo.compactarAjuda');
export const compactarDepois = () => t('configuracoes.custo.compactarDepois');
/** a equipe é de antes desta opção: a escolha fica guardada e passa a valer quando a equipe for atualizada */
export const compactarAtualizacao = () => t('configuracoes.custo.compactarAtualizacao');

export const composicaoIntro = () => t('configuracoes.custo.composicaoIntro');
export const composicaoVazia = () => t('configuracoes.custo.composicaoVazia');
export const composicaoNota = () => t('configuracoes.custo.composicaoNota');
export const composicaoEstimada = () => t('configuracoes.custo.composicaoEstimada');

export interface Fatia { id: 'instrucoes' | 'ferramentas' | 'memoria' | 'anexos' | 'conversa'; rotulo: string; fracao: number; pct: string }
const ROTULOS = {
  instrucoes: 'configuracoes.custo.fatiaInstrucoes',
  ferramentas: 'configuracoes.custo.fatiaFerramentas',
  memoria: 'configuracoes.custo.fatiaMemoria',
  anexos: 'configuracoes.custo.fatiaAnexos',
  conversa: 'configuracoes.custo.fatiaConversa',
} as const satisfies Record<Fatia['id'], Chave>;

/** porcentagem como a pessoa lê: inteira; abaixo de 1%, "<1%"; zero, "0%" */
export function pct(f: number): string {
  const p = Math.max(0, Math.min(1, f)) * 100;
  if (p === 0) return '0%';
  if (p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

/** as cinco partes, na ordem da barra (de servidor antigo, sem os anexos: zero) */
export function fatias(a: Pick<ComposicaoAgente, 'partes'>): Fatia[] {
  return (['instrucoes', 'ferramentas', 'memoria', 'anexos', 'conversa'] as const).map((id) => { const f = a.partes[id] ?? 0; return { id, rotulo: t(ROTULOS[id]), fracao: f, pct: pct(f) }; });
}

/** "≈ 58 mil por chamada" (a média de entrada, na mesma medida do consumo) */
export function tamanhoMedio(n: number): string {
  if (n >= 1_000_000) return t('configuracoes.custo.tamanhoMilhao', { valor: fmtNumero(n / 1_000_000, { maximumFractionDigits: 1 }) });
  if (n >= 10_000) return t('configuracoes.custo.tamanhoMil', { valor: fmtNumero(Math.round(n / 1000)) });
  if (n >= 1000) return t('configuracoes.custo.tamanhoMil', { valor: fmtNumero(n / 1000, { maximumFractionDigits: 1 }) });
  return t('configuracoes.custo.tamanho', { valor: fmtNumero(n) });
}

/** a linha de baixo: de que são feitas as instruções e quanto o provedor reaproveitou */
export function detalhe(a: Pick<ComposicaoAgente, 'instrucoes' | 'cache' | 'chamadas' | 'resumidas' | 'execucoes'>): string {
  const partes = [t('configuracoes.custo.detalheInstrucoes', { agente: pct(a.instrucoes.agente), base: pct(a.instrucoes.base), competencias: pct(a.instrucoes.competencias) })];
  if (a.cache !== null) partes.push(t('configuracoes.custo.detalheCache', { pct: pct(a.cache) }));
  const r = resumidasTexto(a.resumidas ?? 0, a.execucoes ?? 0);
  if (r) partes.push(r);
  return partes.join(' ');
}

/** em quantos pedidos a conversa foi resumida (vazio quando nenhum: nada a dizer) */
export function resumidasTexto(resumidas: number, pedidos: number): string {
  if (resumidas <= 0) return '';
  return pedidos > resumidas
    ? t('configuracoes.custo.resumidasDe', { resumidas: fmtNumero(resumidas), pedidos: fmtNumero(pedidos) })
    : t('configuracoes.custo.resumidas', { n: resumidas });
}

export const chamadasTexto = (n: number) => t('configuracoes.custo.chamadas', { n });
