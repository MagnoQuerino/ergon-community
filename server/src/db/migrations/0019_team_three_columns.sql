-- O quadro da equipe passa a ter três colunas: A fazer, Em andamento e Concluído. "Entrada" fazia o mesmo que
-- "A fazer", e a revisão é uma etapa dentro do andamento (o estado real — revisão, aguardando, falha — continua no
-- card). Nada se perde: os cards mudam de coluna e só as colunas que ficaram vazias saem. Quadros do usuário e
-- espelhados não mudam.
UPDATE tasks SET column_id = (SELECT c2.id FROM columns c2 WHERE c2.board_id = tasks.board_id AND c2.name = 'A fazer' ORDER BY c2.position LIMIT 1)
 WHERE column_id IN (SELECT c.id FROM columns c JOIN boards b ON b.id = c.board_id WHERE b.audience = 'team' AND b.origin = 'native' AND c.name = 'Entrada')
   AND EXISTS (SELECT 1 FROM columns c2 WHERE c2.board_id = tasks.board_id AND c2.name = 'A fazer');

UPDATE tasks SET column_id = (SELECT c2.id FROM columns c2 WHERE c2.board_id = tasks.board_id AND c2.name = 'Em andamento' ORDER BY c2.position LIMIT 1)
 WHERE column_id IN (SELECT c.id FROM columns c JOIN boards b ON b.id = c.board_id WHERE b.audience = 'team' AND b.origin = 'native' AND c.name = 'Revisão')
   AND EXISTS (SELECT 1 FROM columns c2 WHERE c2.board_id = tasks.board_id AND c2.name = 'Em andamento');

DELETE FROM columns
 WHERE name IN ('Entrada', 'Revisão')
   AND board_id IN (SELECT id FROM boards WHERE audience = 'team' AND origin = 'native')
   AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.column_id = columns.id);

UPDATE columns SET name = 'Concluído'
 WHERE name = 'Feito'
   AND board_id IN (SELECT id FROM boards WHERE audience = 'team' AND origin = 'native')
   AND NOT EXISTS (SELECT 1 FROM columns c2 WHERE c2.board_id = columns.board_id AND c2.name = 'Concluído');

UPDATE columns SET position = CASE name WHEN 'A fazer' THEN 0 WHEN 'Em andamento' THEN 1 WHEN 'Concluído' THEN 2 ELSE 3 + position END
 WHERE board_id IN (SELECT id FROM boards WHERE audience = 'team' AND origin = 'native');
