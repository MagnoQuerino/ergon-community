/**
 * Vida ambiente (cosmética): o que agentes ociosos fazem enquanto não há execução real — trabalhar na
 * própria mesa, visitar um colega, levar um rolo, reunir-se, conversar ou debater e sair pela cidade:
 * ágora (fonte, mural), termas (nadar, descansar), ginásio (correr, disco, luta, exercício), teatro
 * (assembleia) e a própria casa (sesta; à noite, dormir). Os pontos de cada atividade vêm das plantas e
 * das áreas (world/); aqui ficam os pesos, os sorteios e o relógio. Nada chama modelo nem muda dados.
 */
import type { Activity, Bubble } from '../world/buildings.ts';
import type { Vec2 } from '../world/geom.ts';

export type { Activity, Bubble };

/** Gerador determinístico, para a vida não depender de Math.random nos testes. */
export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
export function between(r: () => number, [a, b]: [number, number]): number { return a + (b - a) * r(); }

/** Sorteia uma atividade livre (não ocupada por outro agente). */
export function pickActivity(r: () => number, busy: Set<string>, list: Activity[], prefix: string): Activity | null {
  const free = list.filter((a) => !busy.has(prefix + a.id));
  return free.length ? free[Math.floor(r() * free.length)] : null;
}

/** Dupla de conversa: A olha para a direita da tela, B = A + (0,8; −0,8) olha para a esquerda — ambos de frente. */
export function pairAt([x, z]: Vec2): [Vec2, Vec2] { return [[x, z], [x + 0.8, z - 0.8]]; }

/**
 * Pesos do que um ocioso faz a seguir. O trabalho na Stoa continua sendo o centro, mas a cidade é usada de
 * verdade: piscina, corrida, disco, luta, ágora e teatro somam cerca de um terço das escolhas.
 */
export const LIFE_WEIGHTS = {
  desk: 0.22, visit: 0.11, chat: 0.13, handoff: 0.06, meeting: 0.05, solo: 0.08,
  agora: 0.08, termas: 0.09, ginasio: 0.1, teatro: 0.05, casa: 0.03,
};
export type LifeChoice = keyof typeof LIFE_WEIGHTS;
export function pickChoice(r: () => number): LifeChoice {
  let v = r();
  for (const [k, w] of Object.entries(LIFE_WEIGHTS) as Array<[LifeChoice, number]>) { if (v < w) return k; v -= w; }
  return 'solo';
}

/** Noite (22h–6h, hora local): ociosos vão dormir em casa; um pedido real os acorda. */
export function isNightHour(h: number): boolean { return h >= 22 || h < 6; }
/** Tema de cores automático: noite das 19h às 6h, no fuso do navegador. */
export function isDarkHour(h: number): boolean { return h >= 19 || h < 6; }
/** Quanto falta até as 6h (ms). */
export function msUntilMorning(d: Date): number {
  const m = new Date(d); m.setHours(6, 0, 0, 0);
  if (m.getTime() <= d.getTime()) m.setDate(m.getDate() + 1);
  return m.getTime() - d.getTime();
}
