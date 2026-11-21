// O estado da sincronia com o Ergon World em linguagem de gente (rc.41): a sincronia é automática, então a tela não
// tem mais "ver o que chegou / enviar / autorizar"; mostra em que pé está e só o que pede decisão da pessoa. Daqui
// saem a linha do quadro "Sincronizar aparelhos", o selo do cartão do workspace e a linha do cartão da nuvem
// ("Subir o WS para o World"). Sem tela aqui: conferido por sinc-estado.test.ts.
import type { tw } from './textos.ts';

/** o que GET /api/world/sync devolve (servidor mais antigo: sem auto nem atividade) */
export interface SyncAuto {
  auto: boolean; ultimaOk: string | null; ultimaTentativa: string | null;
  pendencia: { codigo: string; passo: 'presenca' | 'chave' | 'giro' | 'receber' | 'enviar'; desde: string; vezes: number } | null;
  equipeRetida: boolean; nuvem: { ativa: boolean; esperandoChave: boolean; appState: string | null } | null;
}
export interface SyncStatus {
  bound: boolean; enabled: boolean; syncWorkspaceId?: string | null; origin?: 'created' | 'joined' | null; keyState?: 'mine' | 'first' | 'handover' | null;
  lastVersion?: number; conflicts?: number; keyVersion?: number; rotationPending?: boolean; recoveryOutdated?: boolean; lastSyncAt?: string | null;
  /** com o que o envelope de recuperação desta conta abre (rc.42); null: nenhum gravado daqui */
  recoveryKind?: 'phrase' | 'world' | null;
  auto?: SyncAuto | null; atividade?: { ativo: boolean; fase: 'enviando' | 'recebendo' | null; pausada: boolean } | null;
}
export type Tom = 'ok' | 'info' | 'warn';
export type Situacao = 'desligada' | 'enviando' | 'recebendo' | 'decisao' | 'pendente' | 'pausada' | 'em_dia' | 'comecando' | 'manual';
export interface Quadro {
  situacao: Situacao; tom: Tom;
  /** a linha principal e, quando há, o que está pendente (uma frase) */
  linha: string; pendente: string | null;
  /** o que só a pessoa resolve, na ordem em que a tela mostra */
  decisoes: Array<'conflitos' | 'equipe' | 'frase'>;
  /** o selo curto do cartão do workspace */
  selo: string; seloTom: Tom | null;
}

/** passageiros: resolvem sozinhos na volta seguinte; só viram aviso depois de se repetirem */
const PASSAGEIROS: Record<string, number> = { version_conflict: 3, key_version: 3, world_offline: 2, rate_limited: 2 };

/** A frase do que ficou pendente na última volta (null: nada que valha dizer ainda). */
export function fraseDaPendencia(p: SyncAuto['pendencia'], t: typeof tw): string | null {
  if (!p) return null;
  if ((PASSAGEIROS[p.codigo] ?? 1) > p.vezes) return null;
  switch (p.codigo) {
    case 'world_offline': return t('sinc.pend.semWorld');
    case 'rate_limited': return t('sinc.pend.pausaWorld');
    case 'version_conflict': case 'key_version': return t('sinc.pend.aoMesmoTempo');
    case 'key_pending': return t('sinc.pend.chaveNova');
    case 'rotation_required': return t('sinc.pend.trocaChave');
    case 'world_inactive': case 'payment_required': return t('sinc.pend.semPlano');
    case 'sync_frozen': return t('sinc.pend.congelado');
    case 'sync_invalid': return t('sinc.pend.naoLeu');
    case 'sync_key_closed': return t('sinc.pend.fechada');
    case 'sync_forbidden': return p.passo === 'giro' ? t('sinc.pend.trocaChave') : t('sinc.pend.soLeitura');
    default: return p.passo === 'chave' ? t('sinc.pend.chaveAparelho') : t('sinc.pend.outro', { codigo: p.codigo });
  }
}

const mesmoDia = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/**
 * O quadro "Sincronizar aparelhos" e o selo do cartão. `hora` e `dia` formatam a última sincronia (a tela passa os do
 * idioma); `agora` existe para o teste.
 */
