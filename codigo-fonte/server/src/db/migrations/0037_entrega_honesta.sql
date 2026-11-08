-- Entrega honesta: o que a pessoa recusou no cartão de confirmação, quando era o trabalho do card, fica "descartado"
-- (nem falha nem entrega; o card sai do quadro e o histórico fica). O SQLite não muda um CHECK: a tabela é refeita
-- com as mesmas linhas, colunas e índice.
CREATE TABLE task_results_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('informativo', 'documental', 'dados', 'externo')),
  state TEXT NOT NULL CHECK (state IN ('validado', 'reprovado', 'aguardando_aprovacao', 'aguardando_info', 'sem_confirmacao', 'falha', 'confirmado_humano', 'devolvido', 'descartado')),
  criteria TEXT NOT NULL,
  evidence TEXT NOT NULL,
  justification TEXT NOT NULL,
  decided_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (id, workspace_id),
  UNIQUE (run_id),
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id)
);
INSERT INTO task_results_new (id, workspace_id, task_id, run_id, kind, state, criteria, evidence, justification, decided_by, created_at, decided_at)
  SELECT id, workspace_id, task_id, run_id, kind, state, criteria, evidence, justification, decided_by, created_at, decided_at FROM task_results;
DROP TABLE task_results;
ALTER TABLE task_results_new RENAME TO task_results;
CREATE INDEX task_results_task ON task_results(workspace_id, task_id, created_at);
