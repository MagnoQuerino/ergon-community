/** Geometria básica do mundo (x, z no chão; y para cima). TypeScript puro. */
export type Vec2 = [number, number];
export type P3 = [number, number, number];
export interface Box { x0: number; z0: number; x1: number; z1: number }
/** Caixa 3D alinhada aos eixos: base da ordenação de desenho e das colisões. */
export interface AABB { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

export const inBox = (b: Box, x: number, z: number, m = 0): boolean => x >= b.x0 - m && x <= b.x1 + m && z >= b.z0 - m && z <= b.z1 + m;
export const boxAt = (x: number, z: number, hx: number, hz: number): Box => ({ x0: x - hx, z0: z - hz, x1: x + hx, z1: z + hz });
export const shiftBox = (b: Box, dx: number, dz: number): Box => ({ x0: b.x0 + dx, z0: b.z0 + dz, x1: b.x1 + dx, z1: b.z1 + dz });
export const grow = (b: Box, m: number): Box => ({ x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m });
export const boxesOverlap = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.z0 < b.z1 && b.z0 < a.z1;
