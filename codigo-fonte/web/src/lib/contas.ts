/**
 * Várias contas por aplicativo (rc.29), o que a tela de Conexões decide sem desenhar nada: quando a lista de contas aparece,
 * quando oferecer "Adicionar outra conta", de que jeito se adiciona em cada aplicativo e o que cada linha da lista oferece.
 * Quem tem uma conta só continua vendo o cartão de sempre.
 */
import type { ContaDaTela, Integration } from './types.ts';

/** As contas que contam (a que ficou pela metade, desligada e sem credencial, o servidor já tira da lista). */
export const contasDe = (i: Pick<Integration, 'contas'>): ContaDaTela[] => i.contas ?? [];

/** A lista de contas aparece quando há mais de uma (conectada, conectando ou com problema). */
export const temVariasContas = (i: Pick<Integration, 'contas'>): boolean => contasDe(i).filter((c) => c.state !== 'off').length > 1;

/** De que jeito se conecta mais uma conta deste aplicativo. */
export type ComoAdicionar = 'credencial' | 'login' | 'qr';
export function comoAdicionar(i: Pick<Integration, 'auth'>): ComoAdicionar | null {
  return i.auth === 'token' ? 'credencial' : i.auth === 'oauth' ? 'login' : i.auth === 'qr' ? 'qr' : null;
}

/**
 * "Adicionar outra conta": o aplicativo funciona (não é "em breve"), o login com a conta está registrado, e a principal já
 * está conectada (a primeira conta entra pelo botão de sempre). Um número do WhatsApp ainda pareando segura o próximo.
 */
export function podeAdicionar(i: Pick<Integration, 'auth' | 'state' | 'ready' | 'contas'>): boolean {
  if (!comoAdicionar(i) || !i.ready || i.state !== 'connected') return false;
  return !(i.auth === 'qr' && contasDe(i).some((c) => !c.principal && c.state === 'pending'));
}

/** As contas além da principal (a principal é o próprio cartão, com tudo o que ele sempre teve). */
export const outrasContas = (i: Pick<Integration, 'contas'>): ContaDaTela[] => contasDe(i).filter((c) => !c.principal);

/** O nome que a linha mostra: o apelido, o e-mail ou número, ou (sem nada ainda) a reserva dada pela tela. */
export const nomeNaTela = (c: Pick<ContaDaTela, 'nome'>, reserva: string): string => c.nome.trim() || reserva;

/** O que uma linha da lista oferece. */
export interface AcoesDaLinha {
  /** virar a principal (a que vale quando ninguém diz qual usar) */
  tornarPrincipal: boolean;
  /** ligar e desligar para a equipe e as rotinas */
  ligarDesligar: boolean;
  /** desconectar esta conta (a principal desconecta pelo botão de sempre, no cartão) */
  desconectar: boolean;
  /** entrar de novo / colar a credencial de novo: a conta caiu */
  conectarDeNovo: boolean;
  /** o QR e os filtros deste número (WhatsApp) */
  whatsapp: boolean;
}
export function acoesDaLinha(i: Pick<Integration, 'auth'>, c: ContaDaTela): AcoesDaLinha {
  return {
    tornarPrincipal: !c.principal && c.state === 'connected',
    ligarDesligar: c.state === 'connected',
    desconectar: !c.principal,
    conectarDeNovo: !c.principal && c.state === 'error' && i.auth !== 'qr',
    whatsapp: !c.principal && i.auth === 'qr',
  };
}

/** O endereço com a conta, quando não é a principal (a principal fica como sempre foi). */
export const comConta = (url: string, conta: string): string => (conta ? `${url}${url.includes('?') ? '&' : '?'}conta=${encodeURIComponent(conta)}` : url);

// ---------------------------------------------------------------------------------------- as contas que uma rotina lê
/** Os aplicativos cujas contas uma rotina lê: e-mail e agenda (Microsoft, Google) e as mensagens recebidas (WhatsApp). */
const LE_CONTAS = /^(email|agenda|tarefas\.pessoais|prazos\.pessoais)(\.|$)/;
/**
 * Os grupos de escolha de uma rotina: só os aplicativos com mais de uma conta conectada que as fontes dela leem. Sem grupo,
 * a rotina não mostra a escolha (lê a única conta, como sempre).
 */
export function gruposDaRotina(ints: ReadonlyArray<Pick<Integration, 'kind' | 'name' | 'contas'>>, fontes: readonly string[]): Array<{ kind: string; name: string; contas: ContaDaTela[] }> {
  const leContas = fontes.some((f) => LE_CONTAS.test(f));
  const leMensagens = fontes.includes('mensagens.texto');
  return ints
    .filter((i) => (i.kind === 'whatsapp' ? leMensagens : (i.kind === 'microsoft' || i.kind === 'google') && leContas))
    .map((i) => ({ kind: i.kind, name: i.name, contas: contasDe(i).filter((c) => c.state === 'connected') }))
    .filter((g) => g.contas.length > 1);
}
/** A conta está marcada: sem nenhuma escolhida no grupo, todas estão (a rotina lê todas). */
export function contaMarcada(escolhidas: readonly string[], grupo: readonly ContaDaTela[], id: string): boolean {
  return !grupo.some((c) => escolhidas.includes(c.id)) || escolhidas.includes(id);
}
/**
 * Marca ou desmarca uma conta no grupo. Todas marcadas volta a "sem escolha" (lê todas, inclusive as que entrarem depois);
 * a última não sai (para a rotina não ler este aplicativo, tire a fonte dela).
 */
export function alternarConta(escolhidas: readonly string[], grupo: readonly ContaDaTela[], id: string): string[] {
  const ids = grupo.map((c) => c.id);
  const atuais = ids.filter((x) => contaMarcada(escolhidas, grupo, x));
  const novo = atuais.includes(id) ? atuais.filter((x) => x !== id) : [...atuais, id];
  const resto = escolhidas.filter((x) => !ids.includes(x));
  if (!novo.length) return [...escolhidas];
  return novo.length === ids.length ? resto : [...resto, ...novo];
}
