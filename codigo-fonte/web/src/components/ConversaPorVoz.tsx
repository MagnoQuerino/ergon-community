import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.ts';
import { ApiError, api, errMsg, requestId, uploadFile } from '../lib/api.ts';
import {
  VAD_ESCUTA, VAD_INTERRUPCAO, VAD_PARADO, conversaVoz, microfoneLigado, modoDoVad, nivelNoMedidor, nivelRms, textoFalado, turnoDaMensagem, vad, vadDeNovo, vezDoAgente, voz0,
  type EstadoVad, type EstadoVoz, type EventoVoz,
} from '../lib/conversa-voz.ts';
import { GRAVACAO_BITS, formatoDeGravacao, motivoDoErro, nomeDaGravacao } from '../lib/gravador.ts';
import { RECURSOS } from '../lib/recursos.ts';
import { useSurface } from '../lib/surface.ts';
import type { Agent, Attachment, Message } from '../lib/types.ts';
import { AgentAvatar } from './AgentAvatar.tsx';
import { Icon } from './Icon.tsx';

/** de quanto em quanto o nível do microfone é medido (em segundo plano o navegador espaça: o detector conta o tempo, não as medidas) */
const MEDIDA_MS = 50;
/**
 * O gravador roda desde antes da fala (para não perder a 1ª sílaba) e recomeça de tempos em tempos enquanto ninguém fala:
 * o que foi captado em silêncio é jogado fora na hora, e o trecho enviado começa no máximo isto antes da fala.
 */
const SOBRA_ESCUTA_MS = 6000;
/** com o agente falando, a sobra é menor: quase nada da voz dele entra no trecho de quem fala por cima */
const SOBRA_INTERRUPCAO_MS = 1500;
/** colunas do medidor de nível */
const COLUNAS = 24;
/** enquanto espera a resposta, confere a conversa de tempos em tempos (se um aviso ao vivo se perder) */
const CONFERIR_MS = 3000;

interface Gravando { r: MediaRecorder; partes: Blob[]; inicio: number; descartar: boolean }

/**
 * Conversa por voz (rc.41): o modo mãos livres da conversa com um agente. A pessoa fala; quando ela para (silêncio), o
 * trecho sobe como uma mensagem de áudio comum (o mesmo anexo e a mesma rota de mensagens), o servidor transcreve, o
 * agente responde e a resposta é lida em voz alta (a rota do "Ouvir"); terminou de falar, volta a ouvir sozinho. Falar
 * por cima ou tocar em "Interromper" para a fala do agente. Tudo fica na conversa de sempre: aqui não há histórico.
 *
 * O microfone só fica aberto com o modo aberto e sem pausa (o indicador no topo diz), e é solto em toda saída: encerrar,
 * erro, pausa e ao desmontar. Sem voz para falar, as respostas aparecem escritas e a escuta segue.
 */
