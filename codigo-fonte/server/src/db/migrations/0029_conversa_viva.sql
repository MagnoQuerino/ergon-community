-- Conversa com a equipe: lida e não lida, fixar, prioridade, personalidade, presença e iniciativa, anexos.

-- cada conversa é de uma pessoa só: o que chegou depois de read_at está "não lido" (as de antes ficam lidas)
ALTER TABLE conversations ADD COLUMN read_at TEXT;
UPDATE conversations SET read_at = COALESCE((SELECT MAX(created_at) FROM messages m WHERE m.conversation_id = conversations.id), created_at);
ALTER TABLE conversations ADD COLUMN pinned_at TEXT;
-- marcação do agente: urgente (para sem você ou tem prazo hoje) ou alta (precisa de você); sai quando a pessoa responde
ALTER TABLE conversations ADD COLUMN priority TEXT CHECK (priority IN ('urgente', 'alta'));
ALTER TABLE conversations ADD COLUMN priority_reason TEXT;
ALTER TABLE conversations ADD COLUMN priority_at TEXT;

-- personalidade padrão do agente (quem é dono do workspace escolhe); a escolha de cada pessoa fica em agent_voices
ALTER TABLE agents ADD COLUMN personality TEXT;
CREATE TABLE agent_voices (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  personality TEXT NOT NULL,
  accepted_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, agent_id)
);

-- presença: quando a pessoa chegou (a equipe puxa conversa) e quando foi vista pela última vez
CREATE TABLE presence (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  last_seen_at TEXT NOT NULL,
  arrived_at TEXT,
  PRIMARY KEY (workspace_id, user_id)
);

-- iniciativa: cada pendência que um colega puxou com a pessoa (para não repetir nem esquecer)
CREATE TABLE nudges (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  agent_id TEXT NOT NULL,
  item_key TEXT NOT NULL,
  conversation_id TEXT,
  count INTEGER NOT NULL DEFAULT 1,
  last_at TEXT NOT NULL,
  answered_at TEXT,
  PRIMARY KEY (workspace_id, user_id, item_key)
);

-- o mesmo pedido aparece em mais de uma conversa (o resumo da coordenação e a conversa com quem precisa):
-- responder em qualquer uma resolve nas duas
CREATE TABLE proposal_links (
  proposal_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (proposal_id, conversation_id)
);

-- anexos das mensagens (o arquivo fica em Documentos)
CREATE TABLE message_attachments (
  message_id TEXT NOT NULL,
  artifact_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  PRIMARY KEY (message_id, artifact_id)
);
CREATE INDEX message_attachments_artifact ON message_attachments (artifact_id);
