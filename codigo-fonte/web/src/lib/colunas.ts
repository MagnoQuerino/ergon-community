/**
 * O nome das colunas do quadro na tela. As colunas de fábrica (criadas pelo sistema, em português no banco) seguem o
 * idioma da tela pelo código fixo da coluna (system_key); a coluna que a pessoa renomeou, ou criou, mostra o nome dela.
 * Os nomes de fábrica são os mesmos de server/src/services/colunas.ts (um teste confere).
 */
import { t } from '../i18n/index.ts';
import type { Column } from './types.ts';

type ChaveDaColuna = 'quadro.coluna.aFazer' | 'quadro.coluna.emAndamento' | 'quadro.coluna.fazendo' | 'quadro.coluna.comVoce' | 'quadro.coluna.concluido' | 'quadro.coluna.feito';

/** nomes de fábrica gravados no banco (em português, ou em inglês), por código da coluna: só para reconhecer */
// i18n-ok: os nomes abaixo são dados gravados, não texto de tela
export const NOMES_DE_FABRICA: Record<NonNullable<Column['system_key']>, Record<string, ChaveDaColuna>> = {
  todo: { 'A fazer': 'quadro.coluna.aFazer', 'To do': 'quadro.coluna.aFazer' }, // i18n-ok: nome gravado
  doing: { 'Em andamento': 'quadro.coluna.emAndamento', 'In progress': 'quadro.coluna.emAndamento', Fazendo: 'quadro.coluna.fazendo', Doing: 'quadro.coluna.fazendo' }, // i18n-ok: nome gravado
  with_you: { 'Com você': 'quadro.coluna.comVoce', 'With you': 'quadro.coluna.comVoce' }, // i18n-ok: nome gravado
  done: { 'Concluído': 'quadro.coluna.concluido', Done: 'quadro.coluna.concluido', Feito: 'quadro.coluna.feito' }, // i18n-ok: nome gravado
};

export function nomeDaColuna(c: Pick<Column, 'name' | 'system_key'>): string {
  const k = c.system_key;
  if (!k) return c.name;
  const chave = NOMES_DE_FABRICA[k][c.name.trim()];
  return chave ? t(chave) : c.name;
}
