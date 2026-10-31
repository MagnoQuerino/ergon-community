-- Cidade por região (docs/CIDADE_REGIOES.md): moradores por andar, por construção e pelo id sem varrer a equipe
-- inteira a cada pedido.

-- moradores de um andar já na ordem de chegada (a vaga sai daqui); o começo dele é o índice antigo, que sai
CREATE INDEX IF NOT EXISTS agents_floor_status_created ON agents(floor_id, status, created_at);
DROP INDEX IF EXISTS agents_floor_status;
-- andares de uma construção por nível, removidos incluídos (a vaga conta por construção e nível, como a tela contava)
CREATE INDEX IF NOT EXISTS floors_building_level ON floors(building_id, level);
