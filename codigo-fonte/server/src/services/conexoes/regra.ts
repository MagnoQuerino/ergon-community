/**
 * Quando uma ação numa conta vai direto e quando pede confirmação:
 *   ler: sempre direto.
 *   apagar: sempre confirma, mesmo pedido pela pessoa na conversa ("Liberar tudo" passa por cima).
 *   a ação que se declara assim (sempreConfirma: criar cobrança no Asaas, que avisa o cliente na hora; decisão de 09/11):
 *   sempre confirma, mesmo pedida pela pessoa e mesmo com "Liberar tudo"; só o ajuste dela ("desligado") vale acima.
 *   o pedido não partiu da pessoa (rotina, mensagem recebida, iniciativa do agente, colega): confirma.
 *   a pessoa pediu no chat: organizar as ferramentas dela vai direto; enviar a outra pessoa vai direto,
 *   a menos que a sessão tenha lido conteúdo de fora antes (um e-mail malicioso poderia ter escolhido destino e texto).
 * Execução de código (codigoLigado): tudo confirma, inclusive leitura, quando o agente da execução tem Terminal ou
 * Executar código, quando outra execução ativa no mesmo motor é de um agente com eles, ou quando um programa já rodou
 * naquele motor desde que ele abriu (app.ts, codigoLigado): quem roda comandos ali alcança a ponte com o token dela e
 * poderia se passar por outra sessão (o terminal enxerga o que o plugin enxerga). Sem execução conhecida, vale o motor
 * inteiro.
 * "Sempre pedir confirmação antes de organizar" (confirmarOrganizar): escolha da pessoa, desligada por padrão; vale como o
 * ajuste por conexão, acima de "Liberar tudo".
 * "Liberar tudo" é escolha consciente da pessoa, desligada por padrão.
 * Regra aprovada pela pessoa (regras.ts, rc.26): "podem mandar os e-mails sem me pedir aprovação", com o alcance que ela
 * escolheu no cartão. Vale como "Liberar tudo" para aquele tipo de ação, conexão e alcance (inclusive em card da equipe,
 * depois de ler conteúdo de fora e, se a regra é do workspace inteiro, com execução de código ligada). Quem decide se a
 * regra cobre a ação é o serviço (regras.ts, cobre): apagar só pela regra que fala em apagar. Os ajustes por conexão e
 * "sempre pedir confirmação antes de organizar" continuam acima dela.
 * Origem e leitura são marcadas pelo sistema. Nada que o modelo diga, ou que venha num e-mail, muda este resultado.
 */
import type { Risco } from './tipos.ts';

export type Origem = 'pessoa' | 'fora';
export type Decisao = 'direto' | 'confirmar' | 'recusar';
/** Ajuste da pessoa, por tipo de ação ou por ação: seguir a regra acima, sempre pedir confirmação, ou desligado. */
export type Ajuste = 'regra' | 'confirmar' | 'desligado';

