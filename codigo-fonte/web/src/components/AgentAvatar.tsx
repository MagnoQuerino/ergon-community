import { useMemo } from 'react';
import { portraitUrl } from '../iso/portrait.ts';
import { useActiveSkin } from '../lib/cosmetics.ts';
import { letterStyle } from '../lib/contraste.ts';
import { useCorDoAgente, varsDaCor } from '../lib/cores-agentes.ts';
import type { Agent } from '../lib/types.ts';

/**
 * Retrato do agente em pixel art (a "selfie 3x4" do boneco da cidade). round: no círculo, mostra o rosto; sem, o
 * retrato inteiro em 3x4. Sem canvas (teste, navegador sem suporte), a inicial na cor do agente.
 * rc.43: a borda na cor do agente (lib/cores-agentes.ts, distinta dentro da equipe) e o nome ao passar o mouse.
 * `anel={false}` quando quem está em volta já desenha o anel na mesma cor (o documento na revisão ao vivo).
 */
export function AgentAvatar({ agent, size = 40, round = true, className = '', anel = true }: { agent: Pick<Agent, 'name' | 'color' | 'role' | 'char_key' | 'look_seed'> & { id?: string }; size?: number; round?: boolean; className?: string; anel?: boolean }) {
  const skin = useActiveSkin();
  const cor = useCorDoAgente(agent.id, agent.name);
  const comAnel = anel && !!cor;
  const url = useMemo(() => { try { return portraitUrl(agent, 4, skin); } catch { return ''; } }, [agent.id, agent.name, agent.color, agent.role, agent.char_key, agent.look_seed, skin]); // eslint-disable-line react-hooks/exhaustive-deps
  const h = round ? size : Math.round((size * 4) / 3);
  const anelCls = comAnel ? ' avatar--anel' : ''; // i18n-ok: nome de classe do estilo
  if (!url) return <span className={`avatar${anelCls} ${className}`} style={{ ...letterStyle(agent.color), ...(comAnel ? varsDaCor(cor) : {}), width: size, height: size }} title={agent.name} aria-hidden="true">{agent.name[0]}</span>;
  return <img className={`pxavatar ${round ? 'pxavatar--round' : ''}${anelCls} ${className}`} style={comAnel ? varsDaCor(cor) : undefined} src={url} width={size} height={h} alt="" title={agent.name} aria-hidden="true" draggable={false} />;
}
