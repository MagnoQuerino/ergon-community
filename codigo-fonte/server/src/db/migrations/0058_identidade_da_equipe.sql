-- rc.41: identidade estável da equipe entre os aparelhos da pessoa (o computador e a nuvem do Ergon World). O esqueleto
-- da sincronia leva, de cada agente e de cada rotina, a referência de quem o criou (o id no aparelho de origem); quem
-- recebe grava aqui a referência para conciliar a próxima vez (atualizar, arquivar) sem duplicar e sem depender do
-- nome: renomear no computador renomeia na nuvem. Nulo = nasceu aqui (a referência é o próprio id).
ALTER TABLE agents ADD COLUMN sync_ref TEXT;
ALTER TABLE routines ADD COLUMN sync_ref TEXT;
CREATE INDEX IF NOT EXISTS agents_sync_ref ON agents (workspace_id, sync_ref) WHERE sync_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS routines_sync_ref ON routines (workspace_id, sync_ref) WHERE sync_ref IS NOT NULL;
