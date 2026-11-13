/**
 * Integrações da conta do usuário: Microsoft 365 e Google (login com a conta — SSO parametrizado em sso.ts:
 * Planner, To Do, Teams; Google Tasks), WhatsApp (QR) e os aplicativos de tarefas e quadros por
 * token pessoal (Asana, Todoist e os de task-providers.ts). A escrita fica em conexoes/. "Conectado" só depois de uma chamada real aceita pelo
 * serviço. Os que ainda dependem de registrar o app do Ergon no fornecedor aparecem como "em breve", sem fingir.
 * Tokens nunca vão para o banco, o navegador ou o log: ficam em /data/secrets (volume de dados, 0600).
 * As listas ligadas trazem título, descrição, situação (concluída ou não), prazo e responsável, e o que muda aqui volta ao
 * aplicativo (conexoes/espelho.ts).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../config.ts';
import type { Db } from '../db/db.ts';
import { HttpError, fold, id, now } from '../lib/util.ts';
import { audit, type Bus } from './bus.ts';
import { ProviderError, type BoardSnapshot, type ExternalBoard, type TaskProvider } from './mirror.ts';
import { SSO, STATE_TTL, SsoAuth, isSso, type Etapa, type SsoKind } from './sso.ts';
import { FieldCipher } from '../security/fields.ts';
import { dueAt, dueOf } from './due.ts';
import { CONECTORES, conferir } from './conexoes/conectores/index.ts';
import type { AjudaExtra } from './conexoes/conectores/declarativo.ts';
import { htmlParaTexto } from './conexoes/texto.ts';
import { ErroAcao } from './conexoes/tipos.ts';
import { workspaceTz } from './routine-proposals.ts';
import {
  AirtableProvider, ClickUpProvider, GitHubProjectsProvider, JiraProvider, LinearProvider, MondayProvider, NotionProvider, PipefyProvider,
  PIPEFY_TOKEN_URL, SmartsheetProvider, TrelloProvider, contaConferida, enderecoTokenPipefy, jiraHost, pipefyAntigo, request, type AccountProvider, type ContaConferida,
} from './task-providers.ts';

export type IntegrationKind =
  | 'microsoft' | 'google' | 'whatsapp' | 'asana' | 'todoist' | 'trello' | 'jira' | 'clickup' | 'monday' | 'notion' | 'linear'
  | 'airtable' | 'smartsheet' | 'pipefy' | 'github' | 'bitrix'
  // conectores por dados (conexoes/conectores) e os ainda em preparo
  | 'slack' | 'discord' | 'telegram' | 'mattermost' | 'rocketchat' | 'hubspot' | 'pipedrive' | 'rdstation' | 'kommo' | 'gohighlevel' | 'zendesk' | 'freshdesk' | 'intercom'
  | 'confluence' | 'gitlab' | 'calendly' | 'asaas' | 'omie' | 'zoom' | 'googlechat' | 'salesforce' | 'dropbox';
/** Campo de credencial pedido na tela (o valor nunca volta ao navegador). */
export interface CredentialField { name: string; label: string; secret?: boolean; placeholder?: string; pattern?: RegExp; patternHelp?: string; opcional?: boolean }
export interface IntegrationDef {
  kind: IntegrationKind; name: string;
  /** oauth: login com a conta · qr: WhatsApp · token: credencial colada · soon: ainda não (motivo em "soon") */
  auth: 'oauth' | 'qr' | 'token' | 'soon';
  group: 'contas' | 'tarefas' | 'conversas' | 'vendas' | 'suporte' | 'documentos' | 'financeiro'; about: string; tasks: boolean; site: string;
  /** antes: o que a pessoa precisa saber antes de começar, no alto da tela de conectar, à vista (ex.: quem pode criar a credencial) */
  fields?: CredentialField[]; help?: { url: string; steps: string; antes?: string; extras?: AjudaExtra[] }; soon?: string;
  /** conectou do jeito que o serviço deixou de recomendar: continua valendo, e a tela avisa para reconectar do novo jeito */
  credencialAntiga?: { antiga: (c: Record<string, string>) => boolean; aviso: string };
  /** a conexão nova começa em "Só leitura" (ConectorDef.comecaSoLeitura): os agentes só consultam até a pessoa liberar a escrita */
  comecaSoLeitura?: boolean;
}

const TOKEN: CredentialField[] = [{ name: 'token', label: 'Token', secret: true, placeholder: 'Cole o token aqui' }];
/** na credencial guardada: o id da conta no serviço, de quando ela foi conferida (ver connectToken) */
export const CONTA_ID = 'conta_id';

/**
 * Catálogo de conexões. Escolha dos aplicativos de tarefas (pesquisa de out/2026): os líderes de mercado com API
 * própria e os mais conhecidos no Brasil. A ordem da lista é a de fama no Brasil (estimativa, sem dado auditado):
 * Trello, Notion, Asana, monday.com, ClickUp, Jira, Pipefy, Todoist, Bitrix24, Airtable, GitHub Projects,
 * Smartsheet, Linear. Fora: os pouco conhecidos aqui (TickTick, Wrike, Basecamp, Zoho, Runrun.it) e os sem API
 * pública (Things, Any.do).
 */
