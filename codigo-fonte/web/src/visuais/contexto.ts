// O que a conversa (ou a sala, ou o diálogo das entregas) oferece aos blocos visuais: os votos das enquetes, votar e a
// marca do PNG. Fora de uma conversa, os blocos só mostram (sem votar).
import { createContext, useContext } from 'react';
import type { Marca } from '../../../shared/visuais/svg.ts';

export interface VotoVisto { enquete: string; opcao: number; quem: string; nome: string; agente?: { name: string; color: string; char_key?: string | null } }

export interface VisuaisContexto {
  votos: VotoVisto[];
  /** quem vota aqui (a chave dela): o voto dela aparece marcado */
  eu?: string;
  /** quantas pessoas podem votar (a sala inteira); sem: conta só quem votou */
  eleitores?: number;
  votar?: (enquete: string, opcao: number) => Promise<void>;
  marca?: Marca | null;
}

export const SEM_CONTEXTO: VisuaisContexto = { votos: [] };
export const ContextoVisuais = createContext<VisuaisContexto>(SEM_CONTEXTO);
export const useVisuais = () => useContext(ContextoVisuais);
