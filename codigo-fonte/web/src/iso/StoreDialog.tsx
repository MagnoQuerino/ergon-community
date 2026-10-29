import { useEffect, useMemo, useRef, useState } from 'react';
import { CATALOG, capacityRange, fitAt, type StructureType } from '../../../shared/city.ts';
import type { Structure } from '../lib/types.ts';
import { Icon } from '../components/Icon.tsx';
import { useSurface } from '../lib/surface.ts';
import { Town } from '../world/town.ts';
import { closedArt } from './buildingArt.ts';
import { THEMES, type Theme, type ThemeId } from './theme.ts';
import { skinTheme, type ActiveSkin } from './skin.ts';
import { useActiveSkin } from '../lib/cosmetics.ts';
import { OFFICIAL_SKINS } from '../../../shared/skins-oficiais.ts';

/** Nome da estrutura na skin ativa (as oficiais instaladas antes de terem nomes usam os da versão atual). */
function skinName(skin: ActiveSkin | null, kind: string): { name: string; common?: string } | null {
  if (!skin) return null;
  return skin.data.structures?.[kind] ?? OFFICIAL_SKINS.find((o) => o.id === skin.data.id)?.structures?.[kind] ?? null;
}

const SIZE_LABEL: Record<StructureType['size'], string> = { pequena: 'Pequena', media: 'Média', grande: 'Grande' };

/** Miniatura do prédio, desenhada pelo mesmo código da cidade. */
function Thumb({ kind, theme }: { kind: string; theme: Theme }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const t = CATALOG.find((x) => x.id === kind); const c = ref.current; if (!t || !c) return;
    const town = new Town([{ id: 'thumb', kind, name: t.name, i: 0, j: 0, floors: Array.from({ length: Math.max(1, t.floors.initial) }, (_, l) => ({ id: `f${l}`, level: l, slots: t.slotsPerFloor })) }]);
    const b = town.buildings.get('thumb'); if (!b) return;
    const art = closedArt(b, theme);
    const L = art.layer.canvas; const g = c.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1; c.width = Math.round(176 * dpr); c.height = Math.round(118 * dpr);
    g.fillStyle = theme.bg; g.fillRect(0, 0, c.width, c.height);
    const s = Math.min(c.width / L.width, c.height / L.height) * 0.98;
    g.imageSmoothingEnabled = s < 1;
    g.drawImage(L, (c.width - L.width * s) / 2, (c.height - L.height * s) / 2, L.width * s, L.height * s);
  }, [kind, theme]);
  return <canvas ref={ref} className="store__thumb" style={{ width: 176, height: 118 }} aria-hidden="true" />;
}

/** Loja de estruturas (versão local: grátis e sem limite). Abre ao clicar num lote livre. */
export default function StoreDialog({ lot, structures, themeId, onBuild, onClose }: {
  lot: { i: number; j: number }; structures: Structure[]; themeId: ThemeId; onBuild: (kind: string, i: number, j: number) => Promise<void>; onClose: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => { requestAnimationFrame(() => setShown(true)); }, []);
  const box = useRef<HTMLDivElement>(null);
  useSurface(box, { onClose, modal: true, outside: true });
  const placed = useMemo(() => structures.map((s) => ({ id: s.id, kind: s.kind, i: s.i, j: s.j })), [structures]);
  const items = CATALOG.filter((t) => t.store);
  // a mesma cara da cidade: com uma skin, a arquitetura, as cores e os nomes dela (só aparência)
  const skin = useActiveSkin();
  const mode: ThemeId = themeId === 'noite' ? 'noite' : 'dia';
  const theme = useMemo(() => (skin ? skinTheme(THEMES[mode], skin.data, mode) : THEMES[themeId] ?? THEMES.dia), [skin, mode, themeId]);
  return (
    <div className={`modal ${shown ? 'modal--in' : ''}`}>
      <div ref={box} className="store" role="dialog" aria-modal="true" aria-label="Loja de estruturas">
        <header className="store__head">
          <div>
            <h2><Icon name="store" size={20} /> Construir neste lote</h2>
            <p className="muted">Todas têm a mesma função — abrigar agentes e oferecer postos de trabalho; muda a arquitetura e quantos cabem.</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar (Esc)" title="Fechar (Esc)"><Icon name="x" /></button>
        </header>
        <p className="store__note"><span className="badge badge--ok">versão local</span> grátis e sem limite de quantidade — o limite é o que o seu computador aguenta.</p>
        <div className="store__grid">
          {items.map((t) => {
            const at = fitAt(placed, t.id, lot.i, lot.j);
            const [cmin, cmax] = capacityRange(t);
            const nm = skinName(skin, t.id);
            return (
              <article key={t.id} className={`store__item ${at ? '' : 'store__item--off'}`}>
                <Thumb kind={t.id} theme={theme} />
                <div className="store__body">
                  <strong>{nm?.name ?? t.name}</strong> <span className="muted">· {nm?.common ?? t.common}</span>
                  <div className="row row--wrap">
                    <span className="badge">{SIZE_LABEL[t.size]} · {t.footprint[0] * t.footprint[1]} lote{t.footprint[0] * t.footprint[1] > 1 ? 's' : ''}</span>
                    <span className="badge">{cmin === cmax ? cmin : `${cmin}–${cmax}`} agentes</span>
                    <span className="badge">até {t.floors.max} andar{t.floors.max > 1 ? 'es' : ''}</span>
                  </div>
                  <p className="small">{t.description}</p>
                  <button className="btn btn--gold btn--sm" disabled={!at || !!busy} onClick={async () => { setBusy(t.id); try { await onBuild(t.id, at![0], at![1]); } finally { setBusy(null); } }}>
                    {busy === t.id ? 'Construindo…' : at ? 'Construir aqui' : 'Não cabe neste lote'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </div>
    </div>
  );
}
