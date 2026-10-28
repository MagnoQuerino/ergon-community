-- O fio do pedido: o card nascido de uma conversa guarda a conversa, o pedido do usuário
-- (cifrado) e quem entrega; o plano do coordenador vira etapas em ordem; o agente da conversa repassa ali as perguntas
-- e aprovações do card; o coordenador pode propor apagar um card; a conversa tem fila de mensagens.

ALTER TABLE tasks ADD COLUMN conversation_id TEXT;
-- o pedido do usuário, como ele escreveu (cifrado)
ALTER TABLE tasks ADD COLUMN purpose TEXT;
-- quem recebeu o pedido e entrega na conversa (de preferência, o agente com quem o usuário falou)
ALTER TABLE tasks ADD COLUMN deliver_agent_id TEXT;
-- a execução da conversa que criou o card (os pedidos de ajuda de uma mesma resposta voltam juntos)
ALTER TABLE tasks ADD COLUMN origin_run_id TEXT;
CREATE INDEX tasks_conversation ON tasks(workspace_id, conversation_id);
CREATE INDEX tasks_origin_run ON tasks(origin_run_id);

CREATE TABLE task_steps (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL REFERENCES tasks(id),
  position INTEGER NOT NULL,
  agent_id TEXT NOT NULL,
  -- o que a etapa faz (cifrado)
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'em_andamento', 'feita', 'falhou')),
  -- o que a etapa entregou (cifrado)
  output TEXT,
  run_id TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT,
  UNIQUE (task_id, position)
);
CREATE INDEX task_steps_task ON task_steps(task_id, position);

-- mensagem na fila da conversa (Ctrl+Enter): vai para o agente quando a resposta em andamento terminar
ALTER TABLE messages ADD COLUMN queued INTEGER NOT NULL DEFAULT 0;

CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('sector', 'create_agent', 'tools', 'permission', 'routine', 'routine_edit', 'question',
    'edit_agent', 'deactivate_agent', 'reactivate_agent', 'sector_edit', 'sector_new', 'task', 'ledger', 'delete_task', 'info_request')),
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
