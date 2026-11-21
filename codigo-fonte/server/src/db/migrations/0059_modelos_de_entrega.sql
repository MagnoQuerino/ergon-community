-- rc.42: modelos de entrega. O que o agente manda para a pessoa ao fim de um card vem num modelo fixo (decisão, entrega,
-- relatório, pergunta, bloqueio), validado no servidor (services/modelos-entrega.ts). Uma linha por entrega registrada
-- ('valida': a do agente; 'minima': o formato mínimo seguro que o Ergon montou) e por tentativa recusada ('recusada': os
-- erros que voltaram ao agente; contam para o limite de tentativas da execução). conteudo vai cifrado (db.seal): é o
-- relatório da entrega. decisoes: o que a pessoa aprovou ou devolveu item a item ({"0": "aprovado"}).
CREATE TABLE IF NOT EXISTS entregas (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT,
  run_id TEXT,
  tipo TEXT NOT NULL,
  estado TEXT NOT NULL CHECK (estado IN ('valida', 'minima', 'recusada')),
  conteudo TEXT NOT NULL,
  decisoes TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entregas_tarefa ON entregas (workspace_id, task_id, created_at);
CREATE INDEX IF NOT EXISTS entregas_execucao ON entregas (run_id);
