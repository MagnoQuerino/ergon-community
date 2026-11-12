-- A equipe puxa conversa (services/initiative.ts): a abertura pronta ("Oi, Ana! Tem um minutinho?") guarda o motivo
-- dela — os cards em que o colega precisa da pessoa (id, número, título, o que precisa e a pergunta) —, cifrado como o
-- texto da mensagem. Quando a pessoa responde, a execução da resposta recebe esse motivo com o estado de agora de cada
-- card: o colega segue do assunto que o fez chamar (ou diz que já se resolveu), mesmo depois de reinício, de "tentar de
-- novo" ou de a conversa ir para o perfil do agente com sessão nova. NULL = mensagem comum.
ALTER TABLE messages ADD COLUMN motivo TEXT;
