/**
 * Conversar com a equipe pelo Teams: os textos da tela que dependem do que o servidor diz (a conferência da conta do
 * Teams na prévia da ligação e os problemas da conexão). Ficam aqui, sem React, para os testes.
 */

/** De quem é a conta do Teams que pediu o código (servidor: services/teams-app, ContaDoTeams). */
export type ContaDoTeams = 'sua' | 'outra_pessoa' | 'organizacao' | 'outra_organizacao' | 'sem_conferir';

/** O nome mostrado não prova nada: é a própria conta do Teams que o escolhe. */
export const NOME_ESCOLHIDO = 'O nome é o que a conta do Teams escolheu para si.';
/** O golpe do "suporte": alguém manda o código da conta DELE para a pessoa digitar aqui. */
export const SO_O_SEU_CODIGO = 'Só digite um código que apareceu agora no SEU Teams, na sua conversa com o app. Ninguém do suporte pede este código.';
/** A escolha consciente, quando a conta não foi conferida como a da pessoa. */
export const ESCOLHA_CONSCIENTE = 'Fui eu que pedi este código agora, no meu próprio Teams.';

export interface Previa { pergunta: string; aviso: string | null; forte: boolean; exigeEscolha: boolean }

/**
 * O que a prévia mostra para cada caso (contrato 12.1). Só a conta conferida como a dela dispensa a escolha consciente; a
 * de outra organização (ou sem como conferir) vem com o aviso forte.
 */
export function previaDaConta(conta: ContaDoTeams | undefined, nome: string, organizacao: string | null | undefined): Previa {
  const org = organizacao ? ` (${organizacao})` : '';
  switch (conta) {
    case 'sua':
      return { pergunta: `Ligar a sua conta do Teams (${nome})?`, aviso: null, forte: false, exigeEscolha: false };
    case 'outra_pessoa':
      return { pergunta: `Ligar a conta do Teams "${nome}"?`, forte: true, exigeEscolha: true,
        aviso: `Esta conta do Teams é de OUTRA PESSOA da sua organização${org}, não da sua conta Microsoft ligada a este Ergon. Só continue se foi você que pediu o código no seu próprio Teams.` };
    case 'organizacao':
      return { pergunta: `Ligar a conta do Teams "${nome}", da sua organização${org}?`, forte: false, exigeEscolha: true,
        aviso: 'Não dá para conferir se esta conta do Teams é a sua (a conta Microsoft foi ligada a este Ergon antes desta conferência; ligue de novo em Conexões para conferir). Só continue se foi você que pediu o código no seu próprio Teams.' };
    case 'outra_organizacao':
      return { pergunta: `Ligar a conta do Teams "${nome}"?`, forte: true, exigeEscolha: true,
        aviso: 'Esta conta do Teams é de OUTRA ORGANIZAÇÃO, não da sua conta Microsoft ligada a este Ergon. Só continue se foi você que pediu o código no seu próprio Teams.' };
    default:
      return { pergunta: `Ligar a conta do Teams "${nome}"?`, forte: true, exigeEscolha: true,
        aviso: 'Não dá para conferir de quem é esta conta do Teams porque a sua conta Microsoft não está ligada a este Ergon. Só continue se foi você que pediu o código no seu próprio Teams.' };
  }
}

/** Problemas da conexão com o serviço do Teams, sem jargão (servidor: Problema). */
export const PROBLEMA_TEAMS: Record<string, string> = {
  revogada: 'Este Ergon foi desligado do serviço do Teams.',
  versao: 'Atualize o Ergon para usar o Teams.',
  substituida: 'Outro Ergon aberto com estes mesmos dados está usando a conversa pelo Teams agora.',
  assinatura: 'O serviço do Teams não aceitou este Ergon agora. Uma nova tentativa acontece sozinha em 10 minutos; se continuar, confira se a data e a hora deste computador estão certas.',
  registro: 'Não deu para ligar este Ergon ao serviço do Teams agora. Novas tentativas acontecem sozinhas, com intervalos cada vez maiores; se continuar, confira se a data e a hora deste computador estão certas.',
  religar: 'O serviço do Teams foi reiniciado e as contas ligadas foram desfeitas. Para ligar de novo, mande uma mensagem ao app no Teams e digite o código abaixo.',
};

/** A linha do estado: com um problema conhecido, ele explica; sem conexão por um instante, os pedidos esperam. */
export function linhaDoEstado(conexao: 'connected' | 'connecting' | 'offline', problema: string | undefined): string | null {
  if (problema && PROBLEMA_TEAMS[problema]) return null; // o aviso do problema já diz o que acontece
  return conexao === 'connected' ? 'Conectado.' : 'Sem conexão agora. Os pedidos ficam guardados por até 7 dias e chegam quando a conexão voltar.';
}
