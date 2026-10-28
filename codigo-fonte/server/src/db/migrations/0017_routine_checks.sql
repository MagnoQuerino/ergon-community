-- Contrato de evidência das rotinas: cada execução guarda a conferência da entrega (fontes lidas, quem escreveu,
-- horários e tarefas citados conferidos com os dados, entrega) e o veredito, para listar sem abrir o detalhe.
ALTER TABLE routine_runs ADD COLUMN checks TEXT;
ALTER TABLE routine_runs ADD COLUMN verdict TEXT CHECK (verdict IN ('validado', 'parcial', 'reprovado'));
