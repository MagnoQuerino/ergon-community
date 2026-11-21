// Conversa por voz (rc.41): a lógica do modo mãos livres, sem navegador (o componente ConversaPorVoz.tsx liga ao microfone,
// ao gravador e ao alto-falante). Três peças puras: o detector de fala por energia (VAD), a máquina de estados do modo
// e a leitura da conversa ("a resposta deste turno já chegou?"). Só códigos e tempos: os textos ficam no dicionário.

// ——— detector de fala (VAD por energia) ———

export interface VadCfg {
  /** piso do limiar (RMS de 0 a 1): abaixo disto nunca é fala, por mais silenciosa que a sala esteja */
  limiarMin: number;
  /** o limiar acompanha o ruído da sala: ruído × este fator */
  fatorRuido: number;
  /** quanto tempo acima do limiar para contar como fala (estalo, tecla e porta não passam) */
  ataqueMs: number;
  /** quanto silêncio fecha a fala (pausa para respirar ou pensar não corta) */
  silencioFimMs: number;
  /** fala com menos voz do que isto é ruído: descarta, não envia */
  minVozMs: number;
  /** teto do trecho: fecha e envia sozinho (o áudio da conversa aceita até 10 minutos) */
  maxMs: number;
}
/** escutando a pessoa: sensível, com 1,4 s de silêncio para fechar */
export const VAD_ESCUTA: VadCfg = { limiarMin: 0.02, fatorRuido: 3, ataqueMs: 120, silencioFimMs: 1400, minVozMs: 350, maxMs: 9.5 * 60_000 };
/**
 * com o agente falando: só uma fala firme e sustentada interrompe (limiar bem mais alto e ataque mais longo), para o
 * eco da própria resposta no alto-falante não contar como a pessoa falando por cima
 */
export const VAD_INTERRUPCAO: VadCfg = { ...VAD_ESCUTA, limiarMin: 0.07, fatorRuido: 6, ataqueMs: 320 };
/** a queda (histerese): já falando, o nível pode cair a esta fração do limiar sem contar como silêncio */
const QUEDA = 0.6;
/** no ataque, um vale de até isto entre duas sílabas não recomeça a contagem */
const VALE_MS = 180;
/** o ruído de fundo estimado não passa disto (sala muito barulhenta: o piso do limiar segura) */
const RUIDO_MAX = 0.04;
/** entre duas medidas, no máximo isto conta como voz (aba em segundo plano mede 1 vez por segundo) */
const PASSO_MAX_MS = 1100;

export interface EstadoVad {
  fase: 'silencio' | 'fala';
  /** ruído de fundo estimado (média lenta do nível enquanto ninguém fala) */
  ruido: number;
  /** o nível passou do limiar desde aqui (ainda no ataque) */
  acimaDesde: number | null;
  /** no ataque: a última medida acima do limiar e quanto tempo acima já somou */
  ultimaAcima: number | null;
  acimaMs: number;
  /** começo da fala em curso */
  inicio: number | null;
  /** a última medida com voz */
  ultimaVoz: number | null;
  /** quanto de voz o trecho tem (sem as pausas) */
  vozMs: number;
  /** a medida anterior */
  ultimo: number | null;
}
export type SinalVad =
  | { tipo: 'inicio'; em: number }
  | { tipo: 'fim'; ms: number; vozMs: number; motivo: 'silencio' | 'limite' }
  | { tipo: 'descartado'; vozMs: number };

export const VAD_PARADO: EstadoVad = { fase: 'silencio', ruido: 0, acimaDesde: null, ultimaAcima: null, acimaMs: 0, inicio: null, ultimaVoz: null, vozMs: 0, ultimo: null }; // i18n-ok: código interno do estado
/** recomeça a escuta guardando o ruído da sala já medido */
export const vadDeNovo = (e: EstadoVad): EstadoVad => ({ ...VAD_PARADO, ruido: e.ruido });
/** o limiar de agora (o piso, ou o ruído da sala vezes o fator) */
export const limiarDoVad = (e: EstadoVad, cfg: VadCfg): number => Math.max(cfg.limiarMin, e.ruido * cfg.fatorRuido);

