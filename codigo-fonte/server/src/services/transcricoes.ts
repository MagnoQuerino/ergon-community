/**
 * Mensagem de áudio (rc.33): o áudio que a pessoa manda na conversa é transcrito pelo motor (o Whisper local da ponte,
 * voz/transcrever) em segundo plano, assim que sobe; o texto fica gravado ligado ao arquivo (audio_transcricoes, cifrado
 * pela chave do workspace) e vai ao agente junto do pedido (attachments.ts). O pedido da conversa espera a transcrição
 * terminar (RunExecutor.anexosPendentes), com a tela dizendo "transcrevendo…"; se falhar, o agente fica sabendo que há um
 * áudio que o sistema não transcreveu e a pessoa vê "tentar de novo".
 *
 * Teto: 10 minutos de áudio (a tela para sozinha em 10:00; aqui o servidor confere pela duração lida do arquivo) e 25 MB
 * (o que a ponte aceita).
 */
import type { Db } from '../db/db.ts';
import { duracaoDoAudio } from '../lib/duracao-audio.ts';
import { HttpError, now } from '../lib/util.ts';
import { log } from '../lib/log.ts';
import { openArtifactAsync } from './artifacts.ts';
import type { Bus } from './bus.ts';

/** 10 minutos, com um respiro para o último quadro do gravador */
export const AUDIO_MAX_S = 600;
const AUDIO_FOLGA_S = 2;
/** o que a ponte do motor aceita (voz/transcrever) */
export const AUDIO_MAX_BYTES = 25 * 1024 * 1024;
/** no máximo quanto o pedido espera a transcrição (o modelo maior num computador lento, mais o 1º download) */
export const ESPERA_MAX_MS = 20 * 60_000;

export type EstadoTranscricao = 'transcrevendo' | 'preparando' | 'pronta' | 'falhou';
export interface Transcricao { estado: EstadoTranscricao; texto: string | null; motivo: string | null; duracao: number | null }
/** o que a ponte respondeu (ok + texto, ou motivo) */
interface RespostaPonte { ok?: boolean; texto?: unknown; motivo?: unknown; provedor?: unknown }

export const ehAudio = (mime: string, nome: string): boolean => /^audio\//.test(mime) || /\.(ogg|oga|opus|mp3|m4a|wav|webm|flac|aac)$/i.test(nome);

/** O áudio passa do teto? Mensagem de tela, ou null. Duração desconhecida: vale o tamanho. */
export function foraDoTeto(data: Buffer): { motivo: 'longo' | 'grande'; duracao: number | null } | null {
  if (data.length > AUDIO_MAX_BYTES) return { motivo: 'grande', duracao: null };
  const d = duracaoDoAudio(data);
  if (d !== null && d > AUDIO_MAX_S + AUDIO_FOLGA_S) return { motivo: 'longo', duracao: d };
  return null;
}
export const TETO_TEXTO = { longo: 'áudio com mais de 10 minutos: grave em partes menores', grande: 'áudio grande demais (até 25 MB)' } as const;

/** A mensagem de tela do motivo da falha (o servidor guarda o código; a tela tem os textos). */
const MOTIVOS = new Set(['componente', 'formato', 'tamanho', 'longo', 'falhou', 'sem_motor', 'tempo']);

interface Deps {
  db: Db; bus: Bus; filesDir: string;
  /** a ponte do motor do workspace: voz/transcrever. Lança HttpError quando não há motor. */
  transcrever: (workspaceId: string, audio: Buffer, nome: string) => Promise<RespostaPonte>;
  /** o modelo de fala ainda vai ser baixado (1º uso)? null = não deu para saber */
  vaiPreparar?: (workspaceId: string) => Promise<boolean | null>;
}

interface Linha { artifact_id: string; estado: EstadoTranscricao; texto: string | null; motivo: string | null; duracao_s: number | null; inicio: string; fim: string | null }

export class Transcricoes {
  private readonly d: Deps;
  /** as que estão andando agora (uma por arquivo) */
  private readonly andando = new Map<string, Promise<void>>();
  constructor(d: Deps) { this.d = d; }

  private linha(ws: string, artId: string): Linha | undefined {
    return this.d.db.get<Linha>('SELECT artifact_id, estado, texto, motivo, duracao_s, inicio, fim FROM audio_transcricoes WHERE artifact_id = ? AND workspace_id = ?', artId, ws);
  }

  /** A transcrição de um arquivo (null = nunca começou). */
  de(ws: string, artId: string): Transcricao | null {
    const l = this.linha(ws, artId);
    return l ? { estado: l.estado, texto: l.texto, motivo: l.motivo, duracao: l.duracao_s } : null;
  }

  /** As de vários arquivos de uma vez (a lista da conversa). */
  deVarios(ws: string, ids: string[]): Map<string, Transcricao> {
    const out = new Map<string, Transcricao>();
    for (let i = 0; i < ids.length; i += 400) {
      const parte = ids.slice(i, i + 400);
      for (const l of this.d.db.all<Linha>(`SELECT artifact_id, estado, texto, motivo, duracao_s, inicio, fim FROM audio_transcricoes WHERE workspace_id = ? AND artifact_id IN (${parte.map(() => '?').join(', ')})`, ws, ...parte)) {
        out.set(l.artifact_id, { estado: l.estado, texto: l.texto, motivo: l.motivo, duracao: l.duracao_s });
      }
    }
    return out;
  }

