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
import { useT, type Chave } from '../i18n/index.ts';

/** Nome da estrutura na skin ativa (as oficiais instaladas antes de terem nomes usam os da versão atual). */
function skinName(skin: ActiveSkin | null, kind: string): { name: string; common?: string } | null {
  if (!skin) return null;
  return skin.data.structures?.[kind] ?? OFFICIAL_SKINS.find((o) => o.id === skin.data.id)?.structures?.[kind] ?? null;
}

type ChaveEstrutura = Extract<Chave, `documentos.construir.estrutura.${string}`>;
/** Nome comum e descrição de cada estrutura da loja no idioma da tela (o catálogo em shared/city.ts é dado e fica em
 *  português); um id que não está aqui volta ao texto do catálogo. Os nomes próprios (Stoa, Oikos…) não se traduzem. */
const ESTRUTURAS_TRADUZIDAS = ['stoa', 'oikos', 'ergasterion', 'pharmakopoleion', 'didaskaleion', 'oikia', 'emporion', 'bouleuterion'] as const;
const chavesDe = <I extends (typeof ESTRUTURAS_TRADUZIDAS)[number]>(id: I) =>
  ({ comum: `documentos.construir.estrutura.${id}.comum`, descricao: `documentos.construir.estrutura.${id}.descricao` }) as const satisfies { comum: ChaveEstrutura; descricao: ChaveEstrutura };
const ESTRUTURA: Partial<Record<string, { comum: ChaveEstrutura; descricao: ChaveEstrutura }>> = Object.fromEntries(ESTRUTURAS_TRADUZIDAS.map((id) => [id, chavesDe(id)]));

const SIZE_LABEL: Record<StructureType['size'], Extract<Chave, `documentos.construir.tamanho.${string}`>> = { pequena: 'documentos.construir.tamanho.pequena', media: 'documentos.construir.tamanho.media', grande: 'documentos.construir.tamanho.grande' };

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
  const t = useT();
  const [busy, setBusy] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => { requestAnimationFrame(() => setShown(true)); }, []);
  const box = useRef<HTMLDivElement>(null);
  useSurface(box, { onClose, modal: true, outside: true });
  const placed = useMemo(() => structures.map((s) => ({ id: s.id, kind: s.kind, i: s.i, j: s.j })), [structures]);
  const items = CATALOG.filter((x) => x.store);
  // a mesma cara da cidade: com uma skin, a arquitetura, as cores e os nomes dela (só aparência)
  const skin = useActiveSkin();
  const mode: ThemeId = themeId === 'noite' ? 'noite' : 'dia';
  const theme = useMemo(() => (skin ? skinTheme(THEMES[mode], skin.data, mode) : THEMES[themeId] ?? THEMES.dia), [skin, mode, themeId]);
  return (
    <div className={`modal ${shown ? 'modal--in' : ''}`}>
      <div ref={box} className="store" role="dialog" aria-modal="true" aria-label={t('documentos.construir.dialogo')}>
        <header className="store__head">
          <div>
            <h2><Icon name="store" size={20} /> {t('documentos.construir.titulo')}</h2>
            <p className="muted">{t('documentos.construir.texto')}</p>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={t('documentos.construir.fechar')} title={t('documentos.construir.fechar')}><Icon name="x" /></button>
        </header>
        <p className="store__note"><span className="badge badge--ok">{t('documentos.construir.versaoLocal')}</span> {t('documentos.construir.nota')}</p>
        <div className="store__grid">
          {items.map((s) => {
            const at = fitAt(placed, s.id, lot.i, lot.j);
            const [cmin, cmax] = capacityRange(s);
            const nm = skinName(skin, s.id);
            const lotes = s.footprint[0] * s.footprint[1];
            const tr = ESTRUTURA[s.id];
            return (
              <article key={s.id} className={`store__item ${at ? '' : 'store__item--off'}`}>
                <Thumb kind={s.id} theme={theme} />
                <div className="store__body">
                  <strong>{nm?.name ?? s.name}</strong> <span className="muted">· {nm?.common ?? (tr ? t(tr.comum) : s.common)}</span>
                  <div className="row row--wrap">
                    <span className="badge">{t(SIZE_LABEL[s.size])} · {t('documentos.construir.lotes', { n: lotes })}</span>
                    <span className="badge">{cmin === cmax ? t('documentos.construir.agentes', { n: cmin }) : t('documentos.construir.agentesFaixa', { min: cmin, max: cmax })}</span>
                    <span className="badge">{t('documentos.construir.andares', { n: s.floors.max })}</span>
                  </div>
                  <p className="small">{tr ? t(tr.descricao) : s.description}</p>
                  <button className="btn btn--gold btn--sm" disabled={!at || !!busy} onClick={async () => { setBusy(s.id); try { await onBuild(s.id, at![0], at![1]); } finally { setBusy(null); } }}>
                    {busy === s.id ? t('documentos.construir.construindo') : at ? t('documentos.construir.aqui') : t('documentos.construir.naoCabe')}
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
