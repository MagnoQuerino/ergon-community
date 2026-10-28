-- Ergon MVP local: schema inicial.
-- Todo objeto de cliente pertence a um workspace. As FKs compostas (id, workspace_id) impedem
-- que uma linha aponte para objeto de outro workspace mesmo se a aplicação errar a consulta.

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  demo_data INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user ON sessions(user_id);

-- Construção e capacidade de habitantes ------------------------------------------------------

CREATE TABLE buildings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'stoa',
  created_at TEXT NOT NULL,
  UNIQUE (id, workspace_id)
);

-- origin: 'base' (incluído), 'simulated' (expansão gratuita do piloto), 'entitlement' (futuro direito
-- adquirido validado no servidor; nenhum fluxo de cobrança cria esta origem no MVP).
CREATE TABLE floors (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  building_id TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level >= 0),
  name TEXT NOT NULL,
  slots INTEGER NOT NULL CHECK (slots >= 0 AND slots <= 50),
  origin TEXT NOT NULL CHECK (origin IN ('base', 'simulated', 'entitlement')),
  created_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (building_id, workspace_id) REFERENCES buildings(id, workspace_id)
);
CREATE UNIQUE INDEX floors_level ON floors(building_id, level) WHERE removed_at IS NULL;

CREATE TABLE profiles (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  instructions TEXT NOT NULL,
  examples TEXT NOT NULL DEFAULT '[]',
  creates_tasks TEXT NOT NULL CHECK (creates_tasks IN ('demands', 'explicit_only')),
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, key)
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  floor_id TEXT NOT NULL,
  profile_id TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  color TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'archived')),
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (floor_id, workspace_id) REFERENCES floors(id, workspace_id),
  FOREIGN KEY (profile_id, workspace_id) REFERENCES profiles(id, workspace_id)
);
CREATE INDEX agents_ws_status ON agents(workspace_id, status);

-- Capacidade validada no banco (defesa em profundidade além da transação do serviço).
CREATE TRIGGER agents_capacity_insert BEFORE INSERT ON agents
WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'invalid_floor') WHERE NOT EXISTS (
    SELECT 1 FROM floors WHERE id = NEW.floor_id AND workspace_id = NEW.workspace_id AND removed_at IS NULL);
  SELECT RAISE(ABORT, 'capacity_exceeded') WHERE
    (SELECT COUNT(*) FROM agents WHERE workspace_id = NEW.workspace_id AND status = 'active')
    >= (SELECT COALESCE(SUM(slots), 0) FROM floors WHERE workspace_id = NEW.workspace_id AND removed_at IS NULL);
  SELECT RAISE(ABORT, 'floor_full') WHERE
    (SELECT COUNT(*) FROM agents WHERE floor_id = NEW.floor_id AND status = 'active')
    >= (SELECT slots FROM floors WHERE id = NEW.floor_id);
END;

CREATE TRIGGER agents_capacity_update BEFORE UPDATE OF status, floor_id ON agents
WHEN NEW.status = 'active'
BEGIN
  SELECT RAISE(ABORT, 'invalid_floor') WHERE NOT EXISTS (
    SELECT 1 FROM floors WHERE id = NEW.floor_id AND workspace_id = NEW.workspace_id AND removed_at IS NULL);
  SELECT RAISE(ABORT, 'capacity_exceeded') WHERE
    (SELECT COUNT(*) FROM agents WHERE workspace_id = NEW.workspace_id AND status = 'active' AND id <> NEW.id)
    >= (SELECT COALESCE(SUM(slots), 0) FROM floors WHERE workspace_id = NEW.workspace_id AND removed_at IS NULL);
  SELECT RAISE(ABORT, 'floor_full') WHERE
    (SELECT COUNT(*) FROM agents WHERE floor_id = NEW.floor_id AND status = 'active' AND id <> NEW.id)
    >= (SELECT slots FROM floors WHERE id = NEW.floor_id);
END;

-- Um andar ocupado não pode ser removido nem encolher abaixo dos residentes ativos.
CREATE TRIGGER floors_guard BEFORE UPDATE OF removed_at, slots ON floors
BEGIN
  SELECT RAISE(ABORT, 'floor_occupied') WHERE NEW.removed_at IS NOT NULL AND
    EXISTS (SELECT 1 FROM agents WHERE floor_id = NEW.id AND status = 'active');
  SELECT RAISE(ABORT, 'floor_occupied') WHERE NEW.removed_at IS NULL AND
    (SELECT COUNT(*) FROM agents WHERE floor_id = NEW.id AND status = 'active') > NEW.slots;
END;

-- Conversas ----------------------------------------------------------------------------------

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  hermes_session_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id)
);
CREATE INDEX conversations_owner ON conversations(workspace_id, owner_user_id, agent_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'agent', 'system')),
  author_user_id TEXT REFERENCES users(id),
  content TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('real', 'simulated', 'local')),
  run_id TEXT,
  client_request_id TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (conversation_id, workspace_id) REFERENCES conversations(id, workspace_id)
);
CREATE INDEX messages_conv ON messages(conversation_id, created_at);
CREATE UNIQUE INDEX messages_client_req ON messages(conversation_id, client_request_id) WHERE client_request_id IS NOT NULL;

-- Conexões e eventos de origem -----------------------------------------------------------------

