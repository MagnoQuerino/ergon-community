-- Mais aplicativos de tarefas (Trello, Jira, ClickUp, monday.com, Notion, Linear, Airtable, Smartsheet, Pipefy,
-- GitHub Projects...). A lista de tipos passa a viver no código (catálogo em integrations.ts); o banco só garante
-- o formato do nome. O SQLite não altera CHECK: a tabela é recriada com os mesmos dados.
CREATE TABLE integrations_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 3 AND 20 AND kind NOT GLOB '*[^a-z]*'),
  state TEXT NOT NULL DEFAULT 'off' CHECK (state IN ('off', 'pending', 'connected', 'error')),
  account_label TEXT,
  settings TEXT NOT NULL DEFAULT '{}',
  connected_at TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, kind)
);
INSERT INTO integrations_new (id, workspace_id, kind, state, account_label, settings, connected_at, last_sync_at, last_error, created_at)
  SELECT id, workspace_id, kind, state, account_label, settings, connected_at, last_sync_at, last_error, created_at FROM integrations;
DROP TABLE integrations;
ALTER TABLE integrations_new RENAME TO integrations;
