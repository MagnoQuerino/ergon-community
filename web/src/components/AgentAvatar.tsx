import { useMemo } from 'react';
import { portraitUrl } from '../iso/portrait.ts';
import type { Agent } from '../lib/types.ts';

/**
 * Retrato do agente em pixel art (a "selfie 3x4" do boneco da cidade). round: no círculo, mostra o rosto; sem, o
 * retrato inteiro em 3x4. Sem canvas (teste, navegador sem suporte), a inicial na cor do agente.
 */
export function AgentAvatar({ agent, size = 40, round = true, className = '' }: { agent: Pick<Agent, 'name' | 'color' | 'role' | 'char_key' | 'look_seed'>; size?: number; round?: boolean; className?: string }) {
  const url = useMemo(() => { try { return portraitUrl(agent); } catch { return ''; } }, [agent.name, agent.color, agent.role, agent.char_key, agent.look_seed]); // eslint-disable-line react-hooks/exhaustive-deps
  const h = round ? size : Math.round((size * 4) / 3);
  if (!url) return <span className={`avatar ${className}`} style={{ background: agent.color, width: size, height: size }} aria-hidden="true">{agent.name[0]}</span>;
  return <img className={`pxavatar ${round ? 'pxavatar--round' : ''} ${className}`} src={url} width={size} height={h} alt="" aria-hidden="true" draggable={false} />;
}