/** Uma medida de nível (RMS de 0 a 1) no instante `agora` (ms). Devolve o estado novo e, quando há, o que aconteceu. */
export function vad(e: EstadoVad, nivel: number, agora: number, cfg: VadCfg): { e: EstadoVad; sinal: SinalVad | null } {
  const n = Number.isFinite(nivel) ? Math.max(0, nivel) : 0;
  const limiar = limiarDoVad(e, cfg);
  const passo = e.ultimo === null ? 0 : Math.min(PASSO_MAX_MS, Math.max(0, agora - e.ultimo));
  if (e.fase === 'silencio') {
    if (n < limiar) {
      // um vale entre duas sílabas não zera o ataque (a fala oscila); silêncio mais longo que isso, sim
      if (e.acimaDesde !== null && e.ultimaAcima !== null && agora - e.ultimaAcima <= VALE_MS) return { e: { ...e, ultimo: agora }, sinal: null };
      // ninguém fala: o ruído da sala se ajusta devagar (para cima mais devagar ainda: uma fala fraca não vira "ruído")
      const k = n > e.ruido ? 0.02 : 0.1;
      return { e: { ...e, acimaDesde: null, ultimaAcima: null, acimaMs: 0, ruido: Math.min(RUIDO_MAX, e.ruido + (n - e.ruido) * k), ultimo: agora }, sinal: null };
    }
    const desde = e.acimaDesde ?? agora;
    const acimaMs = e.acimaDesde === null ? 0 : e.acimaMs + passo;
    // fala: acima do limiar há `ataqueMs`, e na maior parte desse tempo (dois estalos seguidos não bastam)
    if (agora - desde < cfg.ataqueMs || acimaMs < cfg.ataqueMs * 0.6) return { e: { ...e, acimaDesde: desde, ultimaAcima: agora, acimaMs, ultimo: agora }, sinal: null };
    return { e: { ...e, fase: 'fala', acimaDesde: null, ultimaAcima: null, acimaMs: 0, inicio: desde, ultimaVoz: agora, vozMs: Math.min(acimaMs, PASSO_MAX_MS * 2), ultimo: agora }, sinal: { tipo: 'inicio', em: desde } };
  }
  const inicio = e.inicio ?? agora;
  const comVoz = n >= limiar * QUEDA;
  const vozMs = e.vozMs + (comVoz ? passo : 0);
  const ultimaVoz = comVoz ? agora : e.ultimaVoz ?? agora;
  const fechar = (motivo: 'silencio' | 'limite'): { e: EstadoVad; sinal: SinalVad } => ({
    e: { ...vadDeNovo(e), ultimo: agora },
    sinal: vozMs < cfg.minVozMs ? { tipo: 'descartado', vozMs } : { tipo: 'fim', ms: agora - inicio, vozMs, motivo },
  });
  if (agora - inicio >= cfg.maxMs) return fechar('limite');
  if (!comVoz && agora - ultimaVoz >= cfg.silencioFimMs) return fechar('silencio');
  return { e: { ...e, vozMs, ultimaVoz, ultimo: agora }, sinal: null };
}

/** RMS (0 a 1) das amostras do microfone (-1 a 1). */
export function nivelRms(amostras: ArrayLike<number>): number {
  if (!amostras.length) return 0;
  let s = 0;
  for (let i = 0; i < amostras.length; i++) s += amostras[i] * amostras[i];
  return Math.sqrt(s / amostras.length);
}
/** O nível no medidor (0 a 1), em escala de volume percebido: sussurro já mexe, grito não estoura. */
export function nivelNoMedidor(rms: number): number {
  if (!(rms > 0)) return 0;
  return Math.min(1, Math.max(0, (Math.log10(rms) + 2.4) / 1.9));
}

// ——— a máquina de estados do modo ———

