-- A equipe nativa (rc.27): cada agente é um perfil do motor, um por workspace (services/perfis.ts). Aqui fica o que o
-- Ergon já mandou ao motor para cada agente: o nome do perfil, o estado (pendente, pronto, falhou, sem-suporte), a marca do
-- pedido (para não mandar de novo o que não mudou) e o resumo do SOUL que o perfil tem (a execução não manda de novo a
-- identidade do agente quando ela já está lá). Agente sem linha = ainda sem perfil: a volta periódica cria (é assim que
-- quem vem da rc.26 migra, aos poucos e sem perder nada; uma falha fica pendente e tenta de novo).
CREATE TABLE agent_profiles (
  agent_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  profile TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pendente',
  fingerprint TEXT,
  alma_hash TEXT,
  synced_at TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_agent_profiles_ws ON agent_profiles (workspace_id, state);
-- O perfil em que cada execução começou no motor (NULL = o perfil padrão, como até a rc.26). As rotas dela (consultar,
-- acompanhar, parar) ficam no mesmo perfil, e a conversa que já começou num perfil continua nele.
ALTER TABLE runs ADD COLUMN hermes_profile TEXT;
