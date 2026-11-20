/**
 * A sincronia com o Ergon World à vista e o fechamento seguro (rc.40):
 *  - na barra de cima, um sinal discreto enquanto há dados indo ou vindo (a conferência de cada minuto sem nada novo
 *    não acende; acende depois de 0,4 s e fica pelo menos 1,5 s, para não piscar);
 *  - fechar a janela do aplicativo durante a sincronia: um aviso; insistindo, a tela "Encerrando" pausa a sincronia
 *    num ponto seguro (o servidor espera o passo em andamento) e só então fecha. O que ficou para trás continua de onde
 *    parou quando o Ergon abrir de novo (cada mudança aplicada ou enviada é um ponto seguro: server/src/world/sync-local.ts);
 *  - no navegador, o aviso do próprio navegador ao fechar a aba durante a sincronia.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../../lib/api.ts';
import { inDesktopApp } from '../../lib/desktop.ts';
import { avisarApp, EVENTO_FECHAR, FECHAR, guardarFechar } from '../../lib/fechar.ts';
import { useResource } from '../../lib/live.ts';
import { useSurface } from '../../lib/surface.ts';
import { Icon } from '../../components/Icon.tsx';
import { ErgonLogo } from '../../brand/Brand.tsx';
import { useTw } from './textos.ts';

export interface EstadoSync { ativo: boolean; fase: 'enviando' | 'recebendo' | null; desde: string | null; pausada: boolean; algum?: boolean }

const URL_ATIVIDADE = '/api/world/sync/atividade';
const MOSTRA_DEPOIS_MS = 400;
const FICA_PELO_MENOS_MS = 1500;
const ENCERRANDO_PELO_MENOS_MS = 900;
let retomou = false;

/** Liga depois de `depois` ms ligado e, ligado, fica pelo menos `minimo` ms (sem piscar). */
function useSemPiscar(on: boolean, depois: number, minimo: number): boolean {
  const [vis, setVis] = useState(false);
  const desde = useRef(0);
  useEffect(() => {
    if (on && !vis) { const t = window.setTimeout(() => { desde.current = Date.now(); setVis(true); }, depois); return () => window.clearTimeout(t); }
    if (!on && vis) { const t = window.setTimeout(() => setVis(false), Math.max(0, minimo - (Date.now() - desde.current))); return () => window.clearTimeout(t); }
    return undefined;
  }, [on, vis, depois, minimo]);
  return vis;
}

export function Sincronia() {
  const t = useTw();
  const ativ = useResource<EstadoSync>(URL_ATIVIDADE, ['sync.changed']);
  const e = ativ.data;
  const sinal = useSemPiscar(!!e?.ativo, MOSTRA_DEPOIS_MS, FICA_PELO_MENOS_MS);
  const [fase, setFase] = useState<null | 'aviso' | 'encerrando'>(null);
  const faseRef = useRef(fase); faseRef.current = fase;

  // abriu de novo (ou recarregou): a pausa pedida ao fechar acaba aqui. Uma vez por abertura da página: o selo do World
  // se redesenhar (o World caiu e voltou) não desfaz uma pausa pedida no meio do fechamento
  useEffect(() => { if (!retomou) { retomou = true; void api.post('/api/world/sync/retomar', {}).catch(() => undefined); } }, []);

  const encerrar = async () => {
    if (faseRef.current === 'encerrando') return;
    setFase('encerrando'); faseRef.current = 'encerrando';
    avisarApp(FECHAR.encerrando);
    const t0 = Date.now();
    await api.post('/api/world/sync/pausar', {}).catch(() => undefined);
    await new Promise((r) => window.setTimeout(r, Math.max(0, ENCERRANDO_PELO_MENOS_MS - (Date.now() - t0))));
    avisarApp(FECHAR.sair);
  };

  // o aplicativo pediu para fechar (lib/fechar.ts)
  useEffect(() => {
    const sair = guardarFechar();
    const f = async () => {
      if (faseRef.current === 'aviso') { void encerrar(); return; } // fechou de novo com o aviso aberto: insistiu
      if (faseRef.current === 'encerrando') return;
      avisarApp(FECHAR.espera);
      const agora = await api.get<EstadoSync>(URL_ATIVIDADE).catch(() => null);
      if (!agora?.algum && !agora?.ativo) { avisarApp(FECHAR.sair); return; }
      setFase('aviso');
    };
    const ouvir = () => { void f(); };
    window.addEventListener(EVENTO_FECHAR, ouvir);
    return () => { window.removeEventListener(EVENTO_FECHAR, ouvir); sair(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // com o aviso aberto, a sincronia terminou: fecha como a pessoa queria
  useEffect(() => { if (fase === 'aviso' && e && !e.ativo && !e.algum) void encerrar(); }, [fase, e?.ativo, e?.algum]); // eslint-disable-line react-hooks/exhaustive-deps

  // no navegador: o aviso do próprio navegador ao fechar a aba no meio da sincronia
  useEffect(() => {
    if (inDesktopApp() || !e?.ativo) return undefined;
    const f = (ev: BeforeUnloadEvent) => { ev.preventDefault(); ev.returnValue = ''; };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, [e?.ativo]);

  const rotulo = e?.fase === 'enviando' ? t('sync.sinal.enviando') : e?.fase === 'recebendo' ? t('sync.sinal.recebendo') : t('sync.sinal.geral');
  return (
    <>
      {sinal && (
        <span className="tb-sync" role="status" aria-label={rotulo} title={rotulo}>
          <span className="tb-sync__giro" aria-hidden="true"><Icon name="repeat" size={15} /></span>
        </span>
      )}
      {fase === 'aviso' && <AvisoFechar onFicar={() => { setFase(null); avisarApp(FECHAR.cancelar); }} onFechar={() => void encerrar()} />}
      {fase === 'encerrando' && createPortal(
        <div className="encerrando" role="alertdialog" aria-modal="true" aria-labelledby="encerrando-titulo" aria-describedby="encerrando-texto">
          <ErgonLogo kind="horizontal" onDark height={36} />
          <span className="encerrando__giro" aria-hidden="true"><Icon name="repeat" size={22} /></span>
          <h2 id="encerrando-titulo">{t('sync.encerrando.titulo')}</h2>
          <p id="encerrando-texto">{t('sync.encerrando.texto')}</p>
        </div>, document.body)}
    </>
  );
}

function AvisoFechar({ onFicar, onFechar }: { onFicar: () => void; onFechar: () => void }) {
  const t = useTw();
  const ref = useRef<HTMLDivElement>(null);
  useSurface(ref, { onClose: onFicar, modal: true, outside: true });
  return createPortal(
    <div className="cpop" role="presentation">
      <div ref={ref} className="cpop__card" role="alertdialog" aria-modal="true" aria-labelledby="sync-fechar-titulo" aria-describedby="sync-fechar-texto">
        <h3 id="sync-fechar-titulo"><span className="tb-sync__giro" aria-hidden="true"><Icon name="repeat" size={16} /></span> {t('sync.aviso.titulo')}</h3>
        <div className="cpop__body">
          <p id="sync-fechar-texto">{t('sync.aviso.texto')}</p>
          <p className="muted small">{t('sync.aviso.sozinho')}</p>
        </div>
        <div className="cpop__acts">
          <button className="btn btn--primary" onClick={onFicar} autoFocus>{t('sync.aviso.continuar')}</button>
          <button className="btn btn--ghost" onClick={onFechar}>{t('sync.aviso.fechar')}</button>
        </div>
      </div>
    </div>, document.body);
}