export function decidir(x: { risco: Risco; origem: Origem; leuDeFora: boolean; liberarTudo: boolean; codigoLigado?: boolean; ajuste?: Ajuste; confirmarOrganizar?: boolean; regra?: boolean; sempreConfirma?: boolean }): Decisao {
  // a escolha da pessoa para esta conexão vale acima de tudo, inclusive de "Liberar tudo"
  if (x.ajuste === 'desligado') return 'recusar';
  if (x.ajuste === 'confirmar') return 'confirmar';
  // "sempre pedir confirmação antes de organizar", em todas as contas: também é escolha dela, como o ajuste acima
  if (x.confirmarOrganizar && x.risco === 'organizar') return 'confirmar';
  // o cliente é avisado na hora: "Liberar tudo" não libera (decisão de 09/11: sempre); uma regra aprovada que cobre esta
  // ação, sim (a pessoa liberou de propósito)
  if (x.sempreConfirma && !x.regra) return 'confirmar';
  if (x.liberarTudo) return 'direto';
  // a regra que ela aprovou (o serviço já conferiu tipo, conexão e alcance)
  if (x.regra && x.risco !== 'ler') return 'direto';
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
// mcp__: os conectores prontos do motor (rc.27) trazem conteúdo de um aplicativo de fora
export const LEEM_ENDERECO = { prefixos: ['web_', 'browser', 'mcp__'], nomes: ['vision_analyze'] } as const;
export const leEndereco = (tool: string, alvo?: string | null): boolean =>
  LEEM_ENDERECO.prefixos.some((p) => tool.startsWith(p)) || ((LEEM_ENDERECO.nomes as readonly string[]).includes(tool) && !/^\s*data:/i.test(alvo ?? ''));

/**
 * Proteção opcional (desligada por padrão, decisão de 08/11: o agente já trata o que lê como dado, nunca como instrução):
 * com ela ligada, depois de ler conteúdo privado da conta, o que alcança endereços arbitrários ou roda programas pede a
 * aprovação da pessoa num cartão antes (um e-mail malicioso poderia mandar o agente abrir `https://atacante/?dados=...`).
 * Aprovado, vale para o grupo inteiro (decisão de 09/11: abrir qualquer site, ou rodar qualquer programa), naquela conversa
 * ou card, pelo prazo que a pessoa escolhe no cartão (1 h, 8 h, 72 h; regras.ts) — ou "Sempre", no workspace inteiro, até ela
 * desfazer em Conexões › Regras. O cartão ainda mostra o que foi pedido (chavesDeAprovacao: o site, a página aberta no
 * navegador ou o programa exato), para ela decidir vendo.
 * A busca na web segue valendo (a consulta vai ao buscador, e o agente recebe só resultados). "Liberar tudo" tira também
 * esta proteção. Plugin do motor anterior ao pedido de aprovação (sem a capacidade "aprovar_depois_de_ler"): barra, como antes.
 * Nomes reais do Hermes v0.22.2 (toolsets.py; test/conexoes-regra-nomes.test.ts confere com o fixture tirado da imagem).
 * Entrada terminada em "_" vale como prefixo no plugin do motor (ergon_bridge 0.3.0+): "browser_" cobre o navegador
 * inteiro, inclusive o que uma versão nova do motor acrescentar. Os nomes do navegador continuam também por extenso para
 * o plugin de antes (só nome exato), enquanto o motor de alguém ainda não foi renovado.
 */
export const BLOQUEADAS_DEPOIS_DE_LER: ReadonlySet<string> = new Set([
  'web_extract', 'vision_analyze', 'terminal', 'process_manage', 'execute_code',
  // a geração de imagem fica livre (decisão de 08/11): ela pode buscar uma imagem de referência por endereço, mas o uso
  // de imagens não trava depois de ler conteúdo privado
  'browser_',
  'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_back', 'browser_press',
  'browser_get_images', 'browser_vision', 'browser_console', 'browser_cdp', 'browser_dialog', 'browser_vault', 'browser_exec',
  // rc.27: ver um vídeo abre o endereço dele; um conector pronto (MCP) leva o que o agente escreve a um aplicativo de fora.
  // Os nomes dos conectores são montados pelo motor na hora (mcp__<conector>__<ferramenta>): só o prefixo os pega.
  'video_analyze', 'mcp__',
]);

/** Como o cartão chama o pedido: abrir sites (página, imagem por endereço, navegador) ou rodar programas. */
export type GrupoDepoisDeLer = 'sites' | 'programas';
/** Rodam código: no computador da equipe ou dentro da página aberta no navegador (que alcança qualquer endereço). */
const PROGRAMAS: ReadonlySet<string> = new Set(['terminal', 'process_manage', 'execute_code', 'browser_console', 'browser_cdp', 'browser_exec']);
export const grupoDepoisDeLer = (tool: string): GrupoDepoisDeLer => (PROGRAMAS.has(tool) ? 'programas' : 'sites');
/** Abrem o endereço que o agente escreve: a aprovação vale para aquele site (a origem do endereço), não para a internet toda. */
const COM_ENDERECO: ReadonlySet<string> = new Set(['web_extract', 'vision_analyze', 'browser_navigate']);
/** Mexem só na página que já está aberta no navegador (sem endereço novo nem código): valem depois de um site aprovado ali. */
const NA_PAGINA: ReadonlySet<string> = new Set(['browser_snapshot', 'browser_click', 'browser_type', 'browser_scroll', 'browser_back', 'browser_press',
  'browser_get_images', 'browser_vision', 'browser_dialog']);
/** O site de um endereço (protocolo, nome e porta), ou null se não for um endereço da internet. */
export function siteDe(linha: string): string | null {
  const t = linha.trim();
  if (!t) return null;
  for (const c of [t, /^[a-z][a-z0-9+.-]*:/i.test(t) ? null : `https://${t}`]) {
    if (!c) continue;
    try { const u = new URL(c); if ((u.protocol === 'http:' || u.protocol === 'https:') && u.hostname) return u.origin.toLowerCase(); } catch { /* segue */ }
  }
  return null;
}
/**
 * O que exatamente foi pedido, para o cartão mostrar (na revisão de 08/11 era também o que a aprovação prendia; desde
 * 09/11 aprovar vale para o grupo inteiro, conexoes/servico.ts, gruposAprovados). Chaves: "site:<origem>" para cada
 * endereço; "pagina" para mexer na página já aberta; "exato:<ferramenta>:<pedido>" para o resto (programas, código no
 * navegador, cofre de senhas do navegador, ferramenta nova do navegador).
 */
export function chavesDeAprovacao(tool: string, alvo: string): string[] {
  if (NA_PAGINA.has(tool)) return ['pagina'];
  const exato = (x: string) => `exato:${tool}:${x.trim()}`;
  if (!COM_ENDERECO.has(tool)) return [exato(alvo)];
  const linhas = alvo.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!linhas.length) return [exato('')];
  return [...new Set(linhas.map((l) => { const s = siteDe(l); return s ? `site:${s}` : exato(l); }))];
}
/** Imagem que já está na conversa (data:) não vem de endereço nenhum: não pede aprovação (o mesmo de leEndereco). */
export const dispensaAprovacao = (tool: string, alvo: string): boolean => tool === 'vision_analyze' && /^\s*data:/i.test(alvo);
/** Quanto tempo vale a aprovação sem prazo escolhido (cartões de antes da escolha), naquela conversa ou card. */
export const APROVACAO_VALE_MS = 60 * 60_000;
/** Depois de uma recusa, o mesmo pedido (grupo, conversa ou card) não abre outro cartão por este tempo. */
export const RECUSA_VALE_MS = 15 * 60_000;
/** A entrada da lista barra esta ferramenta? O nome exato, ou o prefixo (entrada terminada em "_"), como no plugin do motor. */
export const negadaPor = (tool: string, lista: Iterable<string>): boolean =>
  [...lista].some((d) => tool === d || (d.endsWith('_') && d.length > 1 && tool.startsWith(d)));
