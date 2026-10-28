-- Prazo das tarefas (data, sem hora): escolhido no card, dito no pedido ("até sexta") ou vindo do aplicativo espelhado.
ALTER TABLE tasks ADD COLUMN due_on TEXT;
CREATE INDEX tasks_due ON tasks(workspace_id, due_on) WHERE due_on IS NOT NULL;
