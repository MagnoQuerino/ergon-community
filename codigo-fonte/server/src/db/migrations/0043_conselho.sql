-- Revisão em conselho (rc.27): a execução vai ao conselho de modelos do motor (vários modelos opinam e um junta as
-- opiniões) em vez do modelo do agente. via = 'conselho'; NULL = o modelo do agente, como sempre.
ALTER TABLE runs ADD COLUMN via TEXT CHECK (via IS NULL OR via IN ('conselho'));