export const INTEGRATIONS: IntegrationDef[] = [
  { kind: 'microsoft', name: 'Microsoft 365', auth: 'oauth', group: 'contas', tasks: true, site: 'microsoft.com',
    about: 'Entre com a sua conta Microsoft (trabalho ou pessoal). Os agentes consultam e agem em tarefas (Planner e To Do), e-mail, agenda, arquivos e, em conta de trabalho, Teams.' },
  { kind: 'google', name: 'Google', auth: 'oauth', group: 'contas', tasks: true, site: 'google.com',
    about: 'Entre com a sua conta Google (Gmail ou Workspace). Os agentes consultam e agem em tarefas (Google Tasks), Gmail, Agenda e Drive.' },
  { kind: 'whatsapp', name: 'WhatsApp', auth: 'qr', group: 'conversas', tasks: false, site: 'whatsapp.com',
    about: 'Leia o QR code com o WhatsApp do celular (Aparelhos conectados). Só as conversas que você permitir são lidas; mensagem só sai quando você pede ou confirma, a menos que você ligue "Liberar tudo".' },
  { kind: 'trello', name: 'Trello', auth: 'token', group: 'tarefas', tasks: true, site: 'trello.com',
    about: 'Quadros do Trello: listas viram colunas; cartões, tarefas.',
    fields: [
      { name: 'key', label: 'Chave da API', placeholder: '32 caracteres', pattern: /^[a-f0-9]{32}$/i, patternHelp: 'a chave tem 32 letras e números' },
      { name: 'token', label: 'Token', secret: true, placeholder: 'Cole o token aqui' },
    ],
    help: { url: 'https://trello.com/power-ups/admin', steps: 'No Trello: Power-Ups e integrações › Admin › "Novo" (qualquer nome) › "Gerar uma nova chave de API". Na mesma página, clique em "Token" ao lado da chave, autorize leitura e escrita e copie o token.' } },
  { kind: 'notion', name: 'Notion', auth: 'token', group: 'tarefas', tasks: true, site: 'notion.so', fields: TOKEN,
    about: 'Bancos de dados do Notion: a propriedade de status vira colunas. Os agentes também procuram, leem e escrevem páginas. O Notion só mostra ao Ergon o que você compartilhar com a conexão.',
    help: { url: 'https://app.notion.com/developers/connections', steps: 'No portal de desenvolvedores do Notion: Internal connections › Create a new connection, com as capacidades de ler, atualizar e inserir conteúdo › copie o token. Depois, em cada banco de tarefas e em cada página que os agentes podem usar: ••• › Conexões › adicione a conexão. Cole o token aqui.' } },
  { kind: 'asana', name: 'Asana', auth: 'token', group: 'tarefas', tasks: true, site: 'asana.com', fields: TOKEN,
    about: 'Projetos do Asana: seções viram colunas.',
    help: { url: 'https://app.asana.com/0/my-apps', steps: 'No Asana: Meu perfil › Apps › Console do desenvolvedor › "Criar token de acesso pessoal". Copie e cole aqui.' } },
  { kind: 'monday', name: 'monday.com', auth: 'token', group: 'tarefas', tasks: true, site: 'monday.com', fields: TOKEN,
    about: 'Quadros do monday.com: grupos viram colunas; a coluna de status diz o que está feito.',
    help: { url: 'https://auth.monday.com/users/sign_in', steps: 'No monday.com: sua foto › Developers › "Meus tokens de acesso" › "Mostrar" e copiar. Cole aqui. O token tem as permissões da sua conta: para escrever num quadro, você precisa poder editá-lo.' } },
  { kind: 'clickup', name: 'ClickUp', auth: 'token', group: 'tarefas', tasks: true, site: 'clickup.com', fields: TOKEN,
    about: 'Listas do ClickUp: as situações da lista viram colunas.',
    help: { url: 'https://app.clickup.com/settings/apps', steps: 'No ClickUp: Configurações › Apps › "Gerar" o token de API pessoal (começa com pk_). Copie e cole aqui.' } },
  { kind: 'jira', name: 'Jira', auth: 'token', group: 'tarefas', tasks: true, site: 'atlassian.com',
    about: 'Projetos do Jira Cloud: situações viram colunas; issues, tarefas.',
    fields: [
      { name: 'site', label: 'Endereço do Jira', placeholder: 'sua-empresa.atlassian.net' },
      { name: 'email', label: 'E-mail da sua conta Atlassian', placeholder: 'voce@empresa.com', pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, patternHelp: 'e-mail inválido' },
      { name: 'token', label: 'Token de API', secret: true, placeholder: 'Cole o token aqui' },
    ],
    help: { url: 'https://id.atlassian.com/manage-profile/security/api-tokens', steps: 'Na sua conta Atlassian: Segurança › "Criar token de API" (o botão sem escopos; token com escopos não funciona aqui). Copie e cole aqui, com o endereço do seu Jira e o e-mail da conta. O que dá para fazer segue as permissões da sua conta em cada projeto.' } },
  // conta de serviço, o jeito que o Pipefy recomenda hoje (task-providers.ts, CredPipefy). Quem conectou com o token pessoal
  // (obsoleto) continua funcionando, com o aviso de reconectar (credencialAntiga)
  { kind: 'pipefy', name: 'Pipefy', auth: 'token', group: 'tarefas', tasks: true, site: 'pipefy.com',
    fields: [
      { name: 'client_id', label: 'Client ID', placeholder: 'Cole o Client ID da conta de serviço' },
      { name: 'client_secret', label: 'Client Secret', secret: true, placeholder: 'Cole o Client Secret da conta de serviço' },
      { name: 'token_url', label: 'Endereço do "Token endpoint" (só se o Pipefy mostrar outro)', placeholder: PIPEFY_TOKEN_URL, opcional: true },
    ],
    about: 'Pipes do Pipefy: fases viram colunas; cards, tarefas.',
    help: {
      url: 'https://app.pipefy.com/',
      antes: 'Antes de começar: a conta de serviço só pode ser criada pelo administrador principal da empresa no Pipefy (o Super Admin). Se não for você, peça a ele que crie e lhe passe o Client ID e o Client Secret.',
      steps: 'O Pipefy pede uma conta de serviço (o código de acesso pessoal ficou obsoleto). Quem cria é o Super Admin: clique no nome da empresa ou na sua foto, no alto, abra "Membros e permissões" (Members and Permissions), vá até a aba "Contas de serviço" (Service Accounts) e clique em "Criar conta de serviço". Dê um nome, como Ergon, escolha um papel que possa editar os pipes e a validade do acesso (pode ser a maior, 30 dias: a renovação é automática). Depois clique na conta criada e copie Client ID e Client Secret para cá. A conta de serviço vê os pipes que o papel dela permite; se um pipe não aparecer, adicione-a como membro desse pipe.',
      extras: [{ rotulo: 'Ajuda do Pipefy sobre contas de serviço', url: 'https://help.pipefy.com/en/articles/9027789-service-accounts' }],
    },
    credencialAntiga: { antiga: pipefyAntigo, aviso: 'Esta conexão usa o código de acesso pessoal, que o Pipefy marcou como obsoleto. Ela continua funcionando enquanto o Pipefy aceitar, mas reconecte do novo jeito, com uma conta de serviço, para não parar de repente.' } },
  { kind: 'todoist', name: 'Todoist', auth: 'token', group: 'tarefas', tasks: true, site: 'todoist.com', fields: TOKEN,
    about: 'Projetos do Todoist: seções viram colunas.',
    help: { url: 'https://app.todoist.com/app/settings/integrations/developer', steps: 'No Todoist: Configurações › Integrações › Desenvolvedor › "Token da API". Copie e cole aqui. Não use "Emitir novo token": isso desconecta a conta em todos os aparelhos.' } },
  { kind: 'bitrix', name: 'Bitrix24', auth: 'soon', group: 'tarefas', tasks: true, site: 'bitrix24.com.br', about: 'Tarefas e projetos do Bitrix24.', soon: 'Em preparo.' },
  { kind: 'airtable', name: 'Airtable', auth: 'token', group: 'tarefas', tasks: true, site: 'airtable.com', fields: TOKEN,
    about: 'Tabelas do Airtable: um campo de seleção de status vira colunas.',
    help: { url: 'https://airtable.com/create/tokens', steps: 'No Airtable: Developer hub › "Criar token" com os escopos data.records:read, data.records:write, data.recordComments:write e schema.bases:read, e acesso às bases de tarefas. Você precisa poder editar a base. Copie e cole aqui.' } },
  { kind: 'github', name: 'GitHub Projects', auth: 'token', group: 'tarefas', tasks: true, site: 'github.com', fields: TOKEN,
    about: 'Projetos do GitHub (Projects): o campo Status vira colunas; issues, pull requests e rascunhos viram tarefas. Os agentes também consultam repositórios, abrem issues e comentam.',
    help: { url: 'https://github.com/settings/tokens', steps: 'No GitHub: Settings › Developer settings › Personal access tokens › Tokens (classic) › token com os escopos project, read:org e repo (repo para editar, reabrir ou comentar issues e pull requests e para os agentes consultarem repositórios). Copie e cole aqui.' } },
  { kind: 'smartsheet', name: 'Smartsheet', auth: 'token', group: 'tarefas', tasks: true, site: 'smartsheet.com', fields: TOKEN,
    about: 'Planilhas do Smartsheet: uma coluna de lista "Status" vira colunas; a coluna principal é o título.',
    help: { url: 'https://app.smartsheet.com/b/home', steps: 'No Smartsheet: ícone de Conta › Configurações pessoais › Acesso à API › "Gerar novo token de acesso". O token escreve nas planilhas em que você pode editar. Copie e cole aqui.' } },
  { kind: 'linear', name: 'Linear', auth: 'token', group: 'tarefas', tasks: true, site: 'linear.app', fields: TOKEN,
    about: 'Times do Linear: os estados do fluxo viram colunas; issues, tarefas.',
    help: { url: 'https://linear.app/settings/account/security', steps: 'No Linear: Configurações › Segurança e acesso › "Nova chave de API", com acesso total ou de leitura e escrita. Copie e cole aqui.' } },
];
/** Os aplicativos que entram por dados (leitura e escrita parametrizadas em conexoes/conectores) e os ainda em preparo. */
INTEGRATIONS.push(
  ...CONECTORES.map((c): IntegrationDef => ({ kind: c.kind as IntegrationKind, name: c.nome, auth: 'token', group: c.grupo, tasks: false, site: c.site, about: c.sobre, fields: c.campos, help: { url: c.ajuda.url, steps: c.ajuda.passos, ...(c.ajuda.extras ? { extras: c.ajuda.extras } : {}) }, ...(c.comecaSoLeitura ? { comecaSoLeitura: true } : {}) })),
  { kind: 'zoom', name: 'Zoom', auth: 'soon', group: 'conversas', tasks: false, site: 'zoom.us', about: 'Reuniões e gravações do Zoom.', soon: 'Em preparo: pede o registro de um aplicativo no Zoom.' },
  { kind: 'googlechat', name: 'Google Chat', auth: 'soon', group: 'conversas', tasks: false, site: 'chat.google.com', about: 'Espaços e mensagens do Google Chat.', soon: 'Em preparo: junto com a verificação do Google.' },
  { kind: 'salesforce', name: 'Salesforce', auth: 'soon', group: 'vendas', tasks: false, site: 'salesforce.com', about: 'Contas, contatos e oportunidades do Salesforce.', soon: 'Em preparo: pede o registro de um aplicativo no Salesforce.' },
  { kind: 'dropbox', name: 'Dropbox', auth: 'soon', group: 'documentos', tasks: false, site: 'dropbox.com', about: 'Arquivos do Dropbox.', soon: 'Em preparo: pede login com a conta, como Microsoft e Google.' },
);
export const integrationDef = (k: string) => INTEGRATIONS.find((i) => i.kind === k);
/** tipos que conectam por credencial colada e leem tarefas */
export const TOKEN_KINDS = INTEGRATIONS.filter((d) => d.auth === 'token').map((d) => d.kind);
export const TASK_KINDS = INTEGRATIONS.filter((d) => d.tasks && d.auth !== 'soon').map((d) => d.kind);

// ---------------------------------------------------------------- segredos (arquivo por workspace/integração)
/**
 * Credenciais em disco, cifradas com a chave do workspace quando o Ergon está protegido. Conta emprestada de outro
 * workspace: `read` e `write` seguem até lá (a renovação do acesso vale para todos); `readOwn` e `writeOwn` não seguem, e
 * são os que o login usa, para uma conta nova nunca sobrescrever a do workspace de origem.
 */
/** O id de uma conta além da principal: "c" + 8 letras e números (a principal é ''). */
export const CONTA_RE = /^c[a-f0-9]{8}$/;
export const novaContaId = (): string => `c${crypto.randomBytes(4).toString('hex')}`;
/** De onde vem a credencial de uma conta: o workspace e qual das contas de lá (emprestada de outro workspace). */
export interface OrigemDaCredencial { ws: string; conta: string }
export class SecretStore {
  private readonly dir: string;
  readonly cipher: () => FieldCipher | null;
  /** de qual workspace (e de qual das contas de lá) é a credencial desta conexão */
  origem: (workspaceId: string, kind: string, conta: string) => OrigemDaCredencial = (w, _k, c) => ({ ws: w, conta: c });
  constructor(dataDir: string, cipher: () => FieldCipher | null = () => null) { this.dir = path.join(dataDir, 'secrets'); this.cipher = cipher; }
  /** A principal (conta '') fica onde sempre ficou; as outras, ao lado, com o id da conta no nome. */
  private file(workspaceId: string, kind: string, conta = '') {
    if (!/^ws_[a-f0-9]{32}$/.test(workspaceId) || !/^[a-z]{3,20}$/.test(kind) || (conta !== '' && !CONTA_RE.test(conta))) throw new Error('chave de segredo inválida');
    return path.join(this.dir, `${workspaceId}-${kind}${conta ? `.${conta}` : ''}.json`);
  }
  read<T = Record<string, unknown>>(workspaceId: string, kind: string, conta = ''): T | null { const o = this.origem(workspaceId, kind, conta); return this.readOwn<T>(o.ws, kind, o.conta); }
  write(workspaceId: string, kind: string, data: unknown, conta = ''): void { const o = this.origem(workspaceId, kind, conta); this.writeOwn(o.ws, kind, data, o.conta); }
  readOwn<T = Record<string, unknown>>(workspaceId: string, kind: string, conta = ''): T | null {
    let raw: Buffer;
    try { raw = fs.readFileSync(this.file(workspaceId, kind, conta)); } catch { return null; }
    const c = this.cipher();
    if (FieldCipher.isSealedBytes(raw) && !c) return null; // cifrado e o Ergon trancado: não lê
    return JSON.parse((c ? c.openBytes(raw, `${kind}.json`) : raw).toString('utf8')) as T;
  }
  writeOwn(workspaceId: string, kind: string, data: unknown, conta = ''): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const f = this.file(workspaceId, kind, conta);
    const plain = Buffer.from(JSON.stringify(data), 'utf8');
    const c = this.cipher();
    fs.writeFileSync(`${f}.tmp`, c ? c.sealBytes(workspaceId, plain, `${kind}.json`) : plain, { mode: 0o600 });
    fs.renameSync(`${f}.tmp`, f);
  }
  remove(workspaceId: string, kind: string, conta = ''): void { try { fs.rmSync(this.file(workspaceId, kind, conta), { force: true }); } catch { /* já removido */ } }
  /** pasta própria (sessão do WhatsApp, vários arquivos): uma por conta, cada número com o seu pareamento */
  dirFor(workspaceId: string, kind: string, conta = ''): string {
    const d = this.file(workspaceId, kind, conta).replace(/\.json$/, '');
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    return d;
  }
  removeDir(workspaceId: string, kind: string, conta = ''): void { try { fs.rmSync(this.file(workspaceId, kind, conta).replace(/\.json$/, ''), { recursive: true, force: true }); } catch { /* já removida */ } }
  /**
   * Troca a credencial (e a pasta) de duas contas do mesmo aplicativo no mesmo workspace: é o que acontece ao escolher outra
   * principal. O rótulo da cifra é o mesmo para todas as contas do aplicativo, então o arquivo só muda de nome.
   */
  trocar(workspaceId: string, kind: string, a: string, b: string): void {
    const fa = this.file(workspaceId, kind, a); const fb = this.file(workspaceId, kind, b);
    for (const [x, y] of [[fa, fb], [fa.replace(/\.json$/, ''), fb.replace(/\.json$/, '')]]) {
      const temX = fs.existsSync(x); const temY = fs.existsSync(y);
      if (temX) fs.renameSync(x, `${x}.troca`);
      if (temY) fs.renameSync(y, x);
      if (temX) fs.renameSync(`${x}.troca`, y);
    }
  }
}

