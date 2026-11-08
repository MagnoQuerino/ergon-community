/**
 * Quando uma ação numa conta vai direto e quando pede confirmação:
 *   ler: sempre direto.
 *   apagar: sempre confirma.
 *   o pedido não partiu da pessoa (rotina, mensagem recebida, iniciativa do agente, colega): confirma.
 *   a pessoa pediu no chat: organizar as ferramentas dela vai direto; enviar a outra pessoa vai direto,
 *   a menos que a sessão tenha lido conteúdo de fora antes (um e-mail malicioso poderia ter escolhido destino e texto).
 * Com execução de código ligada no motor, tudo confirma, inclusive leitura: quem roda comandos ali alcança a ponte com o
 * token dela e poderia se passar por outra sessão (o terminal enxerga o que o plugin enxerga).
 * "Liberar tudo" é escolha consciente da pessoa, desligada por padrão.
 * Origem e leitura são marcadas pelo sistema. Nada que o modelo diga, ou que venha num e-mail, muda este resultado.
 */
import type { Risco } from './tipos.ts';

export type Origem = 'pessoa' | 'fora';
export type Decisao = 'direto' | 'confirmar' | 'recusar';
/** Ajuste da pessoa, por tipo de ação ou por ação: seguir a regra acima, sempre pedir confirmação, ou desligado. */
export type Ajuste = 'regra' | 'confirmar' | 'desligado';

export function decidir(x: { risco: Risco; origem: Origem; leuDeFora: boolean; liberarTudo: boolean; codigoLigado?: boolean; ajuste?: Ajuste }): Decisao {
  // a escolha da pessoa para esta conexão vale acima de tudo, inclusive de "Liberar tudo"
  if (x.ajuste === 'desligado') return 'recusar';
  if (x.ajuste === 'confirmar') return 'confirmar';
  if (x.liberarTudo) return 'direto';
  if (x.codigoLigado) return 'confirmar';
  if (x.risco === 'ler') return 'direto';
  if (x.risco === 'apagar' || x.origem === 'fora') return 'confirmar';
  return x.risco === 'enviar' && x.leuDeFora ? 'confirmar' : 'direto';
}

/**
 * As ferramentas do motor que trazem o conteúdo de um endereço (páginas, buscas, imagem por endereço): usar uma delas
 * marca a sessão como tendo lido conteúdo de fora. O plugin do motor (ergon_bridge, _LEEM_ENDERECO_*) repete esta lista.
 * Imagem em data: não vem de endereço nenhum (já está na conversa): não conta.
 */
export const LEEM_ENDERECO = { prefixos: ['web_', 'browser'], nomes: ['vision_analyze'] } as const;
export const leEndereco = (tool: string, alvo?: string | null): boolean =>
  LEEM_ENDERECO.prefixos.some((p) => tool.startsWith(p)) || ((LEEM_ENDERECO.nomes as readonly string[]).includes(tool) && !/^\s*data:/i.test(alvo ?? ''));

/**
 * Depois de ler conteúdo privado da conta, a sessão não usa o que alcança endereços arbitrários: um e-mail malicioso
 * poderia mandar o agente abrir `https://atacante/?dados=...`. A busca na web segue valendo (a consulta vai ao buscador,
 * e o agente recebe só resultados). Também caem com "Liberar tudo".
 */
export const BLOQUEADAS_DEPOIS_DE_LER: ReadonlySet<string> = new Set([
  'web_extract', 'web_crawl', 'vision_analyze', 'terminal', 'process', 'execute_code',
  'browser_navigate', 'browser_click', 'browser_type', 'browser_snapshot', 'browser_scroll', 'browser_vision', 'browser_back', 'browser_press',
]);
