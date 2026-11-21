-- rc.41: o cartão dos quadros da pessoa ganha campos próprios (por quadro), subtarefas, links, pessoas, comentários e
-- anexos (arquivos que já estão em Documentos). Tudo local do Ergon: num quadro espelhado, nada disto vai para o
-- aplicativo de origem. O texto da pessoa (nomes, opções, valores, títulos, links, comentários) fica cifrado, como o
-- título e a descrição das tarefas.

-- Campo próprio de um quadro. options: JSON cifrado [{id, name, color}] (lista de opções e etiquetas; cor = chave da paleta).
CREATE TABLE board_fields (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('text', 'number', 'date', 'select', 'labels', 'person')),
  options TEXT NOT NULL DEFAULT '[]',
  position INTEGER NOT NULL,
  show_on_card INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (board_id, workspace_id) REFERENCES boards(id, workspace_id)
);
CREATE INDEX board_fields_board ON board_fields(board_id, position);

-- Valor de um campo numa tarefa (JSON cifrado; null = sem valor). Sem chave estrangeira para o campo: o valor pode chegar
-- de outro aparelho antes da definição, e apagar o campo apaga os valores pelo serviço.
CREATE TABLE task_field_values (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  value TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (task_id, field_id),
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id)
);

-- Subtarefas: itens marcáveis dentro do cartão (não são cards: tasks.parent_task_id continua sendo "enviada à equipe").
CREATE TABLE task_subtasks (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id)
);
CREATE INDEX task_subtasks_task ON task_subtasks(task_id, position);

-- Links do cartão (só http/https; task_links já é o vínculo com o aplicativo espelhado).
CREATE TABLE task_urls (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id)
);
CREATE INDEX task_urls_task ON task_urls(task_id, created_at);

-- Pessoas do workspace atribuídas ao cartão (além do agente responsável, que continua em tasks.agent_id).
CREATE TABLE task_people (
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, user_id),
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id)
);
CREATE INDEX task_people_user ON task_people(workspace_id, user_id);

-- Comentários (até 240 caracteres): de pessoas e de agentes. O nome de quem escreveu fica guardado (o comentário não
-- perde o autor se a pessoa sair ou o agente for renomeado, e chega com nome a outro aparelho).
CREATE TABLE task_comments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  author_type TEXT NOT NULL CHECK (author_type IN ('user', 'agent')),
  author_user_id TEXT,
  author_agent_id TEXT,
  author_name TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id)
);
CREATE INDEX task_comments_task ON task_comments(task_id, created_at);

-- Anexos: referência a um arquivo de Documentos (sem cópia). Sem chave estrangeira para o arquivo: a referência viaja
-- entre aparelhos e o arquivo pode não estar neste (o nome guardado diz qual era).
CREATE TABLE task_attachments (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (task_id, artifact_id),
  FOREIGN KEY (task_id, workspace_id) REFERENCES tasks(id, workspace_id)
);