// ---------------------------------------------------------------- estado no banco
/**
 * Uma conta de um aplicativo neste workspace. `conta` '' é a principal (a que vale quando ninguém diz qual usar, e a única de
 * quem tem uma só); as outras têm id próprio (CONTA_RE). apelido: o nome que a pessoa deu; ativa: 0 = a pessoa desligou.
 */
export interface IntegrationRow { id: string; workspace_id: string; kind: IntegrationKind; conta: string; origem_workspace_id: string | null; origem_conta: string; state: 'off' | 'pending' | 'connected' | 'error'; account_label: string | null; apelido: string | null; ativa: number; settings: string; connected_at: string | null; last_sync_at: string | null; last_error: string | null; created_at: string }

/** A conta: a principal nasce quando falta (como sempre); outra conta que não existe é um erro (nasce só em Integrations.novaConta). */
export function integrationRow(db: Db, workspaceId: string, kind: IntegrationKind, conta = ''): IntegrationRow {
  let r = db.get<IntegrationRow>('SELECT * FROM integrations WHERE workspace_id = ? AND kind = ? AND conta = ?', workspaceId, kind, conta);
  if (!r) {
    if (conta !== '') throw new HttpError(404, 'conta', 'esta conta não existe mais neste workspace');
    db.run("INSERT INTO integrations (id, workspace_id, kind, conta, state, settings, created_at) VALUES (?, ?, ?, '', 'off', '{}', ?)", id('int'), workspaceId, kind, now());
    r = db.get<IntegrationRow>("SELECT * FROM integrations WHERE workspace_id = ? AND kind = ? AND conta = ''", workspaceId, kind)!;
  }
  return r;
}

export type PatchIntegracao = Partial<Pick<IntegrationRow, 'state' | 'account_label' | 'apelido' | 'last_error' | 'last_sync_at' | 'connected_at'>> & { settings?: Record<string, unknown>; ativa?: boolean };
export function setIntegration(db: Db, workspaceId: string, kind: IntegrationKind, patch: PatchIntegracao, conta = ''): void {
  integrationRow(db, workspaceId, kind, conta);
  const sets: string[] = []; const vals: Array<string | number | null> = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(k === 'settings' ? JSON.stringify(v) : k === 'ativa' ? (v ? 1 : 0) : k === 'account_label' || k === 'apelido' ? db.seal(workspaceId, v as string | null) : (v as string | null));
  }
  if (sets.length) db.run(`UPDATE integrations SET ${sets.join(', ')} WHERE workspace_id = ? AND kind = ? AND conta = ?`, ...vals, workspaceId, kind, conta);
}

/** Como a conta aparece para a pessoa e para os agentes: o apelido dela ou, sem apelido, o e-mail, o número ou o nome da conta. */
export const nomeDaConta = (r: Pick<IntegrationRow, 'apelido' | 'account_label'>): string => (r.apelido ?? '').trim() || (r.account_label ?? '').trim();
/** As contas de um aplicativo neste workspace: a principal primeiro, depois na ordem em que entraram. */
export function contasDe(db: Db, workspaceId: string, kind: string): IntegrationRow[] {
  return db.all<IntegrationRow>("SELECT * FROM integrations WHERE workspace_id = ? AND kind = ? ORDER BY CASE WHEN conta = '' THEN 0 ELSE 1 END, created_at, rowid", workspaceId, kind);
}
/** A conta (linha) pelo id, deste workspace: o que a ação, o quadro e a mensagem recebida guardam (estável quando a principal muda). */
export const contaPorId = (db: Db, workspaceId: string, integracaoId: string): IntegrationRow | null =>
  db.get<IntegrationRow>('SELECT * FROM integrations WHERE id = ? AND workspace_id = ?', integracaoId, workspaceId) ?? null;
/** As contas conectadas e ligadas pela pessoa, de todos os aplicativos ou de um. */
export function contasLigadas(db: Db, workspaceId: string, kinds?: readonly string[]): IntegrationRow[] {
  return db.all<IntegrationRow>("SELECT * FROM integrations WHERE workspace_id = ? AND state = 'connected' AND ativa = 1 ORDER BY kind, CASE WHEN conta = '' THEN 0 ELSE 1 END, created_at, rowid", workspaceId)
    .filter((r) => !kinds || kinds.includes(r.kind));
}

/**
 * Qual conta usar, pelo que foi dito (o apelido, o e-mail ou número, ou o id): sem dizer, a principal. Comparação sem acento
 * nem maiúscula; o apelido vale antes do nome da conta. Não achou, ou achou mais de uma: null (quem chama diz as opções).
 */
export type ContaQualquer = Pick<IntegrationRow, 'conta' | 'apelido' | 'account_label'>;
/**
 * O nome que distingue cada conta de um aplicativo: duas contas com o mesmo nome (o mesmo nome de conta, sem apelido)
 * viram "Ana" e "Ana (2)", na ordem de `todas` (contasDe: a principal primeiro). O agente vê esse nome e pode pedi-lo.
 */
export function nomeUnico<C extends ContaQualquer>(todas: readonly C[]): (c: ContaQualquer) => string {
  const base = (c: ContaQualquer) => nomeDaConta(c) || (c.conta ? c.conta : 'principal');
  const nomes = new Map<string, string>(); const vistos = new Map<string, number>();
  for (const c of todas) { const b = base(c); const k = fold(b); const n = (vistos.get(k) ?? 0) + 1; vistos.set(k, n); nomes.set(c.conta, n > 1 ? `${b} (${n})` : b); }
  return (c) => nomes.get(c.conta) ?? base(c);
}
export function acharConta<C extends ContaQualquer>(contas: readonly C[], pedido: string | null | undefined, nome: (c: ContaQualquer) => string = nomeUnico(contas)): C | null {
  const p = fold(String(pedido ?? '').trim());
  if (!p) return contas.find((c) => c.conta === '') ?? null;
  const exatas = (f: (c: C) => string) => contas.filter((c) => fold(f(c).trim()) === p);
  for (const f of [(c: C) => c.conta || 'principal', (c: C) => c.apelido ?? '', (c: C) => c.account_label ?? '', (c: C) => nome(c)]) {
    const a = exatas(f);
    if (a.length === 1) return a[0];
  }
  const parte = contas.filter((c) => p.length >= 3 && [c.apelido ?? '', c.account_label ?? ''].some((x) => fold(x).includes(p)));
  return parte.length === 1 ? parte[0] : null;
}

export const settingsOf = (r: IntegrationRow): Record<string, unknown> => { try { return JSON.parse(r.settings) as Record<string, unknown>; } catch { return {}; } };

// ---------------------------------------------------------------- Microsoft em etapas e o "conectando…"
/**
 * O que se sabe de cada etapa do consentimento da Microsoft além do que a conta deu (que mora na credencial): o login dela está
 * em andamento ("pedido", vale 10 minutos), voltou sem dar (ou não voltou: "bloqueado"), ou o administrador aprovou ("aprovado",
 * falta só a pessoa entrar de novo). Fica nas configurações da conexão, junto do `state` estável do link do administrador.
 */
export type EstadoEtapa = 'pedido' | 'bloqueado' | 'aprovado';
/**
 * admin: voltou dizendo que a empresa exige o administrador (no Teams também: a tela oferece o pedido, não "Tentar de novo").
 * herdada: a marca veio junto da etapa anterior que exigiu o administrador, sem esta ter sido pedida (o encadeamento ainda a tenta).
 */
export interface MarcaEtapa { estado: EstadoEtapa; em: string; erro?: string | null; admin?: boolean; herdada?: boolean }
/** baseBloqueada: o primeiro login voltou dizendo que a empresa exige o administrador (antes de haver conta conectada) */
export interface Consentimento { etapas?: Partial<Record<Etapa, MarcaEtapa>>; estadoAdmin?: string; baseBloqueada?: { em: string; erro: string | null } | null }
/** Códigos da Microsoft para "precisa do administrador" (reference-error-codes: 65001 DelegationDoesNotExist, 90094 AdminConsentRequired, 90095 AdminConsentRequiredRequestAccess). */
export const PRECISA_ADMINISTRADOR = /AADSTS(65001|90094|90095)\b/;
/** A volta do login diz que a empresa exige o administrador (e não que a pessoa recusou ou que algo falhou). */
export function exigeAdministrador(error: string | null | undefined, descricao?: string | null): boolean {
  const tudo = `${error ?? ''} ${descricao ?? ''}`;
  return PRECISA_ADMINISTRADOR.test(tudo) || /\b(consent_required|admin_policy_enforced)\b/.test(tudo);
}
/**
 * O motivo de um login que não terminou, em português, para gravar nas marcas das etapas e no last_error (a tela mostra):
 * nunca o erro cru da Microsoft ou do Google (inglês e código). Um código que não diz nada à pessoa fica só como
 * referência para o suporte; o erro cru inteiro vai para a evidência da auditoria.
 */