export function quadroDaSincronia(s: SyncStatus, t: typeof tw, f: { hora: (d: Date) => string; dia: (d: Date) => string }, agora = new Date()): Quadro {
  if (!s.enabled) return { situacao: 'desligada', tom: 'info', linha: t('sinc.desligada'), pendente: null, decisoes: [], selo: t('sinc.selo.desligada'), seloTom: null };
  const a = s.auto ?? null;
  const decisoes: Quadro['decisoes'] = [];
  if ((s.conflicts ?? 0) > 0) decisoes.push('conflitos');
  if (a?.equipeRetida) decisoes.push('equipe');
  if (s.recoveryOutdated) decisoes.push('frase');
  const pendente = fraseDaPendencia(a?.pendencia ?? null, t);
  const ultima = a?.ultimaOk ?? s.lastSyncAt ?? null;
  const quando = () => { const d = new Date(ultima!); return mesmoDia(d, agora) ? t('sinc.ultimaHoje', { hora: f.hora(d) }) : t('sinc.ultimaDia', { dia: f.dia(d), hora: f.hora(d) }); };
  const base = { pendente, decisoes };
  if (s.atividade?.ativo && s.atividade.fase) {
    const env = s.atividade.fase === 'enviando';
    // i18n-ok: códigos da situação (o texto da tela vem de t())
    return { ...base, situacao: env ? 'enviando' : 'recebendo', tom: 'info', linha: env ? t('sinc.enviando') : t('sinc.recebendo'), selo: t('sinc.selo.sincronizando'), seloTom: 'info' };
  }
  // o que espera a pessoa vem antes de tudo: enquanto a equipe nova não é vista, nada vem nem vai
  if (decisoes.includes('equipe')) return { ...base, situacao: 'decisao', tom: 'warn', linha: t('sinc.esperaEquipe'), selo: t('sinc.selo.esperaVoce'), seloTom: 'warn' };
  if (pendente) return { ...base, situacao: 'pendente', tom: 'warn', linha: ultima ? t('sinc.pendenteDesde', { quando: quando() }) : t('sinc.pendente'), selo: t('sinc.selo.pendente'), seloTom: 'warn' };
  if (decisoes.includes('conflitos')) return { ...base, situacao: 'decisao', tom: 'warn', linha: t('sinc.esperaConflitos', { n: s.conflicts ?? 0 }), selo: t('sinc.selo.esperaVoce'), seloTom: 'warn' };
  // i18n-ok: código da situação
  if (s.atividade?.pausada) return { ...base, situacao: 'pausada', tom: 'info', linha: t('sinc.pausada'), selo: t('sinc.selo.sincronizando'), seloTom: 'info' };
  // servidor sem a sincronia automática (instalação que a desligou, ou versão de antes): só a saída manual
  if (!a || !a.auto) return { ...base, situacao: 'manual', tom: 'info', linha: ultima ? t('sinc.manualDesde', { quando: quando() }) : t('sinc.manual'), selo: t('sinc.selo.ligada'), seloTom: null };
  if (!a.ultimaOk) return { ...base, situacao: 'comecando', tom: 'info', linha: t('sinc.comecando'), selo: t('sinc.selo.sincronizando'), seloTom: 'info' };
  return { ...base, situacao: 'em_dia', tom: 'ok', linha: t('sinc.emDia', { quando: quando() }), selo: t('sinc.selo.emDia'), seloTom: 'ok' };
}

// ---------------------------------------------------------------------------------------------------------------------
// O cartão "Subir o WS para o World": o estado de verdade do contêiner (o que GET /v1/cloud devolve)