export type FaseVoz =
  /** pedindo o microfone ao navegador */
  | 'abrindo'
  /** microfone aberto, esperando a pessoa falar */
  | 'ouvindo'
  /** a pessoa está falando (gravando o trecho) */
  | 'captando'
  /** o trecho está subindo como mensagem de áudio */
  | 'enviando'
  | 'transcrevendo'
  | 'pensando'
  /** a resposta chegou; a voz está sendo gerada */
  | 'preparando'
  /** o agente está falando */
  | 'falando'
  /** microfone fechado pela pessoa */
  | 'pausado'
  | 'erro'
  | 'fechado';
export type ErroVoz = 'negado' | 'sem_microfone' | 'sem_suporte' | 'falhou' | 'sem_transcricao' | 'sem_motor';
export type AvisoVoz =
  /** não há voz para falar: as respostas aparecem escritas */
  | 'sem_voz'
  /** a voz falhou nesta resposta: ela está escrita */
  | 'voz_falhou'
  | 'envio_falhou'
  /** a transcrição deste trecho falhou (o colega sabe que o áudio chegou) */
  | 'transcricao_falhou'
  | 'resposta_falhou'
  | 'resposta_parada'
  /** o colega espera uma decisão da pessoa na conversa escrita */
  | 'espera_voce'
  /** o trecho chegou ao teto e foi enviado */
  | 'limite';

export interface EstadoVoz {
  fase: FaseVoz;
  /** a pessoa fechou o microfone (vale também no meio de uma resposta: ao terminar, fica pausado) */
  mudo: boolean;
  /** sem voz para falar: só texto na tela */
  semVoz: boolean;
  erro: ErroVoz | null;
  aviso: AvisoVoz | null;
  /** turnos completos (falou → respondeu) */
  turnos: number;
}
export type EventoVoz =
  | { tipo: 'microfone' }
  | { tipo: 'erro'; motivo: ErroVoz }
  | { tipo: 'fala_inicio' }
  | { tipo: 'fala_fim'; limite?: boolean }
  | { tipo: 'fala_descartada' }
  | { tipo: 'enviado' }
  | { tipo: 'envio_falhou' }
  | { tipo: 'transcrito' }
  | { tipo: 'transcricao_falhou' }
  /** a resposta chegou: `falar` = há voz e o texto vai ser lido em voz alta */
  | { tipo: 'resposta'; falar: boolean }
  | { tipo: 'sem_resposta'; motivo: 'falhou' | 'parada' | 'vazia' | 'espera' }
  | { tipo: 'tocando' }
  | { tipo: 'fala_agente_fim' }
  | { tipo: 'voz_indisponivel' }
  | { tipo: 'voz_falhou' }
  | { tipo: 'interromper' }
  | { tipo: 'pausar' }
  | { tipo: 'retomar' }
  | { tipo: 'fechar' };

export const voz0 = (semVoz: boolean): EstadoVoz => ({ fase: 'abrindo', mudo: false, semVoz, erro: null, aviso: semVoz ? 'sem_voz' : null, turnos: 0 }); // i18n-ok: código interno do estado

/** de volta à escuta (ou pausado, se a pessoa fechou o microfone no meio) */
const escuta = (e: EstadoVoz, aviso: AvisoVoz | null = e.aviso): EstadoVoz => ({ ...e, fase: e.mudo ? 'pausado' : 'ouvindo', aviso }); // i18n-ok: código interno do estado
const AVISO_SEM_RESPOSTA = { falhou: 'resposta_falhou', parada: 'resposta_parada', vazia: null, espera: 'espera_voce' } as const;

