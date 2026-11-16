-- Cards do quadro na nuvem (agente com o modelo da pessoa) e o protocolo de recuperação do World.
--   agent_id, task_input: quem trabalha no card e o pedido que foi (a resposta volta como a de uma execução daqui)
--   recovery_round, recovery_log: a rodada de recuperação em andamento e o que falhou em cada rodada (JSON)
--   model_fallback: o motivo curto quando rodou no Ergon AI em vez do modelo do agente
ALTER TABLE world_cards ADD COLUMN agent_id TEXT;
ALTER TABLE world_cards ADD COLUMN task_input TEXT;
ALTER TABLE world_cards ADD COLUMN recovery_round INTEGER NOT NULL DEFAULT 0;
ALTER TABLE world_cards ADD COLUMN recovery_log TEXT;
ALTER TABLE world_cards ADD COLUMN model_fallback TEXT;
-- "Enquanto você esteve fora": cada resultado da nuvem que chegou, até a pessoa ver o resumo
CREATE TABLE world_cloud_results (
  job_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL,
  card_ref TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('concluido', 'falhou')),
  recovered INTEGER NOT NULL DEFAULT 0,
  fallback TEXT,
  reason TEXT,
  at TEXT NOT NULL,
  seen INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX world_cloud_results_unseen ON world_cloud_results(user_id, workspace_id, seen);
