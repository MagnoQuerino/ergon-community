-- World Sync, conteúdo (tarefas, conversas e mensagens). A base da conciliação: o resumo (hash) de cada registro na
-- última vez que este aparelho e o World concordaram. Mudou só aqui: envia; mudou só lá: recebe; mudou dos dois lados:
-- conflito, que fica guardado até a pessoa decidir (o lado do outro aparelho fica cifrado, como o resto).
CREATE TABLE world_sync_records (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('task', 'conversation', 'message')),
  record_id TEXT NOT NULL,
  base_hash TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind, record_id)
);
CREATE TABLE world_sync_conflicts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('task', 'conversation')),
  record_id TEXT NOT NULL,
  remote TEXT NOT NULL,
  remote_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, kind, record_id)
);
-- Resumo do último esqueleto enviado ou aplicado: só manda outro quando a equipe mudou de verdade (sem eco).
ALTER TABLE world_sync ADD COLUMN blueprint_hash TEXT;
