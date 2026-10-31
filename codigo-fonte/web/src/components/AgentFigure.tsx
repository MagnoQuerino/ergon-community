import { useMemo } from 'react';
import { bodyUrl, type PortraitAgent } from '../iso/portrait.ts';
import { useActiveSkin } from '../lib/cosmetics.ts';

/**
 * O boneco inteiro do agente, o mesmo da cidade (com a skin ativa), como imagem em cache: nada de cena nem animação
 * por card. Sem canvas (teste, navegador sem suporte), a inicial na cor do agente.
 */
export function AgentFigure({ agent, scale = 2, className = '' }: { agent: PortraitAgent; scale?: number; className?: string }) {
  const skin = useActiveSkin();
  const img = useMemo(() => { try { return bodyUrl(agent, scale, skin); } catch { return null; } },
    [agent.id, agent.name, agent.color, agent.role, agent.char_key, agent.look_seed, scale, skin]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!img) return <span className={`avatar ${className}`} style={{ background: agent.color }} aria-hidden="true">{agent.name[0]}</span>;
  return <img className={`pxfigure ${className}`} src={img.url} width={img.w} height={img.h} alt="" aria-hidden="true" draggable={false} />;
}
