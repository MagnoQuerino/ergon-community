/**
 * Conversar com a equipe pelo Teams: os textos da tela que dependem do que o servidor diz (a conferência da conta do
 * Teams na prévia da ligação e os problemas da conexão). Ficam aqui, sem React, para os testes. Os textos vêm do
 * dicionário (área "conexoes", chaves teams.*), no idioma de quem está na tela.
 */
import { t } from '../i18n/index.ts';

/** De quem é a conta do Teams que pediu o código (servidor: services/teams-app, ContaDoTeams). */
export type ContaDoTeams = 'sua' | 'outra_pessoa' | 'organizacao' | 'outra_organizacao' | 'sem_conferir';

/** O nome mostrado não prova nada: é a própria conta do Teams que o escolhe. */
export const nomeEscolhido = () => t('conexoes.teams.nomeEscolhido');
/** O golpe do "suporte": alguém manda o código da conta DELE para a pessoa digitar aqui. */
export const soOSeuCodigo = () => t('conexoes.teams.soOSeuCodigo');
/** A escolha consciente, quando a conta não foi conferida como a da pessoa. */
export const escolhaConsciente = () => t('conexoes.teams.escolhaConsciente');

export interface Previa { pergunta: string; aviso: string | null; forte: boolean; exigeEscolha: boolean }

/**
 * O que a prévia mostra para cada caso (contrato 12.1). Só a conta conferida como a dela dispensa a escolha consciente; a
 * de outra organização (ou sem como conferir) vem com o aviso forte.
 */
export function previaDaConta(conta: ContaDoTeams | undefined, nome: string, organizacao: string | null | undefined): Previa {
  const org = organizacao ? t('conexoes.teams.previa.org', { org: organizacao }) : '';
  switch (conta) {
    case 'sua':
      return { pergunta: t('conexoes.teams.previa.sua', { nome }), aviso: null, forte: false, exigeEscolha: false };
    case 'outra_pessoa':
      return { pergunta: t('conexoes.teams.previa.ligar', { nome }), forte: true, exigeEscolha: true,
        aviso: t('conexoes.teams.previa.outraPessoa', { org }) };
    case 'organizacao':
      return { pergunta: t('conexoes.teams.previa.ligarDaOrganizacao', { nome, org }), forte: false, exigeEscolha: true,
        aviso: t('conexoes.teams.previa.organizacao') };
    case 'outra_organizacao':
      return { pergunta: t('conexoes.teams.previa.ligar', { nome }), forte: true, exigeEscolha: true,
        aviso: t('conexoes.teams.previa.outraOrganizacao') };
    default:
      return { pergunta: t('conexoes.teams.previa.ligar', { nome }), forte: true, exigeEscolha: true,
        aviso: t('conexoes.teams.previa.semConferir') };
  }
}

/** Problemas da conexão com o serviço do Teams, sem jargão (servidor: Problema): o código que vem dele → a chave do texto. */
const PROBLEMA_TEAMS = {
  revogada: 'conexoes.teams.problema.revogada',
  versao: 'conexoes.teams.problema.versao',
  substituida: 'conexoes.teams.problema.substituida',
  assinatura: 'conexoes.teams.problema.assinatura',
  registro: 'conexoes.teams.problema.registro',
  religar: 'conexoes.teams.problema.religar',
} as const;
/** Os códigos de problema que a tela sabe explicar. */
export const PROBLEMAS_DO_TEAMS = Object.keys(PROBLEMA_TEAMS) as ReadonlyArray<keyof typeof PROBLEMA_TEAMS>;
const ehProblema = (p: string | undefined): p is keyof typeof PROBLEMA_TEAMS => !!p && Object.prototype.hasOwnProperty.call(PROBLEMA_TEAMS, p);

/** O aviso de um problema conhecido, no idioma da tela; problema que a tela não conhece: nada. */
export function problemaDoTeams(problema: string | undefined): string | null {
  return ehProblema(problema) ? t(PROBLEMA_TEAMS[problema]) : null;
}

/** A linha do estado: com um problema conhecido, ele explica; sem conexão por um instante, os pedidos esperam. */
export function linhaDoEstado(conexao: 'connected' | 'connecting' | 'offline', problema: string | undefined): string | null {
  if (ehProblema(problema)) return null; // o aviso do problema já diz o que acontece
  return conexao === 'connected' ? t('conexoes.teams.estado.conectado') : t('conexoes.teams.estado.offline');
}
