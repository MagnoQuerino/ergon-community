-- Personagens: cada agente pode ser um personagem da equipe (chave estável), com bio curta (interface),
-- instruções próprias (vão para o modelo), métodos (skills), ferramentas e o modelo indicado.
ALTER TABLE agents ADD COLUMN char_key TEXT;
ALTER TABLE agents ADD COLUMN bio TEXT;
ALTER TABLE agents ADD COLUMN charter TEXT;
ALTER TABLE agents ADD COLUMN skills TEXT;
ALTER TABLE agents ADD COLUMN tools TEXT;
ALTER TABLE agents ADD COLUMN model_hint TEXT;
CREATE UNIQUE INDEX agents_char_key ON agents(workspace_id, char_key) WHERE char_key IS NOT NULL;

-- Revisão socrática: perguntas do revisor ao autor, em rodadas limitadas, até um veredito.
CREATE TABLE reviews (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'approved', 'limit', 'stopped')),
  round INTEGER NOT NULL DEFAULT 1,
  max_rounds INTEGER NOT NULL,
  verdict TEXT,
  created_by_user_id TEXT,
  created_at TEXT NOT NULL,
  finished_at TEXT,
  UNIQUE (id, workspace_id),
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id),
  FOREIGN KEY (reviewer_id, workspace_id) REFERENCES agents(id, workspace_id),
  FOREIGN KEY (producer_id, workspace_id) REFERENCES agents(id, workspace_id)
);
CREATE INDEX reviews_task ON reviews(workspace_id, task_id, created_at);

ALTER TABLE runs ADD COLUMN review_id TEXT;
ALTER TABLE runs ADD COLUMN review_step TEXT CHECK (review_step IS NULL OR review_step IN ('questions', 'answers'));
