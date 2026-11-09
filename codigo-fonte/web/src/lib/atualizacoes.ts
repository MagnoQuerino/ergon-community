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
  if (r.rollback === 'instalada-fora') return { voltar: null, nota: 'A versão instalada já não está entre as publicadas recentemente, e por aqui não dá para voltar. Na página desta versão está o instalador.' };
  if (r.rollback === 'antiga') return { voltar: null, nota: 'Antiga demais para voltar com segurança: nela, a equipe e os seus dados de agora não voltariam juntos.' };
  return { voltar: null, nota: 'Esta versão não tem o pacote para voltar pelo aplicativo; na página dela está o instalador.' };
}

/** O texto da lista de versões anteriores, conforme a volta vale aqui e quem olha (função pura: testável). */
export function textoVersoesAnteriores(onde: OndeVolta): string {
  if (!onde.app) return 'Na página de cada versão estão os instaladores. Baixe o da versão escolhida e instale por cima desta.';
  if (!onde.admin) return 'Voltar de versão muda o Ergon de todas as pessoas deste computador: peça a quem administra o Ergon aqui.';
  return 'Dá para voltar só para as duas versões anteriores a esta. Escolha uma e clique em “Voltar para esta versão”: o aplicativo confere a versão, explica o que pode acontecer e só troca depois da sua confirmação, com um backup dos seus dados antes (se o backup não der certo, você escolhe se volta mesmo assim). Os dados ficam.';
}
