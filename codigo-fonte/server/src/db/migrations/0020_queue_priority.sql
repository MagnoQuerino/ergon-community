-- Fila da equipe com ordem e prioridade: o que passa do limite de trabalhos ao mesmo tempo espera em "A fazer", e os
-- agentes pegam de cima para baixo. "Prioridade" marca o card e o leva ao topo; arrastar dentro de "A fazer" muda a
-- ordem. Sem posição dada por você, vale o número do card (ordem de chegada).
ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN queue_pos REAL;
