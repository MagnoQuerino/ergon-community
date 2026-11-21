/**
 * Pictogramas dos infográficos (rc.42), no traço da casa: grade de 24, cantos arredondados, peso cheio. Cada um é um
 * desenho cheio e, quando precisa, recortes na cor do painel (os olhos da carinha, a aba do envelope). Os mesmos na tela
 * (React) e no PNG (servidor): só caminhos SVG, sem texto nem imagem.
 */
export const PICTOGRAMAS = ['pessoa', 'email', 'moeda', 'ampulheta', 'relogio', 'estrela', 'carinha', 'caixa', 'calendario', 'predio'] as const;
export type Pictograma = (typeof PICTOGRAMAS)[number];

export interface Desenho { cheio: string; recorte?: string }
export const DESENHOS: Record<Pictograma, Desenho> = {
  pessoa: { cheio: 'M12 2.6a4.1 4.1 0 1 1 0 8.2a4.1 4.1 0 0 1 0-8.2Z M3.8 21.4c0-4.7 3.7-8.3 8.2-8.3s8.2 3.6 8.2 8.3c0 .3-.2.6-.6.6H4.4c-.4 0-.6-.3-.6-.6Z' },
  email: { cheio: 'M4.6 4.8h14.8a2.3 2.3 0 0 1 2.3 2.3v9.8a2.3 2.3 0 0 1-2.3 2.3H4.6a2.3 2.3 0 0 1-2.3-2.3V7.1a2.3 2.3 0 0 1 2.3-2.3Z', recorte: 'M3.6 7.2l8.4 5.9l8.4-5.9l.1 1.7l-8.5 6l-8.5-6Z' },
  moeda: { cheio: 'M5 15.6h14a1.4 1.4 0 0 1 1.4 1.4v2.3a1.4 1.4 0 0 1-1.4 1.4H5a1.4 1.4 0 0 1-1.4-1.4V17a1.4 1.4 0 0 1 1.4-1.4Z M6 10.2h12a1.4 1.4 0 0 1 1.4 1.4v2.3a1.4 1.4 0 0 1-1.4 1.4H6a1.4 1.4 0 0 1-1.4-1.4v-2.3A1.4 1.4 0 0 1 6 10.2Z M7 4.8h10a1.4 1.4 0 0 1 1.4 1.4v2.3a1.4 1.4 0 0 1-1.4 1.4H7a1.4 1.4 0 0 1-1.4-1.4V6.2A1.4 1.4 0 0 1 7 4.8Z' },
  ampulheta: { cheio: 'M6.2 2.4h11.6a.9.9 0 0 1 .9.9v1.4c0 3-2.4 5.2-4.4 7.3c2 2.1 4.4 4.3 4.4 7.3v1.4a.9.9 0 0 1-.9.9H6.2a.9.9 0 0 1-.9-.9v-1.4c0-3 2.4-5.2 4.4-7.3c-2-2.1-4.4-4.3-4.4-7.3V3.3a.9.9 0 0 1 .9-.9Z', recorte: 'M8.2 5.2h7.6c-.4 1.6-1.9 3.1-3.8 4.9c-1.9-1.8-3.4-3.3-3.8-4.9Z' },
  relogio: { cheio: 'M12 2.4a9.6 9.6 0 1 1 0 19.2a9.6 9.6 0 0 1 0-19.2Z', recorte: 'M11.1 6.4h1.8v5.2l3.4 2l-.9 1.6l-4.3-2.5Z' },
  estrela: { cheio: 'M12 2.3l2.9 6l6.5.9c.5.1.7.7.3 1.1l-4.7 4.5l1.1 6.5c.1.5-.4.9-.9.6L12 18.8l-5.2 3.1c-.5.3-1-.1-.9-.6l1.1-6.5l-4.7-4.5c-.4-.4-.2-1 .3-1.1l6.5-.9Z' },
  carinha: { cheio: 'M12 2.4a9.6 9.6 0 1 1 0 19.2a9.6 9.6 0 0 1 0-19.2Z', recorte: 'M8.6 8.2a1.4 1.4 0 1 1 0 2.8a1.4 1.4 0 0 1 0-2.8Z M15.4 8.2a1.4 1.4 0 1 1 0 2.8a1.4 1.4 0 0 1 0-2.8Z M7.2 13.6h1.9a3.1 3.1 0 0 0 5.8 0h1.9a5 5 0 0 1-9.6 0Z' },
  caixa: { cheio: 'M12 2.4l8.6 4.2v10.8L12 21.6l-8.6-4.2V6.6Z', recorte: 'M12 11.5l7.4-3.7l.6 1.2l-7.3 3.6v8.3h-1.4v-8.3L4 9l.6-1.2Z' },
  calendario: { cheio: 'M5.2 4.2h13.6a2.2 2.2 0 0 1 2.2 2.2v12.8a2.2 2.2 0 0 1-2.2 2.2H5.2A2.2 2.2 0 0 1 3 19.2V6.4a2.2 2.2 0 0 1 2.2-2.2Z M7.4 2h1.8v4h-1.8Z M14.8 2h1.8v4h-1.8Z', recorte: 'M4.6 8.6h14.8v1.4H4.6Z M13.8 13.2h3.4v3.4h-3.4Z' },
  predio: { cheio: 'M4 21.4V6.2c0-.5.3-.9.8-1l7-2.6c.6-.2 1.2.2 1.2.9v17.9Z M14.2 21.4V9.1l5.2 1.7c.4.1.6.5.6.9v9.7Z', recorte: 'M6.6 7.6h1.6v1.8H6.6Z M9.6 7.6h1.6v1.8H9.6Z M6.6 11.4h1.6v1.8H6.6Z M9.6 11.4h1.6v1.8H9.6Z M6.6 15.2h1.6v1.8H6.6Z M9.6 15.2h1.6v1.8H9.6Z M16.2 13h1.8v1.8h-1.8Z M16.2 16.6h1.8v1.8h-1.8Z' },
};
