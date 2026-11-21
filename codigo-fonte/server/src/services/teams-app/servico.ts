/**
 * Conversar com a equipe pelo Teams (app público, contrato v1). A pessoa fala com o app no Teams; o serviço do Teams
 * (relé, nosso) guarda e entrega aqui pela conexão de saída deste Ergon. Cada pessoa ligada tem UMA conversa "Teams" com
 * o coordenador: a mensagem dela entra como mensagem dela (a mesma regra do app: o que ela pede vai direto, o resto pede
 * cartão), a resposta do coordenador volta ao Teams, as confirmações viram cartões com Aprovar/Recusar (o clique decide
 * pela MESMA função da tela) e o que precisa dela em "Com você" vira aviso no Teams (ligado por padrão).
 * O mesmo serviço leva os bots do Ergon no Discord e no Telegram (zero configuração para a pessoa): cada vínculo sabe a
 * plataforma, e cada pessoa tem UMA conversa com o coordenador por plataforma, com a nota do canal dela; respostas,
 * "digitando", cartões e avisos vão para a plataforma da conversa. A conta do Discord liga pelo código (como o Teams) ou
 * pelo "Adicionar ao Discord" (link de uso único, quando o serviço oferece); a do Telegram, pelo link de uso único.
 * Nada daqui depende do módulo opcional da nuvem: funciona igual na edição Community. O endereço do serviço vem do
 * ambiente (ERGON_TEAMS_RELAY_URL), do "Ajuste da instalação" ou, sem nenhum dos dois, é o serviço oficial
 * (RELE_PADRAO, https://api.ergonworld.com/canais): esse só é oferecido depois que a saúde dele responde. "off" no
 * ambiente ou no ajuste desliga. Sem endereço, nada liga.
 */
import type { Config } from '../../config.ts';
import type { Db } from '../../db/db.ts';
import { HttpError, id as novoId, now } from '../../lib/util.ts';
import { log } from '../../lib/log.ts';
import { decrypt, encrypt } from '../../security/crypto.ts';
import { CLOSED_VALUE } from '../../security/fields.ts';
import type { Vault } from '../../security/keys.ts';
import type { Bus, BusEvent } from '../bus.ts';
import { createConversation, sendMessage } from '../chat.ts';
import type { WorkspaceOwners } from '../people.ts';
import { pendingDecisions } from '../proposals.ts';
import { avisoDoCard } from '../resumo-tarefa.ts';
import { workspaceTz } from '../routine-proposals.ts';
import type { RunExecutor } from '../runs.ts';
import { instanceSetting, setInstanceSetting } from '../security.ts';
import { coordinatorFor } from '../team-query.ts';
import { migrarTeamsApp, type PessoaRow, type Plataforma, type SaidaRow, type VinculoRow } from './armazenamento.ts';
import type { CanaisExternos, PedidoExterno } from '../canais/externo.ts';
import { resumoVisivelDaAprovacao } from '../aprovacao-cartao.ts';
import { ABRIR_LONGO, KINDS_INTEIROS, LIMITE_TEAMS, cabeNoCanal, dataHora, montarCartao, montarTexto, partesDoResumo, resumoParaTeams, textoParaTeams, type DesenhoCartao, type EstadoDecisao, type ItemCartao } from './cartoes.ts';
import { ClienteRele, ErroDoRele, type Ack, type EstadoConexao, type Quadro } from './cliente.ts';
import {
  ID_CLAIM, ID_INSTALACAO, ID_VINCULO, PROTOCOLO, abrirSelado, aadDoSelo, assinar, enderecoDoRele, gerarChaves, hashDaConta, mensagemRegistro, normalizarCodigo,
  personRefDe, tokenConfere, wsDoRele, type ChavesInstalacao, type Selado,
} from './protocolo.ts';

/** A instrução do canal (contrato, 7.2 item 1): quem escreve e por onde. */
export const NOTA_TEAMS = 'Canal: conversa pelo Teams. Quem escreve é a pessoa dona do workspace, pela conta do Teams ligada por código. A resposta vai para o Teams: texto simples, sem tabelas largas.';
const TITULO_CONVERSA = 'Teams';
/** O serviço de conversa da nuvem do Ergon (Teams, Discord, Telegram): ninguém precisa configurar nada. */
export const RELE_PADRAO = 'https://api.ergonworld.com/canais';
/** Os bots oficiais (Telegram, Discord) pelo mesmo serviço: nome, título da conversa e instrução do canal. */
export type PlataformaBot = 'telegram' | 'discord';
export const PLATAFORMAS_BOT: readonly PlataformaBot[] = ['telegram', 'discord'];
const NOME_PLAT: Record<Plataforma, string> = { teams: 'Teams', telegram: 'Telegram', discord: 'Discord' };
/** A instrução do canal no Discord: mensagens de até 2000 caracteres, markdown simples. */
export const NOTA_DISCORD = 'Canal: conversa pelo Discord (bot oficial do Ergon). Quem escreve é o membro do workspace dono da conta do Discord ligada (por código ou pelo "Adicionar ao Discord"). A resposta vai para o Discord: texto curto em markdown simples, sem tabelas (cada mensagem do Discord tem até 2000 caracteres).';
export const NOTA_TELEGRAM = 'Canal: conversa pelo Telegram (bot oficial do Ergon). Quem escreve é o membro do workspace dono da conta do Telegram ligada pelo link de uso único. A resposta vai para o Telegram: texto simples, sem tabelas largas.';
const notaDe = (plat: Plataforma) => (plat === 'teams' ? NOTA_TEAMS : plat === 'discord' ? NOTA_DISCORD : NOTA_TELEGRAM);
/** A resposta do agente no Discord: até umas 3 mensagens (o resto continua no Ergon). */
const MAX_RESPOSTA: Record<Plataforma, number | undefined> = { teams: undefined, telegram: undefined, discord: 6000 };
/** O que o serviço oferece (GET /v1/info), guardado na instalação: sem rede, a tela já sabe o que mostrar. */
interface InfoDoRele {
  base: string; teams: boolean; teamsAppId: string | null;
  /** o bot do Ergon no Discord: o link de adicionar é montado aqui pelo id; `linkStart` = o serviço faz o "Adicionar ao Discord" com state */
  discord: { applicationId: string; installUrl: string; botName: string; linkStart: boolean } | null;
  telegram: { botUsername: string | null } | null;
  at: number;
}
/** O que só se aprova dentro do app: decisão nascida de um pedido de risco vindo de fora. */
const SO_NO_APP = 'Por segurança, isto só se decide dentro do app do Ergon: abra o Ergon para aprovar ou recusar.';

/** Para o agente, quando o pedido chegou com atraso (a fila do serviço guardou enquanto este Ergon estava fechado). */
const notaDeAtraso = (quando: string, plat: Plataforma = 'teams') => `Pedido enviado pelo ${NOME_PLAT[plat]} em ${quando}, entregue agora com atraso (este Ergon estava fechado). Antes de agir no que depende de data ou hora, confirme com a pessoa.`;
/** Mais velho que isto (ou vindo da fila do serviço), o pedido é tratado como atrasado. */
const ATRASO_MS = 10 * 60_000;

const DIA = 86_400_000;
/** O relé guarda o pedido até 60 dias, até o Ergon abrir: o id das entregas já recebidas fica um dia a mais (sem repetir). */
const ENTRADA_VALE_MS = 61 * DIA;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** "Locatário" das contas pessoais da Microsoft: não é uma organização. */
const MSA_TENANT = '9188040d-6c67-4c5b-b112-36a304b66dad';
/** Erros de código por pessoa (antes de ir ao serviço, que bloqueia a instalação inteira com 5 em 15 min). */
const ERROS_POR_PESSOA = 3;
const JANELA_ERROS_MS = 15 * 60_000;
class ConteudoInvalido extends Error { constructor() { super('conteúdo inválido'); } }
/** Erros do serviço de conversa na tela (contrato, 7.2), na voz da plataforma. */
const ERROS = (plat: Plataforma): Record<string, [number, string]> => {
  const n = NOME_PLAT[plat];
  return {
    code_invalid: [400, 'Código não encontrado. Confira e tente de novo.'],
    code_expired: [400, `Este código venceu. Mande qualquer mensagem ${plat === 'teams' ? 'ao app no Teams' : `ao bot Ergon no ${n}`} para receber outro.`],
    too_many_attempts: [429, 'Muitas tentativas. Espere 15 minutos.'],
    already_linked: [409, `Esta conta do ${n} já está ligada a outro Ergon. No ${n}, mande "desligar" e peça um código novo.`],
    limit_reached: [409, `Você já ligou 3 contas do ${n}. Desligue uma para ligar outra.`],
    claim_expired: [400, 'A confirmação demorou demais. Digite o código de novo.'],
    // a instalação acabou de se registrar no serviço (contrato 12.2): a tela espera e tenta de novo sozinha
    not_ready: [503, `Preparando a conexão com o ${n}…`],
    offline: [503, `Sem conexão com o serviço do ${n} agora. Tente de novo em instantes.`],
    timeout: [503, `O serviço do ${n} não respondeu a tempo. Tente de novo em instantes.`],
  };
};
const erroDaTela = (code: string, plat: Plataforma = 'teams') => {
  const E = ERROS(plat);
  const [s, m] = E[code] ?? [502, `O serviço do ${NOME_PLAT[plat]} não aceitou agora. Tente de novo em instantes.`];
  return new HttpError(s, code in E ? code : 'teams_relay', m);
};

/** O que identifica uma reserva declarada (para saber se o serviço já tem a mesma). */
const chaveDaReserva = (installationId: string, sws: string, pessoas: string[]) => `${installationId}|${sws}|${[...pessoas].sort().join(',')}`;

type Problema = 'assinatura' | 'revogada' | 'versao' | 'substituida' | 'religar' | 'registro' | null;

/**
 * De quem é a conta do Teams que pediu o código, comparada com a conta Microsoft 365 ligada a este workspace (contrato
 * 12.1). O nome mostrado é escolhido pela própria conta do Teams: só `sua` dispensa a escolha consciente.
 * - sua: a mesma conta (tenant e objeto iguais);
 * - outra_pessoa: a mesma organização, outra conta;
 * - organizacao: a mesma organização, sem como conferir a conta (a conexão Microsoft é anterior a esta conferência);
 * - outra_organizacao: outra organização;
 * - sem_conferir: sem conta Microsoft ligada (ou o serviço não informou), então não dá para conferir.
 */
type ContaDoTeams = 'sua' | 'outra_pessoa' | 'organizacao' | 'outra_organizacao' | 'sem_conferir';

interface TeamsAppDeps {
  db: Db; bus: Bus; cfg: Config; vault: Vault; executor: RunExecutor; owners: WorkspaceOwners;
  /** a mesma decisão de POST /api/proposals/:id (conexões, depois de ler e as demais), com os mesmos ganchos */
  decidir: (ws: string, userId: string, proposalId: string, decisao: 'apply' | 'reject') => Promise<{ status: string; result: string }>;
  edition: 'community' | 'private';
  appVersion: string;
  fetch?: typeof fetch;
  /** a conta Microsoft 365 ligada a este workspace (locatário, objeto e endereço), para conferir a conta do Teams na ligação */
  contaMicrosoft?: (ws: string) => { tid?: string; oid?: string; account?: string } | null;
}

/** Ajustes de tempo (os testes encurtam). */
interface AjustesTeams {
  avisosMs: number; saidaMs: number; digitandoMs: number; atrasoMs: number;
  /** o serviço oficial ainda não respondeu à saúde: de quanto em quanto tempo confere de novo (1 h; a tela aberta confere a cada minuto) */
  saudeMs?: number;
  /** prazo dos pedidos da tela ao serviço (ligar/desligar, avisos): o estado daqui já foi gravado, a conexão seguinte confere */
  pedidoMs?: number;
  /** primeira espera depois de um registro recusado (dobra a cada falha, até 1 h) */
  registroMs?: number;
  cliente?: { baseMs?: number; tetoMs?: number; reenvioMs?: number; semPingMs?: number; zerarAposMs?: number };
}

/** A reserva declarada no serviço (o computador) e quem atende (a nuvem). */
interface ReservaDesejada { ws: string; installationId: string; sws: string }
interface BindingDoRele { primary?: string; workspaceId?: string; bindingId: string; personRef: string; status: 'active' | 'paused'; notices: boolean; teamsName?: string; linkedAt?: string; claimId?: string; canal?: string; platform?: string }
interface ClaimLocal { userId: string; ws: string; teamsName: string; expiresAt: number; conta: ContaDoTeams; plat: Plataforma }
/** A plataforma que o serviço informou (`canal` ou `platform`, os dois nomes que ele manda); sem nenhum, Teams. */
const platDe = (v: unknown): Plataforma => (v === 'discord' || v === 'telegram' ? v : 'teams');

export class TeamsApp {
  readonly d: TeamsAppDeps;
  ajustes: AjustesTeams = { avisosMs: 60_000, saidaMs: 5_000, digitandoMs: 90_000, atrasoMs: 150 };
  cliente: ClienteRele | null = null;
  problema: Problema = null;
  teamsAppUrl: string | null = null;
  /** o que o serviço oferece (GET /v1/info), guardado: a tela não espera a rede para saber o que mostrar */
  info: InfoDoRele | null = null;
  private registradoDeNovo = false;
  private fila: Promise<void> = Promise.resolve();
  /** o relógio deste computador (os testes adiantam ou atrasam) */
  agora: () => number = Date.now;
  private claims = new Map<string, ClaimLocal>();
  /** link.confirm mandado e ainda sem resposta (ou que caiu sem resposta há pouco): na reconciliação, o vínculo é adotado */
  private confirmando = new Map<string, ClaimLocal & { ate: number }>();
  private errosDeCodigo = new Map<string, number[]>();
  private registroFalhas = 0;
  /** a última espera depois de um registro recusado (diagnóstico e testes) */
  esperaDoRegistro = 0;
  private decidindo = new Set<string>();
  /** o que fazer depois do ack de uma entrega (o "digitando", a decisão de um clique) */
  private depoisDoAck: Array<() => void> = [];
  private assinaturas = new Map<string, () => void>();
  private agendados = new Map<string, NodeJS.Timeout>();
  private timers: NodeJS.Timeout[] = [];
  private avisosTimers = new Map<string, NodeJS.Timeout>();
  private digitando = new Map<string, { bindingId: string; timer: NodeJS.Timeout }>();
  private emVooPorVinculo = new Set<string>();
  private ligado = false;
  private iniciando = false;
  private varreduraTimer: NodeJS.Timeout | null = null;
  /** O serviço oficial respondeu à saúde (e quando foi conferido). Endereço escolhido à mão não passa por isso. */
  private saudeOficial: { ok: boolean; em: number } | null = null;
  private conferindoSaude: Promise<boolean> | null = null;
  private saudeTimer: NodeJS.Timeout | null = null;
  /** as plataformas de bot que o serviço tem ligadas (saúde ou /v1/info) */
  plataformasDoRele: Record<PlataformaBot, boolean> = { telegram: false, discord: false };
  /** links de uso único pedidos há pouco (por personRef): a reconciliação adota o vínculo cujo link.added se perdeu */
  private iniciados = new Map<string, { userId: string; ws: string; ate: number }>();
  /**
   * A camada comum dos canais externos (services/canais/externo.ts): cada conta ligada é de um membro e o pedido age como
   * ele, com o papel dele; risco vai a um cartão no app; volume incomum pausa; tudo na auditoria. O app liga com
   * `usarCamadaComum` (sem ela, como antes: só a pessoa dona liga contas).
   */
  externos: CanaisExternos | null = null;
  /** nuvem do Ergon World: quem atende aqui (a conta e o workspace locais do contêiner) as contas ligadas no computador */
  private nuvem: { userId: string; workspaceId: string; syncWorkspaceId: string } | null = null;
  /** os vínculos do computador que o serviço disse que esta instalação atende como reserva (o último `ready`) */
  private daReserva: BindingDoRele[] = [];
  /** o que o serviço tem como reserva desta instalação (a chave do último standby.set aceito ou do `ready`) */
  private reservaNoRele: string | null = null;
  private pedindoReserva = false;
  /** o comprovante do World para declarar a reserva (curto; renovado a cada consulta de GET /v1/cloud) */
  private comprovante: { exp: number; mac: string } | null = null;
  /** o serviço já disse, nesta conexão, quais vínculos esta instalação atende como reserva (antes disso não se apaga nada) */
  private reservaRecebida = false;
  /** este Ergon é o contêiner da nuvem do Ergon World (e não uma instalação "cloud" comum, hospedada pela pessoa) */
  private nuvemWorld(): boolean { return this.d.cfg.mode === 'cloud' && /^sws_[a-f0-9]{32}$/.test(process.env.ERGON_WORLD_WORKSPACE ?? ''); }

