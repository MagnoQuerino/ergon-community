/**
 * Ajustes da equipe que são configuração do motor de IA (rc.27): o que a pessoa escolhe em Configurações e o motor passa a
 * fazer — modelos reserva (plano B quando o modelo principal falha), "não treinar com os meus dados", busca privada,
 * arrumar competências sem uso — mais o idioma das mensagens do próprio motor e a pausa da equipe.
 *
 * O jeito é o dos passos por pedido e da compactação (custo.ts): a ESCOLHA fica gravada no workspace; o motor é um só para
 * os workspaces de quem é dono (ou para a instalação), então vale a escolha gravada mais recente entre eles; o servidor
 * manda ao motor pela ponte de controle na hora, e de novo quando ele abre ou a cada volta do passo de fundo enquanto não
 * chegou. Ausente = o padrão (automações ligadas por padrão; o que tem custo ou risco, desligado).
 *
 * Padrões (regra do dono, 12/11: todo benefício vem ligado, mesmo os que custam; a pessoa reduz para economizar): reserva
 * automática (as outras contas de IA conectadas, na ordem; sem outra conta, nenhuma); não treinar: LIGADO (proteção); busca
 * privada: desligada (ligada, a equipe perde a leitura de páginas: é menos poder); arrumar competências sem uso: DESLIGADO
 * (é economia, não benefício: só arquiva); anotar na memória depois da conversa: LIGADO; profundidade do raciocínio: ALTA;
 * pausa: solta.
 */
import type { Db } from '../db/db.ts';
import { HermesError, type AjustesMotor, type AjustesPatch, type HermesControlClient, type ModeloReserva, type ModelOptions, type Raciocinio } from './hermes.ts';
import { getSetting, setSetting } from './sectors.ts';

export const RESERVA_SETTING = 'team.reserva';
export const NAO_TREINAR_SETTING = 'team.naoTreinar';
export const BUSCA_PRIVADA_SETTING = 'team.buscaPrivada';
export const ARRUMAR_SETTING = 'team.arrumarCompetencias';
export const PAUSA_SETTING = 'team.pausa';
export const ANOTAR_MEMORIA_SETTING = 'team.anotarMemoria';
export const RACIOCINIO_SETTING = 'team.raciocinio';
export const RACIOCINIOS: readonly Raciocinio[] = ['high', 'medium', 'low', 'modelo'];
/** o padrão (migração 10 do cofre: o "low" que ninguém escolheu vira "high"; RACIOCINIO_PADRAO no plugin) */
export const RACIOCINIO_PADRAO: Raciocinio = 'high';
/** no motor, a do modelo é '' */
const noMotor = (r: Raciocinio): string => (r === 'modelo' ? '' : r);
/** o que o motor confirmou por último (JSON de AjustesMotor), ou SEM_AJUSTES; gravado em cada workspace do motor */
export const AJUSTES_MOTOR = 'team.ajustes.motor';
/** o motor é de antes dos ajustes (plugin sem a capacidade): as escolhas ficam guardadas e chegam com a atualização */
export const SEM_AJUSTES = 'sem';
export const CAPACIDADE_AJUSTES = 'ajustes';
export const RESERVA_MAX = 5;
/** na reserva automática: no máximo estas contas (cada uma com um modelo) */
export const RESERVA_AUTO_MAX = 3;
export const AJUSTES_RECONFERE_MS = 10 * 60_000;

export type ReservaModo = 'auto' | 'lista' | 'desligado';
export interface ReservaEscolha { modo: ReservaModo; lista: ModeloReserva[] }
export interface EscolhasDaEquipe { reserva: ReservaEscolha; naoTreinar: boolean; buscaPrivada: boolean; arrumarCompetencias: boolean; anotarMemoria: boolean; raciocinio: Raciocinio }

function ultimaEntre(db: Db, key: string, ids: string[]): string | undefined {
  if (!ids.length) return undefined;
  return db.get<{ value: string }>(
    `SELECT value FROM workspace_settings WHERE key = ? AND workspace_id IN (${ids.map(() => '?').join(',')}) ORDER BY updated_at DESC LIMIT 1`,
    key, ...ids)?.value;
}
const ligado = (v: string | undefined, padrao: boolean): boolean => (v === 'ligado' ? true : v === 'desligado' ? false : padrao);

const PROVEDOR = /^[a-z0-9][a-z0-9_.:-]{0,60}$/;
const MODELO = /^[\w./:@+-]{1,160}$/;
/** A lista de modelos reserva válida, sem repetidos, na ordem, até RESERVA_MAX. */
export function reservaLimpa(raw: unknown): ModeloReserva[] {
  const out: ModeloReserva[] = [];
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!e || typeof e !== 'object') continue;
    const provider = String((e as ModeloReserva).provider ?? '').trim().toLowerCase();
    const model = String((e as ModeloReserva).model ?? '').trim();
    if (!PROVEDOR.test(provider) || !MODELO.test(model)) continue;
    if (!out.some((x) => x.provider === provider && x.model === model)) out.push({ provider, model });
  }
  return out.slice(0, RESERVA_MAX);
}

