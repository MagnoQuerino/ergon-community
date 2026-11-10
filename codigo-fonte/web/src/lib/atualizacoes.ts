import { t } from '../i18n/index.ts';

/**
 * Voltar para uma versão anterior (Configurações › Atualizações). No Ergon Desktop, a versão que tem o pacote
 * assinado do canal ganha o botão "Voltar para esta versão": ele leva a "/__desktop/voltar?versao=X", que o aplicativo
 * intercepta e troca pela tela dele (confere a versão, avisa, pede a confirmação e faz o backup antes). A página não
 * ganha nenhuma permissão com isso. Fora do aplicativo, e para as versões sem o pacote, fica a página da versão.
 * O botão só aparece onde a volta pelo aplicativo vale (Windows com o ambiente próprio: o aplicativo avisa a página)
 * e só para quem administra o Ergon: a volta troca a versão da instalação inteira, com os dados de todas as pessoas.
 */
/** instalada-fora: a instalada já não está entre as publicadas recentemente (o aplicativo recusaria a volta). */
export type Rollback = 'pode' | 'antiga' | 'sem-pacote' | 'instalada-fora';

export interface VersaoAnterior { version: string; url: string | null; publishedAt: string | null; prerelease: boolean; rollback?: Rollback }

/**
 * No Ergon Desktop (onde a volta é pelo aplicativo), só as DUAS versões publicadas logo antes da instalada aparecem
 * (decisão de 09/11; o aplicativo confere de novo do lado dele). Fora dele, a lista dos instaladores segue com até
 * LISTA_ANTERIORES (server/src/version.ts, a mesma conta): a volta ali é pela página de cada versão.
 */
export const VOLTA_ANTERIORES = 2;
export const LISTA_ANTERIORES = 12;
export const anteriores = <T>(lista: T[] | null | undefined, peloApp: boolean): T[] => (lista ?? []).slice(0, peloApp ? VOLTA_ANTERIORES : LISTA_ANTERIORES);

/** Endereço que o aplicativo do computador intercepta (nunca chega ao servidor). */
export const PEDIDO_VOLTAR = '/__desktop/voltar';

export interface VoltaNaLista {
  /** endereço do botão "Voltar para esta versão" (null: sem botão) */
  voltar: string | null;
  /** o porquê de não ter o botão, em palavras simples (null: nada a dizer) */
  nota: string | null;
}

/** Onde a lista está: `app`, a volta pelo próprio aplicativo vale aqui; `admin`, quem olha administra o Ergon. */
export interface OndeVolta { app: boolean; admin: boolean }

/** O que a lista mostra para uma versão anterior (função pura: testável). */
export function voltaNaLista(r: VersaoAnterior, onde: OndeVolta): VoltaNaLista {
  // fora do aplicativo, ou sem administrar (o texto da seção diz a quem pedir): só a página da versão
  if (!onde.app || !onde.admin) return { voltar: null, nota: null };
  if (r.rollback === 'pode') return { voltar: `${PEDIDO_VOLTAR}?versao=${encodeURIComponent(r.version)}`, nota: null };
  if (r.rollback === 'instalada-fora') return { voltar: null, nota: t('configuracoes.atual.notaInstaladaFora') };
  if (r.rollback === 'antiga') return { voltar: null, nota: t('configuracoes.atual.notaAntiga') };
  return { voltar: null, nota: t('configuracoes.atual.notaSemPacote') };
}

/** O texto da lista de versões anteriores, conforme a volta vale aqui e quem olha (função pura: testável). */
export function textoVersoesAnteriores(onde: OndeVolta): string {
  if (!onde.app) return t('configuracoes.atual.anterioresWeb');
  if (!onde.admin) return t('configuracoes.atual.anterioresNaoAdmin');
  return t('configuracoes.atual.anterioresAdmin');
}
