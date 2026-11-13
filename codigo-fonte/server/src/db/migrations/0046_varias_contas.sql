-- Várias contas por aplicativo (rc.29): dois e-mails, dois números de WhatsApp, duas contas do mesmo quadro. Cada conta é
-- uma linha de `integrations`, com a credencial própria no cofre. `conta` = '' é a principal: é a linha que já existia (a
-- de antes desta versão vira a principal de cada aplicativo, com o mesmo id, sem mudar nada para quem tem uma só) e é a
-- que vale quando ninguém diz qual usar. As outras têm um id curto ("c" + 8 letras e números). Trocar a principal troca
-- só o `conta` das duas linhas (o id, os quadros e o registro seguem cada conta).
-- apelido: o nome que a pessoa deu (vazio = o e-mail, o número ou o nome da conta); ativa: a equipe e as rotinas usam
-- esta conta (0 = desligada pela pessoa; a credencial fica guardada). Conta emprestada de outro workspace: origem_conta é
-- qual das contas de lá.
-- O SQLite não troca UNIQUE: a tabela é recriada com os mesmos dados (como em 0006 e 0008). Roda uma vez só, dentro da
-- transação da migração; a tabela de passagem é apagada antes, se tiver sobrado.
DROP TABLE IF EXISTS integrations_new;
CREATE TABLE integrations_new (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (length(kind) BETWEEN 3 AND 20 AND kind NOT GLOB '*[^a-z]*'),
  conta TEXT NOT NULL DEFAULT '' CHECK (conta = '' OR (length(conta) = 9 AND substr(conta, 1, 1) = 'c' AND substr(conta, 2) NOT GLOB '*[^0-9a-f]*')),
  state TEXT NOT NULL DEFAULT 'off' CHECK (state IN ('off', 'pending', 'connected', 'error')),
  account_label TEXT,
  apelido TEXT,
  ativa INTEGER NOT NULL DEFAULT 1 CHECK (ativa IN (0, 1)),
  settings TEXT NOT NULL DEFAULT '{}',
  connected_at TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  origem_workspace_id TEXT,
  origem_conta TEXT NOT NULL DEFAULT '',
  UNIQUE (id, workspace_id),
  UNIQUE (workspace_id, kind, conta)
);
INSERT OR IGNORE INTO integrations_new (id, workspace_id, kind, conta, state, account_label, settings, connected_at, last_sync_at, last_error, created_at, origem_workspace_id, origem_conta)
  SELECT id, workspace_id, kind, '', state, account_label, settings, connected_at, last_sync_at, last_error, created_at, origem_workspace_id, '' FROM integrations;
DROP TABLE integrations;
ALTER TABLE integrations_new RENAME TO integrations;
CREATE INDEX IF NOT EXISTS integrations_origem ON integrations(origem_workspace_id, kind, origem_conta);

-- a ação de um agente guarda por qual conta sai (o id da linha: estável mesmo se a principal mudar). Vazio nas de antes: a principal.
ALTER TABLE conexao_acoes ADD COLUMN integracao_id TEXT;
-- a mensagem recebida guarda por qual conta chegou (o id da linha); as de WhatsApp de antes ficam com a principal, abaixo
ALTER TABLE source_events ADD COLUMN integracao_id TEXT;
-- as mensagens de WhatsApp de antes chegaram pelo número que existia: o principal
UPDATE source_events SET integracao_id = (SELECT i.id FROM integrations i WHERE i.workspace_id = source_events.workspace_id AND i.kind = 'whatsapp' AND i.conta = '')
  WHERE integracao_id IS NULL AND connection_id IN (SELECT id FROM connections WHERE kind = 'whatsapp');
