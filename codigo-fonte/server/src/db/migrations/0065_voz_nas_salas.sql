-- rc.49: voz nas salas.
-- A fala sem agente escolhido (o áudio do gravador, ou o canal de voz em "Todos") espera a transcrição e vai a quem ela
-- chama pelo nome (shared/nomes-falados.ts, sem IA). Até a transcrição chegar, a mensagem fica aqui.
CREATE TABLE salas_rota_voz (
  message_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  pedinte_chave TEXT NOT NULL,
  pedinte_nome TEXT NOT NULL,
  -- canal de voz aberto (a resposta é falada e, sem nome na fala, segue com quem respondeu por último)
  canal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX salas_rota_voz_conv ON salas_rota_voz(conversation_id);
-- vários agentes chamados na mesma mensagem: cada um sabe quem mais responde e em que ordem (uma resposta só, dividida)
ALTER TABLE salas_fila ADD COLUMN juntos TEXT;
