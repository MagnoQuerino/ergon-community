-- Rotinas no agendador do motor (rc.27, services/rotinas-motor.ts): cada rotina com horário é um job do agendador do
-- Hermes no perfil do agente que a executa. Aqui fica o que o Ergon já mandou: o perfil, o id do job, a marca do pedido
-- (para não mandar de novo o que não mudou), a próxima execução que o agendador informou e o estado (pendente, pronto,
-- falhou, sem-suporte). Rotina sem linha = ainda no agendador do Ergon: a volta periódica passa ao motor (é assim que
-- quem vem da rc.26 migra, aos poucos, sem rodar em dobro: o mesmo horário tem a mesma chave de execução).
CREATE TABLE routine_jobs (
  routine_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  profile TEXT,
  job_id TEXT,
  state TEXT NOT NULL DEFAULT 'pendente',
  fingerprint TEXT,
  next_run_at TEXT,
  last_fire_at TEXT,
  synced_at TEXT,
  tries INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_routine_jobs_ws ON routine_jobs (workspace_id, state);
-- Aprovações nativas (rc.27, services/aprovacoes.ts): cada pedido de aprovação do motor (approval.request no fluxo de
-- eventos da execução) e o cartão que a pessoa vê. tipo: 'motor' (um comando perigoso do Terminal, pedido pelo próprio
-- motor) ou 'cartao' (o cartão do Ergon que segurou o turno: confirmação de conexão ou aprovação depois de ler as contas).
-- estado: esperando (o motor segura o turno), respondida (o Ergon respondeu pela API) ou expirou (o prazo do motor acabou:
-- o cartão continua com a pessoa e a resposta segue como continuação).
CREATE TABLE aprovacoes_motor (
  run_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  proposal_id TEXT,
  tipo TEXT NOT NULL,
  comando TEXT,
  padrao TEXT,
  estado TEXT NOT NULL DEFAULT 'esperando',
  espera_ms INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  PRIMARY KEY (run_id, request_id)
);
CREATE INDEX idx_aprovacoes_motor_proposta ON aprovacoes_motor (proposal_id);
-- A pessoa aprovou um comando depois que o motor parou de esperar: vale para o mesmo comando na mesma conversa (ou card)
-- por um tempo, e o pedido seguinte do motor sai aprovado sem outro cartão.
CREATE TABLE aprovacoes_previas (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  sessao TEXT NOT NULL,
  comando_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_aprovacoes_previas ON aprovacoes_previas (sessao, comando_hash);
-- Propostas: + 'aprovacao' (o cartão de um comando de risco que o motor parou pedindo aprovação). O SQLite não muda um
-- CHECK: a tabela é refeita com as mesmas linhas, colunas e índices (como na 0042).
CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('sector', 'create_agent', 'tools', 'permission', 'routine', 'routine_edit', 'question',
    'edit_agent', 'deactivate_agent', 'reactivate_agent', 'sector_edit', 'sector_new', 'task', 'ledger', 'delete_task', 'info_request', 'handoff',
    'batch', 'purge', 'conexao', 'depois_de_ler', 'regra', 'segredo', 'aprovacao')),
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
