-- Agente = subagente: cada agente do Ergon roda no Hermes com o seu modelo (vazio = modelo padrão da conta),
-- as suas instruções (charter), métodos, ferramentas (catálogo do Ergon) e skills da biblioteca.
ALTER TABLE agents ADD COLUMN model TEXT;
ALTER TABLE agents ADD COLUMN provider TEXT;
ALTER TABLE agents ADD COLUMN hermes_skills TEXT;
-- motivo/resumo da desativação (redistribuição das tarefas pela coordenação)
ALTER TABLE agents ADD COLUMN deactivation_note TEXT;

-- Setores (microequipes): a tabela `profiles` passa a guardar os setores. Além da política de tarefas
-- (creates_tasks), cada setor tem descrição e as ferramentas e métodos RECOMENDADOS (sugestão, não limite).
ALTER TABLE profiles ADD COLUMN description TEXT;
ALTER TABLE profiles ADD COLUMN tools TEXT;
ALTER TABLE profiles ADD COLUMN skills TEXT;
ALTER TABLE profiles ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
ALTER TABLE profiles ADD COLUMN custom INTEGER NOT NULL DEFAULT 0;

-- Execuções: sessão e modelo que o Hermes informou (a sessão liga cada chamada de ferramenta ao agente).
ALTER TABLE runs ADD COLUMN hermes_session_id TEXT;
ALTER TABLE runs ADD COLUMN model TEXT;
CREATE INDEX runs_hermes_session ON runs(hermes_session_id) WHERE hermes_session_id IS NOT NULL;

-- Quadros: o da EQUIPE (os agentes dão andamento; você só acompanha) e os SEUS (lista local ou espelho de um
-- aplicativo de tarefas conectado).
ALTER TABLE boards ADD COLUMN audience TEXT NOT NULL DEFAULT 'team' CHECK (audience IN ('team', 'user'));
-- tarefa da equipe criada a partir de uma tarefa sua ("Enviar à equipe")
ALTER TABLE tasks ADD COLUMN parent_task_id TEXT;
-- responsável no aplicativo externo (nome, só leitura) para tarefas espelhadas
ALTER TABLE tasks ADD COLUMN external_assignee TEXT;

-- Integrações da conta (Microsoft, WhatsApp, Asana, Todoist). Tokens e sessões NUNCA ficam aqui:
-- vão para arquivos do volume de dados (/data/secrets), legíveis só pelo servidor.
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('microsoft', 'whatsapp', 'asana', 'todoist')),
  state TEXT NOT NULL DEFAULT 'off' CHECK (state IN ('off', 'pending', 'connected', 'error')),
  account_label TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  connected_at TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, kind)
);

-- Configurações do workspace (chave/valor): andamento automático da equipe etc.
CREATE TABLE workspace_settings (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, key)
);

-- Propostas da coordenação (mudar setor, criar agente): o coordenador propõe, você aplica ou recusa.
CREATE TABLE agent_proposals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('sector', 'create_agent', 'tools')),
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'rejected', 'failed')),
  result TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (id, workspace_id)
);
CREATE INDEX agent_proposals_conv ON agent_proposals(workspace_id, conversation_id, created_at);
