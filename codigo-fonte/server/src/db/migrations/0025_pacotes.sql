-- Pacotes .ergon instalados no workspace (docs/FORMATOS_ERGON.md): só dados (tema, efeitos, pets, aparências, equipe).
-- "previous" guarda o que o pacote mudou, para desfazer sem tocar em conversas, tarefas ou rotinas da pessoa.
CREATE TABLE installed_packages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  package_id TEXT NOT NULL,
  version TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0,      -- assinado pela loja oficial (0 = "não verificado", escolha consciente)
  sha256 TEXT NOT NULL,
  manifest TEXT NOT NULL,
  data TEXT NOT NULL,                       -- cifrado com a chave do workspace
  assets TEXT,                              -- imagens de prévia (base64), cifrado
  previous TEXT,                            -- estado anterior para desfazer, cifrado
  status TEXT NOT NULL CHECK (status IN ('active', 'removed')),
  installed_by TEXT NOT NULL REFERENCES users(id),
  installed_at TEXT NOT NULL,
  removed_at TEXT
);
CREATE INDEX installed_packages_ws ON installed_packages(workspace_id, status);
