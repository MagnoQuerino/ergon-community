// Mensagem de áudio (rc.33): a máquina de estados do gravador da conversa, sem navegador (o componente GravadorDeVoz.tsx
// liga ao microfone e ao MediaRecorder). Só estados, tempos e escolhas de formato: os textos ficam no dicionário.

/** 10 minutos: o gravador para sozinho aqui (o servidor confere o mesmo teto) */
export const GRAVACAO_MAX_MS = 10 * 60_000;
/** 24 a 32 kbit/s em Opus: voz clara, 10 minutos ≈ 2,4 MB */
export const GRAVACAO_BITS = 32_000;
/** gravação curta demais (um clique sem querer) não vira mensagem */
export const GRAVACAO_MIN_MS = 600;

export type EstadoGravador =
  | { fase: 'parado' }
  /** pedindo o microfone ao navegador (a pessoa vê o aviso dele) */
  | { fase: 'pedindo' }
  | { fase: 'gravando'; inicio: number; ms: number }
  /** parou (enviar, ou o teto de 10:00): o arquivo está sendo fechado */
  | { fase: 'fechando'; ms: number; motivo: 'enviar' | 'limite' }
  | { fase: 'negado' }
  | { fase: 'erro'; motivo: 'sem_microfone' | 'sem_suporte' | 'falhou' };

export type EventoGravador =
  | { tipo: 'iniciar' }
  | { tipo: 'permitido'; agora: number }
  | { tipo: 'negado' }
  | { tipo: 'erro'; motivo: 'sem_microfone' | 'sem_suporte' | 'falhou' }
  | { tipo: 'tique'; agora: number }
  | { tipo: 'enviar'; agora: number }
  | { tipo: 'cancelar' }
  | { tipo: 'fechado' };

export const PARADO: EstadoGravador = { fase: 'parado' }; // i18n-ok: código interno do estado

/** O próximo estado. Evento fora de hora não muda nada (um tique atrasado depois de cancelar, dois cliques em enviar). */
export function gravador(e: EstadoGravador, ev: EventoGravador): EstadoGravador {
  switch (ev.tipo) {
    case 'iniciar':
      return e.fase === 'parado' || e.fase === 'negado' || e.fase === 'erro' ? { fase: 'pedindo' } : e;
    case 'permitido':
      return e.fase === 'pedindo' ? { fase: 'gravando', inicio: ev.agora, ms: 0 } : e;
    case 'negado':
      return e.fase === 'pedindo' ? { fase: 'negado' } : e;
    case 'erro':
      return e.fase === 'pedindo' || e.fase === 'gravando' || e.fase === 'fechando' ? { fase: 'erro', motivo: ev.motivo } : e; // i18n-ok: código interno do estado
    case 'tique': {
      if (e.fase !== 'gravando') return e;
      const ms = Math.max(0, ev.agora - e.inicio);
      // chegou aos 10:00: para sozinho (o arquivo vai para o campo, para a pessoa conferir e mandar)
      return ms >= GRAVACAO_MAX_MS ? { fase: 'fechando', ms: GRAVACAO_MAX_MS, motivo: 'limite' } : { ...e, ms };
    }
    case 'enviar':
      return e.fase === 'gravando' ? { fase: 'fechando', ms: Math.min(GRAVACAO_MAX_MS, Math.max(0, ev.agora - e.inicio)), motivo: 'enviar' } : e;
    case 'cancelar':
      return e.fase === 'pedindo' || e.fase === 'gravando' || e.fase === 'negado' || e.fase === 'erro' ? PARADO : e;
    case 'fechado':
      return e.fase === 'fechando' ? PARADO : e;
  }
}

/** O microfone está aberto (o componente precisa soltar a faixa quando sai daqui). */
export const microfoneAberto = (e: EstadoGravador): boolean => e.fase === 'gravando' || e.fase === 'fechando';

/** "0:07", "9:59", "10:00" */
export function relogio(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** O formato do arquivo: WebM/Opus onde o navegador grava (Chrome, Edge, Firefox); Ogg/Opus; MP4 (Safari). '' = nenhum. */
export function formatoDeGravacao(suporta: (tipo: string) => boolean): { mime: string; ext: string; tipo: string } | null {
  const opcoes = [
    { mime: 'audio/webm;codecs=opus', ext: 'webm', tipo: 'audio/webm' },
    { mime: 'audio/ogg;codecs=opus', ext: 'ogg', tipo: 'audio/ogg' },
    { mime: 'audio/webm', ext: 'webm', tipo: 'audio/webm' },
    { mime: 'audio/mp4', ext: 'm4a', tipo: 'audio/mp4' },
  ];
  for (const o of opcoes) { try { if (suporta(o.mime)) return o; } catch { /* navegador que lança: o próximo */ } }
  return null;
}

/** O nome do arquivo gravado: "audio-2026-11-17-1432.webm" (a data e a hora locais). */
export function nomeDaGravacao(d: Date, ext: string): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `audio-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.${ext}`;
}

/** O erro do getUserMedia, no estado do gravador. */
export function motivoDoErro(err: unknown): EventoGravador {
  const nome = (err as { name?: string } | null)?.name ?? '';
  if (nome === 'NotAllowedError' || nome === 'SecurityError' || nome === 'PermissionDeniedError') return { tipo: 'negado' };
  if (nome === 'NotFoundError' || nome === 'OverconstrainedError' || nome === 'DevicesNotFoundError' || nome === 'NotReadableError') return { tipo: 'erro', motivo: 'sem_microfone' }; // i18n-ok: código interno do estado
  return { tipo: 'erro', motivo: 'falhou' }; // i18n-ok: código interno do estado
}
