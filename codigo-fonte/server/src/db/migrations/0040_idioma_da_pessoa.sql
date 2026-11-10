-- O idioma da tela é da pessoa, não do workspace: vale em todos os workspaces dela (trocar de workspace ou criar um
-- novo não troca a língua). NULL = a pessoa nunca escolheu (conta nova: vale o idioma do navegador).
ALTER TABLE users ADD COLUMN lang TEXT;
-- Até esta versão a tela só falava português: quem já tem conta continua em português quando o inglês for liberado,
-- mesmo com o navegador ou o Windows em inglês (ninguém vê a tela mudar de língua sem ter pedido).
UPDATE users SET lang = 'pt-BR' WHERE lang IS NULL;
