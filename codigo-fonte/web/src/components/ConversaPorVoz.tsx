import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../i18n/index.ts';
import { idiomaAtual } from '../i18n/index.ts';
import { ApiError, api, errMsg, requestId, uploadFile } from '../lib/api.ts';
import { falarMensagem, idiomaDaFala, temFalaDoSistema, type Fala } from '../lib/fala.ts';
import {
  VAD_ESCUTA, VAD_INTERRUPCAO, VAD_PARADO, conversaVoz, microfoneLigado, modoDoVad, nivelNoMedidor, nivelRms, turnoDaMensagem, vad, vadDeNovo, voz0,
  type EstadoVad, type EstadoVoz, type EventoVoz, type MensagemDoTurno, type Turno,
} from '../lib/conversa-voz.ts';
import { GRAVACAO_BITS, formatoDeGravacao, motivoDoErro, nomeDaGravacao } from '../lib/gravador.ts';
import type { Agent, Attachment, Message } from '../lib/types.ts';
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
/** enquanto espera a resposta, confere a conversa de tempos em tempos (se um aviso ao vivo se perder) */
const CONFERIR_MS = 3000;

interface Gravando { r: MediaRecorder; partes: Blob[]; inicio: number; descartar: boolean }

/**
 * Conversa por voz (rc.41): um canal ao lado da barra de digitação, não uma tela por cima. Ligado, o próprio botão mostra
 * o estado (o anel segue o nível da voz; pontos com o agente pensando; ondas com ele falando) e a barra de texto continua
 * livre: dá para digitar e mandar com a voz ligada, e a resposta a esse texto também é falada. A pessoa fala; quando ela para (silêncio), o
 * trecho sobe como uma mensagem de áudio comum (o mesmo anexo e a mesma rota de mensagens), o servidor transcreve, o
 * agente responde e a resposta é lida em voz alta (a rota do "Ouvir"); terminou de falar, volta a ouvir sozinho. Falar
 * por cima ou tocar em "Interromper" para a fala do agente. Tudo fica na conversa de sempre: aqui não há histórico.
 *
 * O microfone só fica aberto com o modo aberto e sem pausa (o indicador no topo diz), e é solto em toda saída: encerrar,
 * erro, pausa e ao desmontar. Sem voz para falar, as respostas aparecem escritas e a escuta segue.
 */
