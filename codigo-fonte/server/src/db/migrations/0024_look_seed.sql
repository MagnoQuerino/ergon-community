-- Bonecos sorteados do pacote gráfico: o agente guarda só a semente; "Redefinir" no
-- perfil sorteia outra. NULL = a aparência do personagem (ou a calculada pelo nome, como antes).
ALTER TABLE agents ADD COLUMN look_seed INTEGER;
