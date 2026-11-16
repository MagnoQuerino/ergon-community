-- "Rodar na nuvem" (RC30): cada cartão que já foi ao World. Sem linha, o cartão nunca saiu daqui e não fala com o World.
--   preparing: a intenção está aberta (prepare/stage/commit em andamento ou resposta perdida): retomar com a MESMA chave
--   remote:    o World aceitou (commit): o cartão é dele; daqui só se acompanha
--   local:     trazido de volta; registrado no World (a posse daqui vale por batimento e efeitos pedem licença)
CREATE TABLE world_cards (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  card_ref TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('preparing', 'remote', 'local')),
  intent_key TEXT NOT NULL,
  handoff_id TEXT,
  generation INTEGER,
  job_id TEXT,
  job_state TEXT,
  result_at TEXT,
  checked_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, card_ref)
);