export function reservaEscolhida(db: Db, ids: string[]): ReservaEscolha {
  try {
    const v = JSON.parse(ultimaEntre(db, RESERVA_SETTING, ids) ?? 'null') as Partial<ReservaEscolha> | null;
    if (v && (v.modo === 'lista' || v.modo === 'desligado' || v.modo === 'auto')) return { modo: v.modo, lista: v.modo === 'lista' ? reservaLimpa(v.lista) : [] };
  } catch { /* ilegível: o padrão */ }
  return { modo: 'auto', lista: [] };
}

export function escolhasDaEquipe(db: Db, ids: string[]): EscolhasDaEquipe {
  return {
    reserva: reservaEscolhida(db, ids),
    naoTreinar: ligado(ultimaEntre(db, NAO_TREINAR_SETTING, ids), true),
    buscaPrivada: ligado(ultimaEntre(db, BUSCA_PRIVADA_SETTING, ids), false),
    arrumarCompetencias: ligado(ultimaEntre(db, ARRUMAR_SETTING, ids), false),
    anotarMemoria: ligado(ultimaEntre(db, ANOTAR_MEMORIA_SETTING, ids), true),
    raciocinio: ((v) => (RACIOCINIOS as readonly string[]).includes(v ?? '') ? v as Raciocinio : RACIOCINIO_PADRAO)(ultimaEntre(db, RACIOCINIO_SETTING, ids)),
  };
}

/**
 * A reserva automática: as OUTRAS contas de IA conectadas (não a do modelo principal), na ordem em que o motor as lista,
 * cada uma com um modelo — o mesmo do principal, se a conta o tem; senão o primeiro dela. Só uma conta conectada: nenhuma.
 */
export function reservaAutomatica(o: ModelOptions | null): ModeloReserva[] {
  if (!o) return [];
  const out: ModeloReserva[] = [];
  for (const p of o.providers) {
    if (!p.authenticated || p.current || p.slug === o.provider || !p.models.length) continue;
    const model = (o.model && p.models.includes(o.model) ? o.model : p.models[0]);
    out.push({ provider: p.slug, model });
  }
  return reservaLimpa(out).slice(0, RESERVA_AUTO_MAX);
}

/** Só os modelos que ainda existem numa conta conectada (uma conta desconectada sai da reserva sem a pessoa mexer). */
export function reservaValida(lista: ModeloReserva[], o: ModelOptions | null): ModeloReserva[] {
  if (!o) return lista;
  return lista.filter((e) => o.providers.some((p) => p.slug === e.provider && p.authenticated && p.models.includes(e.model)));
}

export interface ContextoDosAjustes {
  /** o catálogo de modelos do motor (contas conectadas); null = não deu para ler agora (a reserva não é mexida) */
  opcoes: ModelOptions | null;
  /** o idioma da pessoa dona do motor; undefined = sem escolha (o motor fica como está) */
  idioma?: 'pt' | 'en';
}

const mesmaLista = (a: ModeloReserva[], b: ModeloReserva[]) => a.length === b.length && a.every((x, i) => x.provider === b[i].provider && x.model === b[i].model);

/** O que falta mandar ao motor para ele ficar como a pessoa escolheu (vazio = já está). */
export function patchDosAjustes(e: EscolhasDaEquipe, atual: AjustesMotor, ctx: ContextoDosAjustes): AjustesPatch {
  const p: AjustesPatch = {};
  // sem o catálogo (motor ocupado, painel interno subindo): a reserva fica como está; a próxima volta confere
  if (ctx.opcoes || e.reserva.modo === 'desligado') {
    const quer = e.reserva.modo === 'desligado' ? [] : e.reserva.modo === 'lista' ? reservaValida(e.reserva.lista, ctx.opcoes) : reservaAutomatica(ctx.opcoes);
    if (!mesmaLista(quer, atual.reserva)) p.reserva = quer;
  }
  if (e.naoTreinar !== atual.naoTreinar) p.naoTreinar = e.naoTreinar;
  // busca privada num motor sem a busca direta: não manda (ele recusaria; a equipe não fica sem busca). Desligar sempre vai.
  if (e.buscaPrivada !== atual.buscaPrivada && (!e.buscaPrivada || atual.buscaPrivadaDisponivel)) p.buscaPrivada = e.buscaPrivada;
  if (e.arrumarCompetencias !== atual.arrumarCompetencias) p.arrumarCompetencias = e.arrumarCompetencias;
  // motor de antes destes dois (o plugin não diz): não manda (ele recusaria o pedido inteiro)
  if (atual.anotarMemoria !== undefined && e.anotarMemoria !== atual.anotarMemoria) p.anotarMemoria = e.anotarMemoria;
  if (atual.raciocinio !== undefined && noMotor(e.raciocinio) !== atual.raciocinio) p.raciocinio = e.raciocinio;
  if (ctx.idioma && ctx.idioma !== atual.idioma) p.idioma = ctx.idioma;
  return p;
}

