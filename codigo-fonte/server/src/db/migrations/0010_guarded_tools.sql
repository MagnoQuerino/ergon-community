-- Ferramentas que executam código (Executar código = 'calculo', Terminal = 'terminal') passam a ser dadas a cada
-- agente só com a autorização do usuário (senha). Quem as tinha apenas por padrão (perfis e setores de antes, quando
-- elas nunca funcionavam) deixa de ter; o agente pede permissão na conversa quando precisar.
UPDATE agents SET tools = (SELECT json_group_array(value) FROM json_each(agents.tools) WHERE value NOT IN ('calculo', 'terminal'))
  WHERE json_valid(tools) AND (tools LIKE '%"calculo"%' OR tools LIKE '%"terminal"%');
UPDATE profiles SET tools = (SELECT json_group_array(value) FROM json_each(profiles.tools) WHERE value NOT IN ('calculo', 'terminal'))
  WHERE json_valid(tools) AND (tools LIKE '%"calculo"%' OR tools LIKE '%"terminal"%');
