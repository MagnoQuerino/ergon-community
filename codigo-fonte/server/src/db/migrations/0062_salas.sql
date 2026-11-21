-- rc.42: Salas — conversa em grupo (pessoas do workspace e agentes como colegas), como um canal do Discord.
-- A sala é uma conversa (conversations.sala = 1): anexos, áudio, voz, cards e o navegador ao vivo valem nela como na
-- conversa de uma pessoa. owner_user_id = a pessoa deste aparelho que guarda a sala aqui; agent_id = o agente de
-- referência (o primeiro posto na sala); quem fala com quem fica nas tabelas abaixo. Quem vê a sala: só quem está em
-- salas_membros (o servidor confere em toda rota; as listas de conversas da pessoa deixam as salas de fora).
ALTER TABLE conversations ADD COLUMN sala INTEGER NOT NULL DEFAULT 0;
-- quando a sala mudou de nome, membros ou arquivo (a sincronia entre colaboradores fica com a versão mais nova)
ALTER TABLE conversations ADD COLUMN sala_at TEXT;
CREATE INDEX conversations_salas ON conversations(workspace_id, sala) WHERE sala = 1;

-- Autoria nas salas: quem escreveu (chave estável entre aparelhos: "acc:<conta do World>" ou "usr:<pessoa daqui>") e o
-- nome dela na hora; as marcas que a tela formou (menções @ e cessões #, JSON cifrado: [{tipo, chave, inicio, fim}]);
-- quem pediu a resposta do agente (pedinte) e de qual aparelho a sala recebeu a mensagem.
ALTER TABLE messages ADD COLUMN autor_chave TEXT;
ALTER TABLE messages ADD COLUMN autor_nome TEXT;
ALTER TABLE messages ADD COLUMN marcas TEXT;
ALTER TABLE messages ADD COLUMN pedinte_chave TEXT;

-- Membros: pessoas (chave acc:/usr:) e agentes (chave = o nome, o mesmo em todos os aparelhos da equipe). removed_at:
-- saiu ou foi tirado (o histórico fica; não recebe mais nada). admin: renomeia, arquiva, põe e tira.
CREATE TABLE salas_membros (
  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('pessoa', 'agente')),
  chave TEXT NOT NULL,
  nome TEXT NOT NULL,
  admin INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL,
  removed_at TEXT,
  PRIMARY KEY (conversation_id, tipo, chave),
  FOREIGN KEY (conversation_id, workspace_id) REFERENCES conversations(id, workspace_id)
);
CREATE INDEX salas_membros_chave ON salas_membros(workspace_id, tipo, chave);

-- Onde cada pessoa parou de ler (a pessoa deste aparelho; nunca viaja)
CREATE TABLE salas_leitura (conversation_id TEXT NOT NULL, chave TEXT NOT NULL, read_at TEXT NOT NULL, PRIMARY KEY (conversation_id, chave));

-- Avisos para a pessoa deste aparelho: menção (@) e pedido de cessão (#). visto_at: abriu a sala / decidiu.
CREATE TABLE salas_avisos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  para_chave TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('mencao', 'cessao')),
  de_chave TEXT NOT NULL,
  de_nome TEXT NOT NULL,
  agente TEXT,
  status TEXT NOT NULL DEFAULT 'aberto' CHECK (status IN ('aberto', 'visto', 'cedido', 'recusado')),
  created_at TEXT NOT NULL,
  visto_at TEXT,
  UNIQUE (message_id, para_chave, tipo)
);
CREATE INDEX salas_avisos_para ON salas_avisos(workspace_id, para_chave, status);

-- Cessões: a pessoa dona das conexões deste aparelho cede o uso delas a pedidos de alguém NAQUELA sala. prazo: 'vez' (só
-- aquele pedido: message_id), '24h', '7d', '30d' ou 'sempre' (expira_em nulo). Nunca viaja (as credenciais não saem daqui).
CREATE TABLE salas_cessoes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  dono_chave TEXT NOT NULL,
  pedinte_chave TEXT NOT NULL,
  prazo TEXT NOT NULL CHECK (prazo IN ('vez', '24h', '7d', '30d', 'sempre')),
  message_id TEXT,
  expira_em TEXT,
  created_at TEXT NOT NULL,
  revogada_em TEXT
);
CREATE INDEX salas_cessoes_sala ON salas_cessoes(workspace_id, conversation_id, revogada_em);

