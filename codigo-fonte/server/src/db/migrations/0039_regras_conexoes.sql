-- Regras aprovadas pela pessoa (conexoes/regras.ts): "podem mandar os e-mails sem me pedir aprovação" vira uma regra que vale
-- de verdade na decisão das conexões (regra.ts, decidir), e "Sempre" no cartão de aprovação depois de ler conteúdo das contas
-- libera aquele grupo (abrir sites ou rodar programas) no workspace inteiro. A pessoa desfaz em Conexões › Regras.
-- tipo: 'acao' (as ações nas contas) ou 'depois_de_ler' (abrir sites ou rodar programas depois de ler as contas)
-- oque: JSON; em 'acao', os tipos de ação liberados (organizar, enviar, apagar); em 'depois_de_ler', os grupos (sites, programas)
-- conexoes: JSON com as conexões (kind) em que vale; ["*"] = todas
-- so: 'email' = só as ações de e-mail daquelas conexões (o envio de mensagens por outros canais continua pedindo)
-- alcance: 'pedido' (o card ou o pedido daquela conversa, e o que nasceu dele: ancora), '24h' ou 'sempre'
-- ancora: JSON { runs, tasks } do pedido, para alcance 'pedido'
CREATE TABLE regras_conexoes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('acao', 'depois_de_ler')),
  oque TEXT NOT NULL,
  conexoes TEXT NOT NULL,
  so TEXT,
  alcance TEXT NOT NULL CHECK (alcance IN ('pedido', '24h', 'sempre')),
  ancora TEXT,
  conversation_id TEXT,
  expira_em TEXT,
  status TEXT NOT NULL DEFAULT 'ativa' CHECK (status IN ('ativa', 'desfeita')),
  aprovada_por TEXT,
  proposta_id TEXT,
  created_at TEXT NOT NULL,
  desfeita_em TEXT,
  desfeita_por TEXT
);
CREATE INDEX regras_conexoes_ws ON regras_conexoes(workspace_id, status, tipo);

-- a regra que deixou a ação ir sem cartão (o histórico diz "liberado pela sua regra")
ALTER TABLE conexao_acoes ADD COLUMN regra_id TEXT;

-- Propostas: + 'regra' (o cartão com o alcance: só neste pedido, por 24 h, sempre). O SQLite não muda um CHECK: a tabela é
-- refeita com as mesmas linhas, colunas e índices.
CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('sector', 'create_agent', 'tools', 'permission', 'routine', 'routine_edit', 'question',
    'edit_agent', 'deactivate_agent', 'reactivate_agent', 'sector_edit', 'sector_new', 'task', 'ledger', 'delete_task', 'info_request', 'handoff',
    'batch', 'purge', 'conexao', 'depois_de_ler', 'regra')),
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
