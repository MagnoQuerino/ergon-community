-- rc.42 (entregáveis): o .md entregue aparece formatado, com a identidade do workspace e um modelo de documento, e pode
-- ser revisado com o coordenador, com versões. Serviço: services/entregaveis.ts e services/revisao-documento.ts.

-- A identidade aplicada às entregas: nome, cores e o logo (PNG ou JPEG já conferido; SVG chega rasterizado pela tela).
CREATE TABLE doc_identidade (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  nome TEXT NOT NULL DEFAULT '',
  cor_primaria TEXT NOT NULL DEFAULT '#1d184b',
  cor_destaque TEXT NOT NULL DEFAULT '#b88b5b',
  mostrar_ergon INTEGER NOT NULL DEFAULT 1,
  logo BLOB,
  logo_mime TEXT,
  logo_w INTEGER,
  logo_h INTEGER,
  logo_sha TEXT,
  updated_at TEXT NOT NULL
);

-- Modelos de documento criados pela pessoa (os originais "ergon" e "abnt" ficam no código: shared/entregaveis.ts).
-- config: o JSON normalizado (normalizarModelo); padrao = o modelo das entregas sem modelo escolhido.
CREATE TABLE doc_modelos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  nome TEXT NOT NULL,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX doc_modelos_ws ON doc_modelos (workspace_id);

-- O modelo escolhido para um documento (nulo: o padrão do workspace).
ALTER TABLE artifacts ADD COLUMN modelo_id TEXT;

-- Versões de um documento: cada edição grava o conteúdo inteiro (cifrado, como o arquivo) e a versão de agora fica em
-- artifacts.storage_key. Voltar a uma versão cria uma nova, que aponta para o mesmo conteúdo (nada se perde).
CREATE TABLE artifact_versoes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  artifact_id TEXT NOT NULL,
  n INTEGER NOT NULL,
  storage_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  autor_tipo TEXT NOT NULL CHECK (autor_tipo IN ('user', 'agent', 'system')),
  autor_id TEXT NOT NULL,
  revisao_id TEXT,
  nota TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (artifact_id, n)
);
CREATE INDEX artifact_versoes_art ON artifact_versoes (workspace_id, artifact_id, n);

-- Pedidos de revisão feitos no balão "Revisar com o coordenador". Em fila por documento, um de cada vez, cada um sobre a
-- versão mais nova (base_n); o coordenador delega como card (task_id) ao agente escolhido (agent_id).
-- estado: fila → editando → feito | falhou | cancelado
CREATE TABLE doc_revisoes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  artifact_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  pedido TEXT NOT NULL,
  trecho TEXT,
  estado TEXT NOT NULL DEFAULT 'fila' CHECK (estado IN ('fila', 'editando', 'feito', 'falhou', 'cancelado')),
  task_id TEXT,
  run_id TEXT,
  agent_id TEXT,
  base_n INTEGER,
  versao_n INTEGER,
  -- os trechos do documento durante a edição (JSON, cifrado): cada frente troca só os dela
  trechos TEXT,
  erro TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX doc_revisoes_art ON doc_revisoes (workspace_id, artifact_id, created_at);
CREATE INDEX doc_revisoes_task ON doc_revisoes (task_id) WHERE task_id IS NOT NULL;

-- As frentes de um pedido: quem edita quais trechos (reserva). O revisor ("conferir") anda de cima para baixo e só pega
-- trechos já liberados (conferido_ate = o próximo trecho a conferir). Cada passada vira um card do quadro da equipe.
-- estado: espera → trabalhando → feito | falhou
CREATE TABLE doc_revisao_frentes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  revisao_id TEXT NOT NULL REFERENCES doc_revisoes(id),
  agent_id TEXT NOT NULL,
  acao TEXT NOT NULL CHECK (acao IN ('revisar', 'reescrever', 'conferir')),
  especialidade TEXT NOT NULL,
  blocos TEXT NOT NULL,
  ordem INTEGER NOT NULL,
  estado TEXT NOT NULL DEFAULT 'espera' CHECK (estado IN ('espera', 'trabalhando', 'feito', 'falhou')),
  passada TEXT,
  conferido_ate INTEGER NOT NULL DEFAULT 0,
  task_id TEXT,
  run_id TEXT,
  erro TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX doc_revisao_frentes_rev ON doc_revisao_frentes (revisao_id, ordem);
CREATE INDEX doc_revisao_frentes_task ON doc_revisao_frentes (task_id) WHERE task_id IS NOT NULL;