export function motivoDoProvedor(kind: 'microsoft' | 'google', error: string | null | undefined, descricao?: string | null): string {
  const tudo = `${error ?? ''} ${descricao ?? ''}`;
  const quem = kind === 'google' ? 'O Google' : 'A Microsoft';
  if (exigeAdministrador(error, descricao)) return 'A empresa exige a aprovação do administrador.';
  if (/AADSTS65004\b/.test(tudo) || error === 'access_denied') return 'A autorização foi recusada na página da conta.';
  if (!error && !descricao) return `${quem} não mandou resposta ao login. Tente de novo.`;
  const codigo = /\b(AADSTS\d+)\b/.exec(tudo)?.[1] ?? (error && /^[a-z][a-z_]{2,40}$/.test(error) ? error : null);
  return codigo ? `${quem} não concluiu a autorização (código ${codigo}, para o suporte).` : `${quem} não concluiu a autorização.`;
}
/** erro null: o login deu certo (a marca sai). */
export function marcarBaseBloqueada(db: Db, workspaceId: string, erro: string | null, conta = ''): void {
  const r = integrationRow(db, workspaceId, 'microsoft', conta);
  const c = consentimentoDe(r);
  if (erro === null && !c.baseBloqueada) return;
  setIntegration(db, workspaceId, 'microsoft', { settings: { ...settingsOf(r), consentimento: { ...c, baseBloqueada: erro === null ? null : { em: now(), erro } } } }, conta);
}
export const consentimentoDe = (r: IntegrationRow): Consentimento => {
  const c = settingsOf(r).consentimento;
  return c && typeof c === 'object' ? c as Consentimento : {};
};
export function marcarEtapa(db: Db, workspaceId: string, etapa: Etapa, marca: Omit<MarcaEtapa, 'em'> | null, conta = ''): void {
  const r = integrationRow(db, workspaceId, 'microsoft', conta);
  const c = consentimentoDe(r);
  const etapas = { ...(c.etapas ?? {}) };
  // pedir de novo uma etapa que a empresa só libera com o administrador não apaga isso: se a página da Microsoft não voltar, a
  // tela continua com o pedido ao administrador (e não "Tentar de novo")
  const admin = marca?.estado === 'pedido' && etapas[etapa]?.admin === true && marca.admin === undefined ? { admin: true } : {};
  if (marca) etapas[etapa] = { ...marca, ...admin, em: now() }; else delete etapas[etapa];
  setIntegration(db, workspaceId, 'microsoft', { settings: { ...settingsOf(r), consentimento: { ...c, etapas } } }, conta);
}
/** O `state` do link do administrador: um por workspace, guardado (o link pronto na tela não muda a cada leitura). */
export function estadoAdmin(db: Db, workspaceId: string): string {
  const r = integrationRow(db, workspaceId, 'microsoft');
  const c = consentimentoDe(r);
  if (c.estadoAdmin && /^[A-Za-z0-9_-]{20,64}$/.test(c.estadoAdmin)) return c.estadoAdmin;
  const novo = crypto.randomBytes(18).toString('base64url');
  setIntegration(db, workspaceId, 'microsoft', { settings: { ...settingsOf(r), consentimento: { ...c, estadoAdmin: novo } } });
  return novo;
}
/**
 * A etapa já foi pedida e voltou sem ser dada (ou a página da Microsoft não voltou em 10 minutos): o login encadeado não manda a
 * pessoa de novo a ela (sso.ts). O "aprovado" pelo administrador conta como não recusada: aí ela passa. A marca herdada (veio
 * junto de uma etapa anterior, sem esta ter sido pedida) também não conta.
 */
export function etapaJaRecusada(db: Db, workspaceId: string, etapa: Etapa, conta = ''): boolean {
  const m = consentimentoDe(integrationRow(db, workspaceId, 'microsoft', conta)).etapas?.[etapa];
  return (m?.estado === 'bloqueado' && m.herdada !== true) || (m?.estado === 'pedido' && Date.now() - Date.parse(m.em) > STATE_TTL);
}
/** De quem é um `state` de link do administrador (a volta da Microsoft não traz a sessão de ninguém). */
export function workspaceDoEstadoAdmin(db: Db, estado: string): string | null {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(estado)) return null;
  for (const r of db.all<IntegrationRow>("SELECT * FROM integrations WHERE kind = 'microsoft' AND conta = ''")) if (consentimentoDe(r).estadoAdmin === estado) return r.workspace_id;
  return null;
}
/**
 * "Conectando…": o login começou agora (o "conectando…" vence junto com o `state`, em 10 minutos). O estado de antes fica
 * guardado: um login abandonado volta a ele (uma conexão caída continua caída, com o motivo, e não vira "conectada").
 */
export function marcarConectando(db: Db, workspaceId: string, kind: IntegrationKind, conta = ''): void {
  const r = integrationRow(db, workspaceId, kind, conta);
  const antes = r.state === 'pending' ? settingsOf(r).antesDeConectar : { state: r.state, last_error: r.last_error ?? null };
  setIntegration(db, workspaceId, kind, { state: 'pending', last_error: null, settings: { ...settingsOf(r), pendenteDesde: now(), antesDeConectar: antes ?? null } }, conta);
}
/**
 * Para onde volta um login que não terminou: sem credencial, desligada; com ela, o estado de antes (caída continua caída,
 * com o motivo de antes junto do de agora); conectada, continua conectada. As marcas do login saem das configurações.
 */
export function voltaDoConectando(r: IntegrationRow, temCredencial: boolean, motivo: string): { state: 'off' | 'connected' | 'error'; last_error: string; settings: Record<string, unknown> } {
  const { pendenteDesde: _p, antesDeConectar, ...settings } = settingsOf(r);
  const antes = (antesDeConectar && typeof antesDeConectar === 'object' ? antesDeConectar : {}) as { state?: string; last_error?: string | null };
  if (!temCredencial) return { state: 'off', last_error: motivo, settings };
  if (antes.state === 'error') return { state: 'error', last_error: clipTxt(`${motivo} A conexão de antes continua parada${antes.last_error ? `: ${antes.last_error}` : '.'}`, 600), settings };
  return { state: 'connected', last_error: motivo, settings };
}
const clipTxt = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** Outra conta entrou neste workspace: as marcas das etapas da conta de antes (aprovado, pedido, bloqueado) não valem para ela. */
export function limparEtapas(db: Db, workspaceId: string, conta = ''): void {
  const r = integrationRow(db, workspaceId, 'microsoft', conta);
  const c = consentimentoDe(r);
  if (!c.etapas || !Object.keys(c.etapas).length) return;
  setIntegration(db, workspaceId, 'microsoft', { settings: { ...settingsOf(r), consentimento: { ...c, etapas: {} } } }, conta);
}

// ---------------------------------------------------------------- HTTP com token do usuário
const call = (url: string, token: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}): Promise<any> =>
  request(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });

const MAX_TASKS = 500;

/** 401 com o acesso ainda válido (sessão revogada, senha trocada): renova uma vez e repete aquela leitura. */
async function renewOn401<T>(token: (force: boolean) => Promise<string>, fn: (t: string) => Promise<T>): Promise<T> {
  try { return await fn(await token(false)); } catch (e) {
    if (!(e instanceof ProviderError && e.status === 401)) throw e;
    return fn(await token(true));
  }
}

// ---------------------------------------------------------------- Todoist (API v1)
export class TodoistProvider implements TaskProvider {
  readonly name = 'todoist'; readonly isFixture = false;
  readonly supports = { title: true, description: true, completion: true, columns: true, writeBack: false } as const;
  private readonly token: string;
  constructor(token: string) { this.token = token; }
  private base = 'https://api.todoist.com/api/v1';
  private async all(pathq: string): Promise<any[]> {
    const out: any[] = []; let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const sep = pathq.includes('?') ? '&' : '?';
      const j = await call(`${this.base}${pathq}${cursor ? `${sep}cursor=${encodeURIComponent(cursor)}` : ''}`, this.token);
      const items = Array.isArray(j) ? j : (j.results ?? []);
      out.push(...items);
      cursor = Array.isArray(j) ? null : j.next_cursor ?? null;
      if (!cursor || out.length >= MAX_TASKS) break;
    }
    return out;
  }
  async whoami(): Promise<ContaConferida> {
    try { const j = await call(`${this.base}/user`, this.token); return contaConferida(j.full_name ?? j.email ?? 'conta Todoist', j.id); } catch (err) {
      if (err instanceof ProviderError && err.kind === 'forbidden') throw err;
      await this.all('/projects'); // a conta responde: o token vale, só não há perfil nesta rota (nem o id da conta)
      return contaConferida('conta Todoist', null);
    }
  }
  async listBoards() {
    return (await this.all('/projects')).map((p) => ({ externalId: String(p.id), name: String(p.name), version: String(p.updated_at ?? ''), taskCount: -1 }));
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    const projects = await this.all('/projects');
    const p = projects.find((x) => String(x.id) === externalId);
    if (!p) throw new ProviderError('not_found', 'projeto não encontrado (ou sem acesso)');
    const sections = await this.all(`/sections?project_id=${encodeURIComponent(externalId)}`);
    const tasks = await this.all(`/tasks?project_id=${encodeURIComponent(externalId)}`);
    let people = new Map<string, string>();
    try { people = new Map((await this.all(`/projects/${encodeURIComponent(externalId)}/collaborators`)).map((c) => [String(c.id), String(c.name ?? c.email)])); } catch { /* projeto pessoal */ }
    const NONE = '__sem_secao__';
    const columns = [{ externalId: NONE, name: 'Sem seção', order: -1 }, ...sections.map((s, i) => ({ externalId: String(s.id), name: String(s.name), order: Number(s.section_order ?? i) }))];
    return {
      board: { externalId, name: String(p.name), version: String(p.updated_at ?? '') },
      columns,
      tasks: tasks.slice(0, MAX_TASKS).map((t) => ({
        externalId: String(t.id), columnExternalId: t.section_id ? String(t.section_id) : NONE, title: String(t.content ?? '').slice(0, 200),
        description: String(t.description ?? ''), completed: t.checked === true, version: String(t.updated_at ?? t.added_at ?? ''),
        assignee: t.responsible_uid ? people.get(String(t.responsible_uid)) ?? null : null, due: dueOf(t.due?.date), extra: {},
      })),
      // a lista traz só as tarefas abertas: a ausência de uma tarefa não prova nada (pode ter sido concluída)
      complete: false,
    };
  }
}

// ---------------------------------------------------------------- Asana
export class AsanaProvider implements TaskProvider {
  readonly name = 'asana'; readonly isFixture = false;
  readonly supports = { title: true, description: true, completion: true, columns: true, writeBack: false } as const;
  private readonly token: string;
  constructor(token: string) { this.token = token; }
  private base = 'https://app.asana.com/api/1.0';
  async whoami(): Promise<ContaConferida> { const j = await call(`${this.base}/users/me?opt_fields=name,email`, this.token); return contaConferida(j.data?.name ?? j.data?.email ?? 'conta Asana', j.data?.gid); }
  async listBoards() {
    const me = await call(`${this.base}/users/me?opt_fields=workspaces.name`, this.token);
    const out: Array<ExternalBoard & { taskCount: number }> = [];
    for (const w of (me.data?.workspaces ?? []).slice(0, 5)) {
      const j = await call(`${this.base}/projects?workspace=${encodeURIComponent(w.gid)}&archived=false&limit=100&opt_fields=name,modified_at`, this.token);
      for (const p of j.data ?? []) out.push({ externalId: String(p.gid), name: (me.data.workspaces.length > 1 ? `${w.name} › ` : '') + String(p.name), version: String(p.modified_at ?? ''), taskCount: -1 });
    }
    return out;
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    const p = await call(`${this.base}/projects/${encodeURIComponent(externalId)}?opt_fields=name,modified_at`, this.token);
    const sections = await call(`${this.base}/projects/${encodeURIComponent(externalId)}/sections?opt_fields=name`, this.token);
    const tasks: any[] = []; let offset: string | null = null;
    for (let i = 0; i < 6; i++) {
      const j = await call(`${this.base}/tasks?project=${encodeURIComponent(externalId)}&limit=100&opt_fields=name,notes,completed,due_on,assignee.name,memberships.section.gid,memberships.project.gid,modified_at${offset ? `&offset=${encodeURIComponent(offset)}` : ''}`, this.token);
      tasks.push(...(j.data ?? []));
      offset = j.next_page?.offset ?? null;
      if (!offset || tasks.length >= MAX_TASKS) break;
    }
    const cols = (sections.data ?? []).map((s: any, i: number) => ({ externalId: String(s.gid), name: String(s.name), order: i }));
    return {
      board: { externalId, name: String(p.data?.name ?? 'Projeto'), version: String(p.data?.modified_at ?? '') },
      columns: cols.length ? cols : [{ externalId: '__geral__', name: 'Tarefas', order: 0 }],
      tasks: tasks.slice(0, MAX_TASKS).map((t) => {
        const sec = (t.memberships ?? []).find((m: any) => String(m.project?.gid) === externalId)?.section?.gid;
        return {
          externalId: String(t.gid), columnExternalId: sec ? String(sec) : (cols[0]?.externalId ?? '__geral__'), title: String(t.name ?? '').slice(0, 200),
          description: String(t.notes ?? ''), completed: t.completed === true, version: String(t.modified_at ?? ''),
          assignee: t.assignee?.name ? String(t.assignee.name) : null, due: dueOf(t.due_on), extra: {},
        };
      }),
      complete: !offset,
    };
  }
}

