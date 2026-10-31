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
  /** casa do bairro: a posição dele na cidade inteira, calculada no servidor (a mesma regra de antes) */
  house: number;
}

/**
 * Contagens do servidor por andar (GET /api/city/overview): janelas e selo dos andares sem ninguém carregado e o
 * mapa inteiro, sem carregar nenhum agente. `total` = agentes ativos da cidade.
 */
export interface SceneCounts {
  total: number;
  structures: Array<{ id: string; floors: Array<{ level: number; active: number; working: number; waiting: number; queued: number }> }>;
}

/**
 * O que a cena tem perto da tela, para o carregador (lib/cityData.ts) decidir que andares buscar e quais manter.
 * Mandado quando muda (câmera, prédio aberto, escolhido); quem decide quando pedir é o carregador.
 */
export interface SceneWindow {
  /**
   * construções que cruzam a tela + uma tela inteira em volta (o que se mantém), da mais perto do centro visível para
   * a mais longe (`dist` em pixels do mundo); `near` = cruza a tela + meia tela (o que se quer)
   */
  buildings: Array<{ id: string; dist: number; near: boolean }>;
  /** zoom de mapa: nada novo carrega */
  map: boolean;
  open: SceneFocus | null;
  /** o agente escolhido e o andar dele (o carregado ou, enquanto ele não chega, o pedido em focusAgentAt) */
  selected: { id: string; building: string; level: number } | null;
}

export type SceneObject = 'board' | 'shelf' | 'npc' | 'conexoes' | 'atividade' | 'info' | SceneOpsTarget;
/** Placas operacionais: Central de Trabalho (vagas), espera, entregas e decisões. */
export type SceneOpsTarget = 'central' | 'espera' | 'entregas' | 'decisoes';
/**
 * Trabalho da equipe para as placas da cidade: só números já classificados pelo servidor (/api/ambient/operations).
 * A cena não busca nem classifica nada; sem leitura (null), as placas não aparecem.
 */
export interface SceneOps {
  busy: number; limit: number | null; ready: number; blocked: number; attention: number; decisions: number; deliveries: number;
  /** trabalho na nuvem ligado nesta instalação; sem ele, o posto da nuvem fica coberto com lona (sem uso) */
  cloud: boolean;
}
export interface SceneFocus { building: string; level: number }

/** Comandos que a interface dá ao palco (câmera e prédio aberto). */
export interface SceneApi {
  flyTo(target: string | 'cidade'): void;
  /** câmera até o agente (abre o andar dele), mesmo já selecionado */
  focusAgent(id: string): void;
  /**
   * câmera até o andar do agente, mesmo que ele ainda não esteja carregado: abre o andar e, quando ele chega,
   * centraliza nele (cidade por região)
   */
  focusAgentAt(id: string, building: string, level: number): void;
  open(building: string, level: number): void;
  close(): void;
}

export interface SceneProps {
  structures: StructureIn[];
  /** na ordem do servidor (prédio, andar, vaga): na cidade inteira, a mesma ordem de entrada de sempre (a mesma vida) */
  agents: SceneAgent[];
  /** cidade por região: a lista é só o que está carregado; quem sai dela vai embora quando estiver parado e fora da tela */
  partial: boolean;
  /** contagens do servidor por andar (null antes de chegar) */
  counts: SceneCounts | null;
  selectedId: string | null;
  /** Tema de cores do palco (cosmético). */
  themeId: 'dia' | 'noite';
  /** Editor do mapa: arrastar estruturas para outros lotes. */
  editing: boolean;
  /** Largura (px CSS) coberta à direita pelo painel de conversa: a câmera centraliza no que sobra. */
  rightInset: number;
  /** false = outra área do Ergon na tela: a cena fica oculta, mas a vida dos agentes continua */
  active: boolean;
  /** placas do trabalho da equipe (null = sem leitura: nada desenhado) */
  ops: SceneOps | null;
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
  /** o que está perto da tela mudou (para o carregador da cidade) */
  onWindow(w: SceneWindow): void;
}
