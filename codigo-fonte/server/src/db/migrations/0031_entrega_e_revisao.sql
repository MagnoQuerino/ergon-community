-- Entrega e revisão, lote de cards, conversa no estilo dos aplicativos de mensagem e arquivos geridos pela conversa.

-- propostas: + 'batch' (lote grande de cards: você confirma antes de abrir) e 'purge' (apagar de vez: você confirma)
CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('sector', 'create_agent', 'tools', 'permission', 'routine', 'routine_edit', 'question',
    'edit_agent', 'deactivate_agent', 'reactivate_agent', 'sector_edit', 'sector_new', 'task', 'ledger', 'delete_task', 'info_request', 'handoff',
    'batch', 'purge')),
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

-- card que só começa depois de outros (lote com ordem: "depois do #12")
CREATE TABLE task_deps (
  task_id TEXT NOT NULL,
  after_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (task_id, after_id)
);

-- revisão do cliente na entrega: 'nao' (entregar conclui), 'leve' (aprovação sua), 'forte' (você pediu revisão: a
-- equipe revisa a fundo antes e você aprova); rodada de ajustes; quando foi entregue a você
ALTER TABLE tasks ADD COLUMN review TEXT;
ALTER TABLE tasks ADD COLUMN review_round INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN delivered_at TEXT;

-- conversa: assunto arquivado (sai da lista, a busca acha), resposta citando outra mensagem, mensagens marcadas
ALTER TABLE conversations ADD COLUMN archived_at TEXT;
-- assunto novo a partir de uma mensagem (bifurcar): a mensagem de origem vai junto como contexto
ALTER TABLE conversations ADD COLUMN forked_from TEXT;
ALTER TABLE messages ADD COLUMN reply_to TEXT;
CREATE TABLE message_marks (
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id)
);
