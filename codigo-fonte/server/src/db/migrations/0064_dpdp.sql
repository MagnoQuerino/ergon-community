-- rc.47 (Lei DPDP da Índia, Digital Personal Data Protection Act 2023 e as Regras de 2025): o aviso de consentimento
-- próprio (com a versão dele, separado dos termos de uso), o registro de cada consentimento dado e retirado, e o
-- representante que a pessoa nomeia para exercer os direitos dela em caso de morte ou incapacidade (seção 14 da lei).
-- Serviço: services/dpdp.ts. A configuração (quem responde pelos dados, o Grievance Officer, o Consent Manager e o prazo
-- de resposta) fica nas configurações do workspace (workspace_settings, chave privacidade.dpdp).

CREATE TABLE consentimentos (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  tipo TEXT NOT NULL,
  versao TEXT NOT NULL,
  idioma TEXT NOT NULL,
  dado_em TEXT NOT NULL,
  retirado_em TEXT
);
CREATE INDEX consentimentos_pessoa ON consentimentos(user_id, workspace_id, tipo);

CREATE TABLE representantes (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  nome TEXT NOT NULL,
  contato TEXT NOT NULL,
  relacao TEXT NOT NULL DEFAULT '',
  criado_em TEXT NOT NULL,
  atualizado_em TEXT NOT NULL
);