  /**
   * Começa a transcrever (em segundo plano) o áudio do arquivo, se ainda não começou. `deNovo`: a pessoa pediu outra vez
   * (só depois de uma falha, ou para refazer uma pronta). Devolve a promessa do trabalho (para quem quer esperar).
   */
  iniciar(ws: string, artId: string, deNovo = false): Promise<void> {
    const ja = this.andando.get(artId);
    if (ja) return ja;
    const l = this.linha(ws, artId);
    if (l && !deNovo && l.estado !== 'transcrevendo' && l.estado !== 'preparando') return Promise.resolve();
    const t = now();
    // a linha antes do trabalho: a tela já mostra "transcrevendo…" e o pedido já sabe que precisa esperar
    this.d.db.run(`INSERT INTO audio_transcricoes (artifact_id, workspace_id, estado, inicio, updated_at) VALUES (?, ?, 'transcrevendo', ?, ?)
      ON CONFLICT(artifact_id) DO UPDATE SET estado = 'transcrevendo', texto = NULL, motivo = NULL, fim = NULL, inicio = excluded.inicio, updated_at = excluded.updated_at`, artId, ws, t, t);
    this.avisar(ws, artId);
    const p = this.trabalhar(ws, artId).catch((err) => {
      log.warn({ artifactId: artId, err: err instanceof Error ? err.message.slice(0, 200) : 'erro' }, 'transcrição: falhou sem resposta da ponte');
      this.terminar(ws, artId, { estado: 'falhou', motivo: 'falhou' });
    }).finally(() => this.andando.delete(artId));
    this.andando.set(artId, p);
    return p;
  }

  private async trabalhar(ws: string, artId: string): Promise<void> {
    const f = await openArtifactAsync(this.d.db, this.d.filesDir, ws, artId);
    const teto = foraDoTeto(f.data);
    const duracao = duracaoDoAudio(f.data);
    this.d.db.run('UPDATE audio_transcricoes SET duracao_s = ?, tentativas = tentativas + 1 WHERE artifact_id = ?', duracao, artId);
    if (teto) return this.terminar(ws, artId, { estado: 'falhou', motivo: teto.motivo === 'longo' ? 'longo' : 'tamanho' });
    // 1º uso: o modelo de fala é baixado agora (a tela diz "preparando a transcrição (primeira vez)…")
    let prepara: boolean | null = null;
    try { prepara = (await this.d.vaiPreparar?.(ws)) ?? null; } catch { prepara = null; }
    if (prepara) { this.d.db.run("UPDATE audio_transcricoes SET estado = 'preparando', updated_at = ? WHERE artifact_id = ?", now(), artId); this.avisar(ws, artId); }
    let r: RespostaPonte;
    try { r = await this.d.transcrever(ws, f.data, f.filename); }
    catch (err) {
      const semMotor = err instanceof HttpError && err.status === 503;
      return this.terminar(ws, artId, { estado: 'falhou', motivo: semMotor ? 'sem_motor' : 'falhou' });
    }
    if (r.ok === true) {
      const texto = String(r.texto ?? '').trim().slice(0, 200_000);
      return this.terminar(ws, artId, { estado: 'pronta', texto, provedor: typeof r.provedor === 'string' ? r.provedor.slice(0, 30) : null });
    }
    const m = String(r.motivo ?? '');
    this.terminar(ws, artId, { estado: 'falhou', motivo: MOTIVOS.has(m) ? m : 'falhou' });
  }

  private terminar(ws: string, artId: string, f: { estado: 'pronta' | 'falhou'; texto?: string; motivo?: string; provedor?: string | null }): void {
    const t = now();
    this.d.db.run('UPDATE audio_transcricoes SET estado = ?, texto = ?, motivo = ?, provedor = ?, fim = ?, updated_at = ? WHERE artifact_id = ? AND workspace_id = ?',
      f.estado, f.texto ? this.d.db.seal(ws, f.texto) : f.texto === '' ? '' : null, f.motivo ?? null, f.provedor ?? null, t, t, artId, ws);
    this.avisar(ws, artId);
  }

  /** A conversa em que o áudio está (ou vai estar) mostra o estado novo. */
  private avisar(ws: string, artId: string): void {
    const convs = this.d.db.all<{ c: string }>('SELECT DISTINCT m.conversation_id AS c FROM message_attachments ma JOIN messages m ON m.id = ma.message_id WHERE ma.artifact_id = ? AND ma.workspace_id = ?', artId, ws);
    for (const c of convs) this.d.bus.publish(ws, 'messages.changed', { conversationId: c.c });
    if (!convs.length) this.d.bus.publish(ws, 'artifacts.changed', {});
  }

  /**
   * O pedido da conversa espera os áudios da mensagem: começa os que ainda não começaram e diz se algum ainda anda.
   * Passou de ESPERA_MAX_MS: a transcrição conta como falha (o pedido segue e o agente sabe do áudio).
   */
  pendentes(ws: string, artIds: string[]): boolean {
    let algum = false;
    for (const artId of artIds) {
      const l = this.linha(ws, artId);
      if (!l) { void this.iniciar(ws, artId); algum = true; continue; }
      if (l.estado !== 'transcrevendo' && l.estado !== 'preparando') continue;
      if (!this.andando.has(artId)) { void this.iniciar(ws, artId, true); algum = true; continue; } // o servidor reiniciou no meio
      if (Date.now() - Date.parse(l.inicio) > ESPERA_MAX_MS) { this.terminar(ws, artId, { estado: 'falhou', motivo: 'tempo' }); continue; }
      algum = true;
    }
    return algum;
  }

  /** Quanto tempo (ms) a execução já ficou esperando os áudios: não conta no tempo limite dela. */
  esperaMs(ws: string, artIds: string[], desde: string | null): number {
    if (!desde || !artIds.length) return 0;
    const ini = Date.parse(desde);
    let fim = ini;
    for (const artId of artIds) {
      const l = this.linha(ws, artId);
      if (!l) continue;
      fim = Math.max(fim, l.fim ? Date.parse(l.fim) : Date.now());
    }
    return Math.max(0, fim - ini);
  }
}
