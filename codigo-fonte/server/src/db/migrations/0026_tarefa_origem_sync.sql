-- Tarefa recebida de outro aparelho da mesma pessoa (sincronização entre aparelhos): guarda o aparelho onde ela nasceu. O andamento
-- automático da equipe só pega tarefa sem origem remota, para o mesmo trabalho não rodar em dois computadores.
-- Sem World, a coluna fica vazia e nada muda.
ALTER TABLE tasks ADD COLUMN sync_origin TEXT;
