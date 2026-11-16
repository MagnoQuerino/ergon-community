-- Termos de uso (16/11): a versão que a pessoa aceitou e quando. Sem aceite, nada muda para ela (Executar código e
-- Terminal só vêm ligados por padrão depois do aceite da versão que avisa disso).
ALTER TABLE users ADD COLUMN terms_version TEXT;
ALTER TABLE users ADD COLUMN terms_at TEXT;
