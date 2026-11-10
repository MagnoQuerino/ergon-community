// Os termos fixos da tradução (a explicação de cada um está em GLOSSARIO.md). `conferir`: o teste de completude
// confere que todo texto em português com o termo (maiúsculas e minúsculas como estão aqui) tem, no inglês, o termo de
// lá. Os outros servem de guia para quem traduz.

export interface Termo { readonly pt: string; readonly en: string; readonly conferir?: boolean }

export const GLOSSARIO: readonly Termo[] = [
  // a moeda do World não se traduz (decisão de 09/11): o mesmo símbolo nas duas línguas. O nome dela fica na lista do
  // módulo do World (views/world/glossario-moeda.ts), que só existe na distribuição proprietária
  { pt: '₯', en: '₯', conferir: true },

  // as áreas do menu
  { pt: 'Cidade', en: 'City' },
  { pt: 'Equipe', en: 'Team' },
  { pt: 'Rotinas', en: 'Routines', conferir: true },
  { pt: 'Fluxos da equipe', en: 'Team flows', conferir: true },
  { pt: 'Tarefas', en: 'Tasks' },
  { pt: 'Documentos', en: 'Documents' },
  { pt: 'Atividade', en: 'Activity' },
  { pt: 'Conexões', en: 'Connections', conferir: true },
  { pt: 'Configurações', en: 'Settings', conferir: true },
  { pt: 'Ajuda', en: 'Help' },
  { pt: 'Treinar', en: 'Train', conferir: true },
  { pt: 'Saúde', en: 'Health', conferir: true },
  { pt: 'Atualizações', en: 'Updates' },
  { pt: 'Segurança', en: 'Security' },
  { pt: 'Minha conta', en: 'My account', conferir: true },
  { pt: 'Pessoas', en: 'People' },
  { pt: 'Pacotes', en: 'Packages' },
  { pt: 'Loja', en: 'Store' },
  { pt: 'Workspace', en: 'Workspace' },

  // a barra de cima e os modos
  { pt: 'Modo Foco', en: 'Focus Mode', conferir: true },
  { pt: 'Pedir a', en: 'Ask' },
  { pt: 'Aguardando você', en: 'Waiting for you', conferir: true },
  { pt: 'Estado do Ergon', en: 'Ergon status', conferir: true },
  { pt: 'Música ambiente', en: 'Ambient music', conferir: true },
  { pt: 'Cidade viva', en: 'Living city', conferir: true },
  { pt: 'Modo calmo', en: 'Calm mode', conferir: true },
  { pt: 'Central de Trabalho', en: 'Work Center', conferir: true },

  // os quadros e a entrega
  { pt: 'A fazer', en: 'To do', conferir: true },
  { pt: 'Em andamento', en: 'In progress' },
  { pt: 'Com você', en: 'With you', conferir: true },
  { pt: 'Concluído', en: 'Done' },
  { pt: 'Para você decidir', en: 'For you to decide', conferir: true },
  { pt: 'Feito', en: 'Done' },
  { pt: 'card', en: 'card' },
  { pt: 'quadro', en: 'board' },

  // os lugares da cidade
  { pt: 'Ágora', en: 'Agora', conferir: true },
  { pt: 'Stoa do Ergon', en: 'Stoa of Ergon', conferir: true },
  { pt: 'Termas', en: 'Baths', conferir: true },
  { pt: 'Ginásio', en: 'Gymnasium', conferir: true },
  { pt: 'Teatro', en: 'Theater' },
  { pt: 'Bairro', en: 'District' },
  { pt: 'construção', en: 'building' },
  { pt: 'posto', en: 'post' },

  // a equipe
  { pt: 'agente', en: 'agent' },
  { pt: 'Coordenador', en: 'Coordinator' },
  { pt: 'setor', en: 'sector' },
  { pt: 'conta de IA', en: 'AI account' },
  { pt: 'assinatura Nous', en: 'Nous subscription' },
  { pt: 'Briefing Diário', en: 'Daily Briefing' },
  { pt: 'Tentar de novo', en: 'Try again' },

  // as faixas e o preço dos modelos (o seletor da Equipe e o texto de Conexões aparecem juntos: o mesmo nome e o mesmo
  // formato, 'US$0.50 / US$3.00 per million units of text')
  { pt: 'modelo econômico', en: 'budget model' },
  { pt: 'modelo intermediário', en: 'mid-range model' },
  { pt: 'modelo de ponta', en: 'premium model' },
  { pt: 'por milhão de tokens', en: 'per million units of text' },
  // o estado de uma ferramenta travada (o perfil na Equipe e a janela do agente)
  { pt: 'bloqueada', en: 'locked' },
];
