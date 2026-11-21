import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, errMsg } from '../lib/api.ts';
import { useLiveEvent } from '../lib/live.ts';
import { ContaCliques, Toque, lerTecla, minutosAte, modificadores, paraViewport, rodaEmPixels, type MsgMouse, type Tela } from '../lib/navegador.ts';
import { useSurface } from '../lib/surface.ts';
import { useT } from '../i18n/index.ts';
import { Icon } from './Icon.tsx';

interface Estado { runId: string | null; ativo: boolean; controle: 'agente' | 'voce' | 'outra'; quem: string | null; ate: string | null; motivo: string | null }
const MOTIVOS = ['ocioso', 'teto', 'queda', 'sessao', 'prazo', 'navegador'] as const;

/**
 * Navegador ao vivo (rc.41): quando o agente desta conversa (ou deste card) está usando o navegador, a pessoa vê a tela
 * dele aqui, pode ampliar e pode assumir o controle (login, verificação, confirmar algo) e devolver.
 *
 * A tela vem do servidor do Ergon por um WebSocket da mesma origem, aberto com um bilhete de uso único; cada quadro é
 * uma imagem JPEG desenhada num canvas (nada da página visitada vira HTML aqui). O que a pessoa digita vai tecla a tecla
 * para o servidor e de lá para a página: não fica em estado do React, em armazenamento do navegador nem em registro.
 */
export function NavegadorAoVivo({ conversa, tarefa, agente }: { conversa?: string | null; tarefa?: string | null; agente: string }) {
  const [est, setEst] = useState<Estado | null>(null);
  const alvo = conversa ? `conversa=${conversa}` : tarefa ? `tarefa=${tarefa}` : null;
  const buscar = useCallback(async () => {
    if (!alvo) { setEst(null); return; }
    try { setEst(await api.get<Estado>(`/api/navegador?${alvo}`)); } catch { setEst(null); }
  }, [alvo]);
  useEffect(() => { setEst(null); void buscar(); }, [buscar]);
  useLiveEvent('runs.live', (d) => { if (d.navegador && ((conversa && d.conversationId === conversa) || (tarefa && d.taskId === tarefa))) void buscar(); });
  if (!est?.ativo || !est.runId) return null;
  return <Painel key={est.runId} runId={est.runId} est={est} setEst={setEst} agente={agente} rebuscar={buscar} />;
}