// ---------------------------------------------------------------- Microsoft (Graph) e Google (Tasks), pelo SSO
const DESC_PLANNER = new Map<string, { versao: string; texto: string }>();
/**
 * Depois de um envio do espelho (conexoes/espelho.ts): o que a leitura guardou desta tarefa pela versão deixa de valer. A
 * descrição do Planner mora nos detalhes, com versão própria, e gravá-la nem sempre muda a versão da tarefa.
 */
export function esquecerLeitura(workspaceId: string, externo: string): void { DESC_PLANNER.delete(`${workspaceId}:${externo}`); }
/** Planner (planos e buckets) e To Do (listas) da conta Microsoft. IDs: "planner:<id>" ou "todo:<id>". */
export class MicrosoftTasksProvider implements TaskProvider {
  readonly name = 'microsoft'; readonly isFixture = false;
  readonly supports = { title: true, description: true, completion: true, columns: true, writeBack: false } as const;
  private readonly auth: SsoAuth; private readonly workspaceId: string;
  /** fuso do workspace: o Planner guarda o prazo como instante em UTC (ver dueAt) */
  private readonly tz: string;
  private names = new Map<string, string>();
  /** qual das contas Microsoft deste workspace ('' = a principal) */
  private readonly conta: string;
  constructor(auth: SsoAuth, workspaceId: string, tz: string, conta = '') { this.auth = auth; this.workspaceId = workspaceId; this.tz = tz; this.conta = conta; }
  private async g(p: string) { return renewOn401((force) => this.auth.accessToken(this.workspaceId, 'microsoft', { force, conta: this.conta }), (t) => call(`https://graph.microsoft.com/v1.0${p}`, t)); }
  async listBoards() {
    const out: Array<ExternalBoard & { taskCount: number }> = [];
    try { for (const p of (await this.g('/me/planner/plans')).value ?? []) out.push({ externalId: `planner:${p.id}`, name: `Planner › ${p.title}`, version: String(p['@odata.etag'] ?? ''), taskCount: -1 }); } catch { /* conta pessoal: sem Planner */ }
    for (const l of (await this.g('/me/todo/lists')).value ?? []) out.push({ externalId: `todo:${l.id}`, name: `To Do › ${l.displayName}`, version: '', taskCount: -1 });
    return out;
  }
  /** Descrição do Planner (fica nos detalhes da tarefa, uma chamada por tarefa): relida só quando a tarefa mudou. */
  private async descricao(taskId: string, versao: string): Promise<string> {
    const k = `${this.workspaceId}:${taskId}`;
    const hit = DESC_PLANNER.get(k);
    if (hit && hit.versao === versao) return hit.texto;
    try {
      const d = await this.g(`/planner/tasks/${encodeURIComponent(taskId)}/details`);
      const texto = String(d.description ?? '');
      if (DESC_PLANNER.size > 5000) DESC_PLANNER.clear();
      DESC_PLANNER.set(k, { versao, texto });
      return texto;
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'unavailable') throw e; // passageiro: a leitura inteira tenta de novo, sem apagar a descrição
      return hit?.texto ?? '';
    }
  }
  private async person(userId: string): Promise<string | null> {
    if (this.names.has(userId)) return this.names.get(userId)!;
    try { const u = await this.g(`/users/${encodeURIComponent(userId)}?$select=displayName`); this.names.set(userId, String(u.displayName)); return String(u.displayName); } catch { return null; }
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    const [kind, rawId] = externalId.split(':');
    const xid = encodeURIComponent(rawId ?? '');
    if (kind === 'todo') {
      const list = await this.g(`/me/todo/lists/${xid}`);
      const tasks = ((await this.g(`/me/todo/lists/${xid}/tasks?$top=200`)).value ?? []) as any[];
      return {
        board: { externalId, name: `To Do › ${list.displayName}`, version: '' },
        columns: [{ externalId: 'open', name: 'A fazer', order: 0 }, { externalId: 'done', name: 'Concluídas', order: 1 }],
        tasks: tasks.slice(0, MAX_TASKS).map((t) => ({ externalId: String(t.id), columnExternalId: t.status === 'completed' ? 'done' : 'open', title: String(t.title ?? '').slice(0, 200),
          description: t.body?.contentType === 'text' ? String(t.body.content ?? '') : htmlParaTexto(String(t.body?.content ?? '')), completed: t.status === 'completed', version: String(t.lastModifiedDateTime ?? ''), assignee: null, due: dueOf(t.dueDateTime?.dateTime), extra: {} })),
        complete: tasks.length < 200,
      };
    }
    const plan = await this.g(`/planner/plans/${xid}`);
    const buckets = ((await this.g(`/planner/plans/${xid}/buckets`)).value ?? []) as any[];
    // o Graph pagina: sem seguir as páginas, as tarefas não vistas viravam "não apareceu na última leitura"
    const tasks: any[] = [];
    let next: string | null = `/planner/plans/${xid}/tasks`;
    for (let i = 0; next && tasks.length < MAX_TASKS && i < 20; i++) {
      const j: any = await this.g(next);
      tasks.push(...((j.value ?? []) as any[]));
      const link: unknown = j['@odata.nextLink'];
      next = typeof link === 'string' && link.startsWith('https://graph.microsoft.com/v1.0/') ? link.slice('https://graph.microsoft.com/v1.0'.length) : null;
    }
    const out = [];
    for (const t of tasks.slice(0, MAX_TASKS)) {
      const who = Object.keys(t.assignments ?? {})[0];
      out.push({ externalId: String(t.id), columnExternalId: String(t.bucketId ?? buckets[0]?.id ?? ''), title: String(t.title ?? '').slice(0, 200),
        description: t.hasDescription ? await this.descricao(String(t.id), String(t['@odata.etag'] ?? '')) : '', completed: Number(t.percentComplete) === 100, version: String(t['@odata.etag'] ?? ''), assignee: who ? await this.person(who) : null, due: dueAt(t.dueDateTime, this.tz), extra: {} });
    }
    return {
      board: { externalId, name: `Planner › ${plan.title}`, version: String(plan['@odata.etag'] ?? '') },
      columns: buckets.map((b, i) => ({ externalId: String(b.id), name: String(b.name), order: i })), tasks: out, complete: !next && tasks.length <= MAX_TASKS,
    };
  }
}

/**
 * Google Tasks: cada lista vira um quadro com duas colunas (A fazer, Concluídas). O Google Tasks não tem
 * responsável (tarefas são pessoais), então "atribuída a" fica vazio. Concluídas também vêm (showCompleted).
 */
export class GoogleTasksProvider implements TaskProvider {
  readonly name = 'google'; readonly isFixture = false;
  readonly supports = { title: true, description: true, completion: true, columns: false, writeBack: false } as const;
  private readonly auth: SsoAuth; private readonly workspaceId: string;
  private readonly conta: string;
  constructor(auth: SsoAuth, workspaceId: string, conta = '') { this.auth = auth; this.workspaceId = workspaceId; this.conta = conta; }
  private base = 'https://tasks.googleapis.com/tasks/v1';
  private async g(p: string) { return renewOn401((force) => this.auth.accessToken(this.workspaceId, 'google', { force, conta: this.conta }), (t) => call(`${this.base}${p}`, t)); }
  async listBoards() {
    const j = await this.g('/users/@me/lists?maxResults=100');
    return ((j.items ?? []) as any[]).map((l) => ({ externalId: String(l.id), name: String(l.title ?? 'Lista'), version: String(l.updated ?? ''), taskCount: -1 }));
  }
  async getBoard(externalId: string): Promise<BoardSnapshot> {
    const id = encodeURIComponent(externalId);
    const list = await this.g(`/users/@me/lists/${id}`);
    const tasks: any[] = []; let page: string | null = null;
    for (let i = 0; i < 5; i++) {
      const j = await this.g(`/lists/${id}/tasks?maxResults=100&showCompleted=true&showHidden=true${page ? `&pageToken=${encodeURIComponent(page)}` : ''}`);
      tasks.push(...(j.items ?? []));
      page = j.nextPageToken ?? null;
      if (!page || tasks.length >= MAX_TASKS) break;
    }
    return {
      board: { externalId, name: String(list.title ?? 'Lista'), version: String(list.updated ?? '') },
      columns: [{ externalId: 'open', name: 'A fazer', order: 0 }, { externalId: 'done', name: 'Concluídas', order: 1 }],
      tasks: tasks.filter((t) => !t.deleted && String(t.title ?? '').trim()).slice(0, MAX_TASKS).map((t) => ({
        externalId: String(t.id), columnExternalId: t.status === 'completed' ? 'done' : 'open', title: String(t.title).slice(0, 200),
        description: String(t.notes ?? ''), completed: t.status === 'completed', version: String(t.etag ?? t.updated ?? ''), assignee: null, due: dueOf(t.due), extra: {},
      })),
      complete: !page,
    };
  }
}

/** Provedor de um app conectado por credencial colada. */
export function tokenProvider(kind: IntegrationKind, c: Record<string, string>): AccountProvider {
  switch (kind) {
    case 'todoist': return new TodoistProvider(c.token);
    case 'asana': return new AsanaProvider(c.token);
    case 'trello': return new TrelloProvider(c.key, c.token);
    case 'jira': return new JiraProvider(c.site, c.email, c.token);
    case 'clickup': return new ClickUpProvider(c.token);
    case 'monday': return new MondayProvider(c.token);
    case 'notion': return new NotionProvider(c.token);
    case 'linear': return new LinearProvider(c.token);
    case 'airtable': return new AirtableProvider(c.token);
    case 'smartsheet': return new SmartsheetProvider(c.token);
    case 'pipefy': return new PipefyProvider(c);
    case 'github': return new GitHubProjectsProvider(c.token);
    default: throw new HttpError(400, 'no_tasks', 'esta integração não tem tarefas');
  }
}

