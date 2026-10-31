import { useEffect, useRef } from 'react';
import { paintFx, type FxSpec } from '../iso/cosmetics.ts';
import { figureSprite } from '../iso/figures.ts';
import { lookOfAgent, type PortraitAgent } from '../iso/portrait.ts';
import { RES } from '../iso/projection.ts';
import { ALEXANDRIA_DIA } from '../iso/theme.ts';
import { useActiveSkin } from '../lib/cosmetics.ts';

const PW = 40; const PH = 46; // unidades da pixel art (× RES no canvas): corpo inteiro com folga para o efeito

/**
 * Prévia do agente como vai ficar na cidade: o mesmo boneco (skin ativa, semente, cor) e o mesmo efeito, pintados pelo
 * código da cidade. Enquadramento fixo (o boneco não pula ao trocar de efeito). Anima só se há efeito e a pessoa não
 * pediu menos movimento; uma prévia por vez (não há prévia animada em listas).
 */
export function AgentPreview({ agent, fx, size = 4, label }: { agent: PortraitAgent; fx: FxSpec[]; size?: number; label: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const skin = useActiveSkin();
  useEffect(() => {
    const c = ref.current; const g = c?.getContext('2d'); if (!c || !g) return;
    const look = lookOfAgent(agent, ALEXANDRIA_DIA, skin);
    const sprite = figureSprite(look, 'front', 'stand', 0, false, ALEXANDRIA_DIA, 'smile');
    const x = Math.round(c.width / 2); const y = c.height - 5 * RES;
    const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    const draw = (now: number) => {
      g.clearRect(0, 0, c.width, c.height);
      g.save(); g.globalAlpha = 0.18; g.fillStyle = '#3b2f22'; g.beginPath(); g.ellipse(x, y, 7 * RES, 2 * RES, 0, 0, Math.PI * 2); g.fill(); g.restore();
      if (fx.length) paintFx(g, fx, x, y, reduce ? 0 : now, false, false);
      g.drawImage(sprite.canvas, x - sprite.ax, y - sprite.ay);
      if (fx.length && !reduce) raf = requestAnimationFrame(draw);
    };
    draw(0);
    return () => cancelAnimationFrame(raf);
  }, [agent.id, agent.name, agent.color, agent.role, agent.char_key, agent.look_seed, skin, fx.map((e) => `${e.effect}${e.color}${e.intensity}`).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} className="agent-preview" width={PW * RES} height={PH * RES} role="img" aria-label={label} style={{ width: (PW * RES * size) / 2, height: (PH * RES * size) / 2 }} />;
}
