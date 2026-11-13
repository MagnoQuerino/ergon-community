/**
 * Os conectores por dados. Para acrescentar um aplicativo: escreva a definição num arquivo desta pasta e ponha aqui.
 * Ele aparece em Conexões, os agentes passam a usá-lo e o ajuste de cada ação vale sem mais nada.
 * EXTRAS são ações a mais de aplicativos que já têm tarefas (GitHub, Notion), com a mesma credencial deles.
 */
import { ASAAS } from './asaas.ts';
import { CALENDLY } from './calendly.ts';
import { CONFLUENCE } from './confluence.ts';
import { DISCORD } from './discord.ts';
import { GITHUB_EXTRAS } from './extras-github.ts';
import { NOTION_EXTRAS } from './extras-notion.ts';
import { FRESHDESK } from './freshdesk.ts';
import { GITLAB } from './gitlab.ts';
import { GOHIGHLEVEL } from './gohighlevel.ts';
import { HUBSPOT } from './hubspot.ts';
import { INTERCOM } from './intercom.ts';
import { KOMMO } from './kommo.ts';
import { MATTERMOST } from './mattermost.ts';
import { OMIE } from './omie.ts';
import { PIPEDRIVE } from './pipedrive.ts';
import { RDSTATION } from './rdstation.ts';
import { ROCKETCHAT } from './rocketchat.ts';
import { SLACK } from './slack.ts';
import { TELEGRAM } from './telegram.ts';
import { ZENDESK } from './zendesk.ts';
import { acaoDe, contaDoConector, httpDoConector, type ConectorDef, type Credenciais } from './declarativo.ts';
import type { Acao, Http } from '../tipos.ts';
import type { ContaConferida } from '../../task-providers.ts';

// a ordem é a da tela, dentro de cada grupo: os mais conhecidos no Brasil primeiro
export const CONECTORES: ConectorDef[] = [
  SLACK, DISCORD, TELEGRAM, MATTERMOST, ROCKETCHAT,
  HUBSPOT, RDSTATION, PIPEDRIVE, KOMMO, GOHIGHLEVEL, ZENDESK, FRESHDESK, INTERCOM,
  CONFLUENCE, GITLAB, CALENDLY,
  OMIE, ASAAS,
];
const EXTRAS: ConectorDef[] = [GITHUB_EXTRAS, NOTION_EXTRAS];

export const conectorDe = (kind: string): ConectorDef | undefined => CONECTORES.find((c) => c.kind === kind) ?? EXTRAS.find((c) => c.kind === kind);
export const acoesDoConector = (kind: string): Acao[] => (conectorDe(kind)?.acoes ?? []).map(acaoDe);
export const httpDoConectorDe = (kind: string, c: Credenciais): Http => httpDoConector(conectorDe(kind)!, c);
export const conferir = (kind: string, c: Credenciais): Promise<ContaConferida> => contaDoConector(conectorDe(kind)!, c);
