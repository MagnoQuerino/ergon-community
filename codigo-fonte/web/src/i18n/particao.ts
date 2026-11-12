// A partição da tela em áreas, para várias equipes traduzirem ao mesmo tempo sem pisar umas nas outras: cada arquivo de
// tela pertence a UMA área, e a equipe da área só mexe nos arquivos dela, em pt/<area>.ts, en/<area>.ts e na lista
// dela em pendentes.ts. Os caminhos são a partir de web/src. Arquivos de views/world só existem na distribuição
// proprietária (a Community não os traz): os testes pulam o que não existir.
import type { NomeDaArea } from './pt/index.ts';

export const PARTICAO: { readonly [A in NomeDaArea]: readonly string[] } = {
  // a barra de cima, o menu, o avatar, a música, o workspace, o tema e as peças comuns
  geral: [
    'App.tsx', 'components/CommandPalette.tsx', 'components/MusicButton.tsx', 'components/AccountMenu.tsx', 'components/Workspaces.tsx',
    'components/SeletorIdioma.tsx', 'components/ConfirmPopup.tsx', 'components/VirtualGrid.tsx', 'components/TextoLongo.tsx', 'components/Markdown.tsx',
    'components/FileViewer.tsx', 'lib/theme.ts', 'lib/music.ts', 'lib/api.ts', 'lib/files.ts', 'lib/surface.ts', 'brand/Brand.tsx', 'brand/logo.ts',
  ],
  // a Cidade, o Modo Foco, a Central de Trabalho e os rótulos desenhados na cidade
  cidade: [
    'views/AmbienteView.tsx', 'views/FocoView.tsx', 'components/CentralTrabalho.tsx', 'components/CityBar.tsx', 'components/StructureCard.tsx',
    'iso/engine.ts', 'iso/IsoScene.tsx', 'iso/architecture.ts', 'iso/cityThumb.ts', 'iso/theme.ts', 'lib/barra.ts', 'lib/ambient.ts',
    'world/areas.ts', 'world/buildings.ts', 'world/pack.ts',
  ],
  // os quadros (Tarefas e Fluxos da equipe), as colunas e mover cards
  quadro: ['components/Board.tsx', 'views/TarefasView.tsx', 'views/EquipeView.tsx', 'components/MoveTray.tsx', 'lib/dragMove.ts', 'lib/work.ts'],
  // o card aberto
  tarefa: ['components/TaskDetail.tsx', 'components/TaskWork.tsx', 'lib/tarefa-tela.ts'],
  // as conversas
  conversas: ['components/ChatPanel.tsx', 'components/ChatCards.tsx', 'components/Comandos.tsx', 'components/ConversationDock.tsx', 'lib/conversations.ts'],
  // a Equipe e criar agentes
  equipe: [
    'views/AgentesView.tsx', 'components/AgentProfile.tsx', 'components/NewAgentDialog.tsx', 'components/NewGroupDialog.tsx',
    'components/DistributionDialog.tsx', 'components/PersonalityPicker.tsx', 'components/EffectPicker.tsx', 'lib/team.ts',
  ],
  // a janela do agente e Treinar
  agente: ['components/AgentWindow.tsx', 'components/TrainTab.tsx', 'components/CompetenciasProntas.tsx'],
  rotinas: ['views/RotinasView.tsx'],
  conexoes: ['views/ConexoesView.tsx', 'components/ConectoresProntos.tsx', 'components/CartaoRegra.tsx', 'components/ModeloPadrao.tsx', 'components/ModelosPorTarefa.tsx', 'lib/modelos-tarefa.ts', 'lib/teams-app.ts'],
  // Documentos, Pacotes, a loja da Cidade e o World
  documentos: [
    'views/DocumentosView.tsx', 'views/PacotesPanel.tsx', 'iso/StoreDialog.tsx', 'views/world/WorldPanel.tsx', 'views/world/WorldLinkDialog.tsx',
    'views/world/AlaNuvem.tsx',
  ],
  // Configurações, contas de IA, custo, Atualizações e Saúde
  configuracoes: [
    'views/ConfiguracaoView.tsx', 'components/AiAccounts.tsx', 'components/CapacidadesPanel.tsx', 'lib/recursos.ts', 'lib/custo.ts', 'views/AtualizacoesPanel.tsx', 'lib/atualizacoes.ts', 'views/SaudePanel.tsx',
    'components/AjustesEquipe.tsx', 'lib/ajustes.ts',
  ],
  // Entrar, Segurança, Minha conta e Pessoas
  conta: ['components/AuthFlow.tsx', 'views/SegurancaPanel.tsx', 'views/ContaPanel.tsx', 'views/PessoasPanel.tsx', 'components/BaixarMeusDados.tsx', 'lib/passkey.ts'],
  // a Ajuda, as dicas, o tour e as boas-vindas
  ajuda: ['views/AjudaView.tsx', 'components/Tips.tsx', 'components/Tour.tsx', 'components/Onboarding.tsx'],
  // "Aguardando você", a Atividade e o que vem do servidor (lib/textos-tela.ts: ver COMO-TRADUZIR.md)
  servidor: ['components/DecisionsPanel.tsx', 'views/OtherViews.tsx', 'lib/atividade.ts', 'lib/textos-tela.ts', 'lib/types.ts'],
};

/** Fora da varredura do teste-catraca: não é texto de tela escrito à mão. */
export const FORA_DA_VARREDURA: readonly string[] = [
  'components/simple-icons.ts', // gerado do Simple Icons: só os nomes das marcas, que não se traduzem
  'views/world/glossario-moeda.ts', // a lista do glossário (a moeda escrita nas duas línguas), não texto de tela
  'views/world/textos.ts', // o dicionário do World nas duas línguas (fica no módulo do World: a Community não o traz)
];
