/**
 * Regras aprovadas pela pessoa (rc.26): a autonomia que ela dá à equipe, por escolha consciente. "Podem mandar os e-mails
 * sem me pedir aprovação" vira um cartão com o alcance (só neste pedido, por 24 h, sempre); um clique aplica, e a regra vale
 * de verdade na decisão das conexões (regra.ts, decidir): as ações daquele tipo, naquela conexão e naquele alcance vão
 * direto, sem cartão — inclusive em cards da equipe e depois de ler conteúdo de fora. Apagar só entra quando a regra fala
 * em apagar. "Sempre" no cartão de aprovação depois de ler as contas libera aquele grupo (abrir sites ou rodar programas)
 * no workspace inteiro. Tudo fica na auditoria (quem aprovou, o que liberou) e se desfaz em Conexões › Regras.
 * Quem propõe é a coordenação (o marcador [[regra ...]]) ou a própria frase da pessoa (regraDaFrase); nada do que o modelo
 * escreve aplica a regra: só o clique da pessoa dona do workspace.
 */
import type { Db } from '../../db/db.ts';
import { HttpError, fold, id, notFound, now } from '../../lib/util.ts';
import { audit, type Bus } from '../bus.ts';
import { INTEGRATIONS, integrationDef, type IntegrationKind } from '../integrations.ts';
import { attrs } from '../routine-proposals.ts';
import { runDeOrigem } from './marca.ts';
import type { GrupoDepoisDeLer } from './regra.ts';
import type { Risco } from './tipos.ts';

export type Alcance = 'pedido' | '24h' | 'sempre';
export const ALCANCES: readonly Alcance[] = ['pedido', '24h', 'sempre'];
/** O prazo que a pessoa escolhe no cartão de aprovação depois de ler as contas. */
export type PrazoDepoisDeLer = '1h' | '8h' | '72h' | 'sempre';
export const PRAZOS_DEPOIS_DE_LER: readonly PrazoDepoisDeLer[] = ['1h', '8h', '72h', 'sempre'];
const HORA = 3_600_000;
export const PRAZO_MS: Record<Exclude<PrazoDepoisDeLer, 'sempre'>, number> = { '1h': HORA, '8h': 8 * HORA, '72h': 72 * HORA };
/** O mais longo dos prazos com hora marcada: a consulta dos cartões aprovados não precisa ir além. */
export const MAIOR_PRAZO_MS = 72 * HORA;
/** "Só neste pedido" também termina sozinha: um pedido que ninguém fecha não fica liberado para sempre. */
export const PEDIDO_VALE_MS = 7 * 24 * HORA;
/** "Só neste pedido": o que ela escrever na mesma conversa até 6 h depois de aprovar continua o pedido ("ok, pode enviar agora"). */
export const PEDIDO_SEGUE_MS = 6 * HORA;
export type RiscoLiberado = Exclude<Risco, 'ler'>;
const RISCOS_LIBERAVEIS: readonly RiscoLiberado[] = ['organizar', 'enviar', 'apagar'];

/** O que o cartão de regra guarda (proposals.ts): o alcance é o sugerido; a pessoa escolhe no clique. */
export type PropostaRegra = { kind: 'regra'; riscos: RiscoLiberado[]; conexoes: string[]; so: 'email' | null; alcance: Alcance; resumo: string;
  /** a coordenação sugeriu (o marcador), não foi a frase da pessoa: o cartão diz */
  sugerida?: boolean };
export type RegraSemResumo = Omit<PropostaRegra, 'resumo'>;
/**
 * O pedido em que a regra foi aprovada: a execução que propôs (e o card dela) — o que nasce dela entra pela cadeia
 * (cadeiaDoPedido). `desde`: quando ela começou; as mensagens seguintes da pessoa na mesma conversa, até PEDIDO_SEGUE_MS
 * depois da aprovação, contam como o mesmo pedido.
 */
export interface Ancora { runs: string[]; tasks: string[]; desde?: string }
/** O pedido, para conferir uma execução: a âncora, a conversa e até quando a mensagem seguinte dela ainda conta. */
export interface Pedido { ancora: Ancora; conversationId: string | null; ate: number }
export interface RegraConexao {
  id: string; tipo: 'acao' | 'depois_de_ler'; oque: string[]; conexoes: string[]; so: 'email' | null; alcance: Alcance; ancora: Ancora | null;
  conversation_id: string | null; expira_em: string | null; status: 'ativa' | 'desfeita'; aprovada_por: string | null; proposta_id: string | null; created_at: string;
}
interface Linha { id: string; tipo: 'acao' | 'depois_de_ler'; oque: string; conexoes: string; so: string | null; alcance: Alcance; ancora: string | null; conversation_id: string | null; expira_em: string | null; status: 'ativa' | 'desfeita'; aprovada_por: string | null; proposta_id: string | null; created_at: string }
const daLinha = (l: Linha): RegraConexao => ({ ...l, oque: JSON.parse(l.oque) as string[], conexoes: JSON.parse(l.conexoes) as string[], so: l.so === 'email' ? 'email' : null, ancora: l.ancora ? JSON.parse(l.ancora) as Ancora : null });

