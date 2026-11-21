-- Sincronia robusta (rc.41):
--   envio_pendente: a parte que está sendo enviada agora (cifrado; JSON com o código da operação e o resumo do corpo).
--     A resposta do World se perdeu no caminho: o reenvio usa o mesmo código (o World devolve o mesmo recibo) e, se a
--     mudança já estiver lá ao receber, o que ela levava é marcado como enviado sem mandar de novo.
--   giro_candidato: a chave nova de um giro que ainda não foi confirmado (cifrado; JSON versão, chave e operação). Fica
--     gravada ANTES do pedido: se a resposta se perder, a chave que o World já passou a exigir não se perde com ela.
ALTER TABLE world_sync ADD COLUMN envio_pendente TEXT;
ALTER TABLE world_sync ADD COLUMN giro_candidato TEXT;
