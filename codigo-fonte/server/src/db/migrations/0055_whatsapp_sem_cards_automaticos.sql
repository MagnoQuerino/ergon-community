-- rc.35: ler uma conversa do WhatsApp não cria mais card no quadro sozinho. A opção "também criar card quando a
-- mensagem parecer um pedido" vinha ligada sem a pessoa escolher (e era gravada como ligada ao salvar qualquer filtro):
-- mensagens pessoais viravam cards. Agora é desligada por padrão; quem quiser liga de novo em Conexões › WhatsApp.
UPDATE integrations SET settings = json_set(settings, '$.cards', json('false'))
 WHERE kind = 'whatsapp' AND json_valid(settings) AND json_extract(settings, '$.cards') IS NOT 0;
