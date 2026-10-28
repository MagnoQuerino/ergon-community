-- Várias pessoas no mesmo computador: quem administra a instalação (a primeira conta), a trava
-- por inatividade de cada pessoa e os convites (quando só o administrador libera contas novas).

ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;
-- NULL: vale o padrão da instalação (instance_settings.idle_minutes)
ALTER TABLE users ADD COLUMN idle_minutes INTEGER;
UPDATE users SET is_admin = 1 WHERE id = (SELECT id FROM users ORDER BY created_at, rowid LIMIT 1);

CREATE TABLE invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  used_by TEXT
);
