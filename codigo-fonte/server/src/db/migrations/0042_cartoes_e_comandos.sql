-- rc.27, frente dos cartões: o que o motor só oferecia nas outras portas chega ao Ergon.
--
-- 1. Cartões pedidos pelo agente por uma ferramenta do motor (perguntar de volta, pedido seguro de chave, senha de
--    administrador). O cartão que a pessoa vê é uma proposta (agent_proposals: 'question' ou a nova 'segredo'); esta
--    tabela guarda só o andamento do pedido do motor: de qual execução veio, se a ferramenta ainda espera a resposta
--    (ela volta no mesmo trabalho) ou já desistiu de esperar (a resposta segue como continuação), e quanto tempo o
--    trabalho ficou parado esperando a pessoa (não conta no limite de tempo da execução).
--    NUNCA há valor de chave ou senha aqui nem em agent_proposals: o valor vai direto ao cofre do motor.
CREATE TABLE cartoes_motor (
  pedido TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  run_id TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('pergunta', 'chave', 'sudo')),
  -- esperando: a ferramenta consulta; desistiu: o prazo dela acabou (a resposta vira continuação);
  -- entregue: a resposta voltou pela ferramenta; continuada: a resposta seguiu como continuação
  estado TEXT NOT NULL DEFAULT 'esperando' CHECK (estado IN ('esperando', 'desistiu', 'entregue', 'continuada')),
  espera_ms INTEGER NOT NULL DEFAULT 0,
  consultado_em TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX cartoes_motor_run ON cartoes_motor(run_id, estado);

-- 2. Trabalho contínuo numa conversa ou num card: meta com juiz (o trabalho só termina quando o critério for cumprido),
--    repetir até cumprir, checagem periódica e revisão independente (o parecer fica em nota). texto, criterio e nota são
--    conteúdo da pessoa e do agente (cifrados).
CREATE TABLE comandos (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL,
  conversation_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('meta', 'repetir', 'checagem', 'revisao')),
  texto TEXT NOT NULL,
  criterio TEXT,
  intervalo_s INTEGER,
  max_rodadas INTEGER NOT NULL,
  rodadas INTEGER NOT NULL DEFAULT 0,
  -- ativo; cumprido (o juiz disse que sim); esgotado (acabaram as rodadas); bloqueado (o juiz disse que falta algo seu, ou
  -- não há juiz); parado (você parou)
  status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo', 'cumprido', 'esgotado', 'bloqueado', 'parado')),
  nota TEXT,
  proxima_em TEXT,
  -- a última execução que este comando disparou (na revisão independente, a do revisor)
  run_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((conversation_id IS NULL) <> (task_id IS NULL))
);
CREATE INDEX comandos_alvo ON comandos(workspace_id, conversation_id, task_id, status);
CREATE INDEX comandos_prazo ON comandos(status, proxima_em);

-- 3. Propostas: + 'segredo' (o cartão protegido de chave ou senha). O SQLite não muda um CHECK: a tabela é refeita com as
--    mesmas linhas, colunas e índices.
CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('sector', 'create_agent', 'tools', 'permission', 'routine', 'routine_edit', 'question',
    'edit_agent', 'deactivate_agent', 'reactivate_agent', 'sector_edit', 'sector_new', 'task', 'ledger', 'delete_task', 'info_request', 'handoff',
    'batch', 'purge', 'conexao', 'depois_de_ler', 'regra', 'segredo')),
  payload TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied', 'rejected', 'failed')),
  result TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  UNIQUE (id, workspace_id)
);
INSERT INTO agent_proposals_new (id, workspace_id, conversation_id, run_id, kind, payload, summary, status, result, created_at, decided_at)
  SELECT id, workspace_id, conversation_id, run_id, kind, payload, summary, status, result, created_at, decided_at FROM agent_proposals;
DROP TABLE agent_proposals;
ALTER TABLE agent_proposals_new RENAME TO agent_proposals;
CREATE INDEX agent_proposals_conv ON agent_proposals(workspace_id, conversation_id, created_at);
CREATE INDEX agent_proposals_status ON agent_proposals(workspace_id, status, kind);
