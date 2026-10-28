-- Rotinas: trabalhos prontos que o workspace ativa, ajusta e acompanha. A definição (o que coletar, quem executa,
-- quando, o que entregar) é da rotina; os agentes só executam e podem ser trocados sem perder o fluxo.
CREATE TABLE routines (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  template_key TEXT,                       -- modelo da biblioteca; NULL = criada conversando com a coordenação
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  config TEXT NOT NULL,                    -- JSON cifrado: fontes, condição, agente, instruções, entregas, preferências
  trigger TEXT NOT NULL,                   -- JSON: {"kind":"manual"} | {"kind":"schedule","days":[1,2,3,4,5],"time":"08:00","tz":"…"}
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'archived')),
  version INTEGER NOT NULL DEFAULT 1,
  conversation_id TEXT,                    -- onde a rotina entrega e onde dá para conversar sobre o resultado
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  next_run_at TEXT,
  last_run_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, workspace_id)
);
CREATE INDEX routines_due ON routines(status, next_run_at);
CREATE INDEX routines_ws ON routines(workspace_id, status);

-- Cada mudança de configuração vira uma versão (restaurar = voltar a uma delas)
CREATE TABLE routine_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  routine_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL,
  trigger TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (routine_id, version)
);

-- Execuções: identidade única por horário (uma rotina agendada nunca roda duas vezes no mesmo horário), dados
-- coletados (evidência), resultado e entregáveis.
CREATE TABLE routine_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  routine_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual', 'schedule', 'chat')),
  slot TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('queued', 'gathering', 'running', 'succeeded', 'skipped', 'failed', 'cancelled', 'missed')),
  mode TEXT CHECK (mode IN ('real', 'simulated', 'local')),
  run_id TEXT,
  params TEXT,
  facts TEXT,
  output TEXT,
  summary TEXT,
  deliverables TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  requested_by TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX routine_runs_routine ON routine_runs(workspace_id, routine_id, created_at);
CREATE INDEX routine_runs_status ON routine_runs(status);
CREATE INDEX routine_runs_run ON routine_runs(run_id);

-- Conversas abertas por uma rotina (entrega e acompanhamento) não são a conversa principal com o agente
ALTER TABLE conversations ADD COLUMN purpose TEXT;

-- Propostas passam a incluir rotinas: criar (pela conversa ou por recomendação) e ajustar. Recusadas ficam
-- guardadas (base de recusas): não voltam a ser sugeridas e podem ser reapresentadas sem refazer a análise.
CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('sector', 'create_agent', 'tools', 'permission', 'routine', 'routine_edit')),
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
