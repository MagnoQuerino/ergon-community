-- rc.42 ("mãos na massa"): o agente clona, testa, faz commit e abre pull request no repositório da pessoa sem nunca ver a
-- credencial da conexão (conexoes/codigo.ts). Cada concessão vale para UM repositório, UMA execução e pouco tempo: o
-- Terminal do motor fala com o Ergon (/internal/git/v1/...) usando uma senha de uso curto, e é o Ergon que conversa com o
-- GitHub ou o GitLab com o token guardado. Só o hash da senha fica aqui.
-- repo: o caminho no serviço (GitHub "dono/nome"; GitLab "grupo/sub/projeto"); principal: o ramo principal lido na hora
-- principal_ate: até quando a pessoa liberou enviar direto ao ramo principal (cartão aprovado ou "Liberar tudo")
-- apagar_ramo_ate: o mesmo para apagar ramos pelo envio (git push --delete)
CREATE TABLE git_concessoes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  run_id TEXT NOT NULL,
  agent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('github', 'gitlab')),
  conta TEXT NOT NULL DEFAULT '',
  repo TEXT NOT NULL,
  principal TEXT NOT NULL,
  senha_hash TEXT NOT NULL UNIQUE,
  criada_em TEXT NOT NULL,
  expira_em TEXT NOT NULL,
  principal_ate TEXT,
  apagar_ramo_ate TEXT,
  revogada_em TEXT,
  usos INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX git_concessoes_run ON git_concessoes(workspace_id, run_id);
