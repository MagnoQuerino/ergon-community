-- Ferramentas que cada execução usou (eventos do motor): nome, tempo e se deu erro. A prévia é cifrada como as mensagens.
-- seq = ordem dos eventos da execução; o motor repete os eventos depois de um reinício e a mesma ordem substitui a linha.
CREATE TABLE run_tools (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  tool TEXT NOT NULL,
  preview TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ms INTEGER,
  ok INTEGER,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX run_tools_ws ON run_tools(workspace_id, started_at);
