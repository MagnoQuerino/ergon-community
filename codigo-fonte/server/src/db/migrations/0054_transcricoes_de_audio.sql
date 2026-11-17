-- rc.33: mensagem de áudio. A transcrição do áudio que a pessoa manda fica gravada ligada ao arquivo (o texto cifrado pela
-- chave do workspace, como as mensagens), e é ela que vai ao agente junto do pedido (services/transcricoes.ts). Estados:
-- transcrevendo, preparando (o modelo de fala está sendo baixado no 1º uso), pronta, falhou (com o motivo, para a tela
-- oferecer "tentar de novo" e o agente saber que há um áudio que o sistema não transcreveu).
CREATE TABLE audio_transcricoes (
  artifact_id TEXT PRIMARY KEY REFERENCES artifacts(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  estado TEXT NOT NULL CHECK (estado IN ('transcrevendo', 'preparando', 'pronta', 'falhou')),
  texto TEXT,
  motivo TEXT,
  duracao_s REAL,
  provedor TEXT,
  tentativas INTEGER NOT NULL DEFAULT 0,
  inicio TEXT NOT NULL,
  fim TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX audio_transcricoes_ws ON audio_transcricoes(workspace_id, estado);