  constructor(d: TeamsAppDeps) {
    this.d = d;
    migrarTeamsApp(d.db);
    try {
      const v = JSON.parse(instanceSetting(d.db, 'teams_relay_info') ?? 'null') as InfoDoRele | null;
      if (v && typeof v.base === 'string') { this.info = v; this.teamsAppUrl = v.teamsAppId ? `https://teams.microsoft.com/l/app/${v.teamsAppId}` : null; }
    } catch { this.info = null; }
  }

  /** O id do canal na camada comum: `teams:oficial`, `telegram:oficial`, `discord:oficial` (o bot próprio é `telegram`). */
  static canalDe(plat: Plataforma): string { return `${plat}:oficial`; }
  private platDoCanal(channel: string): Plataforma | null {
    const m = /^(teams|telegram|discord):oficial$/.exec(channel);
    return m ? m[1] as Plataforma : null;
  }
  usarCamadaComum(ext: CanaisExternos): void {
    this.externos = ext;
    const entregar = ext.entregarAprovado, avisar = ext.avisarNoCanal;
    ext.entregarAprovado = (p) => { if (this.platDoCanal(p.channel)) this.entregarAprovado(p); else entregar?.(p); };
    ext.avisarNoCanal = (p) => {
      const plat = this.platDoCanal(p.channel);
      if (!plat) { avisar?.(p); return; }
      const b = this.vinculoDeResposta(p.memberId, plat);
      if (b) this.enfileirar(b, 'send', { text: p.texto, summary: resumoParaTeams(p.texto) }, 'system');
    };
    // saiu do workspace: as contas dele (Teams e bots) são desligadas
    ext.aoRemoverMembro((ws, u) => { for (const b of this.vinculosDe(u, ['active', 'paused']).filter((x) => x.workspace_id === ws)) void this.revoke(u, b.binding_id).catch(() => undefined); });
  }
  /** O papel do membro (o da camada comum; sem ela, o da tabela de membros). */
  papel(ws: string, userId: string): string | null {
    return this.externos ? this.externos.papel(ws, userId) : this.d.db.get<{ role: string }>('SELECT role FROM memberships WHERE workspace_id = ? AND user_id = ?', ws, userId)?.role ?? null;
  }
  /** A conversa é de um canal oficial? (para a regra da execução: escrita confirma no app, papel de leitura não escreve) */
  daConversa(conversationId: string | null | undefined): { channel: string; memberId: string; papel: 'owner' | 'admin' | 'editor' | 'viewer' } | null {
    if (!conversationId || !this.externos) return null;
    const p = this.conversaTeams(conversationId);
    if (!p) return null;
    return { channel: TeamsApp.canalDe(p.platform ?? 'teams'), memberId: p.user_id, papel: this.externos.papel(p.workspace_id, p.user_id) ?? 'viewer' };
  }
  /** O pedido aprovado no app (camada comum): vai à conversa da plataforma como pedido do membro. */
  private entregarAprovado(p: PedidoExterno & { proposalId: string; aprovadoPor: string }): void {
    const plat = this.platDoCanal(p.channel);
    const b = plat ? this.vinculoDeResposta(p.memberId, plat) : null;
    if (!b || !plat || b.workspace_id !== p.workspaceId || !this.d.db.workspaceOpen(b.workspace_id)) return;
    const conv = this.conversa(b.user_id, b.workspace_id, plat);
    const quem = this.d.db.get<{ nome: string | null; username: string }>('SELECT display_name AS nome, username FROM users WHERE id = ?', p.aprovadoPor);
    this.notaNaConversa(b.workspace_id, conv, `Sistema — o pedido abaixo chegou pelo ${NOME_PLAT[plat]} e foi aprovado no app por ${quem ? quem.nome || quem.username : 'quem administra o workspace'}.`);
    const crid = `aprovado-${p.proposalId}`.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 64);
    try {
      sendMessage(this.d.db, this.d.bus, this.d.executor, b.workspace_id, b.user_id, conv, p.text.slice(0, this.d.cfg.maxInputChars), crid, this.d.cfg.maxConversationMessages, this.d.cfg.maxInputChars, { queue: true });
      this.enfileirar(b, 'send', { text: 'Aprovado no Ergon: a equipe começou o seu pedido.', summary: 'Aprovado no Ergon' }, 'system');
    } catch (err) { log.warn({ erro: (err as Error).message.slice(0, 120) }, 'canal oficial: pedido aprovado não entrou na conversa'); }
  }

  // ------------------------------------------------------------------------------------------------ configuração
  /** O endereço do serviço do Teams: o do ambiente (prioridade), o ajuste da instalação ou o oficial. null = nenhum. */
  base(): string | null { return this.desligadoNoAjuste() ? null : this.escolhido() ?? enderecoDoRele(this.d.cfg.teamsRelayOficial); }
  /** "off" no ajuste da instalação (sem endereço no ambiente): o recurso fica desligado. ("off" no ambiente: config.ts.) */
  private desligadoNoAjuste(): boolean { return !this.d.cfg.teamsRelayUrl && /^off$/i.test(instanceSetting(this.d.db, 'teams_relay_url')?.trim() ?? ''); }
  /** O endereço escolhido de propósito (ambiente ou ajuste): vale sem conferir a saúde. */
  private escolhido(): string | null { return enderecoDoRele(this.d.cfg.teamsRelayUrl) ?? enderecoDoRele(instanceSetting(this.d.db, 'teams_relay_url')); }
  /** O que o serviço oferece, se a resposta guardada é deste endereço. */
  private infoAtual(): InfoDoRele | null { const b = this.base(); return b && this.info?.base === b ? this.info : null; }
  /** O endereço em uso é o serviço oficial (nada escolhido no ambiente nem no ajuste). */
  oficial(): boolean { return !this.escolhido() && !this.desligadoNoAjuste() && !!enderecoDoRele(this.d.cfg.teamsRelayOficial); }
  /**
   * Oferecido na tela: há endereço e, se é o oficial, a saúde dele já respondeu alguma vez (ou esta instalação já está
   * registrada nele: relé fora do ar depois disso é só "sem conexão", e as contas ligadas continuam na tela).
   */
  disponivel(): boolean { return !!this.base() && (!this.oficial() || this.saudeOficial?.ok === true || !!this.instalacao()); }
  enderecoDoAmbiente(): boolean { return !!this.d.cfg.teamsRelayUrl; }
  /** Ajuste da instalação (pessoa administradora), só quando o ambiente não define. O próprio oficial (ou vazio) volta ao padrão. */
  definirEndereco(url: string | null): void {
    if (this.enderecoDoAmbiente()) throw new HttpError(409, 'env', 'O endereço já vem definido na instalação e não muda por aqui.');
    const off = !!url && /^off$/i.test(url.trim());
    if (url && !off && !enderecoDoRele(url)) throw new HttpError(400, 'url', 'Use um endereço https (ou "off" para desligar).');
    const novo = off ? 'off' : url ? enderecoDoRele(url)! : '';
    setInstanceSetting(this.d.db, 'teams_relay_url', novo === enderecoDoRele(this.d.cfg.teamsRelayOficial) ? '' : novo);
    this.saudeOficial = null;
    void this.reiniciar();
  }

  /**
   * Confere a saúde do serviço oficial (GET /healthz → {"ok":true}). Antes de responder (o relé ainda não está no ar),
   * a tela mostra "ainda não disponível" e este Ergon não registra nada nem gera chaves.
   */
  conferirSaude(): Promise<boolean> {
    const base = this.base();
    if (!base || !this.oficial()) return Promise.resolve(!!base);
    if (!this.conferindoSaude) {
      this.conferindoSaude = (async () => {
        let ok = false;
        try {
          const r = await (this.d.fetch ?? fetch)(`${base}/healthz`, { signal: AbortSignal.timeout(10_000) });
          const j = r.ok ? await r.json().catch(() => null) as { ok?: unknown; platforms?: Record<string, unknown> } | null : null;
          ok = j?.ok === true;
          // relé de antes, sem `platforms` na saúde: o /v1/info diz
          if (ok && j?.platforms) this.lerPlataformas(j.platforms);
        } catch { ok = false; }
        const antes = this.saudeOficial?.ok === true;
        this.saudeOficial = { ok, em: this.agora() };
        if (ok !== antes) this.avisarTela(null);
        return ok;
      })().finally(() => { this.conferindoSaude = null; });
    }
    return this.conferindoSaude;
  }
  private lerPlataformas(p: Record<string, unknown> | null | undefined): void {
    const novo = { telegram: p?.telegram === true, discord: p?.discord === true };
    if (novo.telegram !== this.plataformasDoRele.telegram || novo.discord !== this.plataformasDoRele.discord) { this.plataformasDoRele = novo; this.avisarTela(null); }
  }
  /** Sem resposta do oficial: confere de novo mais tarde (um só agendamento por vez). */
  private conferirDepois(): void {
    if (this.saudeTimer || !this.ligado) return;
    this.saudeTimer = setTimeout(() => { this.saudeTimer = null; if (this.ligado) void this.start(); }, this.ajustes.saudeMs ?? 3600_000);
    this.saudeTimer.unref?.();
  }

  /** A chave do cofre que cifra as credenciais (null: instalação sem proteção, o mesmo nível dos demais segredos dela). */
  private chaveCofre(): Buffer | null { return this.d.vault.state() === 'open' ? this.d.vault.teamsRelayKey() : null; }
  private gravarChaves(k: ChavesInstalacao): void {
    const kk = this.chaveCofre(); const json = Buffer.from(JSON.stringify(k), 'utf8');
    setInstanceSetting(this.d.db, 'teams_relay_keys', kk ? `tk1.${encrypt(kk, json, 'teams-relay/keys').toString('base64url')}` : `tk0.${json.toString('base64url')}`);
  }
  private chavesCache: ChavesInstalacao | null = null;
  /** As chaves da instalação (geradas na primeira vez que o recurso é usado com endereço configurado). */
  chaves(criar = false): ChavesInstalacao | null {
    if (this.chavesCache) return this.chavesCache;
    const v = instanceSetting(this.d.db, 'teams_relay_keys');
    if (v?.startsWith('tk1.')) {
      const kk = this.chaveCofre();
      if (!kk) return null;
      this.chavesCache = JSON.parse(decrypt(kk, Buffer.from(v.slice(4), 'base64url'), 'teams-relay/keys').toString('utf8')) as ChavesInstalacao;
    } else if (v?.startsWith('tk0.')) {
      this.chavesCache = JSON.parse(Buffer.from(v.slice(4), 'base64url').toString('utf8')) as ChavesInstalacao;
      if (this.chaveCofre()) this.gravarChaves(this.chavesCache); // a instalação ganhou proteção: passa a ficar cifrada
    } else if (criar) {
      this.chavesCache = gerarChaves();
      this.gravarChaves(this.chavesCache);
    }
    return this.chavesCache;
  }
  personRef(userId: string): string | null { const k = this.chaves(); return k ? personRefDe(k, userId) : null; }
  private instalacao(): string | null {
    const id = instanceSetting(this.d.db, 'teams_relay_installation_id');
    return id && ID_INSTALACAO.test(id) && instanceSetting(this.d.db, 'teams_relay_installation_base') === this.base() ? id : null;
  }

  // ------------------------------------------------------------------------------------------------ ciclo de vida
  /** Liga (com o cofre aberto e o endereço configurado); sem isso, não tenta nada. */
  async start(): Promise<void> {
    this.ligado = true;
    for (const ws of new Set(this.d.db.all<{ w: string }>("SELECT DISTINCT workspace_id AS w FROM teams_bindings WHERE status IN ('active', 'paused')").map((r) => r.w))) this.assinar(ws);
    const base = this.base();
    if (!base || this.d.vault.state() !== 'open' || this.cliente || this.iniciando) return;
    // na nuvem, só depois de o workspace chegar pela sincronia (antes disso não há a quem entregar)
    if (this.nuvemWorld() && !this.nuvem) return;
    if (this.oficial() && this.saudeOficial?.ok !== true && !this.instalacao()) {
      // o serviço oficial ainda não respondeu: nada de registro nem de chaves até a saúde responder
      if (!(await this.conferirSaude())) { this.conferirDepois(); return; }
      if (!this.ligado || this.cliente || this.iniciando) return;
    }
    this.iniciando = true;
    try {
      if (!this.instalacao()) await this.registrar(base);
      this.registroFalhas = 0;
    } catch (e) {
      // recusado: tenta de novo com espera que dobra (30 s, 1 min, 2 min … até 1 h), sem bater no limite do serviço por
      // endereço (que travaria as outras instalações atrás da mesma rede)
      this.problema = 'registro';
      const espera = Math.min(3600_000, (this.ajustes.registroMs ?? 30_000) * 2 ** Math.min(this.registroFalhas++, 12));
      this.esperaDoRegistro = espera;
      log.warn({ erro: (e as Error).message.slice(0, 80), esperaS: Math.round(espera / 1000) }, 'teams: registro no serviço falhou; tenta de novo depois');
      const r = setTimeout(() => { if (this.ligado) void this.start(); }, espera); r.unref?.(); this.timers.push(r);
      this.avisarTela(null);
      return;
    } finally { this.iniciando = false; }
    if (!this.ligado || this.cliente) return;
    if (!this.varreduraTimer) { this.varreduraTimer = setInterval(() => this.varredura(), this.ajustes.saidaMs); this.varreduraTimer.unref?.(); }
    this.problema = null;
    void this.buscarInfo(base);
    this.cliente = new ClienteRele({
      url: wsDoRele(base), installationId: () => this.instalacao() ?? '', assinar: (m) => assinar(this.chaves()!, m),
      pessoas: () => this.pessoasLigadas(), aoQuadro: (f) => this.receber(f), aoPronto: (f) => this.pronto(f), aoParar: (c) => this.parou(c),
      aoEstado: () => this.avisarTela(null), ajustes: this.ajustes.cliente, agora: () => this.agora(),
    });
    this.cliente.ligar();
  }
  async stop(): Promise<void> {
    this.ligado = false;
    this.cliente?.encerrar(); this.cliente = null;
    for (const t of this.timers.splice(0)) clearTimeout(t);
    if (this.varreduraTimer) { clearInterval(this.varreduraTimer); this.varreduraTimer = null; }
    if (this.saudeTimer) { clearTimeout(this.saudeTimer); this.saudeTimer = null; }
    for (const t of this.agendados.values()) clearTimeout(t); this.agendados.clear();
    for (const t of this.avisosTimers.values()) clearTimeout(t); this.avisosTimers.clear();
    for (const x of this.digitando.values()) clearInterval(x.timer); this.digitando.clear();
    for (const u of this.assinaturas.values()) u(); this.assinaturas.clear();
    await this.fila.catch(() => undefined);
  }
  private async reiniciar(): Promise<void> { const era = this.ligado; await this.stop(); if (era) await this.start(); }
  estadoConexao(): EstadoConexao { return this.cliente?.estado ?? 'offline'; }

  private async registrar(base: string): Promise<void> {
    const k = this.chaves(true)!;
    const f = this.d.fetch ?? fetch;
    const tentar = async (desvio: number) => {
      const ts = new Date(this.agora() + desvio).toISOString();
      const r = await f(`${base}/v1/installations`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ protocol: PROTOCOLO, signPublicKey: k.ed25519Public, boxPublicKey: k.x25519Public, ts, proof: assinar(k, mensagemRegistro(k.ed25519Public, k.x25519Public, ts)), edition: this.d.edition, appVersion: this.d.appVersion }),
      });
      return { r, j: await r.json().catch(() => ({})) as { installationId?: string; serverTime?: string }, local: this.agora() };
    };
    let { r, j, local } = await tentar(0);
    // relógio deste computador fora da hora (contrato 12.8): o serviço diz a hora dele; a prova é refeita UMA vez com a
    // diferença corrigida. Recusado de novo, é a assinatura mesmo (vai para o diagnóstico, sem repetir aqui)
    if (r.status === 401 && typeof j.serverTime === 'string' && Number.isFinite(Date.parse(j.serverTime))) {
      const desvio = Date.parse(j.serverTime) - local;
      log.warn({ desvioS: Math.round(desvio / 1000) }, 'teams: relógio deste computador fora da hora do serviço; registro refeito com a hora dele');
      ({ r, j } = await tentar(desvio));
    }
    if (!r.ok || !j.installationId || !ID_INSTALACAO.test(j.installationId)) throw new Error(`registro recusado (${r.status})`);
    setInstanceSetting(this.d.db, 'teams_relay_installation_id', j.installationId);
    setInstanceSetting(this.d.db, 'teams_relay_installation_base', base);
  }
  /**
   * O que o serviço oferece (Teams, Discord, Telegram), guardado na instalação. O link de adicionar o bot do Discord é
   * montado aqui, com o id do app que o serviço informou (só números). Serviço de antes, sem `platforms`: vale o que os
   * campos `discord` e `telegram` dizem; sem `teams`, era só do Teams.
   */
  private async buscarInfo(base: string): Promise<void> {
    try {
      const r = await (this.d.fetch ?? fetch)(`${base}/v1/info`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) return;
      const j = await r.json() as {
        teams?: unknown; teamsAppId?: unknown; platforms?: Record<string, unknown>;
        discord?: { applicationId?: unknown; botName?: unknown; linkStart?: unknown } | null; telegram?: { botUsername?: unknown } | null;
      };
      const teamsAppId = typeof j.teamsAppId === 'string' && /^[0-9a-f-]{36}$/i.test(j.teamsAppId) ? j.teamsAppId : null;
      const app = j.discord && typeof j.discord === 'object' && typeof j.discord.applicationId === 'string' && /^\d{15,25}$/.test(j.discord.applicationId) ? j.discord.applicationId : null;
      const nome = typeof j.discord?.botName === 'string' ? j.discord.botName.replace(/[\r\n<>]/g, '').trim().slice(0, 40) : '';
      const tg = j.telegram && typeof j.telegram === 'object' ? j.telegram : null;
      const info: InfoDoRele = {
        base, teams: typeof j.teams === 'boolean' ? j.teams : true, teamsAppId,
        discord: app ? { applicationId: app, installUrl: `https://discord.com/oauth2/authorize?client_id=${app}`, botName: nome || 'Ergon', linkStart: j.discord?.linkStart === true } : null,
        telegram: tg ? { botUsername: typeof tg.botUsername === 'string' && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(tg.botUsername) ? tg.botUsername : null } : null,
        at: this.agora(),
      };
      const mudou = JSON.stringify({ ...this.info, at: 0 }) !== JSON.stringify({ ...info, at: 0 });
      this.info = info;
      this.teamsAppUrl = teamsAppId ? `https://teams.microsoft.com/l/app/${teamsAppId}` : null;
      setInstanceSetting(this.d.db, 'teams_relay_info', JSON.stringify(info));
      this.lerPlataformas(j.platforms ?? { discord: !!info.discord, telegram: !!info.telegram });
      if (mudou) this.avisarTela(null);
    } catch { /* fica o que estava guardado */ }
  }

  /** A conexão parou por um motivo que não é só reconectar (contrato, 2.2). */
  private parou(code: number): void {
    if (code === 4401) { this.problema = 'assinatura'; log.warn({ code }, 'teams: assinatura recusada; tenta de novo em 10 minutos'); this.cliente?.agendar(10 * 60_000); }
    else if (code === 4403) this.problema = 'revogada';
    else if (code === 4426) this.problema = 'versao';
    else if (code === 4409) this.problema = 'substituida';
    else if (code === 4404) {
      // o serviço perdeu a base: registra de novo (uma vez) e os vínculos daqui ficam desligados (a pessoa liga de novo)
      this.d.db.run("UPDATE teams_bindings SET status = 'revoked', revoked_by = 'relay', updated_at = ? WHERE status IN ('active', 'paused', 'revoking')", now());
      this.problema = 'religar';
      if (!this.registradoDeNovo) {
        this.registradoDeNovo = true;
        const base = this.base();
        if (base) void this.registrar(base).then(() => this.cliente?.ligar()).catch(() => { this.problema = 'registro'; });
      }
    }
    this.avisarTela(null);
  }

  // ------------------------------------------------------------------------------------------------ pessoas e vínculos
  private vinculo(bindingId: string): VinculoRow | null { return this.d.db.get<VinculoRow>('SELECT * FROM teams_bindings WHERE binding_id = ?', bindingId) ?? null; }
  private vinculosDe(userId: string, estados = ['active', 'paused'], plat?: Plataforma): VinculoRow[] {
    return this.d.db.all<VinculoRow>(`SELECT * FROM teams_bindings WHERE user_id = ? AND status IN (${estados.map(() => '?').join(', ')})${plat ? ' AND platform = ?' : ''} ORDER BY created_at, rowid`, userId, ...estados, ...(plat ? [plat] : []));
  }
  private pessoa(userId: string, plat: Plataforma = 'teams'): PessoaRow | null { return this.d.db.get<PessoaRow>('SELECT * FROM teams_people WHERE user_id = ? AND platform = ?', userId, plat) ?? null; }
  private garantirPessoa(userId: string, ws: string, plat: Plataforma = 'teams'): PessoaRow {
    this.d.db.run('INSERT INTO teams_people (user_id, platform, workspace_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (user_id, platform) DO NOTHING', userId, plat, ws, now());
    return this.pessoa(userId, plat)!;
  }
  /** As plataformas em que a pessoa tem conversa (a do Teams e as dos bots). */
  private plataformasDe(userId: string): Plataforma[] { return this.d.db.all<{ platform: Plataforma }>('SELECT platform FROM teams_people WHERE user_id = ?', userId).map((r) => r.platform); }
  /** "Conversar pelo Teams" (chave geral da pessoa, por plataforma): ausente = ligado. */
  ligadoPara(userId: string, plat: Plataforma = 'teams'): boolean { return Number(this.pessoa(userId, plat)?.enabled ?? 1) === 1; }
  private pessoasLigadas(): Array<{ personRef: string; open: boolean }> {
    const k = this.chaves();
    if (!k) return [];
    return this.d.db.all<{ user_id: string; w: string }>("SELECT user_id, MIN(workspace_id) AS w FROM teams_bindings WHERE status IN ('active', 'paused', 'revoking') AND standby_of IS NULL GROUP BY user_id")
      .map((r) => ({ personRef: personRefDe(k, r.user_id), open: this.d.db.workspaceOpen(r.w) }));
  }
  /** A conversa "Teams" com o coordenador, para esta conversa: é dela? */
  conversaTeams(conversationId: string): PessoaRow | null { return this.d.db.get<PessoaRow>('SELECT * FROM teams_people WHERE conversation_id = ?', conversationId) ?? null; }
  /**
   * A instrução do canal para chat.ts (chatHooks.channelNote). Pedido que chegou com atraso (da fila do serviço, ou
   * escrito há mais de 10 minutos): o agente fica sabendo quando a pessoa escreveu, para não agir como se fosse agora.
   */
  notaDoCanal(conversationId: string, messageId?: string | null): string | null {
    const p = this.conversaTeams(conversationId);
    if (!p) return null;
    const plat = p.platform ?? 'teams';
    if (!messageId) return notaDe(plat);
    const r = this.d.db.get<{ sent_at: string | null; delayed: number }>(
      `SELECT i.sent_at, i.delayed FROM messages m JOIN teams_inbound i ON i.request_id = m.client_request_id
        WHERE m.id = ? AND m.conversation_id = ? AND i.kind = 'activity'`, messageId, conversationId);
    // pedido de fora: o agente fica sabendo de quem é (o papel do membro), e que prefira resumos (camada externa)
    const papel = this.externos?.papel(p.workspace_id, p.user_id);
    const nota = this.externos && papel ? `${notaDe(plat)}\n${this.externos.nota(papel, TeamsApp.canalDe(plat))}` : notaDe(plat);
    if (!r || !Number(r.delayed) || !r.sent_at) return nota;
    return `${nota}\n${notaDeAtraso(dataHora(r.sent_at, workspaceTz(this.d.db, p.workspace_id)), plat)}`;
  }

  /** A conversa da pessoa com o coordenador (uma por pessoa); nova se a de antes sumiu, foi arquivada ou encheu. */
  private conversa(userId: string, ws: string, plat: Plataforma = 'teams'): string {
    const p = this.garantirPessoa(userId, ws, plat);
    if (p.conversation_id && p.workspace_id === ws) {
      const c = this.d.db.get<{ id: string; n: number }>(
        `SELECT c.id, (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS n FROM conversations c JOIN agents a ON a.id = c.agent_id
          WHERE c.id = ? AND c.workspace_id = ? AND c.owner_user_id = ? AND c.sala = 0 AND c.archived_at IS NULL AND a.status = 'active'`, p.conversation_id, ws, userId);
      if (c && Number(c.n) < this.d.cfg.maxConversationMessages - 4) return c.id;
    }
    const agente = coordinatorFor(this.d.db, ws) ?? this.d.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY created_at LIMIT 1", ws)?.id;
    if (!agente) throw new HttpError(409, 'no_agent', 'sem ninguém ativo na equipe');
    const conv = createConversation(this.d.db, ws, userId, agente, plat === 'teams' ? TITULO_CONVERSA : NOME_PLAT[plat]);
    const cursor = Number(this.d.db.get<{ r: number }>('SELECT COALESCE(MAX(rowid), 0) AS r FROM messages')?.r ?? 0);
    this.d.db.run('UPDATE teams_people SET conversation_id = ?, workspace_id = ?, cursor_rowid = ?, updated_at = ? WHERE user_id = ? AND platform = ?', conv.id, ws, cursor, now(), userId, plat);
    return conv.id;
  }

  // ------------------------------------------------------------------------------------------------ eventos do Ergon
  private assinar(ws: string): void {
    if (this.assinaturas.has(ws)) return;
    this.assinaturas.set(ws, this.d.bus.subscribe(ws, (e) => this.aoEvento(ws, e)));
  }
  private aoEvento(ws: string, e: BusEvent): void {
    if (e.type === 'teams.changed' || e.type === 'runs.live' || e.type === 'audit.created') return;
    if (!['messages.changed', 'proposals.changed', 'runs.changed', 'tasks.changed', 'rules.changed', 'conversations.changed'].includes(e.type)) return;
    this.agendar(`ws:${ws}`, () => this.atualizarWorkspace(ws));
  }
  private agendar(chave: string, fn: () => void, ms = this.ajustes.atrasoMs): void {
    if (this.agendados.has(chave)) return;
    const t = setTimeout(() => { this.agendados.delete(chave); try { fn(); } catch (err) { log.warn({ erro: (err as Error).message.slice(0, 120) }, 'teams: atualização falhou'); } }, ms);
    t.unref?.();
    this.agendados.set(chave, t);
  }
  /** Algo mudou no workspace: respostas novas, cartões novos, cartões decididos e avisos. */
  private atualizarWorkspace(ws: string): void {
    if (!this.d.db.workspaceOpen(ws)) return;
    const pessoas = new Set(this.d.db.all<{ user_id: string }>("SELECT DISTINCT user_id FROM teams_bindings WHERE workspace_id = ? AND status IN ('active', 'paused')", ws).map((r) => r.user_id));
    for (const u of pessoas) {
      this.encaminharRespostas(u);
      this.cartoesDaConversa(u);
      this.varrerAvisos(u, ws);
    }
    this.atualizarCartoes(ws);
    this.esvaziarSaida();
  }

  /** A pessoa abriu a parte dela: o serviço reentrega o que esperava por ela; e o que ficou para trás anda. */
  personOpened(userId: string): void {
    // primeiro uso: a proteção acabou de ser criada (o cofre abriu agora) e o recurso ainda não tinha ligado
    if (this.ligado && !this.cliente) void this.start();
    const ref = this.personRef(userId);
    if (!ref || !this.vinculosDe(userId, ['active', 'paused', 'revoking']).length) return;
    this.cliente?.enviar({ type: 'person.state', personRef: ref, open: true });
    for (const ws of new Set(this.vinculosDe(userId).map((b) => b.workspace_id))) this.agendar(`ws:${ws}`, () => this.atualizarWorkspace(ws));
    this.retomarDecisoes(); // o clique que chegou com a parte dela fechando no meio
  }

  private avisarTela(userId: string | null): void {
    // sem pessoa: o estado da conexão mudou, e a tela de qualquer um mostra isso
    const wss = userId ? [...this.d.owners.owned(userId), ...this.vinculosDe(userId, ['active', 'paused', 'revoking', 'revoked']).map((b) => b.workspace_id)] : this.d.db.all<{ w: string }>('SELECT id AS w FROM workspaces').map((r) => r.w);
    for (const ws of new Set(wss)) this.d.bus.publish(ws, 'teams.changed', {});
  }

  /** A conta da pessoa saiu deste computador: as contas do Teams dela são desligadas no serviço (e aqui). */
  async pessoaRemovida(userId: string): Promise<void> {
    for (const b of this.vinculosDe(userId, ['active', 'paused', 'revoking', 'revoked'])) {
      if (b.status === 'revoked') { this.apagarVinculo(b.binding_id); continue; }
      this.d.db.run("UPDATE teams_bindings SET status = 'revoking', updated_at = ? WHERE binding_id = ?", now(), b.binding_id);
      this.pedirRevogar(b.binding_id);
    }
    this.d.db.run('DELETE FROM teams_people WHERE user_id = ?', userId);
    this.d.db.run('DELETE FROM teams_noticed WHERE user_id = ?', userId);
  }

  // ------------------------------------------------------------------------------------------------ o que chega
  private receber(f: Quadro): void {
    this.fila = this.fila.then(() => this.tratar(f)).catch((err: unknown) => { log.warn({ tipo: f.type, erro: (err as Error).message.slice(0, 120) }, 'teams: entrega não tratada'); });
  }
  private async tratar(f: Quadro): Promise<void> {
    const c = this.cliente;
    if (!c) return;
    switch (f.type) {
      case 'activity': case 'card.action': case 'link.revoked': case 'link.added': {
        if (typeof f.id !== 'string' || !/^dlv_[A-Za-z0-9_-]{8,40}$/.test(f.id)) return;
        let ack: Record<string, unknown>;
        this.depoisDoAck = [];
        try { ack = f.type === 'activity' ? this.mensagem(f) : f.type === 'card.action' ? this.clique(f) : f.type === 'link.added' ? await this.adicionado(f) : this.revogado(f); }
        catch (err) {
          // erros definitivos viram recusa (o serviço apaga e responde à pessoa no Teams, contrato 12.7): conteúdo que não
          // abre, ninguém ativo na equipe, ou o que a conversa recusou (cheia, longa demais). Problema passageiro daqui (base
          // ocupada, cofre trancando no meio): sem ack, o serviço entrega de novo
          if (err instanceof ConteudoInvalido) ack = { ok: false, status: 'rejected', error: { code: 'invalid' } };
          else if (err instanceof HttpError && err.code === 'no_agent') ack = { ok: false, status: 'rejected', error: { code: 'no_agent' } };
          else if (err instanceof HttpError && err.status < 500) ack = { ok: false, status: 'rejected', error: { code: 'failed' } };
          else { log.warn({ tipo: f.type, erro: (err as Error).message.slice(0, 120) }, 'teams: entrega não gravada; o serviço entrega de novo'); return; }
          this.depoisDoAck = [];
        }
        c.enviar({ type: 'ack', id: f.id, ...ack });
        const depois = this.depoisDoAck; this.depoisDoAck = [];
        if (ack.status === 'accepted') for (const fn of depois) { try { fn(); } catch (err) { log.warn({ erro: (err as Error).message.slice(0, 120) }, 'teams: depois do ack'); } }
        return;
      }
      case 'standby.bindings': this.importarReserva(f.standbyBindings); return; // a reserva mudou com esta instalação conectada
      case 'queue.begin': case 'queue.end': return; // o começo e o fim do que ficou guardado no serviço: as entregas vêm no meio
      case 'error': return;
      case 'ack': return; // confirmação que chegou depois do prazo do pedido: nada a fazer
      default:
        // tipo novo que esta versão não conhece: avisa sem fechar (contrato, 2.5)
        c.enviar({ type: 'error', code: 'unknown_type', ref: typeof f.id === 'string' ? f.id : null });
    }
  }

  /** O vínculo da entrega confere com a pessoa (personRef) e está de pé? */
  private vinculoDaEntrega(f: Quadro): VinculoRow | null {
    const b = typeof f.bindingId === 'string' ? this.vinculo(f.bindingId) : null;
    if (!b || (b.status !== 'active' && b.status !== 'paused') || (typeof f.personRef === 'string' && f.personRef !== b.person_ref)) return null;
    return b;
  }
  private jaRecebida(deliveryId: string): boolean { return !!this.d.db.get('SELECT 1 AS x FROM teams_inbound WHERE delivery_id = ?', deliveryId); }
  private abrir(f: Quadro): Record<string, unknown> {
    let v: unknown;
    try { v = abrirSelado(this.chaves()!, f.sealed as Selado, aadDoSelo(String(f.id), this.instalacao() ?? '', f.type)); } catch { throw new ConteudoInvalido(); }
    if (!v || typeof v !== 'object') throw new ConteudoInvalido();
    return v as Record<string, unknown>;
  }

  /** Mensagem da pessoa (contrato, 7.2 item 1): na conversa "Teams" com o coordenador, como mensagem dela. */
  private mensagem(f: Quadro): Record<string, unknown> {
    const b = this.vinculoDaEntrega(f);
    if (!b) return { ok: false, status: 'rejected', error: { code: 'unknown_person' } };
    if (this.jaRecebida(String(f.id))) return { ok: true, status: 'accepted' };
    const plat = b.platform ?? 'teams';
    if (b.status === 'paused' || !this.ligadoPara(b.user_id, plat)) return { ok: false, status: 'rejected', error: { code: 'disabled' } };
    if (!this.d.db.workspaceOpen(b.workspace_id)) return { ok: true, status: 'person_locked' };
    const v = this.abrir(f);
    const texto = typeof v.text === 'string' ? v.text.trim() : '';
    if (!texto) return { ok: false, status: 'rejected', error: { code: 'invalid' } };
    const conv = this.conversa(b.user_id, b.workspace_id, plat);
    // a camada comum dos canais externos: age como ESTE membro, com o papel dele; o que ela segura não chega à equipe
    // (recusado, ou guardado num cartão que só se aprova no app)
    const ext = this.externos?.externalRequest({ channel: TeamsApp.canalDe(plat), workspaceId: b.workspace_id, memberId: b.user_id, text: texto, conversationId: conv });
    if (ext && !ext.ok) {
      this.d.db.run('INSERT INTO teams_inbound (delivery_id, user_id, kind, message_id, received_at, binding_id, state) VALUES (?, ?, ?, NULL, ?, ?, ?)', String(f.id), b.user_id, 'activity', now(), b.binding_id, `externo:${ext.motivo}`);
      // na nuvem não há tela para aprovar: o pedido de risco espera o computador
      const resposta = b.standby_of && ext.motivo === 'aprovar_no_app' ? 'Este pedido precisa de aprovação dentro do app do Ergon, por segurança. O seu Ergon está fechado: abra o Ergon no computador e peça de novo por lá.' : ext.resposta;
      if (resposta) this.enfileirar(b, 'send', { text: resposta, summary: resumoParaTeams(resposta) }, 'system');
      return { ok: true, status: 'accepted' };
    }
    const crid = `teams-${String(f.id).replace(/[^A-Za-z0-9-]/g, '-')}`.slice(0, 64);
    // quando a pessoa escreveu: o horário do Teams (ou o de quando o serviço recebeu). Da fila, ou velho, é atrasado
    const quando = [v.timestamp, f.receivedAt].find((x): x is string => typeof x === 'string' && Number.isFinite(Date.parse(x))) ?? null;
    const atrasado = f.fromQueue === true || (!!quando && this.agora() - Date.parse(quando) > ATRASO_MS);
    this.d.db.tx(() => {
      this.d.db.run('INSERT INTO teams_inbound (delivery_id, user_id, kind, message_id, received_at, binding_id, request_id, sent_at, delayed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        String(f.id), b.user_id, 'activity', null, now(), b.binding_id, crid, quando ? new Date(Date.parse(quando)).toISOString() : null, atrasado ? 1 : 0);
      // a primeira mensagem de cada conta do Teams ligada fica à vista no Ergon: quem não ligou esta conta percebe e desliga
      if (!b.first_message_at) {
        this.d.db.run('UPDATE teams_bindings SET first_message_at = ? WHERE binding_id = ?', now(), b.binding_id);
        const nome = b.teams_name && b.teams_name !== CLOSED_VALUE ? b.teams_name : 'sem nome';
        this.notaNaConversa(b.workspace_id, conv, `Sistema — primeira mensagem pela conta do ${NOME_PLAT[plat]} "${nome}", ligada em ${dataHora(b.created_at, workspaceTz(this.d.db, b.workspace_id))}. Se não foi você que ligou esta conta, desligue em Conexões › ${NOME_PLAT[plat]}.`);
      }
      const r = sendMessage(this.d.db, this.d.bus, this.d.executor, b.workspace_id, b.user_id, conv, texto.slice(0, this.d.cfg.maxInputChars), crid,
        this.d.cfg.maxConversationMessages, this.d.cfg.maxInputChars, { queue: true });
      this.d.db.run('UPDATE teams_inbound SET message_id = ? WHERE delivery_id = ?', r.messageId, String(f.id));
      this.d.db.run('UPDATE teams_people SET reply_binding = ?, updated_at = ? WHERE user_id = ? AND platform = ?', b.binding_id, now(), b.user_id, plat);
    });
    this.depoisDoAck.push(() => this.digitar(b.user_id, b.binding_id, true));
    return { ok: true, status: 'accepted' };
  }

  /** Nota do sistema na conversa (só no Ergon: sem execução, não vai ao Teams). */
  private notaNaConversa(ws: string, conv: string, texto: string): void {
    this.d.db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, run_id, created_at) VALUES (?, ?, ?, 'system', ?, 'local', NULL, ?)`,
      novoId('msg'), ws, conv, this.d.db.seal(ws, texto), now());
    this.d.bus.publish(ws, 'messages.changed', { conversationId: conv });
  }

  /**
   * Clique em Aprovar/Recusar (contrato, 3.5 e 6): confere o vínculo, a pessoa, o workspace, o `t` e a proposta. A
   * intenção fica gravada e o ack sai na hora; a decisão (que pode chamar a API de outro app e demorar) corre depois,
   * fora da fila das entregas: as mensagens seguintes não esperam por ela, e o serviço não responde "assim que o seu
   * Ergon estiver aberto" com o Ergon aberto (contrato 12.6). Reiniciar no meio: a decisão gravada é retomada.
   */
  private clique(f: Quadro): Record<string, unknown> {
    const b = this.vinculoDaEntrega(f);
    if (!b) return { ok: false, status: 'rejected', error: { code: 'unknown_person' } };
    if (this.jaRecebida(String(f.id))) return { ok: true, status: 'accepted' };
    if (b.status === 'paused' || !this.ligadoPara(b.user_id, b.platform ?? 'teams')) return { ok: false, status: 'rejected', error: { code: 'disabled' } };
    if (!this.d.db.workspaceOpen(b.workspace_id)) return { ok: true, status: 'person_locked' };
    const v = this.abrir(f);
    const data = (v.data ?? {}) as { p?: unknown; d?: unknown; t?: unknown };
    const p = typeof data.p === 'string' ? data.p : ''; const decisao = data.d;
    if (v.verb !== 'ergon.decidir' || !/^apr_[a-f0-9]{32}$/.test(p) || (decisao !== 'apply' && decisao !== 'reject') || !tokenConfere(this.chaves()!, p, b.binding_id, data.t)) {
      return { ok: false, status: 'rejected', error: { code: 'invalid' } };
    }
    const prop = this.d.db.get<{ status: string; kind: string; summary: string }>('SELECT status, kind, summary FROM agent_proposals WHERE id = ? AND workspace_id = ?', p, b.workspace_id);
    if (!prop) return { ok: false, status: 'rejected', error: { code: 'invalid' } };
    const registrar = (estado: 'feito' | 'decidindo') => this.d.db.run(
      'INSERT OR IGNORE INTO teams_inbound (delivery_id, user_id, kind, message_id, received_at, state, decision, binding_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      String(f.id), b.user_id, 'card.action', p, now(), estado, decisao, b.binding_id);
    if (prop.status !== 'proposed' || ['permission', 'question', 'segredo', 'info_request', 'handoff'].includes(prop.kind) || !cabeNoCanal(prop.kind, prop.summary, LIMITE_TEAMS) || !this.decidePeloCanal(b, p)) {
      // já decidido (no Ergon ou noutro cartão), ou é do tipo que só se responde no Ergon: o cartão diz isso
      this.atualizarCartaoDe(p, b, typeof v.cardActivityId === 'string' ? v.cardActivityId : null, true);
      registrar('feito');
      return { ok: true, status: 'accepted' };
    }
    registrar('decidindo');
    const id = String(f.id);
    this.depoisDoAck.push(() => { void this.decidirPendente(id); });
    return { ok: true, status: 'accepted' };
  }

  /** A decisão gravada de um clique: decide pela mesma função da tela, uma vez, e o cartão fica com a linha final. */
  private async decidirPendente(deliveryId: string): Promise<void> {
    if (this.decidindo.has(deliveryId)) return;
    const r = this.d.db.get<{ user_id: string; message_id: string; decision: string; binding_id: string | null }>(
      "SELECT user_id, message_id, decision, binding_id FROM teams_inbound WHERE delivery_id = ? AND kind = 'card.action' AND state = 'decidindo'", deliveryId);
    if (!r) return;
    const b = r.binding_id ? this.vinculo(r.binding_id) : null;
    const feito = () => this.d.db.run("UPDATE teams_inbound SET state = 'feito' WHERE delivery_id = ?", deliveryId);
    if (!b || b.user_id !== r.user_id || (r.decision !== 'apply' && r.decision !== 'reject')) { feito(); return; }
    if (!this.d.db.workspaceOpen(b.workspace_id)) return; // a parte da pessoa fechou: decide quando ela abrir
    this.decidindo.add(deliveryId);
    try {
      const prop = this.d.db.get<{ status: string }>('SELECT status FROM agent_proposals WHERE id = ? AND workspace_id = ?', r.message_id, b.workspace_id);
      if (prop?.status === 'proposed') {
        try { await this.d.decidir(b.workspace_id, b.user_id, r.message_id, r.decision); }
        catch (err) { log.warn({ erro: (err as Error).message.slice(0, 120) }, 'teams: decisão pelo cartão falhou'); }
      }
      if (!this.ligado) return; // desligando no meio: a decisão volta no próximo início (quem decide confere o estado)
      feito();
      this.atualizarCartoes(b.workspace_id);
      this.esvaziarSaida();
    } finally { this.decidindo.delete(deliveryId); }
  }
  /** Decisões de cliques que ficaram para trás (reinício no meio, parte da pessoa fechada). */
  private retomarDecisoes(): void {
    for (const r of this.d.db.all<{ delivery_id: string }>("SELECT delivery_id FROM teams_inbound WHERE kind = 'card.action' AND state = 'decidindo' ORDER BY received_at")) void this.decidirPendente(r.delivery_id);
  }

  private revogado(f: Quadro): Record<string, unknown> {
    const b = typeof f.bindingId === 'string' ? this.vinculo(f.bindingId) : null;
    if (b && b.status !== 'revoked') {
      this.d.db.run("UPDATE teams_bindings SET status = 'revoked', revoked_by = ?, updated_at = ? WHERE binding_id = ?", typeof f.by === 'string' ? f.by.slice(0, 20) : 'relay', now(), b.binding_id);
      this.d.db.run("UPDATE teams_outbox SET status = 'failed', error = 'not_linked' WHERE binding_id = ? AND status = 'pending'", b.binding_id);
      this.avisarTela(b.user_id);
    }
    return { ok: true, status: 'accepted' };
  }

  /** O serviço autenticou: a verdade dele sobre os vínculos manda (contrato, 2.2). */
  private pronto(f: Quadro): void {
    this.problema = null; this.registradoDeNovo = false;
    const doRele = new Map<string, BindingDoRele>();
    for (const x of Array.isArray(f.bindings) ? f.bindings as BindingDoRele[] : []) if (x && typeof x.bindingId === 'string') doRele.set(x.bindingId, x);
    const locais = this.d.db.all<VinculoRow>("SELECT * FROM teams_bindings WHERE status IN ('active', 'paused', 'revoking') AND standby_of IS NULL");
    const conhecidos = new Set(locais.map((b) => b.binding_id));
    for (const b of locais) {
      const r = doRele.get(b.binding_id);
      if (!r) {
        if (b.status === 'revoking') this.apagarVinculo(b.binding_id);
        else this.d.db.run("UPDATE teams_bindings SET status = 'revoked', revoked_by = 'relay', updated_at = ? WHERE binding_id = ?", now(), b.binding_id);
        continue;
      }
      if (b.status === 'revoking') { this.pedirRevogar(b.binding_id); continue; }
      const pausado = b.status === 'paused';
      if ((r.status === 'paused') !== pausado || !!r.notices !== !!Number(b.notices)) void this.pedirAtualizar(b.binding_id, { paused: pausado, notices: !!Number(b.notices) }).catch(() => undefined);
      if (typeof r.teamsName === 'string' && r.teamsName && this.d.db.workspaceOpen(b.workspace_id)) this.d.db.run('UPDATE teams_bindings SET teams_name = ? WHERE binding_id = ?', this.d.db.seal(b.workspace_id, r.teamsName.slice(0, 120)), b.binding_id);
    }
    // vínculo que só o serviço conhece: o de um link.confirm daqui cujo ack se perdeu na queda é adotado (contrato
    // 12.10); com link.confirm ainda sem resposta, nenhum desconhecido é desfeito agora (pode ser dele); os demais
    // (este Ergon perdeu os dados ou foi restaurado de uma cópia antiga) são desfeitos
    for (const c of [...this.confirmando.entries()]) if (c[1].ate < this.agora()) this.confirmando.delete(c[0]);
    for (const [id, r] of doRele) {
      if (conhecidos.has(id) || !ID_VINCULO.test(id)) continue;
      const meu = typeof r.claimId === 'string' ? this.confirmando.get(r.claimId) : undefined;
      if (meu && r.personRef === this.personRef(meu.userId)) {
        this.confirmando.delete(r.claimId!);
        void this.gravarVinculo(meu, id, typeof r.teamsName === 'string' && r.teamsName ? r.teamsName.slice(0, 120) : meu.teamsName, r.status === 'paused', platDe(r.canal ?? r.platform ?? meu.plat));
        continue;
      }
      // conta de bot ligada por um link pedido daqui, cujo link.added se perdeu: adotada
      const ini = this.iniciados.get(r.personRef);
      const plat = r.platform ?? r.canal;
      if (ini && ini.ate >= this.agora() && (plat === 'telegram' || plat === 'discord')) {
        void this.gravarVinculo(ini, id, typeof r.teamsName === 'string' ? r.teamsName.slice(0, 120) : '', r.status === 'paused', plat);
        continue;
      }
      if (this.confirmando.size) continue;
      void this.cliente?.pedir({ type: 'link.revoke', id: novoId('req'), bindingId: id }).catch(() => undefined);
    }
    // reserva: o que o serviço tem declarado por esta instalação (computador) e os vínculos que ela atende (nuvem)
    const sb = f.standby as { installationId?: unknown; workspaceId?: unknown; personRefs?: unknown } | undefined;
    this.reservaNoRele = sb && typeof sb.installationId === 'string' ? chaveDaReserva(sb.installationId, String(sb.workspaceId ?? ''), Array.isArray(sb.personRefs) ? sb.personRefs.map(String) : []) : '';
    this.importarReserva(f.standbyBindings);
    this.aplicarReserva();
    this.avisarTela(null);
    for (const ws of new Set(locais.map((b) => b.workspace_id))) this.agendar(`ws:${ws}`, () => this.atualizarWorkspace(ws));
    // o que o serviço oferece pode ter mudado (Discord ou Telegram ligados depois, por exemplo): confere de tempos em tempos
    const base = this.base();
    if (base && (!this.infoAtual() || this.agora() - (this.info?.at ?? 0) > 6 * 3600_000)) void this.buscarInfo(base);
    // o que ficou para trás num reinício: avisos de "Com você" agrupados que não saíram, e cliques ainda por decidir
    this.rearmarAvisos();
    this.retomarDecisoes();
    this.esvaziarSaida();
  }

  // ------------------------------------------------------------------------------------------------ o que sai
  private digitar(userId: string, bindingId: string, on: boolean): void {
    const atual = this.digitando.get(userId);
    if (atual) { clearInterval(atual.timer); this.digitando.delete(userId); }
    if (!on) { this.cliente?.enviar({ type: 'typing', bindingId: atual?.bindingId ?? bindingId, on: false }); return; }
    this.cliente?.enviar({ type: 'typing', bindingId, on: true });
    // o serviço para o "digitando" em 120 s: enquanto a equipe trabalha, renova
    const timer = setInterval(() => {
      const p = this.pessoa(userId);
      if (!p?.conversation_id || !this.trabalhando(p.conversation_id)) { this.digitar(userId, bindingId, false); return; }
      this.cliente?.enviar({ type: 'typing', bindingId, on: true });
    }, this.ajustes.digitandoMs);
    timer.unref?.();
    this.digitando.set(userId, { bindingId, timer });
  }
  /**
   * A equipe está trabalhando na conversa ("digitando" no Teams)? Só com execução na fila ou rodando, ou mensagem na fila
   * que vai andar. Esperando uma resposta da pessoa (waiting_user), não: o Teams recebe o aviso de que ela precisa responder.
   */
  private trabalhando(conversationId: string): boolean {
    if (this.d.db.get("SELECT 1 AS x FROM runs WHERE conversation_id = ? AND status IN ('queued', 'running') LIMIT 1", conversationId)) return true;
    return !!this.d.db.get('SELECT 1 AS x FROM messages WHERE conversation_id = ? AND queued = 1 LIMIT 1', conversationId)
      && !this.d.db.get("SELECT 1 AS x FROM runs WHERE conversation_id = ? AND status = 'waiting_user' LIMIT 1", conversationId);
  }

  /** Para onde vai a resposta: o vínculo que mandou a última mensagem, ou o primeiro ativo da pessoa. */
  private vinculoDeResposta(userId: string, plat: Plataforma = 'teams'): VinculoRow | null {
    const p = this.pessoa(userId, plat);
    const r = p?.reply_binding ? this.vinculo(p.reply_binding) : null;
    if (r && r.status === 'active' && (r.platform ?? 'teams') === plat) return r;
    return this.vinculosDe(userId, ['active'], plat)[0] ?? null;
  }

  /** Toda resposta nova do coordenador na conversa "Teams" volta ao Teams (contrato, 7.2 item 2). */
  private encaminharRespostas(userId: string): void { for (const plat of this.plataformasDe(userId)) this.encaminharRespostasDe(userId, plat); }
  private encaminharRespostasDe(userId: string, plat: Plataforma): void {
    const p = this.pessoa(userId, plat);
    if (!p?.conversation_id || !this.d.db.workspaceOpen(p.workspace_id)) return;
    const b = this.ligadoPara(userId, plat) ? this.vinculoDeResposta(userId, plat) : null;
    const msgs = this.d.db.all<{ rid: number; role: string; content: string; run_id: string | null; agente: string | null; sincronizada: number }>(
      `SELECT m.rowid AS rid, m.role, m.content, m.run_id, COALESCE(ra.name, ca.name) AS agente,
              EXISTS (SELECT 1 FROM teams_synced y WHERE y.message_id = m.id) AS sincronizada FROM messages m
         JOIN conversations c ON c.id = m.conversation_id LEFT JOIN agents ca ON ca.id = c.agent_id
         LEFT JOIN runs r ON r.id = m.run_id LEFT JOIN agents ra ON ra.id = r.agent_id
        WHERE m.conversation_id = ? AND m.rowid > ? ORDER BY m.rowid LIMIT 50`, p.conversation_id, Number(p.cursor_rowid));
    let ultimo = Number(p.cursor_rowid);
    for (const m of msgs) {
      if (m.content === CLOSED_VALUE) break;
      ultimo = Number(m.rid);
      if (!b || !(m.role === 'agent' || (m.role === 'system' && m.run_id)) || m.sincronizada) continue;
      const texto = textoParaTeams(m.content, MAX_RESPOSTA[plat]);
      // quem fala vai à frente (o nome do agente, ou "Sistema"), como na tela do Ergon: o que o agente escreve não se
      // confunde com as frases do próprio app no Teams (o serviço não põe nome nas dele)
      const quem = m.role === 'agent' && m.agente && m.agente !== CLOSED_VALUE ? m.agente.replace(/[*_`[\]\n]/g, '').trim().slice(0, 60) : 'Sistema';
      // o Telegram mostra o texto como veio (sem markdown): o nome vai sem os asteriscos
      if (texto) this.enfileirar(b, 'send', { text: plat === 'telegram' ? `${quem}: ${texto}` : `**${quem}:** ${texto}`, summary: resumoParaTeams(`${quem}: ${texto}`) }, 'reply');
    }
    if (ultimo !== Number(p.cursor_rowid)) this.d.db.run('UPDATE teams_people SET cursor_rowid = ?, updated_at = ? WHERE user_id = ? AND platform = ?', ultimo, now(), userId, plat);
    if (!this.trabalhando(p.conversation_id) && this.digitando.has(userId)) this.digitar(userId, this.digitando.get(userId)!.bindingId, false);
  }

  /** Um item do cartão para uma proposta: decisão (Aprovar/Recusar) ou aviso que se responde no Ergon. */
  /** O botão do canal pode decidir este cartão? (camada comum: configuração, apagar, mandar e afins, só no app) */
  private decidePeloCanal(b: VinculoRow, proposalId: string): boolean {
    return !this.externos || this.externos.podeDecidirPeloCanal(b.workspace_id, b.user_id, proposalId);
  }
  private itemDe(dela: { id: string; kind: string; summary: string }, b?: VinculoRow | null): ItemCartao {
    // o comando para aprovar vai só com a frase simples (o cartão gravado antes da rc.33 levava o comando no texto)
    const p = dela.kind === 'aprovacao' ? { ...dela, summary: resumoVisivelDaAprovacao(dela.summary) } : dela;
    const { titulo, texto } = partesDoResumo(p.summary);
    if (b && !this.decidePeloCanal(b, p.id)) return { tipo: 'aviso', p: p.id, titulo, texto, abrir: SO_NO_APP };
    if (p.kind === 'permission') return { tipo: 'aviso', p: p.id, titulo, texto, abrir: 'Abra o Ergon para autorizar (pede a sua senha).' };
    if (p.kind === 'question') return { tipo: 'aviso', p: p.id, titulo, texto, abrir: 'Abra o Ergon para responder.' };
    // pedido de chave ou senha: o valor só se digita no Ergon (nunca passa pelo Teams)
    if (p.kind === 'segredo') return { tipo: 'aviso', p: p.id, titulo, texto, abrir: 'Abra o Ergon para informar: o valor nunca passa por aqui.' };
    // a pessoa aprova exatamente o que lê: o pedido longo demais para o cartão se decide no Ergon
    if (!cabeNoCanal(p.kind, p.summary, LIMITE_TEAMS)) return { tipo: 'aviso', p: p.id, titulo, texto, abrir: ABRIR_LONGO };
    return { tipo: 'decisao', p: p.id, titulo, texto, ...(KINDS_INTEIROS.includes(p.kind) ? { inteiro: true } : {}) };
  }

  /** As confirmações pedidas na conversa "Teams" viram cartões no Teams (contrato, 7.2 item 3). */
  private cartoesDaConversa(userId: string): void { for (const plat of this.plataformasDe(userId)) this.cartoesDaConversaDe(userId, plat); }
  private cartoesDaConversaDe(userId: string, plat: Plataforma): void {
    const p = this.pessoa(userId, plat);
    if (!p?.conversation_id || !this.ligadoPara(userId, plat) || !this.d.db.workspaceOpen(p.workspace_id)) return;
    const b = this.vinculoDeResposta(userId, plat);
    if (!b) return;
    const props = this.d.db.all<{ id: string; kind: string; summary: string }>(
      `SELECT id, kind, summary FROM agent_proposals WHERE workspace_id = ? AND status = 'proposed' AND kind NOT IN ('info_request', 'handoff') AND created_at >= ?
          AND (conversation_id = ? OR id IN (SELECT proposal_id FROM proposal_links WHERE conversation_id = ?))
          AND NOT EXISTS (SELECT 1 FROM teams_cards c WHERE c.proposal_id = agent_proposals.id AND c.binding_id = ?)
        ORDER BY created_at, rowid LIMIT 20`, p.workspace_id, b.created_at, p.conversation_id, p.conversation_id, b.binding_id);
    for (const x of props) {
      const out = this.enfileirar(b, 'send', { desenho: { titulo: 'Precisa de você', itens: [this.itemDe(x, b)] } satisfies DesenhoCartao, summary: resumoParaTeams(`Precisa de você: ${partesDoResumo(x.kind === 'aprovacao' ? resumoVisivelDaAprovacao(x.summary) : x.summary).titulo}`) }, 'card');
      this.d.db.run("INSERT OR IGNORE INTO teams_cards (proposal_id, binding_id, activity_id, state, outbox_id) VALUES (?, ?, NULL, 'open', ?)", x.id, b.binding_id, out);
    }
    // o agente parou esperando uma resposta dela (waiting_user): o Teams fica sabendo, uma vez por execução, mesmo com os
    // avisos de "Com você" desligados (é a resposta ao pedido que ela fez por lá)
    const esperando = this.d.db.all<{ id: string; agente: string }>(
      "SELECT r.id, a.name AS agente FROM runs r JOIN agents a ON a.id = r.agent_id WHERE r.conversation_id = ? AND r.status = 'waiting_user' AND r.created_at >= ? ORDER BY r.created_at LIMIT 5",
      p.conversation_id, b.created_at);
    for (const w of esperando) {
      if (!this.d.db.run('INSERT INTO teams_noticed (user_id, item, at, sent) VALUES (?, ?, ?, 1) ON CONFLICT (user_id, item) DO NOTHING', userId, plat === 'teams' ? `w:${w.id}` : `w:${plat}:${w.id}`, now()).changes) continue;
      const nome = w.agente && w.agente !== CLOSED_VALUE ? w.agente : 'A equipe';
      this.enfileirar(b, 'send', { desenho: { titulo: 'Precisa de você', itens: [{ tipo: 'aviso', titulo: `${nome} espera uma resposta sua`, texto: '', abrir: 'Abra o Ergon para responder.' }] } satisfies DesenhoCartao,
        summary: resumoParaTeams(`${nome} espera uma resposta sua`) }, 'card');
    }
  }

  /** O estado de cada proposta de um cartão. */
  private estados(ws: string, ids: string[], ja: string[] = []): Map<string, EstadoDecisao> {
    const m = new Map<string, EstadoDecisao>();
    for (const pid of ids) {
      const r = this.d.db.get<{ status: string; result: string | null; decided_at: string | null }>('SELECT status, result, decided_at FROM agent_proposals WHERE id = ? AND workspace_id = ?', pid, ws);
      m.set(pid, r ? { status: r.status, result: r.result, decidedAt: r.decided_at, jaDecidido: ja.includes(pid) } : { status: 'gone' });
    }
    return m;
  }

  /** Decidido em qualquer lugar (aqui ou no Teams): todos os cartões daquela proposta ficam com a linha final. */
  private atualizarCartoes(ws: string): void {
    const rows = this.d.db.all<{ proposal_id: string; binding_id: string; activity_id: string | null; outbox_id: string | null }>(
      `SELECT c.proposal_id, c.binding_id, c.activity_id, c.outbox_id FROM teams_cards c JOIN teams_bindings b ON b.binding_id = c.binding_id
        LEFT JOIN agent_proposals p ON p.id = c.proposal_id
        WHERE c.state = 'open' AND b.workspace_id = ? AND b.status = 'active' AND c.activity_id IS NOT NULL AND (p.id IS NULL OR p.status <> 'proposed')`, ws);
    const feitos = new Set<string>();
    for (const r of rows) {
      this.d.db.run("UPDATE teams_cards SET state = 'final' WHERE proposal_id = ? AND binding_id = ?", r.proposal_id, r.binding_id);
      const chave = `${r.binding_id}|${r.activity_id}`;
      if (feitos.has(chave) || !r.outbox_id) continue;
      feitos.add(chave);
      const b = this.vinculo(r.binding_id);
      if (b) this.enfileirar(b, 'card.update', { origem: r.outbox_id, activityId: r.activity_id }, 'card');
    }
  }
  /** Clique num cartão já decidido (ou que só se responde no Ergon): o cartão diz isso, sem decidir nada. */
  private atualizarCartaoDe(pid: string, b: VinculoRow, cardActivityId: string | null, ja: boolean): void {
    const c = this.d.db.get<{ activity_id: string | null; outbox_id: string | null }>('SELECT activity_id, outbox_id FROM teams_cards WHERE proposal_id = ? AND binding_id = ?', pid, b.binding_id);
    const activityId = c?.activity_id ?? cardActivityId;
    if (!c?.outbox_id || !activityId) return;
    this.d.db.run("UPDATE teams_cards SET state = 'final' WHERE proposal_id = ? AND binding_id = ?", pid, b.binding_id);
    this.enfileirar(b, 'card.update', { origem: c.outbox_id, activityId, ja: ja ? [pid] : [] }, 'card');
  }

  // ------------------------------------------------------------------------------------------------ avisos de "Com você"
  /** O que está em "Com você" agora, com uma chave por item (o mesmo critério de pendingDecisions). */
  private comVoce(userId: string, ws: string): Array<{ chave: string; item: ItemCartao }> {
    const d = pendingDecisions(this.d.db, ws);
    // as conversas da pessoa pelos canais (Teams e bots): o que nasceu nelas já foi como cartão
    const convs = new Set(this.d.db.all<{ c: string | null }>('SELECT conversation_id AS c FROM teams_people WHERE user_id = ?', userId).map((r) => r.c).filter(Boolean));
    const out: Array<{ chave: string; item: ItemCartao }> = [];
    for (const p of d.proposals) {
      if (p.conversation_id && convs.has(p.conversation_id)) continue;
      out.push({ chave: `p:${p.id}`, item: this.itemDe(p) });
    }
    for (const w of d.waiting) {
      if (w.conversation_id && convs.has(w.conversation_id)) continue;
      out.push({ chave: `w:${w.id}`, item: { tipo: 'aviso', titulo: `${w.agent_name} espera uma resposta sua`, texto: '', abrir: 'Abra o Ergon para responder.' } });
    }
    const precisa: Record<string, string> = { info: 'precisa de uma informação sua', review: 'está pronto para você revisar', approval: 'espera a sua aprovação' };
    for (const c of d.cards) {
      // com a entrega no modelo: o tipo e os itens curtos do cartão, e o link dos detalhes no Ergon
      const a = avisoDoCard(this.d.db, ws, c.id, this.d.cfg.publicUrl);
      out.push({ chave: `c:${c.id}:${c.work_state}`, item: a
        ? { tipo: 'aviso', titulo: `Card #${c.number} — ${a.titulo}`, texto: a.linhas.join('\n'), abrir: `Ver detalhes: ${a.link}` }
        : { tipo: 'aviso', titulo: `Card #${c.number}: ${c.title}`, texto: `${c.agent_name ? `${c.agent_name}: ` : ''}${precisa[c.need] ?? 'espera você'}${c.question ? ` — ${c.question}` : ''}`, abrir: 'Abra o Ergon para responder.' } });
    }
    for (const l of d.linkList) out.push({ chave: `l:${l.id}`, item: { tipo: 'aviso', titulo: `Ligar o card #${l.number} ao #${l.related_number}?`, texto: l.reason ?? '', abrir: 'Abra o Ergon para responder.' } });
    for (const r of d.ruleList) out.push({ chave: `r:${r.id}`, item: { tipo: 'aviso', titulo: 'Regra sugerida', texto: r.text, abrir: 'Abra o Ergon para responder.' } });
    return out;
  }
  /** Marca o que já está em "Com você" como visto (ao ligar, ou ao religar os avisos): só o que surgir depois vai ao Teams. */
  private linhaDeBase(userId: string, ws: string): void {
    if (!this.d.db.workspaceOpen(ws)) return;
    const at = now();
    for (const x of this.comVoce(userId, ws)) this.d.db.run('INSERT INTO teams_noticed (user_id, item, at, sent) VALUES (?, ?, ?, 1) ON CONFLICT (user_id, item) DO NOTHING', userId, x.chave, at);
  }
  private varrerAvisos(userId: string, ws: string): void {
    if (this.nuvem) return; // os avisos de "Com você" saem do computador (a nuvem só responde ao que perguntam)
    if (!this.vinculosDe(userId, ['active']).some((b) => Number(b.notices) === 1 && b.workspace_id === ws && this.ligadoPara(userId, b.platform ?? 'teams'))) return;
    let novos = 0;
    for (const x of this.comVoce(userId, ws)) novos += this.d.db.run('INSERT INTO teams_noticed (user_id, item, at, sent) VALUES (?, ?, ?, 0) ON CONFLICT (user_id, item) DO NOTHING', userId, x.chave, now()).changes;
    if (novos && !this.avisosTimers.has(userId)) this.armarAvisos(userId, ws, this.ajustes.avisosMs);
  }
  /** Depois de reiniciar: o que estava agrupado esperando o minuto (ou o limite da hora) e não saiu, sai. */
  private rearmarAvisos(): void {
    const quem = this.d.db.all<{ user_id: string; w: string }>(
      `SELECT n.user_id, MIN(b.workspace_id) AS w FROM teams_noticed n JOIN teams_bindings b ON b.user_id = n.user_id AND b.status = 'active' AND b.notices = 1
        WHERE n.sent = 0 GROUP BY n.user_id`);
    for (const r of quem) if (!this.avisosTimers.has(r.user_id)) this.armarAvisos(r.user_id, r.w, this.ajustes.avisosMs);
  }
  /** Os avisos mandados na última hora (fica gravado: reiniciar não zera o limite de 20 por hora). */
  private janelaDeAvisos(userId: string): number[] {
    let v: unknown = [];
    try { v = JSON.parse(this.pessoa(userId)?.notice_window ?? '[]'); } catch { v = []; }
    return (Array.isArray(v) ? v : []).filter((t): t is number => typeof t === 'number' && this.agora() - t < 3600_000 && t <= this.agora() + 60_000);
  }
  private armarAvisos(userId: string, ws: string, ms: number): void {
    const t = setTimeout(() => { this.avisosTimers.delete(userId); try { this.enviarAvisos(userId, ws); } catch (err) { log.warn({ erro: (err as Error).message.slice(0, 120) }, 'teams: aviso não saiu'); } }, ms);
    t.unref?.();
    this.avisosTimers.set(userId, t);
  }
  /** O que surgiu em 60 s vai numa mensagem só; no máximo 20 avisos por hora por pessoa (contrato, 7.2 item 4). */
  private enviarAvisos(userId: string, ws: string): void {
    if (!this.d.db.workspaceOpen(ws)) return;
    const pend = this.d.db.all<{ item: string }>('SELECT item FROM teams_noticed WHERE user_id = ? AND sent = 0', userId).map((r) => r.item);
    if (!pend.length) return;
    const agora = new Map(this.comVoce(userId, ws).map((x) => [x.chave, x.item]));
    const vivos = pend.filter((k) => agora.has(k));
    for (const k of pend) if (!agora.has(k)) this.d.db.run('UPDATE teams_noticed SET sent = 2 WHERE user_id = ? AND item = ?', userId, k); // resolvido antes de sair
    if (!vivos.length) return;
    const janela = this.janelaDeAvisos(userId);
    if (janela.length >= 20) { this.armarAvisos(userId, ws, Math.max(1000, 3600_000 - (this.agora() - Math.min(...janela)))); return; }
    const bs = this.vinculosDe(userId, ['active']).filter((b) => Number(b.notices) === 1 && b.workspace_id === ws && this.ligadoPara(userId, b.platform ?? 'teams'));
    const mostrar = vivos.slice(0, 10).map((k) => agora.get(k)!);
    if (vivos.length > 10) mostrar.push({ tipo: 'aviso', titulo: `E mais ${vivos.length - 10} no Ergon`, texto: '', abrir: 'Abra o Ergon para ver tudo.' });
    const desenho: DesenhoCartao = { titulo: vivos.length === 1 ? 'Precisa de você no Ergon' : `Precisa de você no Ergon (${vivos.length})`, itens: mostrar };
    for (const b of bs) {
      const out = this.enfileirar(b, 'send', { desenho, summary: resumoParaTeams(vivos.length === 1 ? `Precisa de você: ${mostrar[0].titulo}` : `${vivos.length} itens precisam de você no Ergon`) }, 'notice');
      for (const it of mostrar) if (it.p) this.d.db.run("INSERT OR IGNORE INTO teams_cards (proposal_id, binding_id, activity_id, state, outbox_id) VALUES (?, ?, NULL, 'open', ?)", it.p, b.binding_id, out);
    }
    for (const k of vivos) this.d.db.run('UPDATE teams_noticed SET sent = 1, at = ? WHERE user_id = ? AND item = ?', now(), userId, k);
    if (bs.length) {
      janela.push(this.agora());
      this.garantirPessoa(userId, ws);
      this.d.db.run('UPDATE teams_people SET notice_window = ? WHERE user_id = ?', JSON.stringify(janela.slice(-40)), userId);
    }
    this.esvaziarSaida();
  }

  // ------------------------------------------------------------------------------------------------ saída (outbox)
  private enfileirar(b: VinculoRow, kind: 'send' | 'card.update', payload: Record<string, unknown>, purpose: string): string {
    const id = novoId('out');
    this.d.db.run(`INSERT INTO teams_outbox (id, binding_id, workspace_id, kind, payload, purpose, attempts, next_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 'pending', ?)`,
      id, b.binding_id, b.workspace_id, kind, this.d.db.seal(b.workspace_id, JSON.stringify(payload)), purpose, now(), now());
    this.agendar('saida', () => this.esvaziarSaida(), 0);
    return id;
  }
  /** O quadro de um item da saída (o cartão é montado na hora, com o estado atual das decisões). */
  private quadroDe(row: SaidaRow): Quadro | null {
    if (row.payload === CLOSED_VALUE) return null;
    const k = this.chaves();
    if (!k) return null;
    const pl = JSON.parse(row.payload) as { text?: string; summary?: string; desenho?: DesenhoCartao; origem?: string; activityId?: string; ja?: string[] };
    const tz = workspaceTz(this.d.db, row.workspace_id);
    const ids = (desenho: DesenhoCartao) => desenho.itens.flatMap((it) => (it.tipo === 'decisao' ? [it.p] : it.p ? [it.p] : []));
    const cartao = (desenho: DesenhoCartao, ja: string[] = []) => montarCartao(desenho, this.estados(row.workspace_id, ids(desenho), ja), row.binding_id, k, tz);
    // Telegram e Discord: texto simples e botões (o serviço põe no botão só uma chave curta)
    const plat = this.vinculo(row.binding_id)?.platform ?? 'teams';
    if (plat !== 'teams') {
      const texto = (desenho: DesenhoCartao, ja: string[] = []) => montarTexto(desenho, this.estados(row.workspace_id, ids(desenho), ja), row.binding_id, k, tz);
      if (row.kind === 'send') {
        return pl.desenho
          ? { type: 'send', id: row.id, bindingId: row.binding_id, purpose: row.purpose ?? 'card', ...texto(pl.desenho) }
          : { type: 'send', id: row.id, bindingId: row.binding_id, purpose: row.purpose ?? 'reply', text: (pl.text ?? '').replace(/\*\*/g, ''), buttons: [] };
      }
      const orig = pl.origem ? this.d.db.get<{ payload: string }>('SELECT payload FROM teams_outbox WHERE id = ?', pl.origem) : null;
      if (!orig || orig.payload === CLOSED_VALUE || !pl.activityId) return null;
      const d0 = (JSON.parse(orig.payload) as { desenho?: DesenhoCartao }).desenho;
      return d0 ? { type: 'card.update', id: row.id, bindingId: row.binding_id, activityId: pl.activityId, ...texto(d0, pl.ja ?? []) } : null;
    }
    if (row.kind === 'send') {
      return pl.desenho
        ? { type: 'send', id: row.id, bindingId: row.binding_id, purpose: row.purpose ?? 'card', card: cartao(pl.desenho), summary: pl.summary ?? 'Ergon' }
        : { type: 'send', id: row.id, bindingId: row.binding_id, purpose: row.purpose ?? 'reply', text: pl.text ?? '', summary: pl.summary ?? '' };
    }
    const origem = pl.origem ? this.d.db.get<{ payload: string }>('SELECT payload FROM teams_outbox WHERE id = ?', pl.origem) : null;
    if (!origem || origem.payload === CLOSED_VALUE || !pl.activityId) return null;
    const desenho = (JSON.parse(origem.payload) as { desenho?: DesenhoCartao }).desenho;
    return desenho ? { type: 'card.update', id: row.id, bindingId: row.binding_id, activityId: pl.activityId, card: cartao(desenho, pl.ja ?? []) } : null;
  }
  /**
   * Manda o que está na fila de saída: um por vínculo de cada vez, até o ack, e sempre o mais antigo ainda pendente
   * daquele vínculo, mesmo que ele esteja esperando a vez (limite do Teams, erro passageiro): o seguinte não passa à
   * frente, e a ordem no Teams é a ordem em que a equipe respondeu (o cartão não chega antes do texto que o explica).
   */
  esvaziarSaida(): void {
    const c = this.cliente;
    if (!c || c.estado !== 'connected') return;
    const agora = now();
    const rows = this.d.db.all<SaidaRow>("SELECT * FROM teams_outbox WHERE status = 'pending' ORDER BY created_at, rowid LIMIT 500");
    const vez = new Set<string>();
    for (const row of rows) {
      if (vez.has(row.binding_id)) continue;
      vez.add(row.binding_id);
      if (this.emVooPorVinculo.has(row.binding_id) || row.next_at > agora) continue;
      if (!this.d.db.workspaceOpen(row.workspace_id)) continue;
      let q: Quadro | null;
      try { q = this.quadroDe(row); } catch { q = null; }
      // não dá para montar (o cartão de origem sumiu): falha este, e o seguinte do mesmo vínculo pode ir
      if (!q) { this.d.db.run("UPDATE teams_outbox SET status = 'failed', error = 'invalid' WHERE id = ?", row.id); vez.delete(row.binding_id); continue; }
      this.emVooPorVinculo.add(row.binding_id);
      c.pedir(q as Quadro & { id: string })
        .then((ack) => this.aoAckSaida(row, ack))
        .catch(() => undefined)
        .finally(() => { this.emVooPorVinculo.delete(row.binding_id); this.agendar('saida', () => this.esvaziarSaida(), 0); });
    }
  }
  private aoAckSaida(row: SaidaRow, ack: Ack): void {
    if (ack.ok) {
      const activityId = typeof ack.activityId === 'string' ? ack.activityId.slice(0, 200) : null;
      this.d.db.run("UPDATE teams_outbox SET status = 'sent', activity_id = ?, attempts = attempts + 1 WHERE id = ?", activityId, row.id);
      if (row.kind === 'send' && activityId) {
        this.d.db.run('UPDATE teams_cards SET activity_id = ? WHERE outbox_id = ?', activityId, row.id);
        this.atualizarCartoes(row.workspace_id); // decidido enquanto o cartão ia
      }
      return;
    }
    const code = ack.error?.code ?? 'transient';
    if (code === 'rate_limited' || code === 'transient') {
      const espera = code === 'rate_limited' && typeof ack.retryAfterMs === 'number' ? Math.min(ack.retryAfterMs, 10 * 60_000) : Math.min(10 * 60_000, 2000 * 2 ** Math.min(row.attempts, 8));
      this.d.db.run('UPDATE teams_outbox SET attempts = attempts + 1, next_at = ?, error = ? WHERE id = ?', new Date(Date.now() + espera).toISOString(), code, row.id);
      return;
    }
    this.d.db.run("UPDATE teams_outbox SET status = 'failed', error = ?, attempts = attempts + 1 WHERE id = ?", code.slice(0, 40), row.id);
  }

  /**
   * A cada poucos segundos: o que esperava a vez sai, e o que venceu some. A saída vence em 7 dias, menos o cartão
   * enviado que ainda está aberto (é dele que sai a atualização quando a decisão vem depois): esse fica até 30 dias,
   * o mesmo prazo em que o serviço aceita atualizar um cartão (contrato 12.4).
   */
  private varredura(): void {
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
    this.d.db.run(`DELETE FROM teams_outbox WHERE created_at < ? AND NOT (status = 'sent' AND created_at >= ?
      AND id IN (SELECT outbox_id FROM teams_cards WHERE state = 'open' AND outbox_id IS NOT NULL))`, ago(7 * DIA), ago(30 * DIA));
    this.d.db.run('DELETE FROM teams_cards WHERE outbox_id IS NOT NULL AND outbox_id NOT IN (SELECT id FROM teams_outbox)');
    this.d.db.run('DELETE FROM teams_inbound WHERE received_at < ?', ago(ENTRADA_VALE_MS));
    this.d.db.run("DELETE FROM teams_noticed WHERE sent <> 0 AND at < ?", ago(30 * DIA));
    this.d.db.run('DELETE FROM teams_synced WHERE at < ?', ago(30 * DIA));
    for (const [id, c] of this.claims) if (c.expiresAt < this.agora()) this.claims.delete(id);
    for (const [id, c] of this.confirmando) if (c.ate < this.agora()) this.confirmando.delete(id);
    for (const [u, e] of this.errosDeCodigo) if (!e.some((t) => this.agora() - t < JANELA_ERROS_MS)) this.errosDeCodigo.delete(u);
    this.esvaziarSaida();
  }

  // ------------------------------------------------------------------------------------------------ nuvem (reserva)
  /** A instalação deste Ergon no serviço dos canais (o contêiner da nuvem conta a dele ao World). */
  instalacaoNoRele(): string | null { return this.cliente ? this.instalacao() : null; }

  /**
   * No computador: declara ao serviço que, com este Ergon fechado, a nuvem do workspace responde no lugar dele (ou tira,
   * com null). Vale para as contas ligadas pela pessoa DONA do workspace (na nuvem, a equipe age com o papel de dono).
   * Uma reserva por instalação: o primeiro workspace com a nuvem fica. Chamado a cada minuto (confere e repete se preciso).
   */
  reserva(ws: string, x: { installationId: string; syncWorkspaceId: string; ticket?: { exp: number; mac: string } | null } | null): void {
    if (this.nuvemWorld()) return;
    if (x?.ticket) this.comprovante = x.ticket;
    const atual = this.reservaDesejada();
    if (!x) { if (atual?.ws === ws) setInstanceSetting(this.d.db, 'teams_relay_standby', ''); else return; }
    else if (atual && atual.ws !== ws) return;
    else if (!ID_INSTALACAO.test(x.installationId) || !/^sws_[a-f0-9]{32}$/.test(x.syncWorkspaceId)) return;
    else if (atual?.installationId !== x.installationId || atual.sws !== x.syncWorkspaceId) setInstanceSetting(this.d.db, 'teams_relay_standby', JSON.stringify({ ws, installationId: x.installationId, sws: x.syncWorkspaceId }));
    this.aplicarReserva();
  }
  private reservaDesejada(): ReservaDesejada | null {
    try {
      const v = JSON.parse(instanceSetting(this.d.db, 'teams_relay_standby') || 'null') as ReservaDesejada | null;
      return v && typeof v.ws === 'string' && typeof v.installationId === 'string' && typeof v.sws === 'string' ? v : null;
    } catch { return null; }
  }
  /** Manda o `standby.set` se o que o serviço tem difere do que este Ergon quer (contas ligadas ou desligadas mudam a lista). */
  private aplicarReserva(): void {
    const c = this.cliente; const k = this.chaves();
    if (this.nuvemWorld() || !c || c.estado !== 'connected' || !k || this.reservaNoRele === null || this.pedindoReserva) return;
    const r = this.reservaDesejada();
    // declarar pede o comprovante do World (só o dono o recebe, em GET /v1/cloud); tirar, não
    if (r && (!this.comprovante || this.comprovante.exp * 1000 < Date.now() + 30_000)) return;
    const pessoas = r ? [...new Set(this.d.db.all<{ user_id: string }>("SELECT DISTINCT user_id FROM teams_bindings WHERE workspace_id = ? AND status IN ('active', 'paused') AND standby_of IS NULL", r.ws)
      .filter((p) => this.papel(r.ws, p.user_id) === 'owner').map((p) => personRefDe(k, p.user_id)))].sort() : [];
    const quero = r ? chaveDaReserva(r.installationId, r.sws, pessoas) : '';
    if (quero === this.reservaNoRele) return;
    this.pedindoReserva = true;
    void c.pedir(r ? { type: 'standby.set', id: novoId('req'), installationId: r.installationId, workspaceId: r.sws, personRefs: pessoas, ticket: this.comprovante } : { type: 'standby.set', id: novoId('req'), installationId: null }, this.ajustes.pedidoMs ?? 15_000)
      .then((ack) => {
        if (ack.ok) { this.reservaNoRele = quero; log.info({ pessoas: pessoas.length, ligada: !!r }, 'canais: reserva na nuvem declarada ao serviço'); }
        else log.warn({ codigo: ack.error?.code }, 'canais: o serviço não aceitou a reserva na nuvem');
      }).catch(() => undefined).finally(() => { this.pedindoReserva = false; });
  }

  /**
   * Na nuvem: o workspace chegou pela sincronia e a equipe está pronta. A conexão com o serviço liga agora, e as contas
   * que o computador ligou (as que o serviço disser) passam a ser atendidas aqui, pela conta local do contêiner.
   */
  atender(x: { userId: string; workspaceId: string; syncWorkspaceId: string }): void {
    const era = this.nuvem;
    this.nuvem = x;
    if (!era) { this.assinar(x.workspaceId); if (this.ligado) void this.start(); }
    // só com a lista que o serviço mandou nesta conexão (antes dela, daReserva está vazia e apagaria tudo)
    if (this.reservaRecebida) this.importarReserva(this.daReserva);
  }
  /** Os vínculos do computador que esta instalação atende: entram (ou saem) daqui conforme o serviço diz. */
  private importarReserva(lista: unknown): void {
    this.reservaRecebida = true;
    this.daReserva = Array.isArray(lista) ? (lista as BindingDoRele[]).filter((x) => x && typeof x.bindingId === 'string' && ID_VINCULO.test(x.bindingId) && typeof x.personRef === 'string') : [];
    const n = this.nuvem;
    if (!n) return;
    const meus = this.daReserva.filter((x) => x.workspaceId === n.syncWorkspaceId && typeof x.primary === 'string' && ID_INSTALACAO.test(x.primary));
    const ids = new Set(meus.map((x) => x.bindingId));
    for (const b of this.d.db.all<VinculoRow>('SELECT * FROM teams_bindings WHERE standby_of IS NOT NULL')) if (!ids.has(b.binding_id)) this.apagarVinculo(b.binding_id);
    if (!this.d.db.workspaceOpen(n.workspaceId)) return;
    for (const x of meus) {
      const plat = platDe(x.platform ?? x.canal);
      const estado = x.status === 'paused' ? 'paused' : 'active';
      const nome = this.d.db.seal(n.workspaceId, (typeof x.teamsName === 'string' ? x.teamsName : '').slice(0, 120));
      const quando = typeof x.linkedAt === 'string' && Number.isFinite(Date.parse(x.linkedAt)) ? new Date(Date.parse(x.linkedAt)).toISOString() : now();
      // first_message_at preenchido: a nota de "primeira mensagem por esta conta" é do computador, onde ela foi ligada
      this.d.db.run(`INSERT INTO teams_bindings (binding_id, user_id, workspace_id, person_ref, teams_name, status, notices, created_at, updated_at, platform, standby_of, first_message_at)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)
        ON CONFLICT (binding_id) DO UPDATE SET user_id = excluded.user_id, workspace_id = excluded.workspace_id, person_ref = excluded.person_ref, teams_name = excluded.teams_name,
          status = excluded.status, platform = excluded.platform, standby_of = excluded.standby_of, updated_at = excluded.updated_at`,
      x.bindingId, n.userId, n.workspaceId, x.personRef, nome, estado, quando, now(), plat, x.primary!, quando);
      this.adotarConversa(n.userId, n.workspaceId, plat);
    }
    if (meus.length) { log.info({ contas: meus.length }, 'canais: a nuvem atende as contas ligadas no computador'); this.agendar(`ws:${n.workspaceId}`, () => this.atualizarWorkspace(n.workspaceId)); }
  }
  /**
   * A conversa do canal que o computador já usa (veio pela sincronia, com o nome da plataforma): a nuvem continua nela,
   * e o computador vê as mensagens e as respostas no mesmo lugar. O que já estava nela não é mandado de novo ao canal.
   */
  private adotarConversa(userId: string, ws: string, plat: Plataforma): void {
    const p = this.garantirPessoa(userId, ws, plat);
    const viva = (id: string) => !!this.d.db.get('SELECT 1 AS x FROM conversations WHERE id = ? AND workspace_id = ? AND owner_user_id = ? AND sala = 0 AND archived_at IS NULL', id, ws, userId);
    if (p.conversation_id && p.workspace_id === ws && viva(p.conversation_id)) return;
    const titulo = plat === 'teams' ? TITULO_CONVERSA : NOME_PLAT[plat];
    const coord = coordinatorFor(this.d.db, ws);
    const achada = this.d.db.all<{ id: string; title: string; agent_id: string }>(
      `SELECT c.id, c.title, c.agent_id FROM conversations c JOIN agents a ON a.id = c.agent_id AND a.status = 'active'
        WHERE c.workspace_id = ? AND c.owner_user_id = ? AND c.sala = 0 AND c.archived_at IS NULL
        ORDER BY (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id) DESC, c.created_at DESC LIMIT 200`, ws, userId)
      .find((c) => c.title === titulo && (!coord || c.agent_id === coord));
    if (!achada) return; // nenhuma ainda: a primeira mensagem cria (e ela vai ao computador pela sincronia)
    const cursor = Number(this.d.db.get<{ r: number }>('SELECT COALESCE(MAX(rowid), 0) AS r FROM messages')?.r ?? 0);
    this.d.db.run('UPDATE teams_people SET conversation_id = ?, workspace_id = ?, cursor_rowid = ?, updated_at = ? WHERE user_id = ? AND platform = ?', achada.id, ws, cursor, now(), userId, plat);
  }
  /**
   * Mensagens que chegaram pela sincronia (escritas noutro aparelho: o computador, ou a nuvem enquanto ele estava
   * fechado). Quem as escreveu já respondeu no canal: aqui elas só aparecem na conversa, sem ir ao canal de novo.
   */
  sincronizadas(ws: string, messageIds: string[]): void {
    if (!messageIds.length) return;
    // na nuvem, a conversa do canal pode ter acabado de chegar: adota antes (o que já está nela não vai ao canal)
    if (this.nuvem?.workspaceId === ws) for (const p of this.d.db.all<{ platform: Plataforma }>('SELECT platform FROM teams_people WHERE user_id = ? AND conversation_id IS NULL', this.nuvem.userId)) this.adotarConversa(this.nuvem.userId, ws, p.platform);
    const convs = new Set(this.d.db.all<{ c: string }>('SELECT conversation_id AS c FROM teams_people WHERE workspace_id = ? AND conversation_id IS NOT NULL', ws).map((r) => r.c));
    const at = now();
    this.d.db.tx(() => {
      for (const id of messageIds) {
        const m = this.d.db.get<{ c: string }>('SELECT conversation_id AS c FROM messages WHERE id = ? AND workspace_id = ?', id, ws);
        if (m && convs.has(m.c)) this.d.db.run('INSERT OR IGNORE INTO teams_synced (message_id, at) VALUES (?, ?)', id, at);
      }
    });
  }
  /** A equipe está atendendo alguém por um canal agora (a nuvem não dorme no meio de uma conversa)? */
  ocupado(): boolean {
    if (this.d.db.get("SELECT 1 AS x FROM teams_outbox WHERE status = 'pending' LIMIT 1")) return true;
    if (this.d.db.get('SELECT 1 AS x FROM teams_inbound WHERE received_at > ? LIMIT 1', new Date(Date.now() - 5 * 60_000).toISOString())) return true;
    return this.d.db.all<{ c: string }>('SELECT conversation_id AS c FROM teams_people WHERE conversation_id IS NOT NULL').some((r) => this.trabalhando(r.c));
  }

  // ------------------------------------------------------------------------------------------------ tela (rotas)
  private exigirConexao(): ClienteRele {
    if (!this.base()) throw new HttpError(409, 'unconfigured', 'Ainda não disponível.');
    if (!this.disponivel()) throw new HttpError(409, 'unavailable', 'Ainda não disponível.');
    const c = this.cliente;
    if (!c || c.estado !== 'connected') throw erroDaTela('offline');
    return c;
  }
  private async pedir(f: Quadro & { id: string }, plat: Plataforma = 'teams'): Promise<Ack> {
    const c = this.exigirConexao();
    let ack: Ack;
    try { ack = await c.pedir(f, 15_000); } catch (e) { throw erroDaTela(e instanceof ErroDoRele ? e.code : 'offline', plat); }
    if (!ack.ok) throw erroDaTela(ack.error?.code ?? 'teams_relay', plat);
    return ack;
  }
  /** O estado daqui já foi gravado: com prazo, a tela não fica esperando (sem resposta, a próxima conexão confere). */
  private pedirAtualizar(bindingId: string, mud: { paused?: boolean; notices?: boolean }): Promise<Ack> {
    const c = this.cliente;
    if (!c || c.estado !== 'connected') return Promise.reject(new ErroDoRele('offline'));
    return c.pedir({ type: 'link.update', id: novoId('req'), bindingId, ...mud }, this.ajustes.pedidoMs ?? 15_000);
  }
  private pedirRevogar(bindingId: string): void {
    const c = this.cliente;
    if (!c || c.estado !== 'connected') return;
    void c.pedir({ type: 'link.revoke', id: novoId('req'), bindingId }).then((ack) => {
      if (ack.ok || ack.error?.code === 'not_found') { this.apagarVinculo(bindingId); this.avisarTela(null); }
    }).catch(() => undefined);
  }
  private apagarVinculo(bindingId: string): void {
    this.d.db.tx(() => {
      this.d.db.run('DELETE FROM teams_outbox WHERE binding_id = ?', bindingId);
      this.d.db.run('DELETE FROM teams_cards WHERE binding_id = ?', bindingId);
      this.d.db.run('DELETE FROM teams_bindings WHERE binding_id = ?', bindingId);
    });
  }

  /** GET /api/teams-app (contrato, 7.2). */
  estado(userId: string): Record<string, unknown> {
    const base = this.base();
    const disponivel = this.disponivel();
    // a tela aberta confere de novo o serviço oficial (no máximo uma vez por minuto); respondeu, este Ergon conecta
    if (base && !disponivel && this.ligado && !this.conferindoSaude && (!this.saudeOficial || this.agora() - this.saudeOficial.em >= 60_000)) {
      void this.conferirSaude().then((ok) => { if (ok && this.ligado && !this.cliente) void this.start(); });
    }
    const bindings = this.vinculosDe(userId, ['active', 'paused', 'revoked'], 'teams').map((b) => ({
      id: b.binding_id, teamsName: b.teams_name && b.teams_name !== CLOSED_VALUE ? b.teams_name : null, linkedAt: b.created_at, notices: Number(b.notices) === 1, status: b.status,
      ...(b.status === 'revoked' ? { revokedBy: b.revoked_by } : {}),
    }));
    return {
      available: disponivel, ...(disponivel ? {} : { reason: base ? 'unavailable' : 'unconfigured' }), connection: this.estadoConexao(), enabled: this.ligadoPara(userId), bindings,
      ...(this.teamsAppUrl ? { teamsAppUrl: this.teamsAppUrl } : {}), ...(this.problema ? { problem: this.problema } : {}),
    };
  }

  /** "Conversar pelo Teams" / "pelo Discord" / "pelo Telegram": a chave da pessoa em cada plataforma (as outras não mudam). */
  async setEnabled(userId: string, ws: string, enabled: boolean, plat: Plataforma = 'teams'): Promise<Record<string, unknown>> {
    this.garantirPessoa(userId, ws, plat);
    this.d.db.run('UPDATE teams_people SET enabled = ?, updated_at = ? WHERE user_id = ? AND platform = ?', enabled ? 1 : 0, now(), userId, plat);
    const bs = this.vinculosDe(userId, ['active', 'paused'], plat);
    for (const b of bs) this.d.db.run('UPDATE teams_bindings SET status = ?, updated_at = ? WHERE binding_id = ?', enabled ? 'active' : 'paused', now(), b.binding_id);
    // sem conexão (ou sem resposta no prazo): a próxima conexão confere e manda (pronto)
    await Promise.all(bs.map((b) => this.pedirAtualizar(b.binding_id, { paused: !enabled }).catch(() => undefined)));
    if (enabled) this.linhaDeBase(userId, ws);
    this.avisarTela(userId);
    return this.estado(userId);
  }

  /**
   * Prévia da ligação. O código vai ao serviço só se esta pessoa não errou demais (3 em 15 min): o bloqueio do serviço é
   * da instalação inteira, e uma pessoa não tranca a ligação das outras. A conta do Teams é comparada com a conta
   * Microsoft 365 ligada a este workspace (contrato 12.1): o nome mostrado não prova nada, porque é a própria conta do
   * Teams que escolhe; só a conta conferida como a dela dispensa a escolha consciente na tela.
   */
  async claim(userId: string, ws: string, entrada: string, tela: Plataforma = 'teams'): Promise<{ claimId: string; teamsName: string; expiresAt: string; conta: ContaDoTeams; organizacao: string | null; canal: Plataforma }> {
    this.exigirConexao();
    const code = normalizarCodigo(entrada);
    if (!code) throw erroDaTela('code_invalid', tela);
    const ref = this.personRef(userId);
    if (!ref) throw erroDaTela('offline', tela);
    const erros = (this.errosDeCodigo.get(userId) ?? []).filter((t) => this.agora() - t < JANELA_ERROS_MS);
    this.errosDeCodigo.set(userId, erros);
    if (erros.length >= ERROS_POR_PESSOA) throw erroDaTela('too_many_attempts', tela);
    let ack: Ack;
    try { ack = await this.pedir({ type: 'link.claim', id: novoId('req'), code, personRef: ref }, tela); }
    catch (e) {
      if (e instanceof HttpError && (e.code === 'code_invalid' || e.code === 'code_expired')) erros.push(this.agora());
      throw e;
    }
    const claimId = String(ack.claimId ?? '');
    if (!ID_CLAIM.test(claimId)) throw erroDaTela('teams_relay', tela);
    const teamsName = String(ack.teamsName ?? '').slice(0, 120);
    // quem decide a plataforma é a conta que pediu o código (o serviço diz); a tela só muda os textos
    const plat = platDe(ack.canal ?? ack.platform);
    // conta do Discord (ou do Telegram): sem organização nem conta Microsoft para conferir, pede a escolha consciente
    const { conta, organizacao } = plat === 'teams' ? this.conferirConta(ws, ack) : { conta: 'sem_conferir' as const, organizacao: null };
    // o prazo é medido só pelo relógio daqui (o serviço confere o dele): com o relógio do computador adiantado, a prévia
    // não nasce vencida
    const exp = this.agora() + 120_000;
    this.claims.set(claimId, { userId, ws, teamsName, expiresAt: exp, conta, plat });
    return { claimId, teamsName, expiresAt: new Date(exp).toISOString(), conta, organizacao, canal: plat };
  }

  /** De quem é a conta do Teams do claim, pelo locatário e pela conta que o serviço informou (contrato 12.1). */
  private conferirConta(ws: string, ack: Ack): { conta: ContaDoTeams; organizacao: string | null } {
    const tenant = typeof ack.tenantId === 'string' && GUID.test(ack.tenantId) ? ack.tenantId.toLowerCase() : null;
    const hash = typeof ack.accountHash === 'string' && /^[A-Za-z0-9_-]{43}$/.test(ack.accountHash) ? ack.accountHash : null;
    let ms: { tid?: string; oid?: string; account?: string } | null = null;
    try { ms = this.d.db.workspaceOpen(ws) ? this.d.contaMicrosoft?.(ws) ?? null : null; } catch { ms = null; }
    const tid = typeof ms?.tid === 'string' && GUID.test(ms.tid) ? ms.tid.toLowerCase() : null;
    const oid = typeof ms?.oid === 'string' && GUID.test(ms.oid) ? ms.oid.toLowerCase() : null;
    if (!tenant || !tid) return { conta: 'sem_conferir', organizacao: null };
    if (tenant !== tid) return { conta: 'outra_organizacao', organizacao: null };
    if (oid && hash) return { conta: hashDaConta(tid, oid) === hash ? 'sua' : 'outra_pessoa', organizacao: this.organizacaoDe(tid, ms?.account) };
    // a mesma organização, sem como conferir a conta; contas pessoais da Microsoft não são uma organização
    return tid === MSA_TENANT ? { conta: 'sem_conferir', organizacao: null } : { conta: 'organizacao', organizacao: this.organizacaoDe(tid, ms?.account) };
  }
  private organizacaoDe(tid: string, account: string | undefined): string | null {
    if (tid === MSA_TENANT) return 'conta pessoal da Microsoft';
    const dominio = typeof account === 'string' && account.includes('@') ? account.split('@').pop()!.trim().toLowerCase() : '';
    return /^[a-z0-9.-]{3,120}$/.test(dominio) ? dominio : null;
  }

  /** A plataforma da prévia (claim) em andamento; sem prévia, Teams (a rota pede a pessoa dona). */
  platDoClaim(claimId: string): Plataforma { return this.claims.get(claimId)?.plat ?? 'teams'; }
  /** Conta do Teams não conferida como a da pessoa: ligar pede a escolha consciente ("fui eu que pedi este código"). */
  exigirCiente(userId: string, claimId: string, ciente: boolean | undefined): void {
    const c = this.claims.get(claimId);
    if (c && c.userId === userId && c.conta !== 'sua' && ciente !== true) {
      throw new HttpError(400, 'ciente', `Marque que foi você que pediu este código agora, no seu próprio ${NOME_PLAT[c.plat]}.`);
    }
  }

  async confirm(userId: string, ws: string, claimId: string, nomeDaPessoa: string, ciente?: boolean): Promise<Record<string, unknown>> {
    const c = this.claims.get(claimId);
    if (!c || c.userId !== userId || c.expiresAt < this.agora()) { this.claims.delete(claimId); throw erroDaTela('claim_expired', c?.plat); }
    this.exigirCiente(userId, claimId, ciente);
    const label = (nomeDaPessoa.trim().split(/\s+/)[0] || 'você').slice(0, 40);
    // enquanto o link.confirm espera resposta (e por 10 min se a conexão cair sem ela), a reconciliação adota o vínculo
    this.confirmando.set(claimId, { ...c, ate: this.agora() + 10 * 60_000 });
    let ack: Ack;
    try { ack = await this.pedir({ type: 'link.confirm', id: novoId('req'), claimId, label, notices: true }, c.plat); }
    catch (e) {
      if (!(e instanceof HttpError && (e.code === 'offline' || e.code === 'timeout'))) this.confirmando.delete(claimId);
      throw e;
    }
    this.claims.delete(claimId);
    this.confirmando.delete(claimId);
    const bindingId = String(ack.bindingId ?? '');
    if (!ID_VINCULO.test(bindingId)) throw erroDaTela('teams_relay', c.plat);
    const teamsName = String(ack.teamsName ?? c.teamsName).slice(0, 120);
    const plat = platDe(ack.canal ?? ack.platform ?? c.plat);
    await this.gravarVinculo(c, bindingId, teamsName, false, plat);
    const lista = plat === 'teams' ? this.estado(userId).bindings : this.estadoBot(userId, plat).accounts;
    const binding = (lista as Array<{ id: string }>).find((b) => b.id === bindingId);
    return { binding: binding ? { ...binding, canal: plat } : undefined };
  }

  /** Grava o vínculo confirmado (pela resposta do link.confirm, ou adotado na reconciliação). */
  private async gravarVinculo(c: { userId: string; ws: string }, bindingId: string, teamsName: string, pausadoNoRele = false, plat: Plataforma = 'teams'): Promise<void> {
    const { userId, ws } = c;
    const pausado = !this.ligadoPara(userId, plat);
    this.d.db.tx(() => {
      this.d.db.run(`INSERT INTO teams_bindings (binding_id, user_id, workspace_id, person_ref, teams_name, status, notices, created_at, updated_at, platform) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT (binding_id) DO UPDATE SET user_id = excluded.user_id, workspace_id = excluded.workspace_id, status = excluded.status, teams_name = excluded.teams_name, revoked_by = NULL, updated_at = excluded.updated_at`,
      bindingId, userId, ws, this.personRef(userId)!, this.d.db.seal(ws, teamsName), pausado ? 'paused' : 'active', now(), now(), plat);
      const p = this.garantirPessoa(userId, ws, plat);
      // conversa que já existia: as respostas de antes não vão ao Teams, só as de agora em diante
      const cursor = Number(this.d.db.get<{ r: number }>('SELECT COALESCE(MAX(rowid), 0) AS r FROM messages')?.r ?? 0);
      if (p.workspace_id !== ws) this.d.db.run('UPDATE teams_people SET workspace_id = ?, conversation_id = NULL WHERE user_id = ? AND platform = ?', ws, userId, plat);
      this.d.db.run('UPDATE teams_people SET cursor_rowid = MAX(cursor_rowid, ?), reply_binding = COALESCE(reply_binding, ?), updated_at = ? WHERE user_id = ? AND platform = ?', cursor, bindingId, now(), userId, plat);
    });
    if (pausado !== pausadoNoRele) await this.pedirAtualizar(bindingId, { paused: pausado }).catch(() => undefined);
    this.linhaDeBase(userId, ws);
    this.assinar(ws);
    this.avisarTela(userId);
  }

  async cancel(userId: string, claimId: string): Promise<void> {
    const c = this.claims.get(claimId);
    if (!c || c.userId !== userId) return;
    this.claims.delete(claimId);
    await this.cliente?.pedir({ type: 'link.cancel', id: novoId('req'), claimId }, 10_000).catch(() => undefined);
  }

  async setNotices(userId: string, ws: string, bindingId: string, notices: boolean): Promise<Record<string, unknown>> {
    const b = this.vinculo(bindingId);
    if (!b || b.user_id !== userId || (b.status !== 'active' && b.status !== 'paused')) throw new HttpError(404, 'not_found', 'conta do Teams não encontrada');
    this.d.db.run('UPDATE teams_bindings SET notices = ?, updated_at = ? WHERE binding_id = ?', notices ? 1 : 0, now(), bindingId);
    await this.pedirAtualizar(bindingId, { notices }).catch(() => undefined);
    if (notices) this.linhaDeBase(userId, ws);
    this.avisarTela(userId);
    return { binding: (this.estado(userId).bindings as Array<{ id: string }>).find((x) => x.id === bindingId) };
  }

  /** Desligar pela tela: o serviço apaga o vínculo e a fila, e avisa no Teams (R13). Sem conexão, vai quando voltar. */
  async revoke(userId: string, bindingId: string): Promise<void> {
    const b = this.vinculo(bindingId);
    if (!b || b.user_id !== userId) throw new HttpError(404, 'not_found', 'conta do Teams não encontrada');
    if (b.status === 'revoked') { this.apagarVinculo(bindingId); this.avisarTela(userId); return; }
    this.d.db.run("UPDATE teams_bindings SET status = 'revoking', updated_at = ? WHERE binding_id = ?", now(), bindingId);
    this.d.db.run("UPDATE teams_outbox SET status = 'failed', error = 'not_linked' WHERE binding_id = ? AND status = 'pending'", bindingId);
    const c = this.cliente;
    if (c && c.estado === 'connected') {
      try {
        const ack = await c.pedir({ type: 'link.revoke', id: novoId('req'), bindingId }, 15_000);
        if (ack.ok || ack.error?.code === 'not_found') this.apagarVinculo(bindingId);
      } catch { /* fica "desligando": a próxima conexão termina */ }
    }
    this.avisarTela(userId);
  }

  // ------------------------------------------------------------------------------------------------ bots oficiais
  /** A conta de bot ligada pelo link de uso único (o serviço avisa com link.added): grava o vínculo daqui. */
  private async adicionado(f: Quadro): Promise<Record<string, unknown>> {
    const id = typeof f.bindingId === 'string' && ID_VINCULO.test(f.bindingId) ? f.bindingId : null;
    const plat = f.platform === 'telegram' || f.platform === 'discord' ? f.platform : null;
    if (!id || !plat) return { ok: false, status: 'rejected', error: { code: 'invalid' } };
    if (this.vinculo(id)) return { ok: true, status: 'accepted' };
    const ini = typeof f.personRef === 'string' ? this.iniciados.get(f.personRef) : undefined;
    // o personRef é de alguém daqui? (o link vale 10 min; depois disso, quem pediu ainda é procurado entre as pessoas)
    const userId = ini?.userId ?? this.d.db.all<{ id: string }>('SELECT id FROM users').map((u) => u.id).find((u) => this.personRef(u) === f.personRef);
    if (!userId) return { ok: false, status: 'rejected', error: { code: 'unknown_person' } };
    const ws = ini?.ws ?? this.d.db.get<{ w: string }>('SELECT workspace_id AS w FROM memberships WHERE user_id = ? ORDER BY CASE role WHEN \'owner\' THEN 0 ELSE 1 END, created_at LIMIT 1', userId)?.w;
    if (!ws) return { ok: false, status: 'rejected', error: { code: 'unknown_person' } };
    await this.gravarVinculo({ userId, ws }, id, typeof f.teamsName === 'string' ? f.teamsName.slice(0, 120) : '', f.status === 'paused', plat);
    return { ok: true, status: 'accepted' };
  }

  /** A plataforma de bot está oferecida na tela? (o serviço respondeu e diz que ela está ligada) */
  disponivelBot(plat: PlataformaBot): boolean { return this.disponivel() && this.plataformasDoRele[plat]; }

  /** GET /api/canais-oficiais/:plat: as contas ligadas daquela plataforma e se o bot oficial está disponível. */
  estadoBot(userId: string, plat: PlataformaBot): Record<string, unknown> {
    const disponivel = this.disponivelBot(plat);
    if (!disponivel && this.base() && this.ligado && !this.conferindoSaude && (!this.saudeOficial || this.agora() - this.saudeOficial.em >= 60_000)) {
      void this.conferirSaude().then((ok) => { if (ok && this.ligado && !this.cliente) void this.start(); });
    }
    const accounts = this.vinculosDe(userId, ['active', 'paused', 'revoked'], plat).map((b) => ({
      id: b.binding_id, name: b.teams_name && b.teams_name !== CLOSED_VALUE ? b.teams_name : null, linkedAt: b.created_at, notices: Number(b.notices) === 1, status: b.status,
      ...(b.status === 'revoked' ? { revokedBy: b.revoked_by } : {}),
    }));
    // Discord: o "Adicionar ao Discord" com state só quando o serviço oferece (linkStart); senão, liga pelo código, com o
    // link de adicionar o bot (montado pelo id do app que o serviço informou)
    const i = this.infoAtual();
    const extra = plat === 'discord'
      ? { linkStart: !!i?.discord?.linkStart, ...(i?.discord ? { installUrl: i.discord.installUrl, botName: i.discord.botName } : {}) }
      : { linkStart: true, ...(i?.telegram?.botUsername ? { botUsername: i.telegram.botUsername } : {}) };
    return { platform: plat, available: disponivel, connection: this.estadoConexao(), enabled: this.ligadoPara(userId, plat), accounts, ...extra, ...(this.problema ? { problem: this.problema } : {}) };
  }

  /** "Abrir no Telegram" / "Adicionar ao Discord": o serviço gera um link de uso único (10 min) ligado a esta pessoa. */
  async iniciarBot(userId: string, ws: string, plat: PlataformaBot, nomeDaPessoa: string): Promise<{ url: string; expiresAt: string }> {
    if (!this.disponivelBot(plat)) throw new HttpError(409, 'unavailable', 'Ainda não disponível.');
    // serviço sem o "Adicionar ao Discord" com state: a conta liga pelo código (a tela mostra o link do bot e o campo)
    if (plat === 'discord' && this.infoAtual() && !this.infoAtual()!.discord?.linkStart) throw new HttpError(409, 'code_only', 'Adicione o bot Ergon no Discord, mande "oi" na conversa com ele e digite aqui o código que ele responder.');
    if (!this.papel(ws, userId)) throw new HttpError(403, 'forbidden', 'sem acesso a este workspace');
    const ref = this.personRef(userId);
    if (!ref) throw erroDaTela('offline');
    const label = (nomeDaPessoa.trim().split(/\s+/)[0] || 'você').slice(0, 40);
    this.iniciados.set(ref, { userId, ws, ate: this.agora() + 24 * 3600_000 });
    const ack = await this.pedir({ type: 'link.start', id: novoId('req'), personRef: ref, platform: plat, label, notices: true }, plat);
    const url = typeof ack.url === 'string' ? ack.url : '';
    const ok = plat === 'telegram' ? /^https:\/\/t\.me\/[A-Za-z0-9_]{4,32}\?start=[A-Za-z0-9_-]{1,64}$/.test(url) : /^https:\/\/discord\.com\/oauth2\/authorize\?/.test(url);
    if (!ok) throw erroDaTela('teams_relay');
    return { url, expiresAt: typeof ack.expiresAt === 'string' ? ack.expiresAt : new Date(this.agora() + 600_000).toISOString() };
  }

  /** Desligar uma conta de bot (o mesmo caminho do Teams: o serviço apaga e avisa no chat). */
  async revogarBot(userId: string, plat: PlataformaBot, bindingId: string): Promise<void> {
    const b = this.vinculo(bindingId);
    if (!b || b.user_id !== userId || (b.platform ?? 'teams') !== plat) throw new HttpError(404, 'not_found', 'conta não encontrada');
    await this.revoke(userId, bindingId);
  }
}
