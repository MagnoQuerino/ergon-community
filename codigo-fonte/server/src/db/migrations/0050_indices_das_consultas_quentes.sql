-- Índices das consultas que o servidor repete o tempo todo e que liam a tabela inteira (medido com 20 mil execuções,
-- 5 mil cards e 60 mil mensagens). Só leitura mais rápida: nenhum dado muda.
--   runs_task: tentativas de um card, a execução mais nova do card e a reconciliação da fila no boot
--   runs_workspace_status: as contagens de /api/state (execuções rodando, na fila e esperando você)
--   tasks_parent: os subcards de um card (planos e ajudantes)
--   messages_queued: a fila de mensagens (Ctrl+Enter), conferida a cada passo da equipe
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id, created_at) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_workspace_status ON runs(workspace_id, status);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_queued ON messages(workspace_id, conversation_id) WHERE queued = 1;
