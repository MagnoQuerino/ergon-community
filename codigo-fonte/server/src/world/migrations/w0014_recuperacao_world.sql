-- Recuperação da chave do workspace pela senha do Ergon World (rc.42), além da frase:
--   world_sync.recovery_kind: com o que o envelope de recuperação desta conta abre ('phrase' ou 'world'; nula: nenhum
--     gravado daqui). A tela pede a senha do World ou a frase de acordo (giro da chave, entrar num computador novo).
ALTER TABLE world_sync ADD COLUMN recovery_kind TEXT;
