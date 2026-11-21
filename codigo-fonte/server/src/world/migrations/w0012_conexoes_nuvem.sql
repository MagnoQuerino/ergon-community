-- As conexões do computador na nuvem do Ergon World (sync-conexoes.ts). Nenhuma credencial fica aqui: elas moram no
-- SecretStore (cifradas com o cofre); aqui ficam o aceite, a escolha por conta e resumos (HMAC com sal próprio) do que
-- já foi enviado, para saber quando mandar de novo.
CREATE TABLE IF NOT EXISTS world_conexoes_nuvem (
  workspace_id TEXT PRIMARY KEY,
  -- no computador: o aceite explícito (uma vez por workspace) e o último retrato enviado, para qual aparelho-nuvem
  aceite_em TEXT, aceite_por TEXT, sal TEXT NOT NULL,
  enviado_estrutura TEXT, enviado_acessos TEXT, enviado_em TEXT, enviado_para TEXT, enviado_itens INTEGER,
  nuvem_aparelho TEXT, devolvido_versao INTEGER NOT NULL DEFAULT 0,
  -- na nuvem: de qual computador veio o último retrato, a chave pública dele (para devolver o acesso renovado) e a versão
  origem_aparelho TEXT, origem_chave TEXT, recebido_em TEXT, recebido_versao INTEGER NOT NULL DEFAULT 0, devolver INTEGER NOT NULL DEFAULT 0,
  erro TEXT, erro_em TEXT, updated_at TEXT NOT NULL
);
-- no computador: "usar também na nuvem" por conta (sem linha = ligado, depois do aceite)
CREATE TABLE IF NOT EXISTS world_conexoes_escolha (workspace_id TEXT NOT NULL, integration_id TEXT NOT NULL, usar INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (workspace_id, integration_id));
-- na nuvem: as contas que vieram do computador (saem quando somem do retrato; só elas seguem a posse da renovação)
CREATE TABLE IF NOT EXISTS world_conexoes_recebidas (workspace_id TEXT NOT NULL, kind TEXT NOT NULL, conta TEXT NOT NULL, origem TEXT NOT NULL, recebida_em TEXT NOT NULL, PRIMARY KEY (workspace_id, kind, conta));
