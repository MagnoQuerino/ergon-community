/**
 * O estado do cartão do bot oficial (Telegram, Discord) em Conexões, pelo GET /api/canais-oficiais/:canal:
 * - indisponivel: o serviço ainda não tem a plataforma ligada ("ainda não disponível"; o bot próprio segue em "Avançado");
 * - livre: disponível, sem conta ligada (o botão "Abrir no Telegram" / "Adicionar ao Discord");
 * - ligado: uma ou mais contas ligadas (cada uma com Desligar; o botão continua para ligar outra).
 */
export interface ContaBotOficial { id: string; name: string | null; linkedAt: string; status: 'active' | 'paused' | 'revoked'; revokedBy?: string }
export interface EstadoBotOficial {
  platform: 'telegram' | 'discord'; available: boolean; connection: 'connected' | 'connecting' | 'offline'; accounts: ContaBotOficial[];
  /** "Conversar pelo Discord/Telegram" (a chave da pessoa nesta plataforma) */
  enabled?: boolean;
  /** o serviço liga a conta por um link de uso único ("Abrir no Telegram", "Adicionar ao Discord" com state); false = pelo código */
  linkStart?: boolean;
  /** Discord: o link de adicionar o bot do Ergon (montado pelo id do app) e o nome dele */
  installUrl?: string; botName?: string;
}
/** A conta liga pelo código (o bot manda o código na conversa e a pessoa digita aqui): o Discord sem o "Adicionar" com state. */
export const peloCodigo = (e: EstadoBotOficial): boolean => e.platform === 'discord' && e.available && e.linkStart === false;
export type TelaBotOficial = 'indisponivel' | 'livre' | 'ligado';

export const contasLigadas = (e: EstadoBotOficial): ContaBotOficial[] => e.accounts.filter((a) => a.status !== 'revoked');

export function telaDoBot(e: EstadoBotOficial): TelaBotOficial {
  // conta já ligada aparece mesmo com o serviço fora do ar (dá para desligar)
  if (contasLigadas(e).length) return 'ligado';
  return e.available ? 'livre' : 'indisponivel';
}

/** O botão principal aparece? (só com a plataforma disponível; com conta ligada, serve para ligar outra) */
export const mostraBotao = (e: EstadoBotOficial): boolean => e.available;