export function ConversaPorVoz({ agente, mensagens, podeFalar, preparaVoz, garantirConversa, recarregar, parar, onFechar }: {
  agente: Pick<Agent, 'id' | 'name' | 'role' | 'color' | 'char_key'> & { look_seed?: Agent['look_seed'] };
  /** as mensagens da conversa (a lista de sempre do ChatPanel): é por elas que o modo sabe da transcrição e da resposta */
  mensagens: Message[];
  /** há voz para falar neste computador (a mesma condição do botão "Ouvir") */
  podeFalar: boolean;
  /** 1º uso da voz local: ela ainda vai ser baixada */
  preparaVoz: boolean;
  garantirConversa: () => Promise<string>;
  recarregar: () => void;
  /** parar a resposta em andamento (o "Parar" da conversa) */
  parar: () => void;
  onFechar: () => void;
}) {
  const t = useT();
  const [e, setE] = useState<EstadoVoz>(() => voz0(!podeFalar));
  const estado = useRef(e);
  const vivo = useRef(true);
  /** o estado muda aqui, na hora (o microfone e o alto-falante leem `estado.current` entre um desenho e outro) */
  const despachar = useCallback((ev: EventoVoz): EstadoVoz => {
    const n = conversaVoz(estado.current, ev);
    if (n !== estado.current) { estado.current = n; if (vivo.current) setE(n); }
    return n;
  }, []);
  // o microfone mede num relógio aberto lá atrás: o que vem do ChatPanel é lido daqui, sempre o de agora (a conversa
  // pode ter sido criada no 1º envio; sem isto o 2º trecho abriria outra)
  const de = useRef({ garantirConversa, recarregar });
  de.current = { garantirConversa, recarregar };
  /** o que a pessoa disse e o que o agente respondeu no turno de agora (a legenda; o histórico é a conversa) */
  const [legenda, setLegenda] = useState<{ dito: string | null; resposta: string | null }>({ dito: null, resposta: null });
  const [detalhe, setDetalhe] = useState<string | null>(null);

  const raiz = useRef<HTMLDivElement>(null);
  const colunas = useRef<HTMLSpanElement>(null);
  const niveis = useRef<number[]>(Array.from({ length: COLUNAS }, () => 0));
  const fluxo = useRef<MediaStream | null>(null);
  const contexto = useRef<AudioContext | null>(null);
  const analisador = useRef<AnalyserNode | null>(null);
  const relogio = useRef<number | null>(null);
  const pedindo = useRef(false);
  const detector = useRef<EstadoVad>(VAD_PARADO);
  const gravando = useRef<Gravando | null>(null);
  const formato = useRef<{ mime: string; ext: string; tipo: string } | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  /** muda a cada fala do agente começada ou interrompida: o que chega de uma fala antiga é ignorado */
  const ficha = useRef(0);
  const turno = useRef<string | null>(null);
  const envio = useRef<AbortController | null>(null);

  // ——— o medidor: direto no DOM (20 medidas por segundo não redesenham a tela) ———
  const desenhar = (rms: number) => {
    const v = nivelNoMedidor(rms);
    raiz.current?.style.setProperty('--nivel', v.toFixed(3));
    const l = niveis.current; l.push(v); l.shift();
    const filhos = colunas.current?.children;
    if (filhos) for (let i = 0; i < filhos.length; i++) (filhos[i] as HTMLElement).style.transform = `scaleY(${Math.max(0.08, l[i]).toFixed(3)})`;
  };

  // ——— o gravador ———
  const soltarGravador = () => {
    const g = gravando.current;
    gravando.current = null;
    if (!g) return;
    g.descartar = true; g.partes.length = 0;
    try { if (g.r.state !== 'inactive') g.r.stop(); } catch { /* já parado */ }
  };
  const iniciarGravador = (agora: number): boolean => {
    const s = fluxo.current; const f = formato.current;
    if (!s || !f) return false;
    try {
      const g: Gravando = { r: new MediaRecorder(s, { mimeType: f.mime, audioBitsPerSecond: GRAVACAO_BITS }), partes: [], inicio: agora, descartar: false };
      g.r.ondataavailable = (ev) => { if (ev.data.size && !g.descartar) g.partes.push(ev.data); };
      g.r.start();
      gravando.current = g;
      return true;
    } catch { return false; }
  };

  // ——— o alto-falante ———
  const pararFala = () => {
    ficha.current++;
    const a = audio.current;
    if (!a) return;
    try { a.pause(); } catch { /* nada tocando */ }
    if (a.src.startsWith('blob:')) URL.revokeObjectURL(a.src);
    a.removeAttribute('src');
  };
  const falar = async (respostas: Message[]) => {
    const minha = ++ficha.current;
    const a = audio.current ?? (audio.current = new Audio());
    try {
      for (const m of respostas) {
        const blob = await api.postBlob(`${RECURSOS}/voz/falar`, { mensagem: m.id });
        if (ficha.current !== minha) return;
        const url = URL.createObjectURL(blob);
        a.src = url;
        const fim = new Promise<void>((ok) => { a.onended = () => ok(); a.onerror = () => ok(); a.onpause = () => ok(); });
        await a.play();
        if (ficha.current !== minha) return;
        despachar({ tipo: 'tocando' });
        await fim;
        URL.revokeObjectURL(url);
        if (ficha.current !== minha) return;
      }
      despachar({ tipo: 'fala_agente_fim' });
    } catch (err) {
      if (ficha.current !== minha) return;
      // sem o componente da voz: daqui em diante só texto; outra falha (rede, a voz não gerou, o navegador não tocou): só esta
      despachar({ tipo: err instanceof ApiError && err.code === 'voz_componente' ? 'voz_indisponivel' : 'voz_falhou' });
    }
  };

  // ——— enviar o trecho: o anexo e a rota das mensagens de áudio ———
  const enviar = async (blob: Blob) => {
    const f = formato.current;
    if (!f || !blob.size) { despachar({ tipo: 'envio_falhou' }); return; }
    const ac = new AbortController();
    envio.current = ac;
    setDetalhe(null);
    setLegenda({ dito: null, resposta: null });
    try {
      const conv = await de.current.garantirConversa();
      const arq = await uploadFile<Attachment>(new File([blob], nomeDaGravacao(new Date(), f.ext), { type: f.tipo }), { conversationId: conv }, undefined, ac.signal);
      // encerrou no meio: a mensagem não sai
      if (estado.current.fase === 'fechado' || ac.signal.aborted) return;
      const corpo = { text: '', clientRequestId: requestId(), attachments: [arq.id], voz: true };
      const mandar = (fila: boolean) => api.post<{ messageId: string }>(`/api/conversations/${conv}/messages`, { ...corpo, ...(fila ? { queue: true } : {}) });
      // o colega ainda respondia (a pessoa falou por cima de uma resposta longa): a fala entra na fila da conversa
      const r = await mandar(false).catch((err) => { if (err instanceof ApiError && err.code === 'busy') return mandar(true); throw err; });
      turno.current = r.messageId;
      despachar({ tipo: 'enviado' }); // i18n-ok: código interno do estado
      de.current.recarregar();
    } catch (err) {
      if (ac.signal.aborted) return;
      setDetalhe(errMsg(err));
      despachar({ tipo: 'envio_falhou' });
    } finally { if (envio.current === ac) envio.current = null; }
  };
  /** a fala acabou (silêncio, o teto ou "enviar agora"): fecha o arquivo e manda */
  const fecharTrecho = (limite: boolean) => {
    const g = gravando.current;
    gravando.current = null;
    detector.current = vadDeNovo(detector.current);
    if (despachar({ tipo: 'fala_fim', limite }).fase !== 'enviando') { if (g) { g.descartar = true; try { g.r.stop(); } catch { /* já parado */ } } return; }
    if (!g || g.r.state === 'inactive') { despachar({ tipo: 'envio_falhou' }); return; }
    g.r.onstop = () => { if (!g.descartar) void enviar(new Blob(g.partes, { type: formato.current?.tipo })); };
    g.r.onerror = () => despachar({ tipo: 'envio_falhou' });
    g.r.stop();
  };

  // ——— o microfone ———
  const soltarMicrofone = () => {
    if (relogio.current !== null) { window.clearInterval(relogio.current); relogio.current = null; }
    soltarGravador();
    fluxo.current?.getTracks().forEach((x) => { x.onended = null; x.stop(); });
    fluxo.current = null; analisador.current = null;
    void contexto.current?.close().catch(() => { /* já fechado */ });
    contexto.current = null;
    detector.current = vadDeNovo(detector.current);
    desenhar(0);
  };
  const medir = () => {
    const an = analisador.current;
    if (!an) return;
    // aba que voltou do segundo plano: o navegador pode ter suspendido a medição
    if (contexto.current?.state === 'suspended') void contexto.current.resume().catch(() => { /* segue na próxima */ });
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    const nivel = nivelRms(buf);
    desenhar(nivel);
    const modo = modoDoVad(estado.current);
    // a vez é do agente (ou o modo está pausado): nada é escutado nem gravado
    if (!modo) { if (gravando.current) soltarGravador(); detector.current = vadDeNovo(detector.current); return; }
    const agora = performance.now();
    if (!gravando.current && !iniciarGravador(agora)) { soltarMicrofone(); despachar({ tipo: 'erro', motivo: 'sem_suporte' }); return; } // i18n-ok: código interno do estado
    const r = vad(detector.current, nivel, agora, modo === 'escuta' ? VAD_ESCUTA : VAD_INTERRUPCAO);
    detector.current = r.e;
    if (r.sinal?.tipo === 'inicio') {
      if (modo === 'interrupcao') pararFala(); // falou por cima: o agente cala e este já é o próximo trecho
      despachar({ tipo: 'fala_inicio' });
    } else if (r.sinal?.tipo === 'descartado') {
      soltarGravador(); // ruído curto: não vira mensagem
      despachar({ tipo: 'fala_descartada' });
    } else if (r.sinal?.tipo === 'fim') {
      fecharTrecho(r.sinal.motivo === 'limite');
    } else if (r.e.fase === 'silencio' && r.e.acimaDesde === null && gravando.current && agora - gravando.current.inicio > (modo === 'escuta' ? SOBRA_ESCUTA_MS : SOBRA_INTERRUPCAO_MS)) {
      soltarGravador(); // silêncio: o que foi captado até aqui é jogado fora e o gravador recomeça
      iniciarGravador(agora);
    }
  };
  const abrirMicrofone = async () => {
    if (pedindo.current || fluxo.current) return;
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    const Contexto = typeof window !== 'undefined' ? window.AudioContext : undefined;
    formato.current = typeof MediaRecorder !== 'undefined' ? formatoDeGravacao((x) => MediaRecorder.isTypeSupported(x)) : null;
    if (!md?.getUserMedia || !formato.current || !Contexto) { despachar({ tipo: 'erro', motivo: 'sem_suporte' }); return; } // i18n-ok: código interno do estado
    pedindo.current = true;
    let s: MediaStream;
    try { s = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }); }
    catch (err) { pedindo.current = false; const m = motivoDoErro(err); despachar({ tipo: 'erro', motivo: m.tipo === 'negado' ? 'negado' : m.tipo === 'erro' ? m.motivo : 'falhou' }); return; } // i18n-ok: código interno do estado
    pedindo.current = false;
    // saiu, pausou ou deu erro enquanto o navegador perguntava: o microfone é solto na hora
    if (!vivo.current || !microfoneLigado(estado.current)) { s.getTracks().forEach((x) => x.stop()); return; }
    try {
      const ctx = new Contexto();
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      ctx.createMediaStreamSource(s).connect(an);
      fluxo.current = s; contexto.current = ctx; analisador.current = an;
    } catch { s.getTracks().forEach((x) => x.stop()); despachar({ tipo: 'erro', motivo: 'falhou' }); return; } // i18n-ok: código interno do estado
    // o microfone sumiu no meio (fone desconectado, permissão retirada)
    s.getAudioTracks().forEach((x) => { x.onended = () => { if (fluxo.current !== s) return; soltarMicrofone(); despachar({ tipo: 'erro', motivo: 'sem_microfone' }); }; }); // i18n-ok: código interno do estado
    relogio.current = window.setInterval(medir, MEDIDA_MS);
    despachar({ tipo: 'microfone' });
  };

  // abre e solta o microfone conforme o estado (aberto só com o modo aberto, sem pausa e sem erro)
  const ligado = microfoneLigado(e);
  useEffect(() => { if (ligado) void abrirMicrofone(); else soltarMicrofone(); }, [ligado]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (e.fase === 'erro') { pararFala(); envio.current?.abort(); turno.current = null; } }, [e.fase]); // eslint-disable-line react-hooks/exhaustive-deps
  // sair do modo de qualquer jeito (encerrar, trocar de conversa, fechar a janela): microfone solto, fala calada
  useEffect(() => {
    vivo.current = true;
    return () => { vivo.current = false; envio.current?.abort(); soltarMicrofone(); pararFala(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // a tela não apaga no meio da conversa (onde o navegador deixa)
  useEffect(() => {
    let trava: { release: () => Promise<void> } | null = null; let saiu = false;
    const nav = navigator as Navigator & { wakeLock?: { request: (tipo: 'screen') => Promise<{ release: () => Promise<void> }> } };
    void nav.wakeLock?.request('screen').then((x) => { if (saiu) void x.release(); else trava = x; }).catch(() => { /* sem permissão: segue */ });
    return () => { saiu = true; void trava?.release().catch(() => { /* já solta */ }); };
  }, []);

  // ——— a resposta: pela conversa de sempre ———
  const esperando = e.fase === 'transcrevendo' || e.fase === 'pensando';
  useEffect(() => {
    if (!esperando) return;
    const id = window.setInterval(() => de.current.recarregar(), CONFERIR_MS);
    return () => window.clearInterval(id);
  }, [esperando]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const id = turno.current;
    if (!id || !esperando) return;
    const tu = turnoDaMensagem(mensagens, id);
    if (tu.dito !== null) setLegenda((l) => (l.dito === tu.dito ? l : { ...l, dito: tu.dito }));
    // a equipe não transcreve (falta o componente, ou o motor está desligado): sem isso não há conversa por voz
    if (tu.transcricaoFalhou === 'componente' || tu.transcricaoFalhou === 'sem_motor') {
      turno.current = null;
      despachar({ tipo: 'erro', motivo: tu.transcricaoFalhou === 'componente' ? 'sem_transcricao' : 'sem_motor' }); // i18n-ok: código interno do estado
      return;
    }
    if (tu.fase === 'enviando' || tu.fase === 'transcrevendo') return;
    if (tu.fase === 'pensando') { despachar({ tipo: tu.transcricaoFalhou ? 'transcricao_falhou' : 'transcrito' }); return; }
    turno.current = null;
    if (tu.fase !== 'pronta') { despachar({ tipo: 'sem_resposta', motivo: tu.fase }); return; }
    setLegenda((l) => ({ ...l, resposta: tu.respostas.map((m) => textoFalado(m.content)).join('\n\n') }));
    const n = despachar({ tipo: 'resposta', falar: podeFalar });
    if (n.fase === 'preparando') void falar(tu.respostas);
  }, [mensagens, esperando]); // eslint-disable-line react-hooks/exhaustive-deps

  // ——— os botões ———
  const encerrar = () => { despachar({ tipo: 'fechar' }); envio.current?.abort(); soltarMicrofone(); pararFala(); onFechar(); };
  const interromper = () => { pararFala(); despachar({ tipo: 'interromper' }); };
  const pausar = () => {
    if (e.mudo) { despachar({ tipo: 'retomar' }); return; }
    despachar({ tipo: 'pausar' });
    soltarMicrofone(); // na hora, sem esperar o próximo desenho
  };
  useSurface(raiz, { onClose: encerrar, modal: true });

  const nome = agente.name;
  const microfone = ligado && e.fase !== 'abrindo';
  const titulo = e.fase === 'erro' ? t('conversas.voz.fase.erro')
    : e.fase === 'pensando' ? t('conversas.voz.fase.pensando', { nome })
    : e.fase === 'falando' ? t('conversas.voz.fase.falando', { nome })
    : t(`conversas.voz.fase.${e.fase === 'fechado' ? 'pausado' : e.fase}`);
  const dica = e.fase === 'erro'
    ? (e.erro === 'negado' ? t('conversas.gravador.negado') : e.erro === 'sem_microfone' ? t('conversas.gravador.semMicrofone') : e.erro === 'sem_suporte' ? t('conversas.voz.erro.semSuporte')
      : e.erro === 'sem_transcricao' ? t('conversas.voz.erro.semTranscricao') : e.erro === 'sem_motor' ? t('conversas.voz.erro.semMotor') : t('conversas.voz.erro.falhou'))
    : e.fase === 'preparando' ? (preparaVoz ? t('conversas.voz.dica.preparandoPrimeira') : t('conversas.voz.dica.preparando'))
    : e.fase === 'falando' ? (e.mudo ? t('conversas.voz.dica.falandoMudo') : t('conversas.voz.dica.falando'))
    : e.fase === 'fechado' ? '' : t(`conversas.voz.dica.${e.fase}`);
  const aviso = e.fase === 'erro' || !e.aviso ? null
    : e.aviso === 'sem_voz' ? t('conversas.voz.aviso.semVoz')
    : e.aviso === 'voz_falhou' ? t('conversas.voz.aviso.vozFalhou')
    : e.aviso === 'envio_falhou' ? t('conversas.voz.aviso.envioFalhou', { motivo: detalhe ?? t('conversas.voz.aviso.semDetalhe') })
    : e.aviso === 'transcricao_falhou' ? t('conversas.voz.aviso.transcricaoFalhou', { nome })
    : e.aviso === 'resposta_falhou' ? t('conversas.voz.aviso.respostaFalhou')
    : e.aviso === 'resposta_parada' ? t('conversas.voz.aviso.respostaParada')
    : e.aviso === 'espera_voce' ? t('conversas.voz.aviso.esperaVoce', { nome })
    : t('conversas.voz.aviso.limite');

  return (
    <div ref={raiz} className={`vozc vozc--${e.fase}`} role="dialog" aria-modal="true" aria-label={t('conversas.voz.titulo', { nome })} data-fase={e.fase} data-microfone={microfone ? 'aberto' : 'fechado'}>
      <header className="vozc__topo">
        <span className={`vozc__mic ${microfone ? 'is-on' : ''}`} role="status">
          <i aria-hidden="true" />{e.fase === 'abrindo' ? t('conversas.gravador.pedindo') : microfone ? t('conversas.voz.micAberto') : t('conversas.voz.micFechado')}
        </span>
        <span className="vozc__nome">{t('conversas.voz.nome')}</span>
        <button type="button" className="icon-btn vozc__x" onClick={encerrar} aria-label={t('conversas.voz.encerrarDica')} title={t('conversas.voz.encerrarDica')}><Icon name="x" /></button>
      </header>

      <div className="vozc__palco">
        <div className="vozc__orbe" aria-hidden="true">
          <i className="vozc__anel vozc__anel--2" /><i className="vozc__anel" />
          <span className="vozc__rosto"><AgentAvatar agent={{ ...agente, look_seed: agente.look_seed ?? null }} size={96} /></span>
        </div>
        <h3 className="vozc__estado" aria-live="polite" aria-atomic="true">{titulo}</h3>
        <p className="vozc__dica">{dica}</p>
        <span ref={colunas} className="vozc__nivel" aria-hidden="true">{Array.from({ length: COLUNAS }, (_, i) => <i key={i} />)}</span>
      </div>

      {/* a legenda do turno: o que você disse e a resposta (lida pelo leitor de tela só quando não há voz) */}
      <div className="vozc__legenda" aria-live={e.semVoz ? 'polite' : 'off'}>
        {legenda.dito === null && legenda.resposta === null && !vezDoAgente(e)
          ? <p className="vozc__vazio">{t('conversas.voz.legendaVazia')}</p>
          : <>
            <p className="vozc__fala vozc__fala--voce"><b>{t('conversas.conversa.voce')}</b>{legenda.dito === null ? <span className="vozc__pontos" aria-hidden="true">…</span> : legenda.dito || <em>{t('conversas.voz.semFala')}</em>}</p>
            {legenda.resposta !== null && <p className="vozc__fala vozc__fala--agente"><b>{nome}</b>{legenda.resposta}</p>}
          </>}
      </div>
      {aviso && <p className="vozc__aviso" role="status"><Icon name="alert" size={15} /> <span>{aviso}</span></p>}

      <footer className="vozc__acoes">
        {e.fase === 'erro'
          ? <button type="button" className="btn vozc__btn" data-autofocus onClick={() => despachar({ tipo: 'retomar' })}><Icon name="repeat" size={16} /> {t('conversas.voz.tentar')}</button>
          : <button type="button" className="btn vozc__btn" aria-pressed={e.mudo} onClick={pausar} title={e.mudo ? t('conversas.voz.retomarDica') : t('conversas.voz.pausarDica')}>
            <Icon name={e.mudo ? 'mic' : 'pause'} size={16} /> {e.mudo ? t('conversas.voz.retomar') : t('conversas.voz.pausar')}
          </button>}
        {(e.fase === 'falando' || e.fase === 'preparando') && <button type="button" className="btn vozc__btn vozc__btn--destaque" onClick={interromper}><Icon name="stop" size={16} /> {e.fase === 'falando' ? t('conversas.voz.interromper') : t('conversas.voz.pular')}</button>}
        {e.fase === 'captando' && <button type="button" className="btn vozc__btn vozc__btn--destaque" onClick={() => fecharTrecho(false)}><Icon name="send" size={16} /> {t('conversas.voz.enviarAgora')}</button>}
        {e.fase === 'pensando' && <button type="button" className="btn vozc__btn" onClick={parar}><Icon name="stop" size={16} /> {t('conversas.voz.pararResposta')}</button>}
        <button type="button" className="btn vozc__btn vozc__btn--sair" onClick={encerrar}><Icon name="x" size={16} /> {t('conversas.voz.encerrar')}</button>
      </footer>
      <p className="vozc__nota">{t('conversas.voz.privacidade')}</p>
    </div>
  );
}
