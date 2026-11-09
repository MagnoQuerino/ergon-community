-- Título do card: de onde ele veio. 'pessoa' (a pessoa escolheu: criou a tarefa, editou o nome ou pediu para
-- renomear) não é trocado sozinho; 'equipe' (o plano ou a renomeação da coordenação) e 'provisorio' (o card nasceu sem
-- plano, com um título tirado da conversa) a coordenação pode trocar quando entender melhor. NULL: card de antes.
ALTER TABLE tasks ADD COLUMN title_source TEXT CHECK (title_source IS NULL OR title_source IN ('pessoa', 'equipe', 'provisorio'));
-- cards de antes: quem a pessoa criou, ou cujo título ela trocou, ficam como escolha dela. Aprovar, devolver, concluir
-- ou mudar o prazo (também task.update dela) não contam. Registro cifrado não se lê aqui: card-title.ts confere na hora
-- de renomear.
UPDATE tasks SET title_source = 'pessoa' WHERE id IN (
  SELECT target_id FROM audit_events WHERE target_type = 'task' AND actor_type = 'user'
    AND (action = 'task.create' OR (action = 'task.update' AND evidence LIKE '%"titulo"%')));