// ------------------------------------------------------------------------------------------------- textos
const lista = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs.at(-1)}`);
const nomeDe = (k: string): string => integrationDef(k as IntegrationKind)?.name ?? k;
/** "enviar e-mails pela Microsoft 365", "enviar mensagens e e-mails e apagar, em todas as conexões" */
export function descreverRegra(r: { riscos: readonly string[]; conexoes: readonly string[]; so: 'email' | null }): string {
  const email = r.so === 'email';
  // só onde há e-mail (as contas Microsoft e Google, ou todas) o envio inclui e-mails
  const temEmail = r.conexoes.some((k) => k === '*' || k === 'microsoft' || k === 'google');
  const oque = RISCOS_LIBERAVEIS.filter((x) => r.riscos.includes(x)).map((x) => (x === 'enviar' ? (email ? 'enviar e-mails' : temEmail ? 'enviar mensagens e e-mails' : 'enviar mensagens')
    : x === 'organizar' ? (email ? 'organizar os e-mails (rascunhos e pastas)' : 'organizar (criar, mudar, deixar rascunhos)') : email ? 'apagar e-mails' : 'apagar'));
  const onde = r.conexoes.includes('*') ? 'em todas as conexões' : r.conexoes.length === 1 ? `pela conta ${nomeDe(r.conexoes[0])}` : `pelas contas ${lista(r.conexoes.map(nomeDe))}`;
  return `${lista(oque)} ${onde}`;
}
export const descreverGrupo = (g: GrupoDepoisDeLer): string => (g === 'sites' ? 'abrir sites depois de ler conteúdo das contas' : 'rodar programas depois de ler conteúdo das contas');
const quando = (iso: string): string => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export function descreverAlcance(r: Pick<RegraConexao, 'alcance' | 'expira_em'>): string {
  if (r.alcance === 'sempre') return 'sempre';
  if (r.alcance === '24h') return `por 24 h${r.expira_em ? ` (até ${quando(r.expira_em)})` : ''}`;
  return 'só no pedido em que foi aprovada';
}
/** O texto do cartão: o que libera, o que continua pedindo e o cuidado, antes dos botões. */
export function resumoDaProposta(r: RegraSemResumo): string {
  const linhas = [`Liberar sem pedir a sua confirmação: ${descreverRegra(r)}.`];
  if (r.sugerida) linhas.push('Quem sugeriu foi a coordenação, não você: confira se é isso mesmo que você quer.');
  if (!r.riscos.includes('apagar')) linhas.push('Apagar continua pedindo confirmação.');
  linhas.push('Vale também quando a equipe trabalha sozinha num card e depois de ler e-mails ou mensagens de outras pessoas: um texto malicioso lido poderia levar a um envio que você não viu antes. Escolha até quando vale; você desfaz em Conexões › Regras.');
  linhas.push(`"Só neste pedido" vale para o que este pedido já pôs em andamento e para o que você pedir nesta conversa nas próximas ${PEDIDO_SEGUE_MS / HORA} horas; enquanto um agente da equipe puder rodar programas, ele não vale.`);
  linhas.push('O que este pedido deixou esperando a sua confirmação sai no clique; os cartões de outros pedidos continuam esperando você.');
  return linhas.join('\n');
}

// ------------------------------------------------------------------------------- quem propõe: o marcador e a frase
const ALIAS: Record<string, IntegrationKind> = { outlook: 'microsoft', teams: 'microsoft', 'microsoft 365': 'microsoft', office: 'microsoft', gmail: 'google', 'google workspace': 'google', whatsapp: 'whatsapp', zap: 'whatsapp' };
/** "microsoft", "Microsoft 365", "outlook", "todas" → os kinds (["*"] = todas). Desconhecida: null. */
function conexoesDe(v: string): string[] | null {
  const partes = fold(v).split(/[|,;/]|\s+e\s+|\s+and\s+/).map((x) => x.trim()).filter(Boolean);
  if (!partes.length || partes.some((p) => /^(todas?|tudo|\*|qualquer|all|any|every|everything)$/.test(p))) return ['*'];
  const out = new Set<string>();
  for (const p of partes) {
    const k = ALIAS[p] ?? INTEGRATIONS.find((d) => d.kind === p || fold(d.name) === p)?.kind;
    if (!k) return null;
    out.add(k);
  }
  return [...out];
}
function riscosDe(v: string): RiscoLiberado[] {
  const t = fold(v);
  const out = new Set<RiscoLiberado>();
  // também em inglês (a coordenação pode escrever os valores no idioma da conversa): send, organize, delete, all
  if (/\b(envi|mand|respond|dispar|public|escrev|tud|send|repl|answer|forward|post|write|all\b|every)/.test(t)) out.add('enviar');
  if (/\b(organiz|cri|mov|escrev|tud|organis|creat|write|all\b|every)/.test(t)) out.add('organizar');
  // apagar só quando a regra fala em apagar (decisão de 09/11): "tudo" não inclui
  if (/\b(apag|exclu|delet|remov|eras|trash)/.test(t)) out.add('apagar');
  return RISCOS_LIBERAVEIS.filter((r) => out.has(r));
}
const alcanceDe = (v: string | undefined): Alcance => {
  const t = fold(v ?? '');
  return /24|dia|hoje|day|today/.test(t) ? '24h' : /sempre|permanente|always|permanent|forever/.test(t) ? 'sempre' : 'pedido';
};

/** [[regra acao="enviar" conexao="microsoft|todas" alcance="pedido|24h|sempre" so="email"]] na resposta da coordenação (até 3). */
export function parseRegras(text: string | null): RegraSemResumo[] {
  const out: RegraSemResumo[] = [];
  for (const m of (text ?? '').matchAll(/\[\[\s*regra\b([^\]]{0,600})\]\]/gi)) {
    const a = attrs(m[1]);
    const riscos = riscosDe(a.acao ?? '');
    const conexoes = conexoesDe(a.conexao ?? 'todas');
    if (!riscos.length || !conexoes) continue;
    const so = /e-?mail/.test(fold(a.so ?? '')) ? 'email' as const : null;
    out.push({ kind: 'regra', riscos, conexoes, so, alcance: alcanceDe(a.alcance) });
    if (out.length >= 3) break;
  }
  return out;
}

/** "sem (me) pedir aprovação", "sem a minha confirmação", "sem me perguntar", "não precisa pedir confirmação", "estão liberados a mandar" */
const SEM_APROVACAO = [
  /\bsem\s+(?:me\s+|nos\s+)?(?:pedir|esperar|precisar|aguardar|depender)\s+(?:(?:a|da|de|do)\s+)?(?:minha\s+|sua\s+)?(?:aprovacao|confirmacao|autorizacao|permissao|ok)\b/,
  /\bsem\s+(?:a\s+)?(?:minha\s+)?(?:aprovacao|confirmacao|autorizacao|permissao)\b/,
  /\bsem\s+(?:me\s+)?(?:perguntar|consultar)\b/,
  /\bsem\s+(?:precisar\s+)?(?:eu\s+)?(?:aprovar|confirmar)\b/,
  /\bnao\s+(?:precisa[m]?|e\s+preciso)\s+(?:mais\s+)?(?:me\s+)?(?:pedir|esperar|aguardar|de)\s+(?:a\s+|da\s+|minha\s+)*(?:aprovacao|confirmacao|autorizacao|permissao)\b/,
  /\b(?:esta|estao|fica|ficam)\s+(?:liberad|autorizad)[oa]s?\s+(?:a|para|pra)\b/,
  // inglês: "without my approval", "without asking me", "no need to ask for my confirmation", "you're allowed to send"
  /\bwithout\s+(?:my\s+|our\s+|your\s+|the\s+|any\s+)?(?:approval|confirmation|permission|authori[sz]ation|sign-?off|ok|okay)\b/,
  /\bwithout\s+(?:first\s+)?(?:asking|checking\s+with|consulting|waiting\s+for)\b/,
  /\bwithout\s+(?:needing|having)\s+(?:me\s+)?to\s+(?:approve|confirm)\b/,
  /\b(?:no\s+need|(?:you\s+)?(?:don't|do\s+not|doesn't|does\s+not)\s+need)\s+(?:to\s+)?(?:ask(?:\s+me)?(?:\s+for)?\s+|wait\s+for\s+|get\s+|check\s+with\s+me\s+for\s+)?(?:my\s+|our\s+)?(?:approval|confirmation|permission|authori[sz]ation|sign-?off)\b/,
  /\bno\s+need\s+to\s+(?:ask|check\s+with)\s+me\b/,
  /\b(?:are|is|you're|you\s+are)\s+(?:now\s+)?(?:allowed|authori[sz]ed|cleared|free)\s+to\b/,
];
const VERBO: Record<RiscoLiberado, RegExp> = {
  enviar: /\b(?:mand(?:ar|em|e|a)|envi(?:ar|em|e|a)|dispar(?:ar|em|e|a)|respond(?:er|am|a)|encaminh(?:ar|em|e|a)|public(?:ar)|publiquem|publique|post(?:ar|em|e)|send|reply|respond|answer|forward|post|publish|email)\b/,
  apagar: /\b(?:apag(?:ar|a)|apaguem|apague|exclu(?:ir|am|a)|delet(?:ar|em|e)|delete|remove|erase|trash)\b/,
  organizar: /\b(?:organiz(?:ar|em|e)|cri(?:ar|em|e)|mov(?:er|am|a)|organi[sz]e|create|move|file|sort|archive)\b/,
};
/**
 * "não mandem", "nunca apaguem", "não precisa criar": a negação vale só para o verbo dela, na mesma oração e sem passar de
 * uma vírgula ("Não esperem, podem enviar..." não nega o envio). Em inglês: "don't delete", "never send", "do not move".
 */
const RADICAL: Record<RiscoLiberado, string> = { enviar: '(?:mand|envi|dispar|respond|encaminh|public|post)', apagar: '(?:apag|exclu|delet)', organizar: '(?:organiz|cri|mov)' };
const RADICAL_EN: Record<RiscoLiberado, string> = { enviar: '(?:send|repl|respond|answer|forward|post|publish|email)', apagar: '(?:delet|remov|eras|trash)', organizar: '(?:organi[sz]|creat|mov|archiv)' };
/**
 * Também a vontade negada, com mais palavras até o verbo ("não quero que vocês enviem…", "I don't want you to send…",
 * "we would never like anyone to post…"), o que não pode em hipótese alguma ("em hipótese alguma enviem", "under no
 * circumstances send") e o aparte entre vírgulas ("Please don't, under any circumstances, send…"). "Não deixem de enviar"
 * e "don't hesitate/forget to send" pedem o envio: não negam.
 */
const VONTADE_PT = '(?:quero|queremos|quer|gostaria|gostariamos|aceito|aceitamos|permito|permitimos|autorizo|autorizamos|deixo|deixamos)';
const VONTADE_EN = '(?:want|wish|allow|let|permit|authori[sz]e|like)';
const APARTE = /,?\s*\b(?:under\s+(?:any|no)\s+circumstances|in\s+any\s+case|at\s+all|ever|em\s+hipotese\s+(?:alguma|nenhuma)|de\s+jeito\s+(?:algum|nenhum)|de\s+forma\s+(?:alguma|nenhuma)|de\s+modo\s+algum)\b\s*,?/g;
const negado = (oracao: string, risco: RiscoLiberado): boolean => {
  const o = oracao.replace(APARTE, (x) => (/\bno\s+circumstances\b/.test(x) ? ' never ' : /\b(?:hipotese|jeito|forma|modo)\b/.test(x) ? ' nunca ' : ' '));
  return new RegExp(`\\b(?:nao|nunca|jamais|nem)\\s+(?!esquec|hesit|deix\\w*\\s+de\\b)(?:[^\\s,]+\\s+){0,2}?${RADICAL[risco]}`).test(o)
    || new RegExp(`\\b(?:nao|nunca|jamais)\\s+${VONTADE_PT}\\b(?:\\s+[^\\s,]+){0,4}?\\s+${RADICAL[risco]}`).test(o)
    || new RegExp(`(?:\\b(?:not|never)|n't)\\s+(?!hesitate|forget|wait|need|be\\s+afraid|hold\\s+back)(?:[^\\s,]+\\s+){0,2}?${RADICAL_EN[risco]}`).test(o)
    || new RegExp(`\\bno\\s+(?:[^\\s,]+\\s+){0,1}?${RADICAL_EN[risco]}`).test(o)
    || new RegExp(`(?:\\b(?:not|never)|n't)\\s+(?:\\w+\\s+)?${VONTADE_EN}\\b(?:\\s+[^\\s,]+){0,4}?\\s+${RADICAL_EN[risco]}`).test(o);
};
/** "quem mandou?", "por que enviaram sem aprovação": o que já passou (uma reclamação, uma pergunta) não libera nada */
const PASSADO_PT = /\b(?:mandou|mandaram|enviou|enviaram|disparou|dispararam|respondeu|responderam|encaminhou|encaminharam|publicou|publicaram|postou|postaram|apagou|apagaram|excluiu|excluiram|deletou|deletaram|criou|criaram|moveu|moveram|organizou|organizaram)\b/;
// inglês: "sent" também é o particípio ("can be sent"): só com quem fez antes ("who sent", "why did you send")
const PASSADO_EN = /\b(?:who|you|they|someone|somebody|he|she)\s+(?:just\s+)?(?:sent|replied|responded|answered|forwarded|posted|published|emailed|deleted|removed|created|moved)\b|\bwhy\s+did\s+(?:you|they|someone)\b/;
const PASSADO = { test: (s: string) => PASSADO_PT.test(s) || PASSADO_EN.test(s) };
const INTERROGA = /^(?:quem|por que|porque|por qual motivo|pra que|para que|who|why|how come|what for)\b/;
/** onde a pessoa diz o canal: sem nomear e-mail, mensagem, conta ou uma conexão, "todas as conexões" seria um chute */
const CANAL = /\be-?mails?\b|\bcorreio\b|\bmensage(?:m|ns)\b|\bcontas?\b|\bcana(?:l|is)\b|\bconex(?:ao|oes)\b|\bmessages?\b|\baccounts?\b|\bchannels?\b|\bconnections?\b|\bchats?\b/;
const ROTA = Object.keys(RADICAL) as RiscoLiberado[];

