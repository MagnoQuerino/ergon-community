-- Um cargo fixo e sempre presente: o Coordenador (um por workspace). Os outros agentes são livres; ele não sai da
-- equipe, não muda de função nem de setor e não perde as ferramentas de coordenação. Nome, aparência, história e
-- foco continuam dele (temas). Marca quem coordena hoje: ativo, com o encaminhamento, no setor de coordenação.
ALTER TABLE agents ADD COLUMN coordinator INTEGER NOT NULL DEFAULT 0;
UPDATE agents SET coordinator = 1 WHERE id IN (
  SELECT (SELECT a.id FROM agents a JOIN profiles p ON p.id = a.profile_id WHERE a.workspace_id = w.id
           ORDER BY (a.status = 'active') DESC, (a.tools LIKE '%"encaminhar"%') DESC, (p.key = 'coordenacao') DESC,
                    (a.char_key = 'aristoteles') DESC, a.created_at, a.rowid
           LIMIT 1)
    FROM workspaces w);
CREATE UNIQUE INDEX agents_one_coordinator ON agents(workspace_id) WHERE coordinator = 1;
