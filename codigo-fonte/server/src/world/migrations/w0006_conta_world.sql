-- Conta do Ergon World por e-mail e senha (sem o login pelo navegador) e UM workspace local ligado ao World por pessoa:
-- só ele tem o plano e sincroniza; os outros seguem locais. O workspace World pode ter nascido aqui ('created') ou
-- vir de outro computador da mesma conta ('joined': a chave vem do outro aparelho ou da frase de recuperação).
ALTER TABLE world_links ADD COLUMN bound_workspace_id TEXT REFERENCES workspaces(id);
ALTER TABLE world_links ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE world_workspace_ids ADD COLUMN origin TEXT NOT NULL DEFAULT 'created' CHECK (origin IN ('created', 'joined'));
DROP TABLE IF EXISTS world_login_states;
