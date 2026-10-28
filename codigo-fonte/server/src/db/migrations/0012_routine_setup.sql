-- Ativação adaptativa: ao ativar, a rotina fica "em preparo" enquanto a coordenação estuda o jeito de trabalhar do
-- usuário e ajusta a rotina ao caso dele (com perguntas, se precisar). Pronta, ela ativa e já roda a primeira vez.
CREATE TABLE routines_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  template_key TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  config TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('setup', 'active', 'paused', 'archived')),
  version INTEGER NOT NULL DEFAULT 1,
  conversation_id TEXT,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, workspace_id)
);
INSERT INTO routines_new SELECT id, workspace_id, template_key, name, category, config, trigger, status, version, conversation_id, owner_user_id, next_run_at, last_run_at, created_at, updated_at FROM routines;
DROP TABLE routines;
ALTER TABLE routines_new RENAME TO routines;
CREATE INDEX routines_due ON routines(status, next_run_at);
CREATE INDEX routines_ws ON routines(workspace_id, status);

-- O preparo de cada rotina: a conversa com a coordenação, o estudo (dados lidos), o que foi ajustado e a primeira execução.
CREATE TABLE routine_setups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  routine_id TEXT NOT NULL UNIQUE,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('studying', 'asking', 'adapting', 'ready', 'failed')),
  run_id TEXT,
  hint TEXT,
  profile TEXT,
  adapted TEXT,
  first_run_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX routine_setups_conv ON routine_setups(conversation_id);

-- Perguntas com opções que um agente faz na conversa (a resposta volta como mensagem do usuário)
CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('sector', 'create_agent', 'tools', 'permission', 'routine', 'routine_edit', 'question')),
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'rejected', 'failed')),
  result TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (id, workspace_id)
);
INSERT INTO agent_proposals_new (id, workspace_id, conversation_id, run_id, kind, payload, summary, status, result, created_at, decided_at)
  SELECT id, workspace_id, conversation_id, run_id, kind, payload, summary, status, result, created_at, decided_at FROM agent_proposals;
DROP TABLE agent_proposals;
ALTER TABLE agent_proposals_new RENAME TO agent_proposals;
CREATE INDEX agent_proposals_conv ON agent_proposals(workspace_id, conversation_id, created_at);
CREATE INDEX agent_proposals_status ON agent_proposals(workspace_id, status, kind);
