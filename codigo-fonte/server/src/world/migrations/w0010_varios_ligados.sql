-- links por conta (rc.34): a pessoa liga quantos workspaces locais quiser ao World (o plano diz quantos têm direito)
CREATE TABLE IF NOT EXISTS world_bound (user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (user_id, workspace_id));
INSERT OR IGNORE INTO world_bound (user_id, workspace_id, created_at) SELECT user_id, bound_workspace_id, updated_at FROM world_links WHERE bound_workspace_id IS NOT NULL;
UPDATE world_links SET bound_workspace_id = NULL;
