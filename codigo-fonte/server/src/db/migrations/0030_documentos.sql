-- Documentos: pastas do workspace (estilo explorador) e lixeira. O nome da pasta é gravado cifrado.
CREATE TABLE folders (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  parent_id TEXT,
  name TEXT NOT NULL,
  -- pastas automáticas: 'cards', 'conversas', 'rotinas', 'card:<id>', 'agente:<id>', 'rotina:<id>'
  system_key TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT,
  UNIQUE (workspace_id, system_key)
);
CREATE INDEX folders_parent ON folders (workspace_id, parent_id);
ALTER TABLE artifacts ADD COLUMN folder_id TEXT;
-- na lixeira desde (restaurar devolve; esvaziar apaga de vez, só a pessoa)
ALTER TABLE artifacts ADD COLUMN deleted_at TEXT;