CREATE TABLE connections (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('teams', 'whatsapp', 'hermes', 'mirror_fixture', 'chat')),
  label TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('fixture', 'real', 'local')),
  profile_key TEXT NOT NULL DEFAULT 'central',
  last_real_event_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, kind, mode)
);

-- Identidade externa nunca é vinculada por nome de exibição: somente pelo ID estável do provedor.
CREATE TABLE external_identities (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,
  user_id TEXT REFERENCES users(id),
  display_name TEXT,
  can_command INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  UNIQUE (connection_id, external_user_id),
  FOREIGN KEY (connection_id, workspace_id) REFERENCES connections(id, workspace_id)
);

CREATE TABLE source_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  version TEXT NOT NULL DEFAULT '1',
  actor_external_id TEXT,
  actor_display TEXT,
  channel TEXT,
  thread_id TEXT,
  provider_ts TEXT,
  received_at TEXT NOT NULL,
  is_fixture INTEGER NOT NULL DEFAULT 0,
  text_excerpt TEXT,
  interpretation TEXT,
  status TEXT NOT NULL,
  decision TEXT,
  task_id TEXT,
  UNIQUE (id, workspace_id),
  UNIQUE (connection_id, external_id, event_type, version),
  FOREIGN KEY (connection_id, workspace_id) REFERENCES connections(id, workspace_id)
);
CREATE INDEX source_events_ws ON source_events(workspace_id, received_at);

CREATE TABLE subjects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  title TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, workspace_id)
);

-- Kanban ---------------------------------------------------------------------------------------

CREATE TABLE boards (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  name TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('native', 'mirror')),
  connection_id TEXT,
  external_id TEXT,
  external_version TEXT,
  sync_state TEXT,
  last_synced_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, workspace_id),
  UNIQUE (connection_id, external_id)
);

CREATE TABLE columns (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  external_id TEXT,
  UNIQUE (id, workspace_id),
  UNIQUE (board_id, external_id),
  FOREIGN KEY (board_id, workspace_id) REFERENCES boards(id, workspace_id)
);

-- completed é separado da coluna: conclusão não é inferida pela coluna.
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  number INTEGER NOT NULL,
  workspace_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  column_id TEXT NOT NULL,
  subject_id TEXT,
  agent_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  completed INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT,
  completed_by TEXT CHECK (completed_by IN ('human', 'external', 'agent')),
  completed_by_user_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('manual', 'chat', 'teams', 'whatsapp', 'mirror', 'demo')),
  source_event_id TEXT,
  is_fixture INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, number),
  FOREIGN KEY (board_id, workspace_id) REFERENCES boards(id, workspace_id),
  FOREIGN KEY (column_id, workspace_id) REFERENCES columns(id, workspace_id),
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id),
  FOREIGN KEY (subject_id, workspace_id) REFERENCES subjects(id, workspace_id)
);
CREATE INDEX tasks_board ON tasks(workspace_id, board_id, archived);

CREATE TABLE task_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  external_id TEXT NOT NULL,
  external_version TEXT,
  external_extra TEXT NOT NULL DEFAULT '{}',
  sync_state TEXT NOT NULL DEFAULT 'ok',
  conflict TEXT,
  last_seen_at TEXT,
  UNIQUE (connection_id, external_id),
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id)
);

-- Similaridade gera proposta; fusão/vínculo só com confirmação humana, e pode ser revertido.
CREATE TABLE link_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  related_task_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  score REAL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'confirmed', 'rejected')),
  created_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id),
  FOREIGN KEY (related_task_id, workspace_id) REFERENCES tasks(id, workspace_id)
);

-- Execuções, fila e saída -----------------------------------------------------------------------

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  conversation_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('chat', 'subtask')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_user', 'succeeded', 'failed', 'cancelled')),
  mode TEXT NOT NULL CHECK (mode IN ('real', 'simulated')),
  input TEXT NOT NULL,
  instructions TEXT,
  output TEXT,
  error TEXT,
  hermes_run_id TEXT,
  hermes_status TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 2,
  lease_owner TEXT,
  lease_expires_at TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  cost_usd REAL,
  cost_is_estimate INTEGER,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id),
  FOREIGN KEY (conversation_id, workspace_id) REFERENCES conversations(id, workspace_id)
);
CREATE INDEX runs_status ON runs(status, created_at);

-- Fila persistente genérica (tarefas internas não-LLM, ex.: reprocessamento).
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  dedupe_key TEXT UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  lease_owner TEXT,
  lease_expires_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Outbox: toda resposta para canal externo passa aqui, com chave idempotente. Envio real
-- desligado por padrão; fixtures nunca são enviadas.
CREATE TABLE outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  source_event_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('simulated', 'blocked_send_disabled', 'returned_to_gateway', 'sent', 'failed', 'unknown')),
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (connection_id, workspace_id) REFERENCES connections(id, workspace_id)
);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  owner_user_id TEXT NOT NULL REFERENCES users(id),
  task_id TEXT,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id)
);

-- Registro de ações: ação, evidência autorizada e resultado. Nunca raciocínio interno de modelo.
CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'connector')),
  actor_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  evidence TEXT,
  result TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX audit_target ON audit_events(workspace_id, target_type, target_id, created_at);
CREATE INDEX audit_ws ON audit_events(workspace_id, created_at);

CREATE TABLE rules (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  text TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('proposed', 'active', 'rejected')),
  origin_message_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