/** As orações da mensagem: frases (com o fim, para saber se é pergunta), separadas também em "mas", "porém", "exceto" ("but", "except"). */
function oracoes(t: string): Array<{ texto: string; pergunta: boolean }> {
  const out: Array<{ texto: string; pergunta: boolean }> = [];
  for (const m of t.matchAll(/([^.;!?\n]+)([.;!?\n]*)/g)) {
    const pergunta = m[2].includes('?');
    for (const p of m[1].split(/,?\s+(?:mas|porem|so que|exceto|menos|contudo|entretanto|todavia|but|however|except|unless|apart from)\s+/)) if (p.trim()) out.push({ texto: p.trim(), pergunta });
  }
  return out;
}
/** A expressão "sem aprovação" numa oração (a primeira). */
function semAprovacao(oracao: string): RegExpExecArray | null {
  let melhor: RegExpExecArray | null = null;
  for (const r of SEM_APROVACAO) { const m = r.exec(oracao); if (m && (!melhor || m.index < melhor.index)) melhor = m; }
  return melhor;
}
const limpa = (texto: string): string => fold(texto).replace(/[’‘]/g, "'").replace(/[“”"]/g, ' ').replace(/\s+/g, ' ');

/**
 * A frase da pessoa, por regras: "podem mandar os e-mails sem me pedir aprovação" → a proposta (o cartão). Conta o verbo
 * ligado à expressão "sem aprovação" (antes dela, ou logo depois: "não precisa me pedir aprovação para enviar"), na mesma
 * oração; o que ela nega em outra oração ("mas não apaguem nada") sai da lista em vez de anular tudo. Pergunta e passado
 * ("quem mandou enviar sem a minha aprovação?") não propõem. E-mail sem dizer qual conta: as contas de e-mail conectadas
 * (Microsoft e Google); sem dizer canal nenhum (nem e-mail, nem mensagem, nem conta): nada. Sem dizer o alcance: só neste
 * pedido; "sempre", "a partir de agora": sempre; "hoje", "por 24 h": 24 h. Só propõe: nada muda até o clique dela.
 */
export function regraDaFrase(texto: string, ligadas: readonly string[]): RegraSemResumo | null {
  const t = limpa(texto);
  if (t.length > 4000) return null;
  const partes = oracoes(t);
  const riscos = new Set<RiscoLiberado>();
  let achou = false;
  for (const o of partes) {
    const m = semAprovacao(o.texto);
    if (!m) continue;
    achou = true;
    if (o.pergunta || INTERROGA.test(o.texto) || PASSADO.test(o.texto)) return null;
    const antes = o.texto.slice(0, m.index);
    const resto = o.texto.slice(m.index + m[0].length);
    // logo depois da expressão, só quando ela pede o complemento: "aprovação para enviar", "liberados a mandar"
    const logoDepois = /\b(?:a|para|pra|to)$/.test(m[0]) || /^\s*(?:para|pra|de|to|for)\b/.test(resto) ? resto.trim().split(' ').slice(0, 4).join(' ') : '';
    for (const r of ROTA) if ((VERBO[r].test(antes) || VERBO[r].test(logoDepois)) && !negado(o.texto, r)) riscos.add(r);
  }
  if (!achou) return null;
  // "mas não apaguem nada", "não precisa criar card": o verbo negado noutra oração não entra
  for (const o of partes) for (const r of ROTA) if (negado(o.texto, r)) riscos.delete(r);
  if (!riscos.size) return null;
  const email = /\be-?mails?\b|\bcorreio\b/.test(t);
  const outroCanal = /\bmensage(?:m|ns)\b|\bteams\b|\bwhats|\bmessages?\b|\bchats?\b/.test(t);
  const so = email && !outroCanal ? 'email' as const : null;
  const nomeadas = new Set<string>();
  for (const [alias, k] of Object.entries(ALIAS)) if (new RegExp(`\\b${alias}\\b`).test(t)) nomeadas.add(k);
  for (const d of INTEGRATIONS) if (d.kind !== 'microsoft' && d.kind !== 'google' && new RegExp(`\\b${fold(d.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(t)) nomeadas.add(d.kind);
  if (!nomeadas.size && !CANAL.test(t)) return null;
  const doEmail = ligadas.filter((k) => k === 'microsoft' || k === 'google');
  const conexoes = nomeadas.size ? [...nomeadas] : so === 'email' ? (doEmail.length ? doEmail : ['microsoft', 'google']) : ['*'];
  const alcance: Alcance = /\b(?:sempre|a partir de agora|de agora em diante|daqui (?:pra|para) frente|daqui em diante|permanente\w*|always|from now on|going forward|from here on|permanently|forever)\b/.test(t) ? 'sempre'
    : /\b(?:hoje|24 ?h|24 horas|por um dia|ate amanha|today|for 24 ?hours|for a day|for the day|until tomorrow)\b/.test(t) ? '24h' : 'pedido';
  return { kind: 'regra', riscos: RISCOS_LIBERAVEIS.filter((r) => riscos.has(r)), conexoes, so, alcance };
}

/** Palavras que, sozinhas, não dizem nada além da liberação ("a partir de agora", "podem", "os e-mails", "por favor"). */
const ENCHIMENTO = new Set(['pode', 'podem', 'podes', 'voces', 'voce', 'vcs', 'mails', 'mail', 'emails', 'email', 'e-mail', 'e-mails', 'mensagens', 'mensagem', 'tambem', 'todos', 'todas',
  'tudo', 'agora', 'entao', 'sim', 'nos', 'para', 'pra', 'por', 'favor', 'obrigado', 'obrigada', 'combinado', 'certo', 'beleza', 'pessoal', 'equipe', 'gente', 'time', 'partir',
  'diante', 'daqui', 'frente', 'sempre', 'hoje', 'horas', 'dia', 'ola', 'bom', 'boa', 'isso', 'esses', 'essas', 'estes', 'estas', 'meus', 'minhas', 'seus', 'suas',
  // inglês
  'you', 'can', 'all', 'guys', 'team', 'everyone', 'from', 'now', 'going', 'forward', 'always', 'today', 'please', 'thanks', 'the', 'messages', 'message', 'also', 'sure',
  'okay', 'then', 'here', 'hours', 'day', 'your', 'our', 'and', 'any', 'anymore', 'just', 'feel', 'free', 'hey', 'hello']);
/**
 * A mensagem só libera (nada além de "a partir de agora, podem mandar os e-mails sem me pedir aprovação")? Então a regra que
 * vale de verdade substitui a regra de texto. Com outra coisa junto ("respondam sempre em inglês"), as duas propostas ficam.
 */
export function soLiberacao(texto: string): boolean {
  for (const o of oracoes(limpa(texto))) {
    for (const pedaco of o.texto.split(/,|\s+e\s+/)) {
      if (semAprovacao(pedaco)) continue;
      const sobra = pedaco.trim().split(' ').filter((w) => w.length >= 3 && !ENCHIMENTO.has(w) && !ROTA.some((r) => VERBO[r].test(w)));
      if (sobra.length) return false;
    }
  }
  return true;
}

/**
 * Proposta escrita pela coordenação ([[regra ...]]), não pela pessoa: o cartão diz quem sugeriu, e o alcance em destaque
 * nunca é "sempre" (ela ainda pode escolher). Quem filtra o que veio depois de ler conteúdo de fora é o app (onFinish).
 */
export function sugestaoDoAgente(r: RegraSemResumo): PropostaRegra {
  const x: RegraSemResumo = { ...r, alcance: r.alcance === 'sempre' ? 'pedido' : r.alcance, sugerida: true };
  return { ...x, resumo: resumoDaProposta(x) };
}
export const mesmaRegra = (a: Pick<RegraSemResumo, 'riscos' | 'conexoes' | 'so'>, b: Pick<RegraSemResumo, 'riscos' | 'conexoes' | 'so'>): boolean =>
  [...a.riscos].sort().join() === [...b.riscos].sort().join() && [...a.conexoes].sort().join() === [...b.conexoes].sort().join() && (a.so ?? null) === (b.so ?? null);

// ------------------------------------------------------------------------------------------ o pedido de uma execução
type RunDoPedido = { id: string; task_id: string | null; idempotency_key: string; conversation_id?: string | null };
/**
 * O pedido de onde veio uma execução: ela mesma, o card dela e a cadeia que o originou (o card pai, a execução que abriu o
 * card) e as continuações (depois de um cartão, de uma aprovação ou de uma regra, a execução que pediu).
 */
export function cadeiaDoPedido(db: Db, r: RunDoPedido): Ancora {
  const runs = new Set<string>(); const tasks = new Set<string>();
  const filaR: Array<string | null> = [r.id]; const filaT: Array<string | null> = [r.task_id];
  const umaRun = (rid: string) => db.get<{ id: string; task_id: string | null; idempotency_key: string }>('SELECT id, task_id, idempotency_key FROM runs WHERE id = ?', rid);
  for (let i = 0; (filaR.length || filaT.length) && i < 40; i++) {
    const rid = filaR.pop();
    if (rid && !runs.has(rid)) {
      runs.add(rid);
      const x = rid === r.id ? r : umaRun(rid);
      if (x) {
        filaT.push(x.task_id);
        const k = x.idempotency_key;
        if (k.startsWith('conexao-')) filaR.push(db.get<{ run_id: string | null }>('SELECT run_id FROM conexao_acoes WHERE id = ?', k.slice('conexao-'.length))?.run_id ?? null);
        const ap = /^(?:aprovado|recusado|regra)-(apr_[0-9a-f]{32})/.exec(k);
        if (ap) filaR.push(db.get<{ run_id: string | null }>('SELECT run_id FROM agent_proposals WHERE id = ?', ap[1])?.run_id ?? null);
      }
    }
    const tid = filaT.pop();
    if (tid && !tasks.has(tid)) {
      tasks.add(tid);
      const t = db.get<{ parent_task_id: string | null; origin_run_id: string | null }>('SELECT parent_task_id, origin_run_id FROM tasks WHERE id = ?', tid);
      if (t) { filaT.push(t.parent_task_id); filaR.push(runDeOrigem(t.origin_run_id)); }
    }
  }
  return { runs: [...runs], tasks: [...tasks] };
}
const toca = (a: Ancora, b: Ancora): boolean => a.runs.some((x) => b.runs.includes(x)) || a.tasks.some((x) => b.tasks.includes(x));

// ---------------------------------------------------------------------------------------------------- o serviço
export class RegrasConexoes {
  private readonly db: Db; private readonly bus: Bus;
  constructor(db: Db, bus: Bus) { this.db = db; this.bus = bus; }

  /** As regras que valem agora (ativas e dentro do prazo). */
  ativas(ws: string, tipo?: RegraConexao['tipo']): RegraConexao[] {
    return this.db.all<Linha>(`SELECT * FROM regras_conexoes WHERE workspace_id = ? AND status = 'ativa' AND (expira_em IS NULL OR expira_em > ?)${tipo ? ' AND tipo = ?' : ''} ORDER BY created_at`,
      ws, now(), ...(tipo ? [tipo] : [])).map(daLinha);
  }
  get(ws: string, regraId: string): RegraConexao | null {
    const l = this.db.get<Linha>('SELECT * FROM regras_conexoes WHERE id = ? AND workspace_id = ?', regraId, ws);
    return l ? daLinha(l) : null;
  }

  /**
   * A regra que deixa esta ação ir direto, ou null. Ler não precisa de regra. Apagar só pela regra que fala em apagar.
   * "Só neste pedido" vale quando todas as execuções que podem ter chamado (as que dividem a sessão: juntas) são daquele
   * pedido; com execução de código ligada, a sessão pode ser outra se passando por ela, e só valem as do workspace inteiro.
   */
  cobre(ws: string, runs: readonly RunDoPedido[], kind: string, acaoId: string, risco: Risco, codigoLigado: boolean): RegraConexao | null {
    if (risco === 'ler') return null;
    const casam = this.ativas(ws, 'acao').filter((r) => r.oque.includes(risco) && (r.conexoes.includes('*') || r.conexoes.includes(kind)) && (!r.so || acaoId.startsWith(`${r.so}.`)));
    const doWorkspace = casam.find((r) => r.alcance !== 'pedido');
    if (doWorkspace) return doWorkspace;
    const doPedido = casam.filter((r) => r.alcance === 'pedido' && r.ancora);
    if (!doPedido.length || codigoLigado || !runs.length) return null;
    const cadeias = runs.map((x) => cadeiaDoPedido(this.db, x));
    return doPedido.find((r) => cadeias.every((c) => this.noPedido(this.pedidoDa(r), c))) ?? null;
  }

  /** O pedido de uma regra "só neste pedido": a mensagem seguinte dela conta até PEDIDO_SEGUE_MS depois da aprovação. */
  private pedidoDa(r: RegraConexao): Pedido {
    return { ancora: r.ancora ?? { runs: [], tasks: [] }, conversationId: r.conversation_id, ate: Date.parse(r.created_at) + PEDIDO_SEGUE_MS };
  }

  /** As execuções (as que dividem a sessão: juntas) são todas deste pedido? */
  doPedido(p: Pedido, runs: readonly RunDoPedido[]): boolean {
    return runs.length > 0 && runs.every((x) => this.noPedido(p, cadeiaDoPedido(this.db, x)));
  }

  /**
   * Uma cadeia é do pedido quando toca a âncora (a execução que propôs, o card dela e o que nasceu deles), ou quando parte de
   * uma mensagem seguinte da própria pessoa na mesma conversa, depois do começo do pedido e até `ate`. Execuções mais antigas
   * da conversa e cards abertos de outros pedidos ficam de fora.
   */
  private noPedido(p: Pedido, c: Ancora): boolean {
    if (toca(c, p.ancora)) return true;
    if (!p.conversationId || !p.ancora.desde) return false;
    return c.runs.some((rid) => {
      const x = this.db.get<{ conversation_id: string | null; idempotency_key: string; created_at: string }>('SELECT conversation_id, idempotency_key, created_at FROM runs WHERE id = ?', rid);
      if (!x || x.conversation_id !== p.conversationId || x.created_at < p.ancora.desde! || Date.parse(x.created_at) > p.ate) return false;
      // chat.ts: chat-<id da mensagem dela>; a mensagem existe, é dela (quem escreveu foi a pessoa) e é desta conversa
      const m = /^chat-(msg_[0-9a-f]{32})(?:-de-novo-\d+)?$/.exec(x.idempotency_key);
      return !!m && !!this.db.get("SELECT 1 AS x FROM messages WHERE id = ? AND conversation_id = ? AND role = 'user' AND author_user_id IS NOT NULL", m[1], p.conversationId);
    });
  }

  /** "Sempre" no cartão de aprovação depois de ler as contas: aquele grupo vai direto no workspace inteiro. */
  depoisDeLerSempre(ws: string, grupo: GrupoDepoisDeLer): RegraConexao | null {
    return this.ativas(ws, 'depois_de_ler').find((r) => r.oque.includes(grupo)) ?? null;
  }

  /**
   * O pedido em que a regra foi aprovada: a execução que propôs e o card dela. O que nasce deles entra pela cadeia
   * (cadeiaDoPedido) e as mensagens seguintes da pessoa na conversa, por `desde` (noPedido). Execuções mais antigas da
   * conversa e cards abertos de outros pedidos não entram, mesmo com um cartão esperando.
   */
  ancoraDe(ws: string, runId: string | null): Ancora {
    const r = runId ? this.db.get<{ task_id: string | null; created_at: string }>('SELECT task_id, created_at FROM runs WHERE id = ? AND workspace_id = ?', runId, ws) : undefined;
    if (!runId || !r) return { runs: [], tasks: [] };
    return { runs: [runId], tasks: r.task_id ? [r.task_id] : [], desde: r.created_at };
  }
  /** O pedido de agora, no clique (o que já esperava e sai com a regra é só dele, qualquer que seja o alcance). */
  pedidoDoClique(ws: string, conversationId: string | null, runId: string | null): Pedido {
    return { ancora: this.ancoraDe(ws, runId), conversationId, ate: Date.now() };
  }

  /** O clique no cartão de regra: grava a regra com o alcance escolhido e registra quem aprovou e o que liberou. */
  aplicar(ws: string, userId: string, p: { id: string; conversationId: string | null; runId: string | null; proposta: RegraSemResumo }, alcance: Alcance): RegraConexao {
    const agora = Date.now();
    const ancora = alcance === 'pedido' ? this.ancoraDe(ws, p.runId) : null;
    const expira = alcance === 'sempre' ? null : new Date(agora + (alcance === '24h' ? 24 * HORA : PEDIDO_VALE_MS)).toISOString();
    const regraId = id('rgc');
    this.db.run(`INSERT INTO regras_conexoes (id, workspace_id, tipo, oque, conexoes, so, alcance, ancora, conversation_id, expira_em, status, aprovada_por, proposta_id, created_at)
      VALUES (?, ?, 'acao', ?, ?, ?, ?, ?, ?, ?, 'ativa', ?, ?, ?)`, regraId, ws, JSON.stringify(p.proposta.riscos), JSON.stringify(p.proposta.conexoes), p.proposta.so,
      alcance, ancora ? JSON.stringify(ancora) : null, p.conversationId, expira, userId, p.id, now());
    const r = this.get(ws, regraId)!;
    // a mesma regra do workspace inteiro aprovada de novo (por 24 h ou sempre): a nova substitui a de antes, sem duplicar a lista
    const substituidas = alcance === 'pedido' ? [] : this.ativas(ws, 'acao').filter((x) => x.id !== regraId && x.alcance !== 'pedido' && mesmaRegra({ riscos: x.oque as RiscoLiberado[], conexoes: x.conexoes, so: x.so }, p.proposta)).map((x) => x.id);
    for (const sid of substituidas) this.db.run("UPDATE regras_conexoes SET status = 'desfeita', desfeita_em = ?, desfeita_por = ? WHERE id = ?", now(), userId, sid);
    audit(this.db, this.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'conexoes.regra.aprovada', targetType: 'regra', targetId: regraId,
      evidence: { riscos: p.proposta.riscos, conexoes: p.proposta.conexoes, so: p.proposta.so, alcance, expira_em: expira, proposta: p.id, ancora, ...(substituidas.length ? { substituiu: substituidas } : {}) },
      result: `você liberou sem confirmação: ${descreverRegra(p.proposta)} (${descreverAlcance(r)})` });
    this.bus.publish(ws, 'rules.changed', { id: regraId });
    return r;
  }

  /** "Sempre" no cartão de aprovação depois de ler as contas. */
  liberarDepoisDeLer(ws: string, userId: string, grupo: GrupoDepoisDeLer, propostaId: string | null): RegraConexao {
    const ja = this.depoisDeLerSempre(ws, grupo);
    if (ja) return ja;
    const regraId = id('rgc');
    this.db.run(`INSERT INTO regras_conexoes (id, workspace_id, tipo, oque, conexoes, so, alcance, status, aprovada_por, proposta_id, created_at)
      VALUES (?, ?, 'depois_de_ler', ?, '["*"]', NULL, 'sempre', 'ativa', ?, ?, ?)`, regraId, ws, JSON.stringify([grupo]), userId, propostaId, now());
    audit(this.db, this.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'conexoes.regra.aprovada', targetType: 'regra', targetId: regraId,
      evidence: { grupo, alcance: 'sempre', proposta: propostaId }, result: `você liberou sempre: ${descreverGrupo(grupo)}` });
    this.bus.publish(ws, 'rules.changed', { id: regraId });
    return this.get(ws, regraId)!;
  }

  /** "Desfazer": a regra para de valer na hora; o que ela liberou volta a pedir confirmação. */
  desfazer(ws: string, userId: string, regraId: string): RegraConexao {
    const r = this.get(ws, regraId);
    if (!r) throw notFound('regra');
    if (r.status !== 'ativa') throw new HttpError(409, 'desfeita', 'esta regra já foi desfeita');
    this.db.run("UPDATE regras_conexoes SET status = 'desfeita', desfeita_em = ?, desfeita_por = ? WHERE id = ?", now(), userId, regraId);
    audit(this.db, this.bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'conexoes.regra.desfeita', targetType: 'regra', targetId: regraId,
      evidence: { tipo: r.tipo, oque: r.oque, conexoes: r.conexoes, alcance: r.alcance }, result: `você desfez: ${this.texto(r)}` });
    this.bus.publish(ws, 'rules.changed', { id: regraId });
    return { ...r, status: 'desfeita' };
  }

  texto(r: RegraConexao): string {
    return r.tipo === 'depois_de_ler' ? lista(r.oque.map((g) => descreverGrupo(g as GrupoDepoisDeLer))) : descreverRegra({ riscos: r.oque, conexoes: r.conexoes, so: r.so });
  }

  /** Conexões › Regras: as aprovadas (estas e as de texto ativas) e as propostas esperando. */
  tela(ws: string) {
    const regras = this.ativas(ws).map((r) => ({
      id: r.id, tipo: r.tipo, texto: this.texto(r), alcance: r.alcance, alcanceTexto: descreverAlcance(r), expiraEm: r.expira_em, criadaEm: r.created_at,
      apagar: r.tipo === 'acao' && r.oque.includes('apagar'),
      usos: Number(this.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM conexao_acoes WHERE regra_id = ? AND status = 'feita'", r.id)?.n ?? 0),
    }));
    const texto = this.db.all<{ id: string; text: string; created_at: string; decided_at: string | null }>("SELECT id, text, created_at, decided_at FROM rules WHERE workspace_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 50", ws);
    const textoPropostas = this.db.all<{ id: string; text: string; created_at: string }>("SELECT id, text, created_at FROM rules WHERE workspace_id = ? AND status = 'proposed' ORDER BY created_at DESC LIMIT 30", ws);
    const cartoes = this.db.all<{ id: string; summary: string; payload: string; conversation_id: string | null; agent_id: string | null; agent_name: string | null; created_at: string }>(
      `SELECT p.id, p.summary, p.payload, p.conversation_id, c.agent_id, a.name AS agent_name, p.created_at FROM agent_proposals p
         LEFT JOIN conversations c ON c.id = p.conversation_id LEFT JOIN agents a ON a.id = c.agent_id
        WHERE p.workspace_id = ? AND p.kind = 'regra' AND p.status = 'proposed' ORDER BY p.created_at DESC LIMIT 30`, ws)
      .map(({ payload, ...x }) => ({ ...x, alcance: (JSON.parse(payload) as PropostaRegra).alcance }));
    return { regras, texto, propostas: { texto: textoPropostas, cartoes } };
  }
}
