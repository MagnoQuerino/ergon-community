-- Propostas: + 'depois_de_ler' (com a proteção ligada em Conexões, abrir sites ou rodar programas depois de ler conteúdo das
-- contas espera o clique da pessoa num cartão). O SQLite não muda um CHECK: a tabela é refeita com as mesmas linhas,
-- colunas e índices.
CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('sector', 'create_agent', 'tools', 'permission', 'routine', 'routine_edit', 'question',
    'edit_agent', 'deactivate_agent', 'reactivate_agent', 'sector_edit', 'sector_new', 'task', 'ledger', 'delete_task', 'info_request', 'handoff',
    'batch', 'purge', 'conexao', 'depois_de_ler')),
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