/** Uma conta como a tela mostra (Conexões › aplicativo › contas). */
export interface ContaDaTela {
  /** '' = a principal */
  conta: string; id: string; principal: boolean; nome: string; apelido: string | null; account: string | null;
  state: IntegrationRow['state']; ativa: boolean; error: string | null; connectedAt: string | null; lastSyncAt: string | null;
  sharedFrom: string | null; live: Record<string, unknown> | null; renewBy: string | null; aviso: string | null;
}
/** Uma conta como o agente vê: o nome para pedir por ela (conta="...") e se é a principal. */
export interface ContaDoAgente { conta: string; nome: string; principal: boolean }

// ---------------------------------------------------------------- serviço
export class Integrations {
  readonly secrets: SecretStore;
  /** login com a conta (Microsoft, Google), parametrizado */
  readonly sso: SsoAuth;
  private readonly db: Db; private readonly bus: Bus;
  /** estado ao vivo de canais com processo próprio (WhatsApp), por conta */
  liveState: (workspaceId: string, kind: IntegrationKind, conta: string) => Record<string, unknown> | null = () => null;
  /** antes e depois de trocar a principal (o WhatsApp para e retoma as sessões dos dois números) */
  antesDeTrocar: (workspaceId: string, kind: IntegrationKind) => Promise<void> = async () => undefined;
  depoisDeTrocar: (workspaceId: string, kind: IntegrationKind) => void = () => undefined;
  private readonly googleTesting: boolean;
  constructor(db: Db, bus: Bus, cfg: Config) { this.db = db; this.bus = bus; this.secrets = new SecretStore(cfg.dataDir, () => db.fieldCipher);
    this.secrets.origem = (ws, kind, conta) => {
      const r = db.get<{ o: string | null; oc: string | null }>('SELECT origem_workspace_id AS o, origem_conta AS oc FROM integrations WHERE workspace_id = ? AND kind = ? AND conta = ?', ws, kind, conta);
      return r?.o ? { ws: r.o, conta: r.oc ?? '' } : { ws, conta };
    };
    this.sso = new SsoAuth(cfg, this.secrets, (ws, kind, antes, conta, slot) => { if (antes !== conta) this.promover(ws, kind, slot); }, (ws, etapa, slot) => etapaJaRecusada(db, ws, etapa, slot));  this.googleTesting = cfg.googleTesting; }

  /**
   * Login com a conta que não voltou em 10 minutos (o `state` já venceu): sai do "conectando…" e diz por quê. Com a credencial de
   * antes, a conexão continua como estava; sem ela, fica desligada. Sem a hora de início (versão anterior), também venceu.
   */
  vencerConectando(workspaceId: string, kind: IntegrationKind, conta = ''): IntegrationRow {
    const r = integrationRow(this.db, workspaceId, kind, conta);
    if (!isSso(kind) || r.state !== 'pending') return r;
    const desde = Date.parse(String(settingsOf(r).pendenteDesde ?? ''));
    if (Number.isFinite(desde) && Date.now() - desde <= STATE_TTL) return r;
    const tem = !!this.secrets.read(workspaceId, kind, conta);
    const quem = kind === 'google' ? 'do Google' : 'da Microsoft';
    const caida = (settingsOf(r).antesDeConectar as { state?: string } | undefined)?.state === 'error';
    setIntegration(this.db, workspaceId, kind, voltaDoConectando(r, tem, tem && !caida
      ? `A nova autorização ${quem} não terminou em 10 minutos; a conexão de antes continua valendo.`
      : `O login ${quem} não terminou em 10 minutos. Para tentar de novo, clique em "Entrar com ${kind === 'google' ? 'o Google' : 'a Microsoft'}".`), conta);
    return integrationRow(this.db, workspaceId, kind, conta);
  }

  /**
   * Conta a mais que ficou desligada sem credencial (o login ou o QR de uma conta nova que não terminou, ou uma que a pessoa
   * desconectou e não tem quadro ligado): sai da lista. A principal nunca sai (é o cartão do aplicativo).
   */
  private limparAbandonadas(workspaceId: string, kind: IntegrationKind): void {
    for (const r of contasDe(this.db, workspaceId, kind)) {
      if (!r.conta || r.state !== 'off' || r.origem_workspace_id) continue;
      if (this.secrets.readOwn(workspaceId, kind, r.conta) || this.db.get('SELECT 1 AS x FROM boards WHERE connection_id = ? LIMIT 1', r.id)) continue;
      this.secrets.removeDir(workspaceId, kind, r.conta);
      this.db.run('DELETE FROM integrations WHERE id = ?', r.id);
    }
  }

  /** userId: o dono do workspace, que pode usar aqui uma conta dos outros workspaces dele (só ele vê as opções). */
  list(workspaceId: string, userId: string | null = null) {
    return INTEGRATIONS.map((d) => {
      // "em breve": nada no banco, só o cartão honesto
      if (d.auth !== 'soon') this.limparAbandonadas(workspaceId, d.kind);
      const r = d.auth === 'soon' ? null : isSso(d.kind) ? this.vencerConectando(workspaceId, d.kind) : integrationRow(this.db, workspaceId, d.kind);
      const s = r ? settingsOf(r) : {};
      const contas = d.auth === 'soon' ? [] : contasDe(this.db, workspaceId, d.kind).map((c) => this.contaDaTela(workspaceId, d, isSso(d.kind) && c.conta ? this.vencerConectando(workspaceId, d.kind, c.conta) : c));
      return {
        kind: d.kind, name: d.name, auth: d.auth, group: d.group, about: d.about, tasks: d.tasks, site: d.site, soon: d.soon ?? null, help: d.help ?? null,
        fields: (d.fields ?? []).map((f) => ({ name: f.name, label: f.label, secret: !!f.secret, placeholder: f.placeholder ?? '', opcional: !!f.opcional })),
        // o jeito antigo de conectar ainda vale, mas a tela pede para reconectar do novo jeito
        aviso: r ? this.avisoDe(workspaceId, d, r) : null,
        state: r?.state ?? 'off', account: r?.account_label ?? null, connectedAt: r?.connected_at ?? null, lastSyncAt: r?.last_sync_at ?? null, error: r?.last_error ?? null,
        settings: d.kind === 'whatsapp' ? s : {}, ready: !isSso(d.kind) || this.sso.configured(d.kind),
        // conta emprestada de outro workspace seu
        sharedFrom: r?.origem_workspace_id ? this.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', r.origem_workspace_id)?.name ?? null : null,
        // os outros workspaces que usam a credencial que mora aqui: desconectar aqui não corta o acesso deles (promover).
        // São workspaces do dono: só ele vê os nomes, como os reutilizáveis
        usadaEm: userId && r && !r.origem_workspace_id && r.state === 'connected'
          ? this.db.all<{ name: string }>("SELECT w.name FROM integrations i JOIN workspaces w ON w.id = i.workspace_id WHERE i.origem_workspace_id = ? AND i.kind = ? AND i.origem_conta = '' ORDER BY w.name", workspaceId, d.kind).map((x) => x.name) : [],
        // a mesma conta já conectada noutro workspace da pessoa: vem junto, para a tela abrir pronta (e para "Adicionar outra conta")
        reutilizaveis: userId && r ? this.reutilizaveis(workspaceId, userId, d.kind) : [],
        setup: isSso(d.kind) ? { needs: SSO[d.kind].needs, doc: SSO[d.kind].doc, place: SSO[d.kind].place } : null,
        live: this.liveState(workspaceId, d.kind, ''),
        // Google com o app em teste: a autorização vale 7 dias (depois, entrar de novo); a tela avisa antes. Conta emprestada
        // vence junto com a do workspace onde ela mora (o connected_at daqui é a hora do empréstimo)
        renewBy: d.kind === 'google' && this.googleTesting && r?.state === 'connected' ? this.renovarAte(r) : null,
        // empresa que não deixa ninguém autorizar sozinho: o primeiro login volta sem a conta, e o pedido ao administrador
        // aparece já no cartão desconectado (o link da leitura inclui o que o primeiro login pediria)
        adminBase: d.kind === 'microsoft' && r && r.state !== 'connected' ? this.adminBase(workspaceId, r) : null,
        // todas as contas deste aplicativo (rc.29): a principal primeiro. Quem tem uma só vê a mesma tela de antes
        contas,
      };
    });
  }

  private avisoDe(workspaceId: string, d: IntegrationDef, r: IntegrationRow): string | null {
    return r.state === 'connected' && d.credencialAntiga && d.credencialAntiga.antiga(this.secrets.read<Record<string, string>>(workspaceId, d.kind, r.conta) ?? {}) ? d.credencialAntiga.aviso : null;
  }

  private contaDaTela(workspaceId: string, d: IntegrationDef, c: IntegrationRow): ContaDaTela {
    return {
      conta: c.conta, id: c.id, principal: c.conta === '', nome: nomeDaConta(c), apelido: c.apelido ?? null, account: c.account_label ?? null,
      state: c.state, ativa: c.ativa !== 0, error: c.last_error ?? null, connectedAt: c.connected_at ?? null, lastSyncAt: c.last_sync_at ?? null,
      sharedFrom: c.origem_workspace_id ? this.db.get<{ name: string }>('SELECT name FROM workspaces WHERE id = ?', c.origem_workspace_id)?.name ?? null : null,
      live: this.liveState(workspaceId, d.kind, c.conta),
      renewBy: d.kind === 'google' && this.googleTesting && c.state === 'connected' ? this.renovarAte(c) : null,
      aviso: this.avisoDe(workspaceId, d, c),
    };
  }

  /** O pedido ao administrador antes da primeira conexão: só depois que o login da Microsoft voltou dizendo que precisa dele. */
  private adminBase(workspaceId: string, r: IntegrationRow): { link: string; erro: string | null } | null {
    const b = consentimentoDe(r).baseBloqueada;
    if (!b || this.secrets.read(workspaceId, 'microsoft')) return null;
    const link = this.sso.linkAdministrador(workspaceId, 'leitura', `${estadoAdmin(this.db, workspaceId)}.leitura`);
    return link ? { link, erro: b.erro ?? null } : null;
  }

  private renovarAte(r: IntegrationRow): string | null {
    const desde = r.origem_workspace_id
      ? this.db.get<{ c: string | null }>('SELECT connected_at AS c FROM integrations WHERE workspace_id = ? AND kind = ? AND conta = ?', r.origem_workspace_id, r.kind, r.origem_conta ?? '')?.c ?? null
      : r.connected_at;
    return desde ? new Date(Date.parse(desde) + 7 * 86_400_000).toISOString() : null;
  }

