-- Cidade em lotes: cada construção (prédio de trabalho, praça, área de lazer, bairro) tem um tipo do catálogo
-- (shared/city.ts), um lote no mapa (canto da pegada) e a origem: 'base' (a cidade inicial) ou 'local'
-- (criada na loja da versão local: grátis e sem limite). Removidas ficam com removed_at (histórico preservado).
ALTER TABLE buildings ADD COLUMN lot_x INTEGER;
ALTER TABLE buildings ADD COLUMN lot_z INTEGER;
ALTER TABLE buildings ADD COLUMN origin TEXT NOT NULL DEFAULT 'base';
ALTER TABLE buildings ADD COLUMN removed_at TEXT;
CREATE INDEX buildings_ws ON buildings(workspace_id) WHERE removed_at IS NULL;
