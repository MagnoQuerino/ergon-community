/** Contrato entre a tela Ambiente e o palco (renderer). Trocar o renderer não muda este contrato. */
import type { RunStatus } from './agentState.ts';
import type { StructureIn } from '../world/town.ts';

export type { StructureIn };

export interface SceneAgent {
  id: string; name: string; color: string; role: string;
  /** prédio e andar onde o agente tem a mesa; vaga = posição dele no andar */
  building: string; level: number; slot: number;
  run: RunStatus;
  /** personagem da equipe (iconografia própria na cena) */
  key?: string | null;
  /** boneco sorteado do pacote gráfico ("Redefinir" no perfil); null = o do personagem ou pelo nome */
  seed?: number | null;
  /** Último desfecho real ("succeeded|<data>", "failed|…", "cancelled|…") — dispara a reação na cena. */
  outcome: string | null;
}

export type SceneObject = 'board' | 'shelf' | 'npc' | 'conexoes' | 'atividade' | 'info';
export interface SceneFocus { building: string; level: number }

/** Comandos que a interface dá ao palco (câmera e prédio aberto). */
export interface SceneApi {
  flyTo(target: string | 'cidade'): void;
  open(building: string, level: number): void;
  close(): void;
}

export interface SceneProps {
  structures: StructureIn[];
  agents: SceneAgent[];
  selectedId: string | null;
  /** Tema de cores do palco (cosmético). */
  themeId: 'dia' | 'noite';
  /** Editor do mapa: arrastar estruturas para outros lotes. */
  editing: boolean;
  /** Largura (px CSS) coberta à direita pelo painel de conversa: a câmera centraliza no que sobra. */
  rightInset: number;
  /** false = outra área do Ergon na tela: a cena fica oculta, mas a vida dos agentes continua */
  active: boolean;
  onSelectAgent(id: string): void;
  /** Clique num objeto: quadro, arquivo, anfitrião, mural (Conexões), teatro/conselho (Atividade) ou uma área (texto). */
  onObject(kind: SceneObject, text?: string): void;
  /** Clique num lote livre: abre a loja de estruturas. */
  onLot(i: number, j: number): void;
  /** Estrutura escolhida no palco (cartão de informações) — null ao clicar fora. */
  onStructure(id: string | null): void;
  /** Prédio aberto num andar (ou fechado). */
  onFocus(f: SceneFocus | null): void;
  /** Editor: estrutura solta num lote válido. */
  onMove(id: string, i: number, j: number): void;
  onContextLost(): void;
  onReady(api: SceneApi | null): void;
}