  provider(workspaceId: string, kind: IntegrationKind, conta = ''): TaskProvider {
    const r = integrationRow(this.db, workspaceId, kind, conta);
    if (r.state !== 'connected') throw new HttpError(409, 'not_connected', 'integração não conectada');
    if (kind === 'microsoft') return new MicrosoftTasksProvider(this.sso, workspaceId, workspaceTz(this.db, workspaceId), conta);
    if (kind === 'google') return new GoogleTasksProvider(this.sso, workspaceId, conta);
    const creds = this.secrets.read<Record<string, string>>(workspaceId, kind, conta);
    // Pipefy: a conta de serviço não tem token (Client ID e Client Secret); quem conectou antes, sim
    if (!creds?.token && !(kind === 'pipefy' && creds?.client_id)) throw new HttpError(409, 'not_connected', 'credencial ausente: conecte de novo');
    return tokenProvider(kind, creds);
  }

  // ------------------------------------------------------------------- várias contas do mesmo aplicativo
  /**
   * Uma conta a mais deste aplicativo, ainda sem credencial (o login com a conta ou o QR do WhatsApp começam por aqui). Quem
   * ainda não tem nenhuma usa a principal: a primeira conta é sempre a principal.
   */
  novaConta(workspaceId: string, kind: IntegrationKind): string {
    const p = integrationRow(this.db, workspaceId, kind);
    if (p.state === 'off' && !p.origem_workspace_id && !this.secrets.readOwn(workspaceId, kind)) return '';
    const conta = novaContaId();
    this.db.run("INSERT INTO integrations (id, workspace_id, kind, conta, state, settings, created_at) VALUES (?, ?, ?, ?, 'off', ?, ?)", id('int'), workspaceId, kind, conta,
      // os filtros e o aceite dos riscos do WhatsApp valem para a pessoa, não para um número: o número novo começa com os da principal
      // (o número de quem pareou e o estado do pareamento são de cada número: não vêm junto, ou o novo pareceria repetido)
      kind === 'whatsapp' ? JSON.stringify((({ numero: _n, recusadas: _r, pendenteDesde: _p, antesDeConectar: _a, ...resto }) => resto)(settingsOf(p))) : '{}', now());
    return conta;
  }

  /** As contas que a equipe pode usar agora neste aplicativo (conectadas e ligadas), como o agente pede por elas. */
  contasDoAgente(workspaceId: string, kind: IntegrationKind): ContaDoAgente[] {
    const nome = nomeUnico(contasDe(this.db, workspaceId, kind));
    return contasLigadas(this.db, workspaceId, [kind]).map((r) => ({ conta: r.conta, nome: nome(r), principal: r.conta === '' }));
  }

  /** O apelido da conta (vazio: volta a valer o e-mail, o número ou o nome da conta). Dois iguais no mesmo aplicativo confundiriam quem pede. */
  renomear(workspaceId: string, userId: string, kind: IntegrationKind, conta: string, apelido: string): void {
    const r = integrationRow(this.db, workspaceId, kind, conta);
    const novo = apelido.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (novo && contasDe(this.db, workspaceId, kind).some((c) => c.id !== r.id && fold(nomeDaConta(c)) === fold(novo))) throw new HttpError(409, 'apelido_repetido', 'Outra conta deste aplicativo já tem esse nome. Escolha outro.');
    setIntegration(this.db, workspaceId, kind, { apelido: novo || null }, conta);
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.apelido', targetType: 'integration', targetId: r.id, evidence: { kind }, result: novo ? 'apelido da conta atualizado' : 'apelido da conta removido' });
    this.bus.publish(workspaceId, 'integrations.changed', { kind });
  }

  /** Liga ou desliga a conta para a equipe e as rotinas (a credencial continua guardada). */
  ligar(workspaceId: string, userId: string, kind: IntegrationKind, conta: string, ativa: boolean): void {
    const r = integrationRow(this.db, workspaceId, kind, conta);
    setIntegration(this.db, workspaceId, kind, { ativa }, conta);
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.ativa', targetType: 'integration', targetId: r.id, evidence: { kind, ativa }, result: ativa ? 'a equipe e as rotinas voltam a usar esta conta' : 'a equipe e as rotinas deixam de usar esta conta' });
    this.bus.publish(workspaceId, 'integrations.changed', { kind });
  }

  /**
   * Outra conta passa a ser a principal (a que vale quando ninguém diz qual usar). Só o `conta` das duas linhas troca, com a
   * credencial e a pasta de cada uma: o id, os quadros, as permissões e o registro seguem cada conta. Quem usa uma delas
   * emprestada noutro workspace continua apontando para a mesma conta.
   */
  async tornarPrincipal(workspaceId: string, userId: string | null, kind: IntegrationKind, conta: string): Promise<void> {
    if (!conta) return;
    const x = integrationRow(this.db, workspaceId, kind, conta);
    const p = integrationRow(this.db, workspaceId, kind);
    await this.antesDeTrocar(workspaceId, kind);
    try {
      const tmp = novaContaId();
      this.db.tx(() => {
        this.db.run('UPDATE integrations SET conta = ? WHERE id = ?', tmp, p.id);
        this.db.run("UPDATE integrations SET conta = '' WHERE id = ?", x.id);
        this.db.run('UPDATE integrations SET conta = ? WHERE id = ?', conta, p.id);
        this.db.run("UPDATE integrations SET origem_conta = CASE origem_conta WHEN '' THEN ? ELSE '' END WHERE origem_workspace_id = ? AND kind = ? AND origem_conta IN ('', ?)", conta, workspaceId, kind, conta);
      });
      this.secrets.trocar(workspaceId, kind, '', conta);
    } finally { this.depoisDeTrocar(workspaceId, kind); }
    if (userId) audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.principal', targetType: 'integration', targetId: x.id, evidence: { kind }, result: 'esta conta passou a ser a principal' });
    this.bus.publish(workspaceId, 'integrations.changed', { kind });
  }

  /** Credencial colada (token e, conforme o app, chave, endereço ou e-mail): confere com uma chamada real antes de chamar de "conectado". */
  async connectToken(workspaceId: string, userId: string, kind: IntegrationKind, input: Record<string, string>, contaPedida = ''): Promise<string> {
    const d = integrationDef(kind);
    if (!d || d.auth !== 'token') throw new HttpError(400, 'kind', 'esta conexão não usa token');
    const creds: Record<string, string> = {};
    for (const f of d.fields ?? TOKEN) {
      const v = String(input[f.name] ?? '').trim();
      if (!v && f.opcional) continue;
      if (!v) throw new HttpError(400, 'field', `preencha: ${f.label}`);
      if (v.length > 2000 || (f.secret && (v.length < 16 || /\s/.test(v)))) throw new HttpError(400, 'token', `${f.label}: formato inválido`);
      if (f.pattern && !f.pattern.test(v)) throw new HttpError(400, 'field', `${f.label}: ${f.patternHelp ?? 'formato inválido'}`);
      creds[f.name] = v;
    }
    if (kind === 'jira' && !jiraHost(creds.site)) throw new HttpError(400, 'field', 'Endereço do Jira: use sua-empresa.atlassian.net (só Jira Cloud)');
    // o segredo da conta de serviço só vai ao próprio Pipefy
    if (kind === 'pipefy' && creds.token_url) { try { creds.token_url = enderecoTokenPipefy(creds.token_url); } catch (e) { throw new HttpError(400, 'field', e instanceof Error ? e.message : 'endereço inválido'); } }
    if (contaPedida && contaPedida !== 'nova') integrationRow(this.db, workspaceId, kind, contaPedida); // a conta existe
    let conta: ContaConferida;
    try { conta = d.tasks ? await tokenProvider(kind, creds).whoami() : await conferir(kind, creds); } catch (err) {
      if (err instanceof ErroAcao) throw new HttpError(400, 'field', err.message);
      throw new HttpError(400, 'token_rejected', err instanceof ProviderError ? `O ${d.name} recusou: ${err.message}` : 'não consegui conferir a credencial');
    }
    const campos = d.fields ?? TOKEN;
    const igual = (antes: Record<string, unknown> | null, f: CredentialField) => (antes?.[f.name] ?? '') === (creds[f.name] ?? '');
    /** a mesma conta do serviço: o id dela no mesmo endereço (site, e-mail, região) ou, sem id, a mesma credencial colada de novo */
    const mesmaConta = (antes: Record<string, unknown> | null) => !!antes && (campos.every((f) => igual(antes, f)) || (!!conta.id && antes[CONTA_ID] === conta.id && campos.filter((f) => !f.secret).every((f) => igual(antes, f))));
    // conta nova: a mesma conta já conectada aqui (outra linha deste aplicativo) não entra duas vezes
    let slot = contaPedida === 'nova' ? null : contaPedida;
    if (slot === null) {
      const repetida = contasDe(this.db, workspaceId, kind).find((c) => c.state !== 'off' && mesmaConta(this.secrets.read<Record<string, unknown>>(workspaceId, kind, c.conta)));
      if (repetida) throw new HttpError(409, 'ja_conectada', `Esta conta já está conectada aqui${nomeDaConta(repetida) ? ` (${nomeDaConta(repetida)})` : ''}.`);
      slot = this.novaConta(workspaceId, kind);
    }
    const account = conta.nome;
    // credencial nova onde a conta mora: só continua valendo para quem a usa emprestada noutros workspaces se for a mesma conta.
    // O nome não prova isso (duas contas podem ter o mesmo nome): vale o id da conta no serviço, no mesmo endereço (site,
    // e-mail, região); sem id conhecido, só a mesma credencial colada de novo. Outra conta: quem usava fica com a de antes
    const row = integrationRow(this.db, workspaceId, kind, slot);
    const antes = row.origem_workspace_id ? null : this.secrets.readOwn<Record<string, unknown>>(workspaceId, kind, slot);
    if (!row.origem_workspace_id && !mesmaConta(antes)) this.promover(workspaceId, kind, slot);
    this.db.run("UPDATE integrations SET origem_workspace_id = NULL, origem_conta = '' WHERE id = ?", row.id);
    this.secrets.writeOwn(workspaceId, kind, conta.id ? { ...creds, [CONTA_ID]: conta.id } : creds, slot);
    setIntegration(this.db, workspaceId, kind, { state: 'connected', account_label: account.slice(0, 120), connected_at: now(), last_error: null }, slot);
    this.comecarSoLeitura(workspaceId, kind, conta.id, slot);
    this.reativarQuemUsa(workspaceId, kind, slot);
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.connect', targetType: 'integration', targetId: kind, evidence: { account, ...(slot ? { conta: slot } : {}) }, result: slot ? 'outra conta conectada (conferida no serviço)' : 'conectado (conferido no serviço)' });
    this.bus.publish(workspaceId, 'integrations.changed', { kind });
    return account;
  }

