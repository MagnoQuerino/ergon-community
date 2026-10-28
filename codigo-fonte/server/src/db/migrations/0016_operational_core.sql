-- Núcleo operacional confiável: uma tarefa só é concluída com evidência.
--
-- task_results: o contrato de resultado de cada execução de um card (um por execução — idempotente). Diz o tipo de
--   trabalho, os critérios aplicados, as evidências, o estado da validação e por que o card foi (ou não) concluído.
-- task_artifacts: arquivos ligados a um card, com papel — "entrada" (dados que o agente processa) ou "entregavel"
--   (o que o trabalho produziu). Um arquivo pode servir a mais de um card (ex.: sua tarefa e o card da equipe).
-- operations: capacidades determinísticas executadas pelo Ergon a pedido de um agente autorizado (ex.: análise de
--   desempenho a partir de um CSV). Idempotentes pela chave: repetir não duplica entregáveis.
-- tasks.work_state: o estado real do trabalho (solicitada → processamento → resultado → validação → concluída, ou
--   aguardando informações, falha, revisão necessária, aguardando aprovação). As colunas do quadro continuam as mesmas.
CREATE TABLE task_results (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('informativo', 'documental', 'dados', 'externo')),
  state TEXT NOT NULL CHECK (state IN ('validado', 'reprovado', 'aguardando_aprovacao', 'aguardando_info', 'sem_confirmacao', 'falha', 'confirmado_humano', 'devolvido')),
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
CREATE INDEX task_results_task ON task_results(workspace_id, task_id, created_at);

CREATE TABLE task_artifacts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('entrada', 'entregavel')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, artifact_id),
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id),
  FOREIGN KEY (artifact_id, workspace_id) REFERENCES artifacts(id, workspace_id)
);
CREATE INDEX task_artifacts_ws ON task_artifacts(workspace_id, task_id, role);
-- arquivos já enviados para um card viram entrada dele
INSERT INTO task_artifacts (workspace_id, task_id, artifact_id, role, created_at)
  SELECT workspace_id, task_id, id, 'entrada', created_at FROM artifacts WHERE task_id IS NOT NULL;

CREATE TABLE operations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  op TEXT NOT NULL,
  input_artifact_id TEXT NOT NULL,
  params TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ok', 'erro')),
  result TEXT,
  error TEXT,
  outputs TEXT NOT NULL DEFAULT '[]',
  idempotency_key TEXT NOT NULL,
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id)
);

ALTER TABLE tasks ADD COLUMN work_state TEXT CHECK (work_state IN ('solicitada', 'processamento', 'resultado', 'validacao', 'concluida', 'aguardando_info', 'falha', 'revisao', 'aguardando_aprovacao'));
ALTER TABLE tasks ADD COLUMN requires_approval INTEGER NOT NULL DEFAULT 0;
-- cards da equipe já existentes: o estado sai da situação atual (concluídos ficam como estão; nada é reaberto)
UPDATE tasks SET work_state = CASE WHEN completed = 1 THEN 'concluida' ELSE 'solicitada' END
  WHERE board_id IN (SELECT id FROM boards WHERE audience = 'team');
