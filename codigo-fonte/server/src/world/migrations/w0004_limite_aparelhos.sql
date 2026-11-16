-- Conta do World: no máximo 2 aparelhos com sessão ao mesmo tempo. O login pode
-- encerrar a sessão de um dos aparelhos conectados: a escolha da pessoa viaja com o login em andamento.
ALTER TABLE world_login_states ADD COLUMN end_sessions_of TEXT;
