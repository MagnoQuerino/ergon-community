/**
 * A cor de cada agente (rc.43): borda do avatar em todas as telas, realce do trecho na revisão ao vivo, cursor. Cada
 * agente da equipe tem uma cor só dele dentro do workspace.
 *
 * - Paleta de 16 cores em par (tema claro, tema escuro): no claro, contraste de pelo menos 3:1 com o papel; no escuro, com
 *   o fundo da noite (cores-agentes.test confere). Dezesseis matizes, alternando um tom fundo e um mais vivo, para que
 *   as vizinhas não se confundam.
 * - Derivada do id: cada agente prefere a cor que o id sorteia. Desempate: na ordem de chegada à equipe, quem chega
 *   depois e acharia a cor já tomada (ou parecida demais com uma tomada) fica com a livre mais distante das usadas. A
 *   ordem de chegada não muda, então a cor de ninguém muda quando outro entra ou sai.
 * - Mais de 16 agentes: a cor menos repetida e mais distante das vizinhas.
 */
export interface CorDoAgente { claro: string; escuro: string }

export const PALETA_AGENTES: readonly CorDoAgente[] = [
  ['#972527', '#ed756e'], ['#0388a5', '#5dd9fd'], ['#764a05', '#d98b09'], ['#5740a1', '#9e8cf4'],
  ['#09672e', '#4cb86a'], ['#c04d6e', '#fdaebf'], ['#076262', '#1db4b4'], ['#be5a0a', '#fdb48c'],
  ['#545b04', '#9ca81f'], ['#88296f', '#da76bb'], ['#158e77', '#29e6c2'], ['#4e75d2', '#aec7fc'],
  ['#90790f', '#e6c540'], ['#075a8e', '#3ba6f5'], ['#508d23', '#9cdd76'], ['#9b5bb6', '#e5affd'],
].map(([claro, escuro]) => ({ claro, escuro }));

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const rgb = (h: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as [number, number, number];
function oklab(h: string): [number, number, number] {
  const [r, g, b] = rgb(h).map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
// a claridade pesa menos que o matiz: dois tons do mesmo vermelho, lado a lado num avatar pequeno, parecem a mesma cor
const dist = (a: string, b: string) => { const x = oklab(a), y = oklab(b); return Math.hypot((x[0] - y[0]) * 0.4, x[1] - y[1], x[2] - y[2]); };
/** a distância entre duas cores da paleta: a menor das duas (claro e escuro), em OKLab */
const D: number[][] = PALETA_AGENTES.map((a) => PALETA_AGENTES.map((b) => Math.min(dist(a.claro, b.claro), dist(a.escuro, b.escuro))));
/** abaixo disto, duas cores lado a lado parecem a mesma */
export const PARECIDAS = 0.08;

/** O sorteio pelo id (FNV-1a): sempre o mesmo índice para o mesmo id. */
export function indicePreferido(id: string): number {
  let h = 2166136261;
  for (const ch of id) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619) >>> 0; }
  return h % PALETA_AGENTES.length;
}

/**
 * As cores da equipe: `ids` na ordem de chegada (created_at, id). Devolve o índice da paleta de cada agente.
 */
export function distribuirCores(ids: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  const usos = PALETA_AGENTES.map(() => 0);
  const N = PALETA_AGENTES.length;
  for (const id of ids) {
    if (out.has(id)) continue;
    const pref = indicePreferido(id);
    const menorUso = Math.min(...usos);
    const usadas = usos.flatMap((u, i) => (u > 0 ? [i] : []));
    // a distância de i à cor usada mais parecida (0 se a própria já está em uso)
    const perto = (i: number) => (usos[i] > 0 ? 0 : usadas.length ? Math.min(...usadas.map((j) => D[i][j])) : 9);
    let escolha = pref;
    if (usos[pref] > menorUso || perto(pref) < PARECIDAS) {
      // a livre (ou a menos repetida) mais distante das usadas; empate, a mais perto do sorteio
      let melhor = -1;
      for (let k = 0; k < N; k++) {
        const i = (pref + k) % N;
        if (usos[i] > menorUso) continue;
        const d = perto(i);
        if (d > melhor + 1e-9) { melhor = d; escolha = i; }
      }
    }
    usos[escolha]++;
    out.set(id, escolha);
  }
  return out;
}

/** A cor de um agente fora da equipe conhecida (sem a lista): a do sorteio pelo id. */
export const corPeloId = (id: string): CorDoAgente => PALETA_AGENTES[indicePreferido(id)];
