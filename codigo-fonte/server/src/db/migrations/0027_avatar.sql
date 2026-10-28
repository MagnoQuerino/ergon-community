-- Foto de perfil da pessoa (Minha conta): imagem pequena (256 px, redimensionada no navegador) como data URL.
-- Sem foto, a interface mostra a inicial do nome.
ALTER TABLE users ADD COLUMN avatar TEXT;
