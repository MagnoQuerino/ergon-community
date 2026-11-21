/**
 * As cores dos blocos visuais por tema, para o PNG do servidor (a tela usa as variáveis CSS do tema; o PNG baixado na
 * tela lê as mesmas variáveis já resolvidas). Iguais às de web/src/styles.css: um teste confere.
 */
import type { Cor } from './cena.ts';

export type Paleta = Record<Cor, string> & { fundo: string };
/** de cada cor de função, a variável CSS do tema */
export const VARIAVEL: Record<Cor | 'fundo', string> = {
  v1: '--vis-1', v2: '--vis-2', v3: '--vis-3', v4: '--vis-4', v5: '--vis-5', v6: '--vis-6',
  bom: '--vis-bom', ruim: '--vis-ruim', atencao: '--vis-atencao', trilho: '--vis-trilho', sobre: '--vis-sobre',
  tinta: '--ink', suave: '--muted', linha: '--line', painel: '--panel', painel2: '--panel-2', marca: '--navy', fundo: '--bg',
};

export const PALETAS: Record<'claro' | 'escuro', Paleta> = {
  claro: {
    v1: '#1f5b6b', v2: '#a9773f', v3: '#6b4fb0', v4: '#b4603f', v5: '#2c774b', v6: '#2b5f86',
    bom: '#237a4a', ruim: '#b23a26', atencao: '#966800', trilho: '#ebe3d4', sobre: '#ffffff',
    tinta: '#1d2a33', suave: '#686760', linha: '#e3d9c8', painel: '#fffdf8', painel2: '#f8f3ea', marca: '#1D184B', fundo: '#f4efe6',
  },
  escuro: {
    v1: '#6cc3d3', v2: '#d6a874', v3: '#a993e6', v4: '#e58b68', v5: '#7fd3a1', v6: '#8fb8e0',
    bom: '#5ec58a', ruim: '#ff8a73', atencao: '#f1c96b', trilho: '#2b313b', sobre: '#0e1116',
    tinta: '#e9ecf1', suave: '#aab2bf', linha: '#343b47', painel: '#1a1e26', painel2: '#20252e', marca: '#c9c4ff', fundo: '#12151b',
  },
};