-- A fila de respostas de agentes numa sala: um por vez, na ordem das menções (e uma chamada de agente para agente por
-- mensagem humana: profundidade 1). origem_id: a mensagem humana que começou tudo. cedida: roda neste aparelho com as
-- conexões de quem cedeu (o complemento do pedido de outra pessoa).
CREATE TABLE salas_fila (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  origem_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  pedinte_chave TEXT NOT NULL,
  pedinte_nome TEXT NOT NULL,
  pedido TEXT NOT NULL,
  profundidade INTEGER NOT NULL DEFAULT 0,
  cedida INTEGER NOT NULL DEFAULT 0,
  -- conversa por voz (o canal de voz da sala): a resposta vai ser falada (curta, sem formatação)
  voz INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'esperando' CHECK (status IN ('esperando', 'rodando', 'feito')),
  run_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX salas_fila_conv ON salas_fila(conversation_id, status, created_at);
CREATE INDEX salas_fila_run ON salas_fila(run_id);

-- Sincronia entre colaboradores (world/sync-salas.ts): a chave pública de cada aparelho (anunciada por ele no log do
-- World, com a conta que o World registrou) e o que já foi selado para cada aparelho (nada vai duas vezes).
CREATE TABLE salas_aparelhos (workspace_id TEXT NOT NULL, device_id TEXT NOT NULL, account_id TEXT NOT NULL, x25519_public TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, device_id));
CREATE TABLE salas_enviados (workspace_id TEXT NOT NULL, device_id TEXT NOT NULL, kind TEXT NOT NULL, record_id TEXT NOT NULL, hash TEXT NOT NULL,
  PRIMARY KEY (workspace_id, device_id, kind, record_id));

-- Anexos das salas entre aparelhos (world/sync-salas.ts): a mensagem chega com a ficha do arquivo (nome, tipo, tamanho,
-- resumo); o arquivo só vem quando alguém pede para baixar, em partes seladas para o aparelho que pediu, do aparelho
-- onde ele nasceu. Acima do teto, fica só a ficha.
CREATE TABLE salas_anexos (
  workspace_id TEXT NOT NULL, message_id TEXT NOT NULL, ref TEXT NOT NULL, conversation_id TEXT NOT NULL, de_device TEXT NOT NULL,
  filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL,
  artifact_id TEXT, pedido_em TEXT, pedido_enviado_em TEXT,
  PRIMARY KEY (workspace_id, message_id, ref)
);
CREATE INDEX salas_anexos_ref ON salas_anexos(workspace_id, ref);
CREATE TABLE salas_anexo_partes (workspace_id TEXT NOT NULL, ref TEXT NOT NULL, parte INTEGER NOT NULL, dados TEXT NOT NULL, PRIMARY KEY (workspace_id, ref, parte));
CREATE TABLE salas_anexo_envios (workspace_id TEXT NOT NULL, ref TEXT NOT NULL, device_id TEXT NOT NULL, proxima INTEGER NOT NULL, total INTEGER NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, ref, device_id));

-- Tópicos (como no Discord): uma conversa paralela dentro de uma sala, a partir de uma mensagem ou do zero. É uma sala
-- também (menções, cessão, agentes, anexos, voz valem igual), com a sala-mãe (sala_pai) e a mensagem de origem.
-- Visibilidade: 'compartilhado' (qualquer membro da sala vê e entra: os membros são os da sala) ou 'privado' (só quem foi
-- convidado, em salas_membros, e que continua na sala). Arquivado continua consultável e pode ser reaberto.
ALTER TABLE conversations ADD COLUMN sala_pai TEXT;
ALTER TABLE conversations ADD COLUMN topico_visivel TEXT CHECK (topico_visivel IN ('privado', 'compartilhado'));
ALTER TABLE conversations ADD COLUMN topico_origem TEXT;
CREATE INDEX conversations_topicos ON conversations(sala_pai) WHERE sala_pai IS NOT NULL;