export function ConversaPorVoz({ agente, mensagens, podeFalar: vozDaEquipe, preparaVoz, garantirConversa, recarregar, onFechar, enviarFala, turnoDe = turnoDaMensagem }: {
  agente: Pick<Agent, 'id' | 'name'>;
  /** as mensagens da conversa (a lista de sempre do ChatPanel): é por elas que o modo sabe da transcrição e da resposta */
  mensagens: Message[];
  /** há voz para falar neste computador (a mesma condição do botão "Ouvir") */
  podeFalar: boolean;
  /** 1º uso da voz local: ela ainda vai ser baixada */
  preparaVoz: boolean;
  garantirConversa: () => Promise<string>;
  recarregar: () => void;
  onFechar: () => void;
  /** sala (rc.42): a fala vai pela rota da sala, para o agente escolhido; devolve o id da mensagem */
  enviarFala?: (arquivoId: string) => Promise<string>;
  /** sala (rc.49): o turno lido pela sala (vários agentes podem responder à mesma fala) */
  turnoDe?: (msgs: readonly MensagemDoTurno[], id: string) => Turno<MensagemDoTurno>;
}) {
  const t = useT();
  // a voz da equipe, ou a do próprio sistema: toda resposta é falada onde houver uma das duas
  const podeFalar = vozDaEquipe || temFalaDoSistema();
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
  const de = useRef({ garantirConversa, recarregar, enviarFala });
  de.current = { garantirConversa, recarregar, enviarFala };
  /** as mensagens que já estavam na conversa (ou já tratadas): um texto novo da pessoa, fora delas, é adotado como turno */
  const conhecidas = useRef<Set<string> | null>(null);
  if (conhecidas.current === null) conhecidas.current = new Set(mensagens.map((m) => m.id));
  const [detalhe, setDetalhe] = useState<string | null>(null);

  const raiz = useRef<HTMLSpanElement>(null);
  const fluxo = useRef<MediaStream | null>(null);
  const contexto = useRef<AudioContext | null>(null);
  const analisador = useRef<AnalyserNode | null>(null);
  const relogio = useRef<number | null>(null);
  const pedindo = useRef(false);
  const detector = useRef<EstadoVad>(VAD_PARADO);
  const gravando = useRef<Gravando | null>(null);
  const formato = useRef<{ mime: string; ext: string; tipo: string } | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const fala = useRef<Fala | null>(null);
  /** as respostas já faladas neste turno (na sala, cada uma é falada assim que chega) */
  const faladas = useRef(new Set<string>());
  /** o microfone está mudo no sistema (o botão mostra; nenhum aviso cobre a barra) */
  const [semSom, setSemSom] = useState(false);
  const zeroDesde = useRef<number | null>(null);
  /** muda a cada fala do agente começada ou interrompida: o que chega de uma fala antiga é ignorado */
  const ficha = useRef(0);
  const turno = useRef<string | null>(null);
  const envio = useRef<AbortController | null>(null);

  // ——— o nível da voz: direto no DOM, na variável que o anel do microfone lê (20 medidas por segundo não redesenham a tela) ———
  const desenhar = (rms: number) => { raiz.current?.style.setProperty('--nivel', nivelNoMedidor(rms).toFixed(3)); };

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
    fala.current?.parar(); fala.current = null;
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
        const autor = (m as Message & { autor?: { nome: string | null } }).autor?.nome ?? agente.name;
        const f = await falarMensagem({ id: m.id, content: m.content, autor }, { podeEquipe: vozDaEquipe && !estado.current.semVoz, idioma: idiomaDaFala(idiomaAtual()), audio: a });
        if (ficha.current !== minha) { f?.parar(); return; }
        if (!f) { despachar({ tipo: 'voz_indisponivel' }); return; }
        fala.current = f;
        despachar({ tipo: 'tocando' });
        await f.fim;
        if (ficha.current !== minha) return;
      }
      fala.current = null;
      despachar({ tipo: 'fala_agente_fim' });
      // a sala: outro agente ainda vai responder a esta fala
      if (turno.current) despachar({ tipo: 'aguardar' });
    } catch (err) {
      if (ficha.current !== minha) return;
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
    try {
      const conv = await de.current.garantirConversa();
      const arq = await uploadFile<Attachment>(new File([blob], nomeDaGravacao(new Date(), f.ext), { type: f.tipo }), { conversationId: conv }, undefined, ac.signal);
      // encerrou no meio: a mensagem não sai
      if (estado.current.fase === 'fechado' || ac.signal.aborted) return;
      const corpo = { text: '', clientRequestId: requestId(), attachments: [arq.id], voz: true };
      const mandar = (fila: boolean) => api.post<{ messageId: string }>(`/api/conversations/${conv}/messages`, { ...corpo, ...(fila ? { queue: true } : {}) });
      // o colega ainda respondia (a pessoa falou por cima de uma resposta longa): a fala entra na fila da conversa
      const r = de.current.enviarFala ? { messageId: await de.current.enviarFala(arq.id) }
        : await mandar(false).catch((err) => { if (err instanceof ApiError && err.code === 'busy') return mandar(true); throw err; });
      turno.current = r.messageId;
      faladas.current.clear();
      conhecidas.current?.add(r.messageId);
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
    // microfone mudo no sistema (tecla de mudo, chave do fone): o sinal fica em zero absoluto; o botão mostra
    const agoraMs = performance.now();
    if (nivel < 1e-6 || fluxo.current?.getAudioTracks().some((x) => x.muted)) { zeroDesde.current ??= agoraMs; if (agoraMs - zeroDesde.current > 1200) setSemSom(true); }
    else if (zeroDesde.current !== null) { zeroDesde.current = null; setSemSom(false); }
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
    const tu = turnoDe(mensagens, id);
    // a equipe não transcreve (falta o componente, ou o motor está desligado): sem isso não há conversa por voz
    if (tu.transcricaoFalhou === 'componente' || tu.transcricaoFalhou === 'sem_motor') {
      turno.current = null;
      despachar({ tipo: 'erro', motivo: tu.transcricaoFalhou === 'componente' ? 'sem_transcricao' : 'sem_motor' }); // i18n-ok: código interno do estado
      return;
    }
    if (tu.fase === 'enviando' || tu.fase === 'transcrevendo') return;
    const novas = tu.respostas.filter((m) => !faladas.current.has(m.id));
    if (tu.fase === 'pensando' || (tu.maisVindo && !novas.length)) { if (e.fase === 'transcrevendo') despachar({ tipo: tu.transcricaoFalhou ? 'transcricao_falhou' : 'transcrito' }); return; }
    if (!tu.maisVindo) turno.current = null;
    if (tu.fase !== 'pronta' || !novas.length) {
      if (e.fase === 'transcrevendo') despachar({ tipo: 'transcrito' });
      despachar({ tipo: 'sem_resposta', motivo: tu.ninguem ? 'ninguem' : tu.fase === 'pronta' ? 'vazia' : tu.fase });
      return;
    }
    for (const m of novas) faladas.current.add(m.id);
    const n = despachar({ tipo: 'resposta', falar: podeFalar });
    if (n.fase === 'preparando') void falar(novas as Message[]);
    else if (turno.current) despachar({ tipo: 'aguardar' });
  }, [mensagens, esperando]); // eslint-disable-line react-hooks/exhaustive-deps

  // ——— um texto mandado pela barra com a voz ligada: a resposta dele também é falada ———
  useEffect(() => {
    const k = conhecidas.current!;
    if (e.fase !== 'ouvindo' || turno.current) return;
    for (const m of mensagens) {
      if (k.has(m.id) || m.role !== 'user') continue;
      const tu = turnoDe(mensagens, m.id);
      k.add(m.id);
      // já respondido (chegou enquanto o agente falava outra coisa): fica só escrito
      if (tu.fase !== 'pensando' && tu.fase !== 'transcrevendo') continue;
      turno.current = m.id;
      faladas.current.clear();
      despachar({ tipo: 'texto' });
      return;
    }
  }, [mensagens, e.fase]); // eslint-disable-line react-hooks/exhaustive-deps

  // ——— os botões ———
  const encerrar = () => { despachar({ tipo: 'fechar' }); envio.current?.abort(); soltarMicrofone(); pararFala(); onFechar(); };
  const interromper = () => { pararFala(); despachar({ tipo: 'interromper' }); };


  const nome = agente.name;
  const microfone = ligado && e.fase !== 'abrindo';
  const falando = e.fase === 'falando' || e.fase === 'preparando';
  // o estado curto, só para o leitor de tela (a tela mostra no próprio botão); no erro, a linha do erro
  const estadoCurto = e.fase === 'erro' ? '' : t(`conversas.voz.fase.${e.fase === 'fechado' ? 'pausado' : e.fase}`);
  const linha = e.fase === 'erro'
    ? t(e.erro === 'negado' ? 'conversas.voz.erro.negado' : e.erro === 'sem_microfone' ? 'conversas.voz.erro.semMicrofone' : e.erro === 'sem_suporte' ? 'conversas.voz.erro.semSuporte'
      : e.erro === 'sem_transcricao' ? 'conversas.voz.erro.semTranscricao' : e.erro === 'sem_motor' ? 'conversas.voz.erro.semMotor' : 'conversas.voz.erro.falhou')
    : e.fase === 'preparando' && preparaVoz ? t('conversas.voz.dica.preparandoPrimeira')
    : !e.aviso ? null
    : e.aviso === 'ninguem' ? t('conversas.voz.aviso.ninguem')
    : e.aviso === 'voz_falhou' ? t('conversas.voz.aviso.vozFalhou')
    : e.aviso === 'envio_falhou' ? t('conversas.voz.aviso.envioFalhou', { motivo: detalhe ?? t('conversas.voz.aviso.semDetalhe') })
    : e.aviso === 'transcricao_falhou' ? t('conversas.voz.aviso.transcricaoFalhou', { nome })
    : e.aviso === 'resposta_falhou' ? t('conversas.voz.aviso.respostaFalhou')
    : e.aviso === 'resposta_parada' ? t('conversas.voz.aviso.respostaParada')
    : e.aviso === 'espera_voce' ? t('conversas.voz.aviso.esperaVoce', { nome })
    : t('conversas.voz.aviso.limite');
  // a linha some sozinha depois de um tempo (o erro fica: ele tem o "de novo")
  const [linhaVista, setLinhaVista] = useState<string | null>(null);
  useEffect(() => {
    setLinhaVista(linha);
    if (!linha || e.fase === 'erro' || e.fase === 'preparando') return;
    const id = window.setTimeout(() => setLinhaVista(null), 6000);
    return () => window.clearTimeout(id);
  }, [linha, e.fase]);

  return (
    <span ref={raiz} className={`vozc vozc--${e.fase} ${esperando || e.fase === 'enviando' ? 'vozc--espera' : ''} ${semSom && microfone ? 'vozc--sem-som' : ''}`} data-fase={e.fase} data-microfone={microfone ? 'aberto' : 'fechado'}>
      <button type="button" className="icon-btn vozc__botao" onClick={encerrar} aria-pressed="true"
        aria-label={semSom && microfone ? `${t('conversas.voz.semSom')} · ${t('conversas.voz.encerrarDica')}` : t('conversas.voz.encerrarDica')}
        title={semSom && microfone ? t('conversas.voz.semSom') : t('conversas.voz.encerrarDica')}>
        {semSom && microfone && <i className="vozc__corte" aria-hidden="true" />}
        <i className="vozc-anel__fig" aria-hidden="true" /><i className="vozc-onda__fig" aria-hidden="true" />
        <Icon name="voz" />
        <span className="vozc__pontos" aria-hidden="true"><i /><i /><i /></span>
        {/* o ponto vermelho: o microfone está aberto de verdade */}
        <i className="vozc__rec" aria-hidden="true" />
      </button>
      {falando && (
        <button type="button" className="icon-btn vozc__parar" onClick={interromper} aria-label={t('conversas.voz.interromperDica', { nome })} title={t('conversas.voz.interromperDica', { nome })}>
          <Icon name="stop" size={16} />
        </button>
      )}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{estadoCurto}</span>
      {linhaVista && (
        <span className={`vozc__linha ${e.fase === 'erro' ? 'vozc__linha--erro' : ''}`} role={e.fase === 'erro' ? 'alert' : 'status'}>
          <Icon name="alert" size={13} /><span>{linhaVista}</span>
          {e.fase === 'erro' && <button type="button" className="linkish" onClick={() => despachar({ tipo: 'retomar' })}>{t('conversas.voz.tentar')}</button>}
        </span>
      )}
    </span>
  );
}
