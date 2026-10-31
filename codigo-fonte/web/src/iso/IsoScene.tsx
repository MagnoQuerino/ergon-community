import { useEffect, useRef } from 'react';
import type { SceneProps } from '../scene/types.ts';
import { IsoEngine } from './engine.ts';

/** Palco isométrico em pixel art (Canvas 2D). */
export default function IsoScene(p: SceneProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const eng = useRef<IsoEngine | null>(null);
  const latest = useRef(p);
  latest.current = p;

  useEffect(() => {
    const e = new IsoEngine(canvas.current!, {
      onSelectAgent: (id) => latest.current.onSelectAgent(id),
      onObject: (k, text) => latest.current.onObject(k, text),
      onLot: (i, j) => latest.current.onLot(i, j),
      onStructure: (id) => latest.current.onStructure(id),
      onFocus: (f) => latest.current.onFocus(f),
      onMove: (id, i, j) => latest.current.onMove(id, i, j),
      onLost: () => latest.current.onContextLost(),
      onWindow: (w) => latest.current.onWindow(w),
    }, latest.current.themeId);
    eng.current = e;
    e.setTown(latest.current.structures);
    const ro = new ResizeObserver(([entry]) => e.resize(entry.contentRect.width, entry.contentRect.height));
    ro.observe(wrap.current!);
    (window as unknown as { __ergonIso?: IsoEngine }).__ergonIso = e; // inspeção em testes visuais e medição de desempenho
    latest.current.onReady({
      flyTo: (t) => e.flyTo(t), focusAgent: (id) => e.focusAgent(id), focusAgentAt: (id, b, l) => e.focusAgentAt(id, b, l),
      open: (b, l) => e.open(b, l), close: () => e.close(),
    });
    return () => { ro.disconnect(); e.dispose(); eng.current = null; latest.current.onReady(null); };
  }, []);

  // pacotes .ergon instalados (tema, efeitos, pets): só dados; sem pacote, nada muda
  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/packages/cosmetics', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : null)).then((c) => { if (alive && c) eng.current?.setCosmetics(c); }).catch(() => undefined);
    void load(); const t = setInterval(load, 30_000);
    window.addEventListener('ergon:packages', load);
    return () => { alive = false; clearInterval(t); window.removeEventListener('ergon:packages', load); };
  }, []);
  useEffect(() => { eng.current?.setTown(p.structures); }, [p.structures]);
  useEffect(() => { eng.current?.setTheme(p.themeId); }, [p.themeId]);
  // contagens do servidor: janelas e selo de quem não está carregado, e o mapa inteiro
  useEffect(() => { eng.current?.setCounts(p.counts); }, [p.counts]);
  useEffect(() => { eng.current?.setAgents(p.agents, { partial: p.partial }); }, [p.agents, p.partial]);
  useEffect(() => { eng.current?.setSelected(p.selectedId); }, [p.selectedId]);
  useEffect(() => { eng.current?.setEditing(p.editing); }, [p.editing]);
  useEffect(() => { eng.current?.setInsets(p.rightInset); }, [p.rightInset]);
  useEffect(() => { eng.current?.setActive(p.active); }, [p.active]);
  useEffect(() => { eng.current?.setOps(p.ops); }, [p.ops]);

  return (
    <div ref={wrap} className="iso">
      <canvas ref={canvas} className="iso__canvas" role="img"
        aria-label="Cidade em pixel art: passe o mouse num prédio para escolher o andar e clique para abrir; clique num agente para conversar, num lote livre para construir. Arraste para mover, roda do mouse para aproximar, duplo clique para ver a cidade inteira, Esc fecha o prédio." />
    </div>
  );
}
