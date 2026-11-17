/** Conversar com a equipe pelo Telegram e pelo Discord: ver servico.ts. */
export { Canais, RESPOSTA, notaCanal } from './servico.ts';
export { registerCanaisRoutes } from './rotas.ts';
export { WhatsAppEquipe, registerWhatsAppEquipeRoutes } from './whatsapp.ts';
/** A camada comum dos canais externos (membro, papel, travas, auditoria): a interface está no comentário de externo.ts. */
export { CanaisExternos, classificar, type PedidoExterno, type RespostaExterna } from './externo.ts';