  /**
   * A primeira conexão de um app que começa só para consulta (comecaSoLeitura): a escrita fica desligada até a pessoa
   * desmarcar "Só leitura" em Conexões. Um ajuste que ela já fez continua como estava quando a conta é a mesma (reconectar,
   * chave nova da mesma subconta); outra conta (outra subconta do HighLevel, depois de desconectar a primeira) começa de
   * novo em "Só leitura": o que ela liberou valia para a outra empresa. settings.soLeituraConta guarda de qual conta é o ajuste.
   * Vale por conta do app (slot): cada subconta do HighLevel é uma conta, e a que entra com "Adicionar outra conta" nasce
   * com settings vazios, logo começa trancada, sem herdar o que a principal liberou.
   */
  private comecarSoLeitura(workspaceId: string, kind: IntegrationKind, contaId: unknown, slot = ''): void {
    if (!integrationDef(kind)?.comecaSoLeitura) return;
    const s = settingsOf(integrationRow(this.db, workspaceId, kind, slot));
    const conta = contaId === undefined || contaId === null || contaId === '' ? null : String(contaId);
    const outraConta = !!conta && typeof s.soLeituraConta === 'string' && s.soLeituraConta !== conta;
    if (s.permissoes !== undefined && !outraConta) {
      if (conta && s.soLeituraConta !== conta) setIntegration(this.db, workspaceId, kind, { settings: { ...s, soLeituraConta: conta } }, slot);
      return;
    }
    const { soLeituraAntes: _antes, ...resto } = s as Record<string, unknown>;
    setIntegration(this.db, workspaceId, kind, { settings: { ...resto, permissoes: { tipos: { organizar: 'desligado', enviar: 'desligado', apagar: 'desligado' }, acoes: {} }, ...(conta ? { soLeituraConta: conta } : {}) } }, slot);
  }

  // ------------------------------------------------------------------- a mesma conta em mais de um workspace seu
  /** Contas desta conexão nos seus outros workspaces, que este pode usar sem conectar de novo. WhatsApp é um aparelho só: fica fora. */
  reutilizaveis(workspaceId: string, userId: string, kind: IntegrationKind): Array<{ workspaceId: string; workspace: string; conta: string | null; origemConta: string }> {
    if (kind === 'whatsapp') return [];
    // as que este workspace já usa emprestadas não aparecem de novo
    const ja = new Set(this.db.all<{ k: string }>("SELECT origem_workspace_id || '|' || origem_conta AS k FROM integrations WHERE workspace_id = ? AND kind = ? AND origem_workspace_id IS NOT NULL", workspaceId, kind).map((r) => r.k));
    return this.db.all<{ id: string; name: string; conta: string | null; apelido: string | null; slot: string }>(
      `SELECT w.id, w.name, i.account_label AS conta, i.apelido, i.conta AS slot FROM integrations i JOIN workspaces w ON w.id = i.workspace_id
         JOIN memberships m ON m.workspace_id = i.workspace_id AND m.user_id = ? AND m.role = 'owner'
        WHERE i.kind = ? AND i.state = 'connected' AND i.origem_workspace_id IS NULL AND i.workspace_id <> ? ORDER BY w.name, CASE WHEN i.conta = '' THEN 0 ELSE 1 END, i.created_at`, userId, kind, workspaceId)
      .filter((r) => !ja.has(`${r.id}|${r.slot}`))
      .map((r) => ({ workspaceId: r.id, workspace: r.name, conta: nomeDaConta({ apelido: r.apelido, account_label: r.conta }) || r.conta, origemConta: r.slot }));
  }

  /**
   * Este workspace passa a usar a conta de outro workspace da mesma pessoa. Permissões e quadros continuam de cada um.
   * `conta`: em qual conta daqui ('nova' = mais uma conta; sem dizer, a principal, como antes).
   */
  usarDe(workspaceId: string, userId: string, kind: IntegrationKind, origem: string, origemConta = '', contaPedida = ''): string | null {
    const achada = this.reutilizaveis(workspaceId, userId, kind).find((x) => x.workspaceId === origem && x.origemConta === origemConta);
    if (!achada) throw new HttpError(404, 'origem', 'esta conta não está disponível nos seus outros workspaces');
    const slot = contaPedida === 'nova' ? this.novaConta(workspaceId, kind) : contaPedida;
    const atual = integrationRow(this.db, workspaceId, kind, slot);
    if (!atual.origem_workspace_id && atual.state === 'connected') this.promover(workspaceId, kind, slot);
    if (!atual.origem_workspace_id) { this.secrets.remove(workspaceId, kind, slot); }
    this.db.run('UPDATE integrations SET origem_workspace_id = ?, origem_conta = ? WHERE id = ?', origem, origemConta, atual.id);
    const daOrigem = integrationRow(this.db, origem, kind, origemConta);
    setIntegration(this.db, workspaceId, kind, { state: 'connected', account_label: (daOrigem.account_label ?? '').slice(0, 120) || null, connected_at: now(), last_error: null }, slot);
    this.comecarSoLeitura(workspaceId, kind, this.secrets.readOwn<Record<string, unknown>>(origem, kind, origemConta)?.[CONTA_ID], slot);
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.link', targetType: 'integration', targetId: kind, evidence: { origem, workspace: achada.workspace }, result: `usa a conta do workspace ${achada.workspace}` });
    this.bus.publish(workspaceId, 'integrations.changed', { kind });
    return achada.conta;
  }

  /**
   * Este workspace vai deixar a credencial (desconectou, trocou de conta ou está sendo apagado): quem a usa emprestada não
   * pode cair junto. O primeiro fica com ela e os outros passam a apontar para ele.
   */
  promover(workspaceId: string, kind: string, conta = ''): void {
    const deps = this.db.all<{ id: string; workspace_id: string; conta: string }>('SELECT id, workspace_id, conta FROM integrations WHERE origem_workspace_id = ? AND kind = ? AND origem_conta = ? ORDER BY created_at', workspaceId, kind, conta);
    if (!deps.length) return;
    const creds = this.secrets.readOwn<Record<string, unknown>>(workspaceId, kind, conta);
    const [novo, ...resto] = deps;
    if (creds) this.secrets.writeOwn(novo.workspace_id, kind, creds, novo.conta);
    this.db.tx(() => {
      this.db.run("UPDATE integrations SET origem_workspace_id = NULL, origem_conta = '' WHERE id = ?", novo.id);
      for (const w of resto) this.db.run('UPDATE integrations SET origem_workspace_id = ?, origem_conta = ? WHERE id = ?', novo.workspace_id, novo.conta, w.id);
    });
  }
  /** A credencial que mora aqui voltou a valer: quem a usa emprestada e tinha caído por ela volta junto (o estado é de cada workspace). */
  private reativarQuemUsa(workspaceId: string, kind: IntegrationKind, conta = ''): void {
    for (const r of this.db.all<{ w: string; c: string }>("SELECT workspace_id AS w, conta AS c FROM integrations WHERE origem_workspace_id = ? AND kind = ? AND origem_conta = ? AND state = 'error'", workspaceId, kind, conta)) {
      setIntegration(this.db, r.w, kind, { state: 'connected', last_error: null }, r.c);
      this.bus.publish(r.w, 'integrations.changed', { kind });
    }
  }
  /** Workspace sendo apagado: as contas que os outros usam ficam com eles. */
  promoverTudo(workspaceId: string): void {
    for (const r of this.db.all<{ kind: string; c: string }>('SELECT DISTINCT kind, origem_conta AS c FROM integrations WHERE origem_workspace_id = ?', workspaceId)) this.promover(workspaceId, r.kind, r.c);
  }

  /**
   * Desconecta uma conta. A principal fica no cartão, desligada, como sempre; se houver outra conta conectada, ela passa a ser a
   * principal (a equipe não fica sem conta à toa). Outra conta sai da lista (os quadros ligados a ela ficam, sem atualizar).
   */
  async disconnect(workspaceId: string, userId: string, kind: IntegrationKind, conta = ''): Promise<void> {
    const row = integrationRow(this.db, workspaceId, kind, conta);
    if (row.origem_workspace_id) {
      // só deixa de usar: a conta segue funcionando no workspace dela
      this.db.run("UPDATE integrations SET origem_workspace_id = NULL, origem_conta = '' WHERE id = ?", row.id);
      setIntegration(this.db, workspaceId, kind, { state: 'off', account_label: null, last_error: null }, conta);
      audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.unlink', targetType: 'integration', targetId: kind, result: 'deixou de usar a conta do outro workspace' });
    } else {
      this.promover(workspaceId, kind, conta);
      this.secrets.remove(workspaceId, kind, conta);
      if (kind === 'whatsapp') this.secrets.removeDir(workspaceId, kind, conta);
      setIntegration(this.db, workspaceId, kind, { state: 'off', account_label: null, last_error: null }, conta);
      audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.disconnect', targetType: 'integration', targetId: kind, evidence: conta ? { conta } : {}, result: 'desconectado (credenciais locais apagadas)' });
    }
    if (conta) { setIntegration(this.db, workspaceId, kind, { apelido: null }, conta); this.limparAbandonadas(workspaceId, kind); }
    else {
      const outra = contasDe(this.db, workspaceId, kind).find((c) => c.conta && c.state === 'connected');
      if (outra) await this.tornarPrincipal(workspaceId, null, kind, outra.conta);
    }
    this.bus.publish(workspaceId, 'integrations.changed', { kind });
  }

  /** Volta do login com a conta: só aqui a integração vira "conectada" (o provedor já entregou o acesso). */
  markSso(kind: SsoKind, workspaceId: string, userId: string, account: string, conta = ''): void {
    this.db.run("UPDATE integrations SET origem_workspace_id = NULL, origem_conta = '' WHERE workspace_id = ? AND kind = ? AND conta = ?", workspaceId, kind, conta);
    setIntegration(this.db, workspaceId, kind, { state: 'connected', account_label: account.slice(0, 120), connected_at: now(), last_error: null }, conta);
    this.reativarQuemUsa(workspaceId, kind, conta);
    audit(this.db, this.bus, { workspaceId, actorType: 'user', actorId: userId, action: 'integration.connect', targetType: 'integration', targetId: kind, evidence: { account, ...(conta ? { conta } : {}) }, result: conta ? 'outra conta conectada (login com a conta)' : `conectado (login com a conta)` });
    this.bus.publish(workspaceId, 'integrations.changed', { kind });
  }

  /**
   * A mesma conta do serviço já está noutra linha deste aplicativo neste workspace (entrou duas vezes com o mesmo e-mail): a
   * nova sai, e a de antes continua. Devolve o nome da que já estava.
   */
  repetidaNoLogin(kind: SsoKind, workspaceId: string, conta: string, account: string): string | null {
    const outra = contasDe(this.db, workspaceId, kind).find((c) => c.conta !== conta && c.state !== 'off' && fold(this.secrets.read<{ account?: string }>(workspaceId, kind, c.conta)?.account ?? c.account_label ?? '') === fold(account));
    return outra ? nomeDaConta(outra) || account : null;
  }

  connectedChannels(workspaceId: string): boolean {
    return !!this.db.get("SELECT 1 AS x FROM integrations WHERE workspace_id = ? AND kind IN ('whatsapp', 'microsoft', 'google') AND state = 'connected'", workspaceId);
  }
}