function gravarMotor(db: Db, ids: string[], v: string): void {
  for (const ws of ids) if (getSetting(db, ws, AJUSTES_MOTOR) !== v) setSetting(db, ws, AJUSTES_MOTOR, v);
}
export function ajustesNoMotor(db: Db, ids: string[]): AjustesMotor | 'sem' | null {
  const v = ultimaEntre(db, AJUSTES_MOTOR, ids);
  if (v === SEM_AJUSTES) return 'sem';
  try { const j = v ? JSON.parse(v) as AjustesMotor : null; return j && Array.isArray(j.reserva) ? j : null; } catch { return null; }
}

/**
 * Deixa o motor com as escolhas e grava o que ele confirmou. Devolve como o motor ficou; null = motor sem a ponte dos
 * ajustes (versão anterior): fica gravado SEM_AJUSTES e a tela diz que chega com a próxima atualização da equipe. Erro de
 * rede sobe (quem chama tenta de novo depois).
 */
export async function sincronizarAjustes(db: Db, control: HermesControlClient | null, ids: string[], ctx: ContextoDosAjustes): Promise<AjustesMotor | null> {
  if (!control?.ajustes || !control.setAjustes) return null;
  const info = control.info ? await control.info().catch(() => null) : null;
  if (info?.ok && !(info.capacidades ?? []).includes(CAPACIDADE_AJUSTES)) { gravarMotor(db, ids, SEM_AJUSTES); return null; }
  let atual = await control.ajustes();
  if (atual === null) { gravarMotor(db, ids, SEM_AJUSTES); return null; }
  const patch = patchDosAjustes(escolhasDaEquipe(db, ids), atual, ctx);
  if (Object.keys(patch).length) {
    try { atual = (await control.setAjustes(patch)) ?? atual; }
    catch (err) {
      // a busca direta sumiu entre a leitura e a gravação: manda o resto, sem ela
      if (!(err instanceof HermesError && err.status === 409 && patch.buscaPrivada)) throw err;
      const { buscaPrivada: _b, ...resto } = patch;
      if (Object.keys(resto).length) atual = (await control.setAjustes(resto)) ?? atual;
    }
  }
  gravarMotor(db, ids, JSON.stringify(atual));
  return atual;
}

export interface AjustesDaEquipe {
  reserva: { modo: ReservaModo; lista: ModeloReserva[]; /** o que está valendo no motor agora */ emUso: ModeloReserva[] };
  naoTreinar: boolean;
  buscaPrivada: boolean;
  /** a busca privada foi escolhida, mas esta versão da equipe ainda não traz a busca direta: chega com a atualização */
  buscaPrivadaAguarda: boolean;
  arrumarCompetencias: boolean;
  anotarMemoria: boolean;
  raciocinio: Raciocinio;
  /** alguma escolha ainda não chegou ao motor (ele estava fora): chega quando ligar */
  pendente: boolean;
  /** o motor é de antes dos ajustes: as escolhas ficam guardadas e chegam com a próxima atualização da equipe */
  atualizacao: boolean;
}

/** O que a tela mostra: as escolhas da pessoa (ou os padrões) e se o motor já está com elas. */
export function ajustesDaEquipe(db: Db, ids: string[]): AjustesDaEquipe {
  const e = escolhasDaEquipe(db, ids);
  const motor = ajustesNoMotor(db, ids);
  const base = { reserva: { modo: e.reserva.modo, lista: e.reserva.lista, emUso: [] as ModeloReserva[] }, naoTreinar: e.naoTreinar, buscaPrivada: e.buscaPrivada,
    buscaPrivadaAguarda: false, arrumarCompetencias: e.arrumarCompetencias, anotarMemoria: e.anotarMemoria, raciocinio: e.raciocinio };
  if (motor === 'sem') return { ...base, pendente: false, atualizacao: true };
  if (!motor) return { ...base, pendente: false, atualizacao: false }; // ainda não lido (motor nunca aberto desde a atualização): sem aviso
  const aguarda = e.buscaPrivada && !motor.buscaPrivada && !motor.buscaPrivadaDisponivel;
  const pendente = e.naoTreinar !== motor.naoTreinar || e.arrumarCompetencias !== motor.arrumarCompetencias || (e.buscaPrivada !== motor.buscaPrivada && !aguarda)
    || (e.reserva.modo === 'desligado' && motor.reserva.length > 0)
    || (motor.anotarMemoria !== undefined && e.anotarMemoria !== motor.anotarMemoria) || (motor.raciocinio !== undefined && noMotor(e.raciocinio) !== motor.raciocinio);
  return { ...base, reserva: { ...base.reserva, emUso: motor.reserva }, buscaPrivadaAguarda: aguarda, pendente, atualizacao: false };
}

