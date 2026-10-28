-- "Conectado" exige confirmação humana após teste real no canal (Teams/WhatsApp).
-- Eventos recebidos pela ponte sozinhos não provam autenticação do adapter: um disparo de teste
-- do hook seria indistinguível. Até a confirmação, o estado é "não validado".
ALTER TABLE connections ADD COLUMN validated_at TEXT;
ALTER TABLE connections ADD COLUMN validated_by TEXT;