/** O próximo estado. Evento fora de hora não muda nada (uma resposta atrasada depois de encerrar, dois toques no botão). */
export function conversaVoz(e: EstadoVoz, ev: EventoVoz): EstadoVoz {
  if (e.fase === 'fechado') return e;
  if (ev.tipo === 'fechar') return { ...e, fase: 'fechado' };
  // erro: só "tentar de novo" (retomar) e fechar saem dele
  if (e.fase === 'erro') return ev.tipo === 'retomar' ? { ...e, fase: 'abrindo', erro: null, mudo: false } : e;
  switch (ev.tipo) {
    case 'microfone':
      return e.fase === 'abrindo' ? { ...e, fase: 'ouvindo' } : e;
    case 'erro':
      return { ...e, fase: 'erro', erro: ev.motivo }; // i18n-ok: código interno do estado
    case 'fala_inicio':
      // falar por cima da resposta (ou enquanto a voz é preparada) interrompe e já é o próximo trecho
      return e.fase === 'ouvindo' || e.fase === 'falando' || e.fase === 'preparando' ? { ...e, fase: 'captando', aviso: e.semVoz ? 'sem_voz' : null } : e;
    case 'fala_fim':
      return e.fase === 'captando' ? { ...e, fase: 'enviando', aviso: ev.limite ? 'limite' : e.aviso } : e; // i18n-ok: código interno do estado
    case 'fala_descartada':
      return e.fase === 'captando' ? escuta(e) : e;
    case 'enviado':
      return e.fase === 'enviando' ? { ...e, fase: 'transcrevendo' } : e;
    case 'envio_falhou':
      return e.fase === 'enviando' ? escuta(e, 'envio_falhou') : e;
    case 'transcrito':
      return e.fase === 'transcrevendo' ? { ...e, fase: 'pensando' } : e;
    case 'transcricao_falhou':
      // o pedido segue (o colega sabe que há um áudio que não foi transcrito): só o aviso
      return e.fase === 'transcrevendo' ? { ...e, fase: 'pensando', aviso: 'transcricao_falhou' } : e;
    case 'resposta':
      if (e.fase !== 'transcrevendo' && e.fase !== 'pensando') return e;
      return ev.falar && !e.semVoz ? { ...e, fase: 'preparando', turnos: e.turnos + 1 } : escuta({ ...e, turnos: e.turnos + 1 }, 'sem_voz');
    case 'sem_resposta': {
      if (e.fase !== 'transcrevendo' && e.fase !== 'pensando') return e;
      // o colega espera uma decisão na conversa escrita: o microfone fecha, para a pessoa olhar a tela
      if (ev.motivo === 'espera') return { ...e, fase: 'pausado', mudo: true, aviso: 'espera_voce' }; // i18n-ok: código interno do estado
      return escuta(e, AVISO_SEM_RESPOSTA[ev.motivo] ?? e.aviso);
    }
    case 'tocando':
      return e.fase === 'preparando' ? { ...e, fase: 'falando' } : e;
    case 'fala_agente_fim':
      return e.fase === 'falando' || e.fase === 'preparando' ? escuta(e) : e;
    case 'voz_indisponivel':
      return e.fase === 'preparando' || e.fase === 'falando' ? escuta({ ...e, semVoz: true }, 'sem_voz') : { ...e, semVoz: true };
    case 'voz_falhou':
      return e.fase === 'preparando' || e.fase === 'falando' ? escuta(e, 'voz_falhou') : e;
    case 'interromper':
      return e.fase === 'preparando' || e.fase === 'falando' ? escuta(e) : e;
    case 'pausar':
      if (e.mudo) return e;
      // pausar ouvindo ou no meio de uma fala: o trecho em curso é descartado (nada do que foi dito com o microfone "fechado" vai)
      return e.fase === 'ouvindo' || e.fase === 'captando' || e.fase === 'abrindo' ? { ...e, fase: 'pausado', mudo: true } : { ...e, mudo: true }; // i18n-ok: código interno do estado
    case 'retomar':
      if (!e.mudo) return e;
      return e.fase === 'pausado' ? { ...e, fase: 'abrindo', mudo: false, aviso: e.semVoz ? 'sem_voz' : null } : { ...e, mudo: false };
  }
}

/** O microfone deve estar aberto agora (o componente abre ou solta a faixa quando isto muda). */
export const microfoneLigado = (e: EstadoVoz): boolean => !e.mudo && e.fase !== 'erro' && e.fase !== 'fechado';
/**
 * O que o detector de fala faz nesta fase: escutar a pessoa, só vigiar a interrupção (com o agente falando), ou nada
 * (enviando, transcrevendo, pensando: a vez é do agente; nada é gravado).
 */