function Painel({ runId, est, setEst, agente, rebuscar }: { runId: string; est: Estado; setEst: (e: Estado) => void; agente: string; rebuscar: () => Promise<void> }) {
  const t = useT();
  const [ampliado, setAmpliado] = useState(false);
  const [pagina, setPagina] = useState<{ url: string; titulo: string } | null>(null);
  const [tela, setTela] = useState<Tela | null>(null);
  const [ligacao, setLigacao] = useState('');
  const [temQuadro, setTemQuadro] = useState(false);
  const [ocupado, setOcupado] = useState(false);
  const [erro, setErro] = useState('');
  const [nota, setNota] = useState('');
  const [teclado, setTeclado] = useState(false);
  const [, setRelogio] = useState(0);
  const ws = useRef<WebSocket | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const campo = useRef<HTMLTextAreaElement | null>(null);
  const quadro = useRef<ImageBitmap | null>(null);
  const telaRef = useRef<Tela | null>(null);
  const estRef = useRef(est);
  estRef.current = est;
  const euControlo = est.controle === 'voce';

  const desenhar = useCallback(() => {
    const c = canvas.current, q = quadro.current;
    if (!c || !q) return;
    if (c.width !== q.width || c.height !== q.height) { c.width = q.width; c.height = q.height; }
    c.getContext('2d')?.drawImage(q, 0, 0);
  }, []);
  // o canvas muda de lugar ao ampliar e reduzir: o último quadro volta na hora
  useEffect(() => { desenhar(); }, [ampliado, euControlo, est.controle, desenhar]);

  // a transmissão: bilhete (rota com sessão e CSRF) e WebSocket da mesma origem; cai, tenta de novo algumas vezes
  useEffect(() => {
    let vivo = true, tentativas = 0, espera: ReturnType<typeof setTimeout> | null = null;
    const abrir = async () => {
      if (!vivo) return;
      let bilhete = '';
      try { bilhete = (await api.post<{ bilhete: string }>(`/api/runs/${runId}/navegador/bilhete`)).bilhete; }
      catch { if (vivo) void rebuscar(); return; }
      if (!vivo) return;
      const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/runs/${runId}/navegador/fluxo?bilhete=${encodeURIComponent(bilhete)}`);
      s.binaryType = 'arraybuffer';
      ws.current = s;
      s.onmessage = (ev) => {
        if (typeof ev.data !== 'string') {
          void createImageBitmap(new Blob([ev.data as ArrayBuffer], { type: 'image/jpeg' })).then((b) => {
            if (!vivo) { b.close(); return; }
            quadro.current?.close();
            quadro.current = b;
            setTemQuadro(true);
            desenhar();
          }).catch(() => undefined);
          return;
        }
        let m: Record<string, unknown>;
        try { m = JSON.parse(ev.data) as Record<string, unknown>; } catch { return; }
        if (m.t === 'ola') {
          tentativas = 0;
          setLigacao(String(m.ligacao ?? ''));
          // a ligação caiu e voltou com a pessoa ainda no controle: o controle passa para a ligação nova (o servidor espera 20 s)
          if (m.controle === 'voce') void api.post(`/api/runs/${runId}/navegador/controle`, { pessoa: true, ligacao: String(m.ligacao ?? '') }).catch(() => undefined);
        }
        if (m.t === 'ola' || m.t === 'estado') {
          const antes = estRef.current;
          const novo: Estado = { runId, ativo: m.ativo !== false, controle: m.controle === 'voce' || m.controle === 'outra' ? m.controle : 'agente', quem: typeof m.quem === 'string' ? m.quem : null,
            ate: typeof m.ate === 'string' ? m.ate : null, motivo: typeof m.motivo === 'string' ? m.motivo : null };
          if (antes.controle === 'voce' && novo.controle === 'agente' && novo.motivo && (MOTIVOS as readonly string[]).includes(novo.motivo)) {
            setNota(t(`conversas.navegador.voltou.${novo.motivo as (typeof MOTIVOS)[number]}`));
            // viu na hora: o aviso da próxima abertura (AvisoDevolvido) não repete
            void api.post('/api/controle/devolvido/visto').catch(() => undefined);
          }
          setEst(novo);
        } else if (m.t === 'tela') { const nova = { largura: Number(m.largura), altura: Number(m.altura) }; telaRef.current = nova; setTela(nova); }
        else if (m.t === 'pagina') setPagina({ url: String(m.url ?? ''), titulo: String(m.titulo ?? '') });
        else if (m.t === 'fim') void rebuscar();
      };
      s.onclose = () => {
        if (ws.current === s) ws.current = null;
        if (!vivo) return;
        setLigacao('');
        if (tentativas++ < 6) espera = setTimeout(() => void abrir(), 800 + tentativas * 700); else void rebuscar();
      };
    };
    void abrir();
    return () => {
      vivo = false;
      if (espera) clearTimeout(espera);
      try { ws.current?.close(); } catch { /* já fechada */ }
      ws.current = null;
      quadro.current?.close();
      quadro.current = null;
    };
  }, [runId]); // eslint-disable-line react-hooks/exhaustive-deps

  // o prazo na tela anda sozinho
  useEffect(() => {
    if (!euControlo) return;
    const i = setInterval(() => setRelogio((n) => n + 1), 20_000);
    return () => clearInterval(i);
  }, [euControlo]);

  const mandar = (m: object) => { const s = ws.current; if (s && s.readyState === WebSocket.OPEN && estRef.current.controle === 'voce') s.send(JSON.stringify(m)); };
  const assumir = async () => {
    setErro(''); setNota(''); setOcupado(true);
    try {
      setEst({ ...(await api.post<Estado>(`/api/runs/${runId}/navegador/controle`, { pessoa: true, ligacao })) });
      setAmpliado(true);
    } catch (e) { setErro(errMsg(e)); void rebuscar(); }
    setOcupado(false);
  };
  const devolver = async () => {
    setErro(''); setOcupado(true);
    try {
      const r = await api.post<Estado & { senhas: number }>(`/api/runs/${runId}/navegador/controle`, { pessoa: false });
      setEst(r);
      setNota(r.senhas > 0 ? t('conversas.navegador.devolvidoSenhas', { nome: agente }) : t('conversas.navegador.devolvido', { nome: agente }));
    } catch (e) { setErro(errMsg(e)); }
    setOcupado(false);
  };

  // ——— entrada da pessoa (só no controle e com a tela ampliada)
  const captura = euControlo && ampliado;
  const cliques = useRef(new ContaCliques());
  const toque = useRef(new Toque());
  const movimento = useRef<{ x: number; y: number; k: number } | null>(null);
  const ponto = (e: { clientX: number; clientY: number }) => {
    const c = canvas.current, tl = telaRef.current;
    return c && tl ? paraViewport(e.clientX, e.clientY, c.getBoundingClientRect(), tl) : null;
  };
  const focarCampo = () => campo.current?.focus({ preventScroll: true });
  useEffect(() => { if (captura) focarCampo(); }, [captura]);
  // a roda precisa de um ouvinte que possa impedir a rolagem da página do Ergon
  useEffect(() => {
    const c = canvas.current;
    if (!c || !captura) return;
    const roda = (e: WheelEvent) => {
      const p = ponto(e), tl = telaRef.current;
      if (!p || !tl) return;
      e.preventDefault();
      mandar({ t: 'm', e: 'wh', ...p, ...rodaEmPixels(e.deltaX, e.deltaY, e.deltaMode, tl), k: modificadores(e) });
    };
    c.addEventListener('wheel', roda, { passive: false });
    return () => c.removeEventListener('wheel', roda);
  }, [captura, ampliado]); // eslint-disable-line react-hooks/exhaustive-deps
  const aoApertar = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!captura) return;
    const p = ponto(e);
    e.preventDefault();
    focarCampo();
    if (!p) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ponteiro já solto */ }
    if (e.pointerType === 'touch') { for (const m of toque.current.comecar(p)) mandar(m); return; }
    const b = e.button === 1 ? 1 : e.button === 2 ? 2 : 0;
    mandar({ t: 'm', e: 'mv', ...p, k: modificadores(e) } satisfies MsgMouse);
    mandar({ t: 'm', e: 'dn', ...p, b, c: cliques.current.clique(p.x, p.y, e.timeStamp), k: modificadores(e) } satisfies MsgMouse);
  };
  const aoMover = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!captura) return;
    const p = ponto(e);
    if (!p) return;
    if (e.pointerType === 'touch') { for (const m of toque.current.mover(p)) mandar(m); return; }
    // um movimento por quadro da tela (o servidor também limita)
    const tinha = movimento.current;
    movimento.current = { ...p, k: modificadores(e) };
    if (!tinha) requestAnimationFrame(() => { const m = movimento.current; movimento.current = null; if (m) mandar({ t: 'm', e: 'mv', x: m.x, y: m.y, k: m.k }); });
  };
  const aoSoltar = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!captura) return;
    if (e.pointerType === 'touch') { for (const m of toque.current.soltar()) mandar(m); return; }
    const p = ponto(e);
    if (!p) return;
    const b = e.button === 1 ? 1 : e.button === 2 ? 2 : 0;
    mandar({ t: 'm', e: 'up', ...p, b, c: 1, k: modificadores(e) } satisfies MsgMouse);
  };
  const aoTeclar = (fase: 'dn' | 'up') => (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (!captura) return;
    const r = lerTecla({ key: e.key, code: e.code, keyCode: e.keyCode, altKey: e.altKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, isComposing: e.nativeEvent.isComposing }, fase);
    if (r === 'texto' || r === null) return;
    e.preventDefault();
    e.stopPropagation();
    mandar(r);
  };
  // o texto pronto (letras, acentos, colar, teclado do celular) sai do campo escondido e o campo esvazia na hora
  const aoDigitar = (e: React.FormEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    if ((e.nativeEvent as InputEvent).isComposing) return;
    if (el.value) mandar({ t: 'txt', s: el.value.slice(0, 2000) });
    el.value = '';
  };

  const dlg = useRef<HTMLElement>(null);
  useSurface(dlg, { onClose: () => setAmpliado(false), modal: true, outside: !euControlo, escape: !euControlo, active: ampliado, autoFocus: !euControlo });

  const min = minutosAte(est.ate, Date.now());
  const situacao = euControlo ? t('conversas.navegador.voceNoControle') : est.controle === 'outra' ? t('conversas.navegador.outraNoControle', { nome: est.quem ?? '' }) : t('conversas.navegador.agenteNavegando', { nome: agente });
  const proporcao = tela ? `${tela.largura} / ${tela.altura}` : '16 / 9';
  const visor = (grande: boolean) => (
    <div className={`navv__tela ${captura && grande ? `navv__tela--captura ${teclado ? 'is-digitando' : 'is-chamando'}` : ''}`} style={{ aspectRatio: proporcao }}>
      {est.controle === 'outra'
        ? <p className="navv__vazio"><Icon name="lock" size={18} /> {t('conversas.navegador.telaComOutra', { nome: est.quem ?? '' })}</p>
        : (
          <>
            <canvas ref={canvas} className="navv__canvas" role="img" aria-label={t('conversas.navegador.telaAria', { nome: agente, titulo: pagina?.titulo || pagina?.url || '' })}
              onPointerDown={aoApertar} onPointerMove={aoMover} onPointerUp={aoSoltar} onPointerCancel={() => toque.current.cancelar()} onContextMenu={(e) => { if (captura) e.preventDefault(); }}
              onClick={() => { if (!grande) setAmpliado(true); }} />
            {!temQuadro && <p className="navv__vazio">{t('conversas.navegador.carregando')}</p>}
            {captura && grande && (
              <textarea ref={campo} className="navv__campo" aria-label={t('conversas.navegador.campoTeclado')} autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false} rows={1}
                onKeyDown={aoTeclar('dn')} onKeyUp={aoTeclar('up')} onInput={aoDigitar} onCompositionEnd={aoDigitar} onFocus={() => setTeclado(true)} onBlur={() => setTeclado(false)} />
            )}
          </>
        )}
    </div>
  );
  const barra = (grande: boolean) => (
    <div className="navv__barra">
      <span className={`navv__sit navv__sit--${est.controle}`} role="status"><span className="navv__ponto" aria-hidden="true" />{situacao}</span>
      <span className="navv__end" title={pagina?.url || undefined}><Icon name="globe" size={14} /><span className="navv__url">{pagina?.url || t('conversas.navegador.semEndereco')}</span></span>
      <span className="navv__acoes">
        {est.controle === 'agente' && <button type="button" className="btn btn--primary btn--sm" onClick={() => void assumir()} disabled={ocupado || !ligacao} aria-busy={ocupado}><Icon name="walk" size={14} /> {t('conversas.navegador.assumir')}</button>}
        {euControlo && <button type="button" className="btn btn--gold btn--sm" onClick={() => void devolver()} disabled={ocupado} aria-busy={ocupado}><Icon name="undo" size={14} /> {t('conversas.navegador.devolver')}</button>}
        {euControlo && min !== null && <span className="navv__prazo" title={t('conversas.navegador.prazoDica', { n: Math.max(1, min) })}><Icon name="clock" size={13} />{t('conversas.navegador.prazo', { n: Math.max(1, min) })}</span>}
        {grande
          ? <button type="button" className="icon-btn" onClick={() => setAmpliado(false)} aria-label={t('conversas.navegador.reduzir')} title={t('conversas.navegador.reduzir')}><Icon name="x" /></button>
          : <button type="button" className={`icon-btn ${euControlo ? 'navv__chamar' : ''}`} onClick={() => setAmpliado(true)} aria-label={t('conversas.navegador.ampliar')} title={t('conversas.navegador.ampliar')}><Icon name="focus" size={16} /></button>}
      </span>
    </div>
  );
  // no controle, a moldura e o botão de ampliar (que pulsa na tela pequena) já dizem o que fazer: sem faixa de instrução
  const avisos = () => (
    <>
      {!euControlo && nota && <p className="navv__nota" role="status">{nota}</p>}
      {erro && <p className="error navv__nota" role="alert">{erro}</p>}
    </>
  );

  return (
    <section className={`navv navv--${est.controle}`} aria-label={t('conversas.navegador.titulo', { nome: agente })}>
      {barra(false)}
      {ampliado ? <button type="button" className="navv__mini-aberta" onClick={() => dlg.current?.focus()}>{t('conversas.navegador.abertaAoLado')}</button> : visor(false)}
      {avisos()}
      {ampliado && createPortal(
        <div className="dlg-back navv-back">
          <section ref={dlg} tabIndex={-1} className={`dlg navv navv--grande navv--${est.controle}`} role="dialog" aria-modal="true" aria-label={t('conversas.navegador.titulo', { nome: agente })}>
            {barra(true)}
            {visor(true)}
            {avisos()}
          </section>
        </div>,
        document.body,
      )}
    </section>
  );
}
