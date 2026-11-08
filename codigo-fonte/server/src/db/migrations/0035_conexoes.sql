-- Conexões com escrita: ações dos agentes nas contas (com registro e confirmação), o que cada sessão já leu de fora e a
-- fila de escrita do espelho (dar check ou mover no Ergon reflete no aplicativo de origem).

-- propostas: + 'conexao' (ação numa conta esperando o seu clique)
CREATE TABLE agent_proposals_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  conversation_id TEXT,
  run_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('sector', 'create_agent', 'tools', 'permission', 'routine', 'routine_edit', 'question',
    'edit_agent', 'deactivate_agent', 'reactivate_agent', 'sector_edit', 'sector_new', 'task', 'ledger', 'delete_task', 'info_request', 'handoff',
    'batch', 'purge', 'conexao')),
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

-- cada ação pedida por um agente ou pela pessoa numa conta: registro, deduplicação e o que espera confirmação
CREATE TABLE conexao_acoes (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  run_id TEXT,
  agent_id TEXT,
  user_id TEXT,
  conversation_id TEXT,
  task_id TEXT,
  conexao TEXT NOT NULL,
  -- a conta por onde sai (o nome dela quando a ação foi pedida): trocou antes do clique, o cartão não vale
  conta TEXT,
  -- marca (sha256, cifrada) da credencial do cartão: outra credencial com o mesmo nome de conta também não vale
  credencial TEXT,
  acao TEXT NOT NULL,
  risco TEXT NOT NULL,
  origem TEXT NOT NULL,
  leu_de_fora INTEGER NOT NULL DEFAULT 0,
  decisao TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pendente', 'feita', 'falhou', 'recusada')),
  args TEXT,
  resumo TEXT,
  -- o alvo lido do serviço, quando o cartão fixou o id dele: é o que a pessoa lê no resultado (os ids ficam com o agente)
  alvo TEXT,
  resultado TEXT,
  erro TEXT,
  dedupe TEXT,
  ms INTEGER,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX conexao_acoes_ws ON conexao_acoes(workspace_id, created_at);
CREATE INDEX conexao_acoes_dedupe ON conexao_acoes(dedupe, created_at);

-- o que já entrou numa sessão vindo de fora. chave: sessão do motor, "conv:<id>" ou "task:<id>" (o conteúdo também volta
-- por conversa e por card). privado = conteúdo das contas da pessoa, que não pode sair para endereços arbitrários.
CREATE TABLE conteudo_externo (
  chave TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  privado INTEGER NOT NULL DEFAULT 0,
  motivo TEXT,
  at TEXT NOT NULL
);
CREATE INDEX conteudo_externo_ws ON conteudo_externo(workspace_id);

-- escrita do espelho: o que a pessoa fez no Ergon, a caminho do aplicativo. A leitura periódica não mexe numa tarefa com
-- escrita pendente (senão o check voltaria atrás antes de chegar lá).
-- tipo: a operação, em claro (op é cifrado), para um envio que deu certo encerrar os mais antigos do mesmo tipo que falharam
-- ("criar", "concluir", "mover", "editar:titulo", "editar:descricao", "editar:prazo").
-- status: enviando = a chamada ao aplicativo saiu e a resposta ainda não foi gravada (se o processo cair aí, criar não se
-- repete sozinho); superada = falhou, mas um envio mais novo do mesmo tipo já foi; cancelada = o card saiu antes de nascer lá.
CREATE TABLE mirror_outbox (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL,
  op TEXT NOT NULL,
  tipo TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pendente', 'enviando', 'feita', 'falhou', 'superada', 'cancelada')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at TEXT NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  done_at TEXT
);
CREATE INDEX mirror_outbox_pend ON mirror_outbox(status, next_at);
CREATE INDEX mirror_outbox_task ON mirror_outbox(task_id, status);

-- um card fica ligado a uma tarefa só em cada conexão (repetir uma criação pela metade não abre um segundo vínculo)
CREATE UNIQUE INDEX task_links_task_conn ON task_links(task_id, connection_id);

-- conexão é por workspace; a conta pode ser emprestada de outro workspace da mesma pessoa (a credencial mora lá, uma só,
-- e a renovação vale para os dois). Permissões, quadros e registro continuam de cada workspace.
ALTER TABLE integrations ADD COLUMN origem_workspace_id TEXT;
CREATE INDEX integrations_origem ON integrations(origem_workspace_id, kind);
