-- Conversa resumida (rc.26, docs/CUSTO_DAS_CHAMADAS.md): quantas vezes, numa execução, o motor resumiu a parte antiga da
-- conversa (o tamanho do resumo mudou de uma chamada para a seguinte, ou apareceu). 0 = não resumiu nesta execução
-- (inclusive as medidas antes desta versão e as de um motor que não informa o resumo). Só números: nada do conteúdo.
ALTER TABLE run_composicao ADD COLUMN compactacoes INTEGER NOT NULL DEFAULT 0;
