import { useEffect, useReducer, useRef } from 'react';
import { useT } from '../i18n/index.ts';
import { GRAVACAO_BITS, GRAVACAO_MAX_MS, GRAVACAO_MIN_MS, PARADO, formatoDeGravacao, gravador, microfoneAberto, motivoDoErro, nomeDaGravacao, relogio } from '../lib/gravador.ts';
import { Icon } from './Icon.tsx';

/**
 * Mensagem de áudio (rc.33): o botão do microfone no campo da conversa. Grava em WebM/Opus a 32 kbit/s, com o relógio à
 * vista, "cancelar" e "enviar"; para sozinho em 10:00. O arquivo sobe pelo anexo de sempre (quem chama decide: enviar
 * na hora ou deixar no campo). Microfone negado: uma frase curta, sem travar a conversa.
 */
export function GravadorDeVoz({ onGravado, onAtivo, desligado }: {
  /** o arquivo gravado; `limite`: parou sozinho em 10:00 (fica no campo para a pessoa conferir e mandar) */
  onGravado: (f: File, motivo: 'enviar' | 'limite') => void;
  /** gravando agora (o campo de texto dá lugar à barra do gravador) */
  onAtivo?: (ativo: boolean) => void;
  desligado?: boolean;
}) {
  const t = useT();
  const [e, despachar] = useReducer(gravador, PARADO);
  const fluxo = useRef<MediaStream | null>(null);
  const rec = useRef<MediaRecorder | null>(null);
  const partes = useRef<Blob[]>([]);
  const cancelado = useRef(false);
  const formato = useRef<{ mime: string; ext: string; tipo: string } | null>(null);

  const soltar = () => { fluxo.current?.getTracks().forEach((x) => x.stop()); fluxo.current = null; rec.current = null; };
  useEffect(() => () => { cancelado.current = true; try { rec.current?.stop(); } catch { /* já parado */ } soltar(); }, []);
  useEffect(() => { onAtivo?.(e.fase === 'gravando' || e.fase === 'pedindo' || e.fase === 'fechando'); }, [e.fase]); // eslint-disable-line react-hooks/exhaustive-deps

  // o relógio (e o teto de 10:00)
  useEffect(() => {
    if (e.fase !== 'gravando') return;
    const id = window.setInterval(() => despachar({ tipo: 'tique', agora: Date.now() }), 250);
    return () => window.clearInterval(id);
  }, [e.fase]);
  // parou (enviar ou o teto): fecha o arquivo; o "dataavailable" final chega antes do "stop"
  useEffect(() => {
    if (e.fase === 'fechando' && rec.current && rec.current.state !== 'inactive') { cancelado.current = false; rec.current.stop(); }
  }, [e.fase]);

  async function comecar() {
    despachar({ tipo: 'iniciar' });
    const md = typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined;
    formato.current = typeof MediaRecorder !== 'undefined' ? formatoDeGravacao((x) => MediaRecorder.isTypeSupported(x)) : null;
    if (!md?.getUserMedia || !formato.current) { despachar({ tipo: 'erro', motivo: 'sem_suporte' }); return; } // i18n-ok: código interno do estado
    let s: MediaStream;
    try { s = await md.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } }); }
    catch (err) { despachar(motivoDoErro(err)); return; }
    fluxo.current = s;
    partes.current = [];
    let r: MediaRecorder;
    try { r = new MediaRecorder(s, { mimeType: formato.current.mime, audioBitsPerSecond: GRAVACAO_BITS }); }
    catch { soltar(); despachar({ tipo: 'erro', motivo: 'sem_suporte' }); return; } // i18n-ok: código interno do estado
    rec.current = r;
    const inicio = Date.now();
    r.ondataavailable = (ev) => { if (ev.data.size) partes.current.push(ev.data); };
    r.onerror = () => { soltar(); despachar({ tipo: 'erro', motivo: 'falhou' }); }; // i18n-ok: código interno do estado
    r.onstop = () => {
      const f = formato.current!;
      const ms = Date.now() - inicio;
      soltar();
      const blob = new Blob(partes.current, { type: f.tipo });
      partes.current = [];
      const motivo = ms >= GRAVACAO_MAX_MS - 500 ? 'limite' : 'enviar';
      despachar({ tipo: 'fechado' });
      if (cancelado.current || ms < GRAVACAO_MIN_MS || !blob.size) return;
      onGravado(new File([blob], nomeDaGravacao(new Date(), f.ext), { type: f.tipo }), motivo);
    };
    r.start(1000); // um pedaço por segundo: o que já gravou não se perde se a aba fechar no meio
    despachar({ tipo: 'permitido', agora: inicio });
  }
  function cancelar() {
    cancelado.current = true;
    try { if (rec.current && rec.current.state !== 'inactive') rec.current.stop(); } catch { /* já parado */ }
    soltar();
    despachar({ tipo: 'cancelar' });
  }

  if (e.fase === 'gravando' || e.fase === 'fechando' || e.fase === 'pedindo') {
    const ms = e.fase === 'pedindo' ? 0 : e.ms;
    return (
      <div className="gravador" role="group" aria-label={t('conversas.gravador.titulo')}>
        <span className={`gravador__ponto ${e.fase === 'gravando' ? 'is-on' : ''}`} aria-hidden="true" />
        <span className="gravador__txt" aria-live="polite">
          {e.fase === 'pedindo' ? t('conversas.gravador.pedindo') : e.fase === 'fechando' ? t('conversas.gravador.fechando') : t('conversas.gravador.gravando')}
        </span>
        <time className="gravador__relogio" aria-label={t('conversas.gravador.tempo', { tempo: relogio(ms), max: relogio(GRAVACAO_MAX_MS) })}>
          {relogio(ms)} <small>/ {relogio(GRAVACAO_MAX_MS)}</small>
        </time>
        <span className="gravador__barra" aria-hidden="true"><i style={{ width: `${Math.min(100, (ms / GRAVACAO_MAX_MS) * 100)}%` }} /></span>
        <button type="button" className="btn btn--sm btn--ghost" onClick={cancelar} disabled={e.fase === 'fechando'}><Icon name="x" size={14} /> {t('conversas.gravador.cancelar')}</button>
        <button type="button" className="btn btn--sm btn--primary" onClick={() => despachar({ tipo: 'enviar', agora: Date.now() })} disabled={e.fase !== 'gravando'}>
          <Icon name="send" size={14} /> {t('conversas.gravador.enviar')}
        </button>
      </div>
    );
  }
  return (
    <>
      <button type="button" className="icon-btn chat__mic" onClick={() => void comecar()} disabled={desligado || microfoneAberto(e)}
        aria-label={t('conversas.gravador.gravar')} title={t('conversas.gravador.gravarDica')}><Icon name="mic" /></button>
      {(e.fase === 'negado' || e.fase === 'erro') && (
        <span className="gravador__aviso" role="status">
          {e.fase === 'negado' ? t('conversas.gravador.negado') : e.motivo === 'sem_microfone' ? t('conversas.gravador.semMicrofone') : e.motivo === 'sem_suporte' ? t('conversas.gravador.semSuporte') : t('conversas.gravador.falhou')}
          <button type="button" className="icon-btn" onClick={() => despachar({ tipo: 'cancelar' })} aria-label={t('conversas.gravador.fecharAviso')}><Icon name="x" size={12} /></button>
        </span>
      )}
    </>
  );
}