export interface NuvemEstado { active: boolean; runtime?: string | null; runtimeError?: string | null; appState?: string | null; keyWanted?: boolean | null }
/** `appState` vem como "estado" ou "estado: detalhe" (o que o contêiner conta ao World) */
export function lerAppState(v: string | null | undefined): { estado: 'preparando' | 'aguardando_chave' | 'pronto' | 'erro' | null; detalhe: string | null } {
  const m = /^(preparando|aguardando_chave|pronto|erro)(?::\s*(.*))?$/s.exec((v ?? '').trim());
  return m ? { estado: m[1] as 'pronto', detalhe: m[2]?.trim() || null } : { estado: null, detalhe: null };
}
/** os passos do preparo que o contêiner conta, pelo começo da frase dele → a frase da tela */
const PASSOS: Array<[RegExp, 'ws.passo.dados' | 'ws.passo.equipe' | 'ws.passo.modelo' | 'ws.passo.canais']> = [
  [/^recebendo/i, 'ws.passo.dados'], [/^ligando a equipe/i, 'ws.passo.equipe'], [/^ligando o modelo/i, 'ws.passo.modelo'], [/^ligando os canais/i, 'ws.passo.canais'],
];

/**
 * A linha de estado do cartão da nuvem. `syncLigada`: este computador tem a sincronia ligada neste workspace (é ele
 * quem entrega a chave); sem ela, a espera da chave não se resolve sozinha daqui e a frase diz o que fazer.
 */
export function linhaDaNuvem(d: NuvemEstado, t: typeof tw, o: { syncLigada?: boolean } = {}): { texto: string; tom: Tom; preparando: boolean } | null {
  if (!d.active) return null;
  const rt = d.runtime ?? null; const app = lerAppState(d.appState);
  const fixo = (texto: string, tom: Tom = 'info') => ({ texto, tom, preparando: false });
  if (rt === 'pausado') return fixo(t('ws.estado.pausado'), 'warn');
  if (rt === 'erro') return fixo(d.runtimeError ? t('ws.estado.erroCom', { motivo: d.runtimeError.slice(0, 160) }) : t('ws.estado.erro'), 'warn');
  if (rt === 'fila') return fixo(t('ws.estado.fila'));
  if (rt === 'desconhecido') return fixo(t('ws.estado.semSinal'), 'warn');
  // a espera da chave vale com o contêiner de pé; dormindo, ele volta a pedir quando acordar
  const esperaChave = d.keyWanted === true || (d.keyWanted == null && app.estado === 'aguardando_chave');
  if (rt === 'rodando' || rt === null) {
    if (esperaChave) return { texto: o.syncLigada === false ? t('ws.estado.chaveSemSync') : t('ws.estado.chave'), tom: o.syncLigada === false ? 'warn' : 'info', preparando: true };
    if (app.estado === 'pronto') return fixo(t('ws.estado.pronta'), 'ok');
    if (app.estado === 'erro') return fixo(app.detalhe ? t('ws.estado.erroCom', { motivo: app.detalhe.slice(0, 160) }) : t('ws.estado.erro'), 'warn');
    if (app.estado === 'preparando' || app.estado === 'aguardando_chave') {
      const passo = PASSOS.find(([re]) => re.test(app.detalhe ?? ''))?.[1];
      return { texto: passo ? t('ws.estado.preparandoPasso', { passo: t(passo) }) : t('ws.estado.preparando'), tom: 'info', preparando: true };
    }
    return rt === 'rodando' ? { texto: t('ws.estado.ligando'), tom: 'info', preparando: true } : fixo(t('ws.estado.parado'));
  }
  if (rt === 'dormindo') {
    // nunca ficou pronta: dormindo, mas o preparo ainda não terminou (termina na próxima vez que acordar com este computador aberto)
    if (esperaChave) return fixo(o.syncLigada === false ? t('ws.estado.chaveSemSync') : t('ws.estado.dormindoSemChave'), o.syncLigada === false ? 'warn' : 'info');
    if (app.estado === 'erro') return fixo(app.detalhe ? t('ws.estado.erroCom', { motivo: app.detalhe.slice(0, 160) }) : t('ws.estado.erro'), 'warn');
    return fixo(app.estado === 'pronto' || app.estado === null ? t('ws.estado.dormindo') : t('ws.estado.dormindoPreparo'), app.estado === 'pronto' ? 'ok' : 'info');
  }
  return fixo(t('ws.estado.parado'));
}
