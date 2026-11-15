-- O saldo do World é sempre de um workspace. Um workspace local pode ter o seu workspace
-- World só para os créditos (Ergon AI) sem ligar a sincronização: o id fica aqui; ligar o Sync depois usa o mesmo.
CREATE TABLE world_workspace_ids (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id),
  sync_workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- login que precisa remover um aparelho cadastrado (limite de 4) para caber este
ALTER TABLE world_login_states ADD COLUMN replace_device_id TEXT;
