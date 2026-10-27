-- Treinar: competências que a pessoa ensina a um agente (texto, documentos, links). O motor de IA escreve a
-- competência como skill (mecanismo /learn); a escrita fica em espera até a pessoa aprovar no Ergon. Cada
-- competência é do agente e do workspace; as versões aprovadas ficam guardadas aqui (cifradas) para restaurar.

CREATE TABLE agent_skills (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  -- nome da skill no motor (ergon-<workspace>-<agente>-<tema>): único na instalação
  name TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('ativa', 'desativada', 'removida')),
  version INTEGER NOT NULL DEFAULT 1,
  -- prova de uso: quantas vezes o agente carregou a competência numa execução (o motor avisa) e quando foi a última
  uses INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX agent_skills_agent ON agent_skills (workspace_id, agent_id);

CREATE TABLE agent_skill_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  skill_id TEXT NOT NULL REFERENCES agent_skills(id),
  version INTEGER NOT NULL,
  -- {caminho: conteúdo} da skill aprovada (SKILL.md e referências), cifrado
  files TEXT NOT NULL,
  -- fontes usadas no treinamento que gerou esta versão, cifrado
  sources TEXT NOT NULL DEFAULT '[]',
  training_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (skill_id, version)
);

CREATE TABLE trainings (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  skill_name TEXT NOT NULL,
  -- atualização de uma competência existente (null = nova)
  skill_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('executando', 'em_revisao', 'falhou', 'aprovado', 'descartado')),
  title TEXT NOT NULL,
  -- 1 = nome dado pela pessoa (ou o da competência que se atualiza): o título que o agente escrever não o troca
  title_fixed INTEGER NOT NULL DEFAULT 0,
  request TEXT NOT NULL,
  -- arquivos e links pedidos, com o que foi lido de cada um (cifrado)
  sources TEXT NOT NULL,
  run_id TEXT,
  -- ids das escritas em espera no motor, na ordem em que o agente as fez
  pending TEXT NOT NULL DEFAULT '[]',
  -- a competência proposta {caminho: conteúdo} e o resumo do agente (cifrados)
  draft TEXT,
  summary TEXT,
  -- limitações e problemas encontrados (fonte ilegível, link fora do ar…)
  problems TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT
);
CREATE INDEX trainings_agent ON trainings (workspace_id, agent_id, created_at);