/** Grava as escolhas que vieram (no workspace de quem escolheu; valem para os workspaces do mesmo motor). */
export function gravarEscolhas(db: Db, workspaceId: string, p: { reserva?: { modo: ReservaModo; lista?: unknown }; naoTreinar?: boolean; buscaPrivada?: boolean; arrumarCompetencias?: boolean; anotarMemoria?: boolean; raciocinio?: Raciocinio }): void {
  const txt = (b: boolean) => (b ? 'ligado' : 'desligado');
  if (p.reserva) setSetting(db, workspaceId, RESERVA_SETTING, JSON.stringify({ modo: p.reserva.modo, lista: p.reserva.modo === 'lista' ? reservaLimpa(p.reserva.lista) : [] }));
  if (p.naoTreinar !== undefined) setSetting(db, workspaceId, NAO_TREINAR_SETTING, txt(p.naoTreinar));
  if (p.buscaPrivada !== undefined) setSetting(db, workspaceId, BUSCA_PRIVADA_SETTING, txt(p.buscaPrivada));
  if (p.arrumarCompetencias !== undefined) setSetting(db, workspaceId, ARRUMAR_SETTING, txt(p.arrumarCompetencias));
  if (p.anotarMemoria !== undefined) setSetting(db, workspaceId, ANOTAR_MEMORIA_SETTING, txt(p.anotarMemoria));
  if (p.raciocinio !== undefined && RACIOCINIOS.includes(p.raciocinio)) setSetting(db, workspaceId, RACIOCINIO_SETTING, p.raciocinio);
}

// ---------------------------------------------------------------- o modelo reserva foi usado?
/**
 * O motor informa, ao terminar, quem atendeu de fato (conta e modelo). Foi o reserva quando esse par está na cadeia de
 * reserva do motor e não é o que foi pedido (o modelo do agente, ou o padrão da conta).
 */
export function reservaUsada(served: { provider: string | null; model: string | null } | null | undefined,
  pedido: { provider: string | null; model: string | null }, cadeia: ModeloReserva[]): ModeloReserva | null {
  if (!served?.model || !cadeia.length) return null;
  const hit = cadeia.find((e) => e.model === served.model && (!served.provider || e.provider === served.provider));
  if (!hit) return null;
  const oPedido = served.model === pedido.model && (!pedido.provider || !served.provider || served.provider === pedido.provider);
  return oPedido ? null : hit;
}

// ---------------------------------------------------------------- pausar a equipe
/**
 * Pausa: nenhum trabalho NOVO começa (os pedidos e as conversas esperam na fila, sem prazo correndo); o que já está em
 * andamento termina. No motor, é a parada geral do Hermes (agendamentos e canais diretos dele também esperam); a rota de
 * execuções do Hermes não confere a parada, então quem segura os pedidos do Ergon é a fila do próprio Ergon (RunExecutor).
 * A pausa é do motor: vale para todos os workspaces dele.
 */
export interface PausaDaEquipe { pausada: boolean; desde: string | null }
export function pausaDaEquipe(db: Db, ids: string[]): PausaDaEquipe {
  const v = ultimaEntre(db, PAUSA_SETTING, ids);
  if (!v || v === 'desligado') return { pausada: false, desde: null };
  return { pausada: true, desde: /^\d{4}-\d\d-\d\dT/.test(v) ? v : null };
}
export function gravarPausa(db: Db, ids: string[], pausada: boolean, agoraIso: string): void {
  // em todos os workspaces do motor: a fila de cada um consulta o seu, sem depender de qual gravou por último
  for (const ws of ids) setSetting(db, ws, PAUSA_SETTING, pausada ? agoraIso : 'desligado');
}
/** Deixa a parada geral do motor igual à pausa escolhida. Devolve como ficou; null = motor sem a ponte da pausa. */
export async function sincronizarPausa(db: Db, control: HermesControlClient | null, ids: string[]): Promise<boolean | null> {
  if (!control?.pausa || !control.setPausa) return null;
  const quer = pausaDaEquipe(db, ids).pausada;
  const atual = await control.pausa();
  if (atual === null || atual === quer) return atual;
  return control.setPausa(quer);
}
