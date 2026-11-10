-- Colunas dos quadros do sistema com um código fixo (rc.26): o sistema acha "A fazer", "Em andamento", "Com você" e
-- "Concluído" pelo código, nunca pelo nome. Assim um card não para de andar quando o nome da coluna aparece em outro
-- idioma ou quando a pessoa renomeia a coluna. Colunas de quadros espelhados (de outro aplicativo) ficam sem código.
ALTER TABLE columns ADD COLUMN system_key TEXT CHECK (system_key IS NULL OR system_key IN ('todo', 'doing', 'with_you', 'done'));

-- quadro da equipe: os nomes de fábrica de hoje (a primeira coluna com cada nome, se houver repetida)
UPDATE columns SET system_key = CASE name WHEN 'A fazer' THEN 'todo' WHEN 'Em andamento' THEN 'doing' WHEN 'Com você' THEN 'with_you' WHEN 'Concluído' THEN 'done' END
 WHERE name IN ('A fazer', 'Em andamento', 'Com você', 'Concluído')
   AND board_id IN (SELECT id FROM boards WHERE origin = 'native' AND audience = 'team')
   AND id = (SELECT c2.id FROM columns c2 WHERE c2.board_id = columns.board_id AND c2.name = columns.name ORDER BY c2.position, c2.rowid LIMIT 1);

-- "Minhas tarefas" (quadro da pessoa): A fazer, Fazendo, Feito
UPDATE columns SET system_key = CASE name WHEN 'A fazer' THEN 'todo' WHEN 'Fazendo' THEN 'doing' WHEN 'Feito' THEN 'done' END
 WHERE name IN ('A fazer', 'Fazendo', 'Feito')
   AND board_id IN (SELECT id FROM boards WHERE origin = 'native' AND audience = 'user')
   AND id = (SELECT c2.id FROM columns c2 WHERE c2.board_id = columns.board_id AND c2.name = columns.name ORDER BY c2.position, c2.rowid LIMIT 1);

-- um código por quadro
CREATE UNIQUE INDEX columns_system_key ON columns (board_id, system_key) WHERE system_key IS NOT NULL;
