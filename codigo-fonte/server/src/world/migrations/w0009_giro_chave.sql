-- Giro da chave do workspace World depois que alguém sai.
--   old_keys: as chaves anteriores (cifrado; JSON versão → chave) para ler o histórico de antes do giro
--   rotation_pending: o World pediu o giro e ele ainda não foi feito deste computador
--   recovery_key_version: a versão da chave que a frase de recuperação deste aparelho abre (nula: sem frase daqui)
ALTER TABLE world_sync ADD COLUMN old_keys TEXT;
ALTER TABLE world_sync ADD COLUMN rotation_pending INTEGER NOT NULL DEFAULT 0;
ALTER TABLE world_sync ADD COLUMN recovery_key_version INTEGER;
