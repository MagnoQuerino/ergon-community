-- rc.41: quadros da pessoa, colunas, campos e os itens do cartão vão e voltam entre aparelhos com identidade estável.
-- Para unir sem duplicar nem ressuscitar o que foi apagado, cada aparelho guarda o que apagou (lápides) e, por registro,
-- o resumo do que ele e o World tinham em comum (como world_sync_records faz para tarefas e conversas).

-- quando o quadro (nome, colunas, campos) mudou pela última vez: entre dois aparelhos, vale o mais recente
ALTER TABLE boards ADD COLUMN updated_at TEXT;

-- quadro, coluna ou campo apagado. ref: o id (ou "k:<código>" de uma coluna de fábrica do quadro de entrada, cujo id
-- difere em cada aparelho); moved_to: para onde foram os cards (o outro aparelho leva os dele para o mesmo lugar)
CREATE TABLE board_tombstones (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('board', 'column', 'field')),
  ref TEXT NOT NULL,
  board_id TEXT NOT NULL,
  moved_to TEXT,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind, board_id, ref)
);

-- item de cartão apagado (subtarefa, link, comentário, anexo, pessoa)
CREATE TABLE card_tombstones (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  PRIMARY KEY (task_id, item_id)
);

-- a base da conciliação dos quadros ('board') e dos itens de cartão ('card'): o resumo do que foi enviado ou recebido
CREATE TABLE sync_bases (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('board', 'card')),
  record_id TEXT NOT NULL,
  base_hash TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind, record_id)
);

-- pessoa atribuída num outro aparelho que não tem conta neste (pelo nome de usuário): guardada para não se perder na
-- volta; se a conta existir aqui, a atribuição vale em task_people
CREATE TABLE task_people_remote (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  task_id TEXT NOT NULL,
  username TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, username)
);
