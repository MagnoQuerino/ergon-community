import { useMemo, type ReactNode } from 'react';
import { drawCityThumb } from '../iso/cityThumb.ts';
import { lookFromSeed } from '../iso/figures.ts';
import { ALEXANDRIA_DIA } from '../iso/theme.ts';

const fotos = new Map<string, string>();
// as cores das roupas dos moradores da miniatura (as da equipe inicial)
const CORES = ['#2f4f8a', '#2e7d78', '#b5482f', '#c08a2a', '#a3446a', '#5b3f8c', '#6d7a3a'];
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; };

/**
 * A "foto" da cidade de um workspace (iso/cityThumb.ts): os prédios da cidade e três moradores sorteados pelo id do
 * workspace, para cada um ter a sua cara. Imagem em cache; sem canvas, nada.
 */
function fotoDe(id: string, w: number, h: number): string | null {
  const k = `${id}|${w}x${h}`;
  const hit = fotos.get(k);
  if (hit !== undefined) return hit || null;
  let url = '';
  try {
    const c = document.createElement('canvas');
    const base = hash(id);
    const looks = [0, 1, 2].map((i) => lookFromSeed(((base + i * 7919) % 2147483646) + 1, CORES[(base + i * 3) % CORES.length], ALEXANDRIA_DIA));
    drawCityThumb(c, ALEXANDRIA_DIA, looks, w, h);
    url = c.toDataURL('image/png');
  } catch { url = ''; }
  fotos.set(k, url);
  return url || null;
}

export function WsFoto({ id, w = 168, h = 92, className = '' }: { id: string; w?: number; h?: number; className?: string }) {
  const url = useMemo(() => fotoDe(id, w, h), [id, w, h]);
  return url ? <img className={`ws-card__foto ${className}`} src={url} width={w} height={h} alt="" draggable={false} /> : <span className={`ws-card__foto ws-card__foto--vazia ${className}`} />;
}

/**
 * Um workspace em cartão: a miniatura da cidade, o nome, os selos (atual, no Ergon World ou só neste computador, plano,
 * sincronia), os números e as ações. O mesmo cartão no seletor da barra, em Configurações › Workspace e na escolha do
 * workspace do Ergon World. Os textos chegam prontos de quem usa.
 */
export function WsCard({ id, nome, atual, selos, numeros, acoes, compacto, escolhido, children }: {
  id: string; nome: string; atual?: boolean; selos?: ReactNode; numeros?: ReactNode; acoes?: ReactNode; compacto?: boolean; escolhido?: boolean; children?: ReactNode;
}) {
  return (
    <article className={`ws-card${compacto ? ' ws-card--compacto' : ''}${atual ? ' is-current' : ''}${escolhido ? ' is-escolhido' : ''}`} aria-label={nome}>
      <WsFoto id={id} w={compacto ? 92 : 300} h={compacto ? 58 : 120} />
      <div className="ws-card__corpo">
        <b className="ws-card__nome">{nome}</b>
        {selos && <div className="ws-card__selos">{selos}</div>}
        {numeros && <p className="ws-card__nums small">{numeros}</p>}
        {acoes && <div className="ws-card__acoes">{acoes}</div>}
        {children}
      </div>
    </article>
  );
}
