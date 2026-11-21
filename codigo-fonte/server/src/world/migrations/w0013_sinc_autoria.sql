-- Segurança da sincronia (rc.41, revisão antes do lançamento):
--   world_sync.dono_conta: a conta World dona do workspace (o World diz no pull). Só o esqueleto da equipe vindo de um
--     aparelho dessa conta é aplicado; um colaborador tem a chave do workspace, mas não manda na equipe do dono.
--   world_nuvem_fixa: o aparelho-nuvem do workspace como este computador o viu da primeira vez (id e chave pública X25519).
--     Um aparelho-nuvem diferente depois disso (nuvem recriada ou um World mal-intencionado) não recebe as conexões nem a
--     chave do workspace até a pessoa dona confirmar com a senha; o novo espera em nova_*.
--   world_conexoes_carimbos: o último carimbo de hora (`em`) aplicado de cada remetente das conexões: um retrato antigo
--     reenviado não volta a valer.
ALTER TABLE world_sync ADD COLUMN dono_conta TEXT;
CREATE TABLE IF NOT EXISTS world_nuvem_fixa (
  workspace_id TEXT PRIMARY KEY, aparelho TEXT NOT NULL, chave TEXT NOT NULL, fixada_em TEXT NOT NULL,
  nova_aparelho TEXT, nova_chave TEXT, nova_em TEXT
);
CREATE TABLE IF NOT EXISTS world_conexoes_carimbos (workspace_id TEXT NOT NULL, remetente TEXT NOT NULL, em TEXT NOT NULL, PRIMARY KEY (workspace_id, remetente));
