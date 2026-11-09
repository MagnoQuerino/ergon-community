-- Do que é feita cada execução real (docs/CUSTO_DAS_CHAMADAS.md): as chamadas ao modelo medidas pelo plugin do motor e o
-- total informado pelo provedor, somados por execução. Cada parte em tokens: o total é o informado (ou, sem ele, estimado
-- pelo tamanho), repartido pelo tamanho de cada parte. Só números: nada do conteúdo.
-- base = instruções da equipe por baixo (identidade, regras gerais, ambiente); ergon = as instruções que o Ergon manda ao
-- agente (cargo, equipe, cards, regras do workspace); competencias = a lista de competências; anexos = o que o sistema
-- juntou à mensagem do pedido (anexos, documentos citados, dados das contas), que sai da conversa; o resto, cada um o seu.
-- informado = 1 quando a medição fecha: o provedor informou o total de todas as chamadas, nenhuma ficou sem registro e a
-- soma bate com o total da execução.
CREATE TABLE run_composicao (
  run_id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  agent_id TEXT NOT NULL,
  chamadas INTEGER NOT NULL,
  base INTEGER NOT NULL,
  ergon INTEGER NOT NULL,
  competencias INTEGER NOT NULL,
  ferramentas INTEGER NOT NULL,
  memoria INTEGER NOT NULL,
  anexos INTEGER NOT NULL DEFAULT 0,
  conversa INTEGER NOT NULL,
  entrada INTEGER NOT NULL,
  cache_lido INTEGER NOT NULL,
  informado INTEGER NOT NULL,
  ferramentas_exato INTEGER NOT NULL,
  medido_em TEXT NOT NULL
);
CREATE INDEX run_composicao_ws ON run_composicao(workspace_id, medido_em);

-- o tamanho (como vai na conversa ao motor) do que o sistema juntou à mensagem do pedido; null = nada
ALTER TABLE runs ADD COLUMN context_chars INTEGER;
