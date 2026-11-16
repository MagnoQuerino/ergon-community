-- Trabalho que saiu deste computador ("Rodar na nuvem", RC30): enquanto houver a linha, o cartão é de outro executor
-- (o Ergon World) e a fila e o agendador daqui não o executam. Sem linha, o cartão é local, como sempre foi.
-- Quem escreve é o módulo opcional do World; sem ele, a tabela fica vazia e nada muda.
CREATE TABLE remote_work (
  workspace_id TEXT NOT NULL,
  card_ref TEXT NOT NULL,
  holder TEXT NOT NULL,
  since TEXT NOT NULL,
  PRIMARY KEY (workspace_id, card_ref)
);
