// Textos de tela que dependem do que o servidor mandou: o erro do login da Microsoft ou do Google, a volta do pedido ao
// administrador, a limpeza das versões antigas da equipe e o motivo de um card em falha. Ficam aqui, fora dos componentes,
// para o teste (textos-tela.test.ts) conferir que a pessoa nunca lê o erro cru, em inglês, nem as peças por dentro do Ergon.
import type { EtapaConsentimento } from './types.ts';

type Provedor = 'microsoft' | 'google';
const QUEM: Record<Provedor, { nome: string; cujo: string; artigo: string }> = {
  microsoft: { nome: 'Microsoft', cujo: 'da Microsoft', artigo: 'A' },
  google: { nome: 'Google', cujo: 'do Google', artigo: 'O' },
};

/** primeira letra maiúscula e ponto final */
const frase = (t: string) => {
  const s = t.trim();
  const c = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(c) ? c : `${c}.`;
};

/** a empresa exige o administrador (Microsoft: AADSTS90094/90095/65001; Google: admin_policy_enforced) */
const PRECISA_ADMIN = /AADSTS(?:90094|90095|65001)\b|\bconsent_required\b|\badmin_policy_enforced\b/i;
/** a própria pessoa recusou na página da conta */
const RECUSOU = /AADSTS65004\b|\baccess_denied\b/i;
const CODIGO_MS = /\b(AADSTS\d+)\b/;
/** o formato que o servidor grava com o erro do provedor: "prefixo: código (descrição em inglês)" */
const CRU_OAUTH = /^(?:A conta não concluiu o login|O administrador não aprovou|O login não terminou):\s*([a-z][a-z_]+)(?:\s*\(|$)/i;

/**
 * O motivo de um login que não terminou, em português: nunca o erro cru do provedor (inglês e código). Um código que não
 * diz nada à pessoa fica só como referência para o suporte. Texto que já está em português passa como está.
 */
export function motivoDoLogin(erro: string | null | undefined, provedor: Provedor = 'microsoft'): string | null {
  const t = (erro ?? '').trim();
  if (!t) return null;
  const p = QUEM[provedor];
  if (/^O administrador não aprovou\b/i.test(t)) return 'O administrador não aprovou o pedido.';
  if (PRECISA_ADMIN.test(t)) return 'A empresa exige a aprovação do administrador.';
  if (RECUSOU.test(t)) return `A autorização foi recusada na página ${p.cujo}.`;
  const codigo = CODIGO_MS.exec(t)?.[1] ?? CRU_OAUTH.exec(t)?.[1];
  if (codigo) return `${p.artigo} ${p.nome} não concluiu a autorização (código ${codigo}, para o suporte).`;
  return frase(t);
}

/**
 * O problema gravado na conexão, como o cartão mostra: no pedido ao administrador já no primeiro acesso, nada em vermelho
 * (é um passo esperado, que o próprio cartão explica); na Microsoft e no Google, o motivo em português.
 */
export function erroDaConexao(i: { kind: string; error?: string | null; adminBase?: unknown }): string | null {
  if (i.adminBase || !i.error) return null;
  return i.kind === 'microsoft' || i.kind === 'google' ? motivoDoLogin(i.error, i.kind) : i.error;
}

const APROVOU_SEM_CONTA = 'A Microsoft registrou a aprovação do administrador. Para terminar, clique em "Já aprovaram? Entrar de novo", abaixo.';

/**
 * O aviso da volta do login (a Microsoft entra em etapas: o que voltou sem a leitura ou sem os canais diz o que fazer).
 * conectada: a conta já está ligada neste workspace. Sem ela, a aprovação do administrador foi a do primeiro acesso, e o
 * botão que existe no cartão é "Já aprovaram? Entrar de novo" (com ela, a etapa aprovada mostra "Autorizar agora").
 */
export function textoDaVolta(kind: Provedor, status: string, conectada: boolean): string {
  const who = QUEM[kind].nome;
  switch (status) {
    case 'conectado': return `Conta ${who} conectada.`;
    case 'parcial': return `Conta ${who} conectada, mas a autorização do Teams não terminou: enviar e-mail e criar arquivos já funcionam. Veja abaixo o que falta.`;
    case 'sem-leitura': return `Conta ${who} conectada. A leitura (e-mail, agenda, arquivos, tarefas e conversas) não foi liberada: numa empresa, ela costuma precisar da aprovação do administrador. Veja abaixo como pedir.`;
    case 'sem-canais': return 'A leitura dos canais do Teams não foi liberada: ela sempre precisa da aprovação do administrador da empresa. Veja abaixo como pedir.';
    case 'admin-aprovou': return conectada ? 'A Microsoft registrou a aprovação do administrador. Para terminar, clique em "Autorizar agora", abaixo.' : APROVOU_SEM_CONTA;
    case 'admin-aprovou-base': return APROVOU_SEM_CONTA;
    case 'admin-recusou': return 'O administrador não aprovou o pedido. Se precisar, converse com ele e envie o link de novo.';
    // o pedido aprovado não era deste Ergon (por exemplo, quem aprovou também usa o Ergon neste computador)
    case 'admin-aprovou-outro': return 'A Microsoft registrou a aprovação. Quem pediu já pode entrar de novo com a conta Microsoft no Ergon.';
    case 'admin-recusou-outro': return 'A Microsoft registrou que o pedido não foi aprovado. Avise quem pediu.';
    case 'admin-base': return 'A sua empresa não deixa autorizar o Ergon sem o administrador. Veja abaixo como pedir a aprovação.';
    case 'recusado': return `Login ${QUEM[kind].cujo} cancelado.`;
    default: return `Não deu para concluir o login ${QUEM[kind].cujo}. Tente de novo.`;
  }
}

/** O que a mensagem pronta ao administrador diz que ele aprova: o mesmo que o link de cada etapa pede (sso.ts). */
export function oQuePedirAoAdministrador(etapa: EtapaConsentimento['id']): string {
  if (etapa === 'canais') return 'ler as mensagens dos canais do Teams';
  // o primeiro acesso já bloqueado pela empresa: o link pede tudo de uma vez (envio, escrita, leitura e Teams)
  if (etapa === 'base') return 'enviar e ler e-mail, ver a agenda, criar e ler arquivos, organizar tarefas e mandar e ler mensagens no Teams';
  return 'ler e-mail, agenda, arquivos, tarefas e conversas do Teams';
}

/**
 * O próximo passo de uma conexão de tarefas. Na Microsoft, escolher o plano ou a lista depende da leitura (Tasks.ReadWrite é
 * dela): antes de liberada, o cartão diz isso em vez de mandar a pessoa a uma escolha que falharia. link: Tarefas já serve.
 */
export function proximoPassoTarefas(kind: string, etapas: EtapaConsentimento[]): { texto: string; link: boolean } {
  const leitura = kind === 'microsoft' ? etapas.find((e) => e.id === 'leitura') : undefined;
  if (leitura && leitura.estado !== 'ok') return { texto: 'Depois de liberar a leitura, escolha a lista ou o quadro em Tarefas.', link: false };
  return { texto: 'Próximo passo: em Tarefas, escolha a lista ou o quadro. Dar check ou mover por lá reflete aqui e vice-versa.', link: true };
}

/** Enquanto a equipe é atualizada para a versão nova (a conta de IA fica fora por alguns minutos). */
export const FRASE_RENOVANDO = 'Atualizando a equipe para a versão nova… os pedidos esperam e seguem sozinhos.';

/** peças por dentro do Ergon e erros de rede: não dizem nada à pessoa (ficam no registro e no diagnóstico) */
const JARGAO = /\bmotor(?:es)?\b|\bgerente\b|ponte de controle|cont[eê]iner|\bpodman\b|\bdocker\b|\bimagem\b|respondeu \d{3}|fetch failed|\b\d{1,3}(?:\.\d{1,3}){3}\b|\bsocket\b|\btimeout\b/i;
/** códigos de erro do sistema (ECONNREFUSED, ETIMEDOUT…): em maiúsculas, para não pegar palavras como "está" (sem /i) */
const ERRO_DE_REDE = /\bE[A-Z]{4,}\b/;

/** O motivo de uma demora, só se ele for dito para a pessoa; com peça interna (motor, gerente, endereço…), nada. */
export function semJargao(texto: string | null | undefined): string | null {
  const t = (texto ?? '').trim();
  return t && !JARGAO.test(t) && !ERRO_DE_REDE.test(t) ? t : null;
}

export const tamanho = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(1).replace('.', ',')} GB` : b >= 1024 ** 2 ? `${Math.round(b / 1024 ** 2)} MB` : 'menos de 1 MB');
/** No Windows o Ergon roda num ambiente próprio: o espaço sai de dentro dele (o disco do Windows não encolhe na hora). */
export const ondeLibera = (noWindows: boolean) => (noWindows ? ' (espaço liberado dentro do ambiente do Ergon)' : '');
/** o que saiu, sem inventar número quando não deu para medir */
const saiu = (liberado: number | null, noWindows: boolean) => (liberado === null ? `Espaço liberado${noWindows ? ' dentro do ambiente do Ergon' : ''}` : `${tamanho(liberado)} liberados${ondeLibera(noWindows)}`);

/** O resultado de "Liberar espaço" (Saúde). */
export function textoDoLiberado(r: { liberado: number | null; removidas: number }, noWindows: boolean): string {
  return r.removidas ? `${saiu(r.liberado, noWindows)}: ${r.removidas} versão(ões) antiga(s) da equipe apagada(s). Nenhum dado seu foi apagado.` : 'Nada para liberar agora: as versões antigas já tinham saído.';
}

/** A última limpeza, enquanto não há resultado novo na tela. */
export function textoUltimaLimpeza(u: { at: string; liberado: number | null; removidas: number }, noWindows: boolean): string {
  return `Última limpeza das versões antigas da equipe (${new Date(u.at).toLocaleDateString('pt-BR')}): ${u.removidas ? saiu(u.liberado, noWindows) : 'nada para liberar'}.`;
}

/** A pergunta antes de liberar espaço. */
export function textoConfirmarLiberar(noWindows: boolean): string {
  return `Apaga as versões antigas da equipe que já não estão em uso${ondeLibera(noWindows)}. Nenhum dado seu é apagado: conversas, arquivos, contas e cofres ficam como estão.`;
}

/** De quem é um cofre sem conta, para "Cofre de …": sem repetir "cofre de" e com "uma conta" (aceita o texto antigo do servidor). */
export function rotuloDoCofre(conta: string): string {
  const t = conta.trim().replace(/^cofre de\s+/i, '');
  return /^conta\b/i.test(t) ? `uma ${t}` : t;
}

/** O card em falha: o motivo (a entrega honesta diz o que não foi feito) e o que a pessoa pode fazer. */
export function motivoDaFalha(justificativa: string | null | undefined): string {
  const j = (justificativa ?? '').trim();
  return `${j || 'Não deu certo.'} Use "Tentar de novo" ou devolva com uma instrução.`;
}
