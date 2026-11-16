-- Cliente do Ergon World (numeração própria "w", fora das migrações do núcleo: só roda com o World configurado).
-- Vínculo de cada PESSOA local com a conta do World: chaves do aparelho e
-- sessão ficam CIFRADAS com a chave do workspace dela (só ela abre; outra pessoa no mesmo PC não usa).
CREATE TABLE world_links (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  account_email TEXT,
  device_keys TEXT NOT NULL,        -- cifrado: chaves privadas Ed25519 (posse) e X25519 (Sync)
  session_token TEXT NOT NULL,      -- cifrado: sessão do aparelho no World
  authorized_until TEXT,            -- última autorização online confirmada
  entitlement TEXT,                 -- último resumo de direitos recebido (para a interface)
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- login em andamento (removida na w0006)
CREATE TABLE world_login_states (
  state TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL,
  verifier TEXT NOT NULL,           -- cifrado
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL
);
