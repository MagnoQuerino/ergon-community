-- Segurança: chaves de workspace, sessões com trava por inatividade e confirmação recente, 2º fator.

-- Chave de dados de cada workspace (DEK), embrulhada pela origem de chaves: local = chave mestra;
-- nuvem = cofre de chaves gerenciado (KMS). Nunca gravada aberta.
CREATE TABLE workspace_keys (
  workspace_id TEXT PRIMARY KEY,
  wrapped TEXT NOT NULL,
  key_source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

-- Sessões: última atividade de verdade (mouse/teclado, não recargas automáticas) para trancar por
-- inatividade; última autenticação forte para pedir a senha de novo em ações sensíveis; aparelho.
ALTER TABLE sessions ADD COLUMN last_seen_at TEXT;
ALTER TABLE sessions ADD COLUMN auth_at TEXT;
ALTER TABLE sessions ADD COLUMN user_agent TEXT;
ALTER TABLE sessions ADD COLUMN ip TEXT;

-- Autenticador (TOTP, códigos de 6 dígitos): segredo cifrado por campo; só vale depois de confirmado.
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN password_changed_at TEXT;

-- Passkeys (WebAuthn): chave pública por aparelho (Windows Hello, Touch ID, celular, chave física).
CREATE TABLE passkeys (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX passkeys_user ON passkeys(user_id);

-- Configurações da instância (minutos de inatividade até trancar, etc.).
CREATE TABLE instance_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