export function modoDoVad(e: EstadoVoz): 'escuta' | 'interrupcao' | null {
  if (e.mudo) return null;
  if (e.fase === 'ouvindo' || e.fase === 'captando') return 'escuta';
  if (e.fase === 'falando' || e.fase === 'preparando') return 'interrupcao';
  return null;
}
/** A vez é do agente (esperando ou ouvindo a resposta). */
export const vezDoAgente = (e: EstadoVoz): boolean => ['enviando', 'transcrevendo', 'pensando', 'preparando', 'falando'].includes(e.fase); // i18n-ok: código interno do estado

// ——— a conversa: a resposta deste turno ———

/** o que este módulo lê de uma mensagem da conversa (lib/types.ts Message) */
export interface MensagemDoTurno {
  id: string; role: string; content: string; run_id: string | null; run_status: string | null; queued?: number;
  attachments?: Array<{ transcricao?: { estado: string; texto: string | null; motivo: string | null } | null }>;
}
export interface Turno<M extends MensagemDoTurno = MensagemDoTurno> {
  /**
   * enviando: a mensagem ainda não aparece na conversa · transcrevendo · pensando · pronta (há resposta) · vazia (terminou
   * sem texto) · falhou · parada · espera (o colega espera uma decisão da pessoa na conversa)
   */
  fase: 'enviando' | 'transcrevendo' | 'pensando' | 'pronta' | 'vazia' | 'falhou' | 'parada' | 'espera';
  /** o que a pessoa disse, como o servidor transcreveu (null = ainda não há) */
  dito: string | null;
  /** a transcrição falhou (o motivo do servidor) */
  transcricaoFalhou: string | null;
  /** as respostas do agente a este pedido, na ordem */
  respostas: M[];
}

/** O estado do turno da mensagem `id` (a que o modo voz enviou), lido da lista de mensagens da conversa. */
export function turnoDaMensagem<M extends MensagemDoTurno>(msgs: readonly M[], id: string): Turno<M> {
  const i = msgs.findIndex((m) => m.id === id);
  if (i < 0) return { fase: 'enviando', dito: null, transcricaoFalhou: null, respostas: [] }; // i18n-ok: código interno do estado
  const m = msgs[i];
  const tr = m.attachments?.find((a) => a.transcricao)?.transcricao ?? null;
  const dito = tr?.estado === 'pronta' ? (tr.texto ?? '').trim() : null;
  const transcricaoFalhou = tr?.estado === 'falhou' ? tr.motivo ?? 'falhou' : null; // i18n-ok: código interno do estado
  const respostas = m.run_id ? msgs.slice(i + 1).filter((x) => x.role === 'agent' && x.run_id === m.run_id && textoFalado(x.content)) : [];
  const base = { dito, transcricaoFalhou, respostas };
  const transcrevendo = !tr || tr.estado === 'transcrevendo' || tr.estado === 'preparando';
  switch (m.run_status) {
    case 'succeeded': return { ...base, fase: respostas.length ? 'pronta' : 'vazia' }; // i18n-ok: código interno do estado
    case 'failed': return { ...base, fase: 'falhou' }; // i18n-ok: código interno do estado
    case 'cancelled': return { ...base, fase: 'parada' }; // i18n-ok: código interno do estado
    case 'waiting_user': return { ...base, fase: 'espera' };
    // na fila da conversa (queued), na fila do executor ou rodando
    default: return { ...base, fase: transcrevendo && m.attachments?.length ? 'transcrevendo' : 'pensando' };
  }
}

/** O texto como aparece na legenda e como é falado: sem as marcas internas [[...]] e sem a formatação. */
export function textoFalado(md: string): string {
  return String(md ?? '')
    .replace(/\[\[[^\]]*\]\]/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^[ \t]{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|\*|~~|`)/g, '')
    .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}
