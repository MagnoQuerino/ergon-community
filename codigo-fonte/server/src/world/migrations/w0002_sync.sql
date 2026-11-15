-- World Sync no aparelho: qual workspace local está ligado a qual workspace World, a chave do Sync (cifrada com a chave
-- da pessoa, nunca em claro) e até onde este aparelho já leu.
CREATE TABLE world_sync (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  sync_workspace_id TEXT NOT NULL,
  key_version INTEGER NOT NULL,
  sync_key TEXT NOT NULL,           -- cifrado (chave do workspace World)
  last_version INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
