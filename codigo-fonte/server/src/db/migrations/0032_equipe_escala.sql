-- Equipe por partes (sem teto artificial de agentes ou construções): índices para as consultas paginadas e para as
-- contagens por setor, por construção e por andar, e a escolha de efeito de cada agente (Pacotes instalados).

-- moradores de um andar (capacidade, ocupação, gatilhos de lotação)
CREATE INDEX IF NOT EXISTS agents_floor_status ON agents(floor_id, status);
-- membros de um setor e a galeria ordenada pelo nome
CREATE INDEX IF NOT EXISTS agents_ws_sector ON agents(workspace_id, profile_id, status);
CREATE INDEX IF NOT EXISTS agents_ws_name ON agents(workspace_id, status, coordinator, name);
-- andares de uma construção; construções na ordem de criação (cursor da lista)
CREATE INDEX IF NOT EXISTS floors_building ON floors(building_id) WHERE removed_at IS NULL;
CREATE INDEX IF NOT EXISTS buildings_ws_created ON buildings(workspace_id, created_at, id) WHERE removed_at IS NULL;
-- o que cada agente está fazendo agora (estado na galeria e no /api/state)
CREATE INDEX IF NOT EXISTS runs_agent_status ON runs(agent_id, status);

-- Efeito pessoal de cada agente. Sem linha = herda o padrão da cidade (alvos dos pacotes, como antes).
-- mode: 'inherit' (padrão da cidade), 'off' (sem efeitos de pacote neste agente), 'custom' (só o item escolhido).
-- O item é um efeito de um pacote instalado (installed_packages.id + posição na lista de efeitos dele).
CREATE TABLE agent_fx (
  workspace_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('inherit', 'off', 'custom')),
  package_id TEXT,
  item INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, agent_id),
  FOREIGN KEY (agent_id, workspace_id) REFERENCES agents(id, workspace_id),
  CHECK ((mode = 'custom') = (package_id IS NOT NULL AND item IS NOT NULL))
);
CREATE INDEX agent_fx_package ON agent_fx(package_id) WHERE package_id IS NOT NULL;
