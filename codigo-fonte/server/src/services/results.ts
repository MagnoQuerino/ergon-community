/**
 * Contrato de resultado: um card da equipe só é concluído com evidência. Cada execução da fila gera um registro
 * (task_results, um por execução) com o tipo de trabalho, os critérios aplicados, as evidências e a decisão — e o
 * card segue o estado real do trabalho:
 *
 *   solicitada → processamento → resultado produzido → validação → concluída
 *   (ou: aguardando informações · falha · revisão necessária · aguardando aprovação)
 *
 * Execução concluída não é trabalho concluído. O texto do modelo nunca basta sozinho: "concluído" sem conteúdo,
 * resposta simulada, pergunta pendente, entregável ausente ou número não conferido deixam o card aberto, com o
 * motivo. Ação externa (enviar, pagar, publicar…) nunca é presumida: o que uma conta conectada faz vale pelo registro
 * do serviço (conexao_acoes); o que nenhuma conexão faz (pagar um boleto) espera a sua confirmação. "Não consegui" é
 * falha, nunca entrega. Conclusão humana é soberana e nunca é desfeita por aqui.
 */
import type { Db } from '../db/db.ts';
import { HttpError, clip, fold, id, now } from '../lib/util.ts';
import { emPt, tx } from '../lib/textos.ts';
import { idioma, semNomeComum } from '../lib/idioma.ts';
import { audit, type Bus } from './bus.ts';
import { saveArtifact } from './artifacts.ts';
import { TOOLS, motorScope, platformToolsets, toolStatus } from './characters.ts';
import { acoesDe, acoesLigadas, ajusteDe, RISCOS } from './conexoes/catalogo.ts';
import type { Risco } from './conexoes/tipos.ts';
import { MARCA_PESSOA, episodioDoCard, type MotivoPessoa } from './episodio.ts';
import { integrationDef, integrationRow, settingsOf, type IntegrationKind } from './integrations.ts';
import { linkFile, taskFiles, type Operations, type OperationRow } from './operations.ts';
import type { RunRow, RunStatus } from './runs.ts';
import { getTask, updateTask, type Actor } from './tasks.ts';
import { questionIn } from './purpose.ts';
import { semLinhaParaVoce } from './resumo-tarefa.ts';
import { colunaPorChave, type ChaveColuna } from './colunas.ts';

export type ResultKind = 'informativo' | 'documental' | 'dados' | 'externo';
/** descartado: a pessoa recusou no cartão a ação que era o trabalho do card (não é falha nem entrega; o card fica aberto esperando ela) */
export type ResultState = 'validado' | 'reprovado' | 'aguardando_aprovacao' | 'aguardando_info' | 'sem_confirmacao' | 'falha' | 'confirmado_humano' | 'devolvido' | 'descartado';
export type WorkState = 'solicitada' | 'processamento' | 'resultado' | 'validacao' | 'concluida' | 'aguardando_info' | 'falha' | 'revisao' | 'aguardando_aprovacao';
export interface Criterion { id: string; label: string; ok: boolean; detail?: string }
export interface ResultRow {
  id: string; workspace_id: string; task_id: string; run_id: string | null; kind: ResultKind; state: ResultState;
  criteria: string; evidence: string; justification: string; decided_by: string; created_at: string; decided_at: string | null;
}

export const WORK_LABEL: Record<WorkState, string> = {
  solicitada: 'Solicitada', processamento: 'Em processamento', resultado: 'Resultado produzido', validacao: 'Em validação', concluida: 'Concluída',
  aguardando_info: 'Aguardando informações', falha: 'Falha', revisao: 'Revisão necessária', aguardando_aprovacao: 'Aguardando aprovação',
};
export const KIND_LABEL: Record<ResultKind, string> = {
  informativo: 'Informativo (a resposta basta)', documental: 'Documental (exige um documento entregue)',
  dados: 'Dados (números calculados do arquivo)', externo: 'Externo (exige confirmação da fonte)',
};
/**
 * Coluna do quadro de cada estado, pelo código fixo (colunas.ts), nunca pelo nome: revisão, espera e falha ficam em
 * andamento (o estado real aparece no card).
 */
const COLUMN: Record<WorkState, ChaveColuna> = {
  solicitada: 'todo', processamento: 'doing', resultado: 'doing', validacao: 'doing', concluida: 'done',
  aguardando_info: 'doing', falha: 'doing', revisao: 'doing', aguardando_aprovacao: 'with_you',
};
/** coluna de quem está esperando você (aprovação); quadro antigo sem ela: fica em andamento */
export const WITH_YOU: ChaveColuna = 'with_you';
/** descartado (recusado por você no cartão): o card fica aberto esperando o que mudar, ou que você o cancele */
const WORK_OF: Record<ResultState, WorkState | null> = {
  validado: 'concluida', confirmado_humano: 'concluida', aguardando_aprovacao: 'aguardando_aprovacao', sem_confirmacao: 'aguardando_aprovacao',
  aguardando_info: 'aguardando_info', reprovado: 'revisao', falha: 'falha', devolvido: 'solicitada', descartado: 'aguardando_info',
};

/**
 * As conferências entendem português e inglês, sempre as duas juntas (a pessoa pode misturar, e a equipe responde no
 * idioma de quem pediu). O texto chega sem acentos e em minúsculas (fold), com o apóstrofo curvo trocado pelo reto
 * ("couldn’t" = "couldn't"): o comprimento não muda, e as posições valem no texto original.
 */
const fe = (s: string) => fold(s).replace(/[’‘ʼ`]/g, "'");
/** junta dois grupos de alternativas "(a|b)" e "(c|d)" em "(a|b|c|d)" */
const alt = (...gs: string[]) => `(${gs.map((g) => g.slice(1, -1)).join('|')})`;

const has = (t: string, stems: string[]) => stems.some((s) => new RegExp(`(^|[^a-z])${s}`).test(t));
const DATA = ['analis', 'analiz', 'indicador', 'desempenho', 'planilh', 'dados', 'metric', 'estatistic', 'relatori', 'kpi', 'csv', 'percentu', 'contag', 'calcul', 'resumo',
  // inglês
  'analy', 'indicator', 'performance', 'spreadsheet', 'data\\b', 'statistic', 'reports?\\b', 'reporting\\b', 'percent', 'count(s|ing)?\\b', 'summar'];
// Só verbos de ação (infinitivo e imperativo). Radicais soltos pegavam substantivos e adjetivos: "dados públicos" e
// "páginas públicas" (publi[cq]) faziam uma pesquisa virar "ação externa à espera de confirmação", e a resposta não
// voltava a quem pediu; "agenda", "telefone", "compra" e "versão paga" também caíam aqui.
const EXTERNAL = ['enviar\\b', 'envie\\b', 'mandar\\b', 'mande\\b', 'publicar', 'publique', 'postar\\b', 'poste\\b', 'agendar\\b', 'agende\\b',
  'marcar (uma )?reuniao', 'pagar\\b', 'pague\\b', 'quitar', 'transferir', 'transfira', 'comprar\\b', 'compre\\b', 'contratar\\b', 'contrate\\b',
  'ligar para', 'telefonar', 'cadastrar\\b', 'cadastre\\b', 'responder (ao|a|o) (cliente|fornecedor)', 'protocolar', 'submeter', 'assinar',
  // inglês: o verbo no imperativo (o mesmo que o infinitivo, com "to" antes: ver externoDeFato). Em inglês o verbo e o
  // substantivo costumam ser a mesma palavra ("pay", "transfer", "hire"): esses só contam com o objeto logo depois
  'send\\b', 'publish\\b', 'post (it|this|that|them|the|on|in|to)\\b', 'schedule (a |an |the )?(meeting|call|appointment)', 'book (a |an |the )?(meeting|call|room|flight|hotel|appointment)',
  'pay (the|this|that|it|them|my|our|an?|for)\\b', 'wire (the|money|funds)\\b', 'transfer (the |money|funds|\\d)', 'buy (the|a|an|some|it|them|\\d)', 'purchase (the|a|an|some|it|them)\\b',
  'hire (a|an|the|someone)\\b', 'phone (him|her|them|the)\\b', 'sign up (for|to|on)\\b', 'register (the|a|an|me|us|for|on)\\b',
  'reply to (the )?(client|customer|supplier|vendor)', 'respond to (the )?(client|customer|supplier|vendor)', 'submit (the|this|a|an|it|our|my)\\b', 'sign (the|this) (contract|agreement|document|form)'];
const DOCUMENT = ['relatori', 'document', 'propost', 'redig', 'redac', 'escrev', 'texto', 'plano', 'apresentac', 'roteiro', 'artigo', 'carta', 'comunicado', 'parecer', 'manual', 'politica', 'procedimento', 'ata\\b', 'e-?mail', 'resumo', 'minuta', 'contrato', 'briefing', 'post\\b',
  // inglês
  // "report" sem o fim da palavra pegava o português "reporte ao fornecedor", "reportagem"
  'reports?\\b', 'reporting\\b', 'proposal', 'draft', 'write\\b', 'writing', 'text\\b', 'plan\\b', 'presentation', 'script', 'article', 'letter', 'memo\\b', 'announcement', 'policy', 'procedure', 'minutes\\b', 'summary', 'contract', 'brief\\b'];

/** Tipo de trabalho, pelas palavras do pedido e pelos arquivos que vieram com ele (sem modelo). */
export function classifyTask(text: string, hasCsvInput: boolean): ResultKind {
  const t = fe(text);
  if (hasCsvInput && has(t, DATA)) return 'dados';
  if (externoDeFato(t)) return 'externo';
  if (has(t, DOCUMENT)) return 'documental';
  return 'informativo';
}

const SIMULATED = '[Simulação — sem modelo de IA]';
/** "Concluído.", "Feito!", "Tarefa realizada com sucesso" — alegação de conclusão sem o trabalho. */
const CLAIM_PT = /^(ok[.!]?\s*)?((a )?tarefa |o trabalho |tudo )?(foi )?(conclu[ií]d[ao]|feit[ao]|pront[ao]|realizad[ao]|finalizad[ao]|entregue|resolvid[ao]|done)( com sucesso)?[.!]*$/i;
/** "Done.", "All done!", "Task completed successfully", "It's finished." */
const CLAIM_EN = /^(ok(ay)?[.!,]?\s*)?((the )?task |the work |it |this |that |everything |all )?(is |was |has been |'s |is now |have been )?(all )?(done|complete|completed|finished|ready|delivered|resolved|sorted)( successfully)?[.!]*$/i;
const CLAIM = { test: (s: string) => CLAIM_PT.test(s) || CLAIM_EN.test(s.replace(/[’‘]/g, "'")) };
const words = (s: string) => (s.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? []).length;
const control = (s: string) => s.replace(/\[\[(?:[^\]]|\](?!\]))*\]\]/g, ' ').replace(/\s+/g, ' ').trim();
const MIN_WORDS: Record<ResultKind, number> = { informativo: 25, documental: 120, dados: 0, externo: 25 };

/**
 * O documento como entrega: sem linhas de controle e sem a frase de conversa antes do título ("Segue o documento…"),
 * quando o título aparece logo no começo. Sem título perto do começo, o texto fica inteiro.
 */
export function deliverableBody(raw: string): string {
  const s = raw.replace(/\[\[(?:[^\]]|\](?!\]))*\]\]\s*/g, '').trim();
  const lines = s.split(/\r?\n/);
  const h = lines.findIndex((l) => /^#{1,3}\s+\S/.test(l));
  if (h > 0 && h <= 3 && lines.slice(0, h).join(' ').trim().length <= 200) return lines.slice(h).join('\n').trim();
  return s;
}

// --- conferência pelas Conexões: o que o pedido quer fazer numa conta e o que o serviço registrou -------------------

/**
 * Verbos no infinitivo, no imperativo e na forma do dia a dia ("responde o João", "lê meus emails", "dá uma olhada"):
 * "o e-mail enviado ontem" não é pedido de envio, e "o que o cliente responde" também não (sujeito antes do verbo, em pede).
 */
const ENVIAR_PT = '(enviar|envie|envia|mandar|mande|manda|responder|responda|responde|encaminhar|encaminhe|encaminha|disparar|dispare|dispara|repassar|repasse|repassa|avisar|avise|avisa)';
const MENSAGEM_PT = '(enviar|envie|envia|mandar|mande|manda|responder|responda|responde|avisar|avise|avisa|escrever|escreva|escreve|postar|poste|posta|publicar|publique|publica|falar|fale|fala|perguntar|pergunte|cobrar|cobre|cobra|chamar|chame|chama|diga (ao|a|para|pro|pra))';
const LER_PT = '(ler|leia|le|resumir|resuma|resume|buscar|busque|busca|procurar|procure|procura|verificar|verifique|verifica|ver|veja|ve|olhar|olhe|olha|levantar|levante|levanta|listar|liste|checar|cheque|checa|varrer|varra|varre|avaliar|avalie|avalia|analisar|analise|analisa|monitorar|monitore|monitora|acompanhar|acompanhe|acompanha|mapear|mapeie|mapeia|extrair|extraia|extrai|conferir|confira|confere|(da|de|dar) uma olhada|o que (rolou|chegou))';
const CRIAR_PT = '(criar|crie|cria|cadastrar|cadastre|cadastra|lancar|lance|lanca|jogar|jogue|joga|abrir|abra|abre|adicionar|adicione|adiciona|registrar|registre|registra|colocar|coloque|coloca|incluir|inclua|inclui|subir|suba|sobe|passar|passe|transformar|transforme|transforma|botar|bote|bota|ponha)';
const MUDAR_PT = '(concluir|conclua|conclui|fechar|feche|fecha|finalizar|finalize|finaliza|marcar|marque|marca|mover|mova|move|arrastar|arraste|arrasta|atualizar|atualize|atualiza)';
const AGENDAR_PT = '(agendar|agende|marcar|marque|marca|remarcar|remarque|remarca|desmarcar|desmarque|desmarca|bloquear|bloqueie|bloqueia|reservar|reserve|reserva)';
// inglês: o imperativo é a própria forma base ("send", "reply"); a terceira pessoa tem -s ("the client replies") e não casa
const ENVIAR_EN = "(send|reply|respond|answer|forward|notify|let (him|her|them) know)";
// "tell me what…" e "ask me" são para a própria pessoa, não uma mensagem a alguém
const MENSAGEM_EN = "(send|reply|respond|answer|notify|write|post|publish|tell (?!me |us )[a-z]+|ask (?!me |us )[a-z]+|text|ping|message|dm|chase|follow up with)";
const LER_EN = "(read|summari[sz]e|search|look (at|through|for|into)|check|review|go through|scan|list|find|fetch|see|monitor|track|analy[sz]e|extract|catch up on|what (came in|arrived|happened))";
const CRIAR_EN = "(create|add|make|open|log|register|put|turn|set up|enter|file)";
const MUDAR_EN = "(complete|close|finish|mark|move|update|check off|tick off)";
const AGENDAR_EN = "(schedule|book|set up|reschedule|cancel|block|reserve|arrange)";
const ENVIAR = alt(ENVIAR_PT, ENVIAR_EN);
const MENSAGEM = alt(MENSAGEM_PT, MENSAGEM_EN);
const LER = alt(LER_PT, LER_EN);
const CRIAR = alt(CRIAR_PT, CRIAR_EN);
const MUDAR = alt(MUDAR_PT, MUDAR_EN);
const AGENDAR = alt(AGENDAR_PT, AGENDAR_EN);
/** o verbo achado é do inglês (para as regras do inglês: o sujeito antes dele, o "to" do infinitivo) */
const VERBO_EN = new RegExp(`^${alt(ENVIAR_EN, MENSAGEM_EN, LER_EN, CRIAR_EN, MUDAR_EN, AGENDAR_EN)}$`);
/** Endereço de e-mail citado no pedido ("envie a proposta para ana@empresa.com.br"). */
const ENDERECO = '[a-z0-9_+-]+(\\.[a-z0-9_+-]+)*@[a-z0-9-]+\\.[a-z]';
/** A forma do dia a dia é também a da terceira pessoa ("o cliente responde"): com sujeito logo antes, não é pedido. */
const COLOQUIAL = new Set(['envia', 'manda', 'responde', 'encaminha', 'dispara', 'repassa', 'avisa', 'escreve', 'posta', 'publica', 'fala', 'cobra', 'chama',
  'le', 'resume', 'busca', 'procura', 'verifica', 've', 'olha', 'levanta', 'checa', 'varre', 'avalia', 'analisa', 'monitora', 'acompanha', 'mapeia', 'extrai', 'confere',
  'cria', 'cadastra', 'lanca', 'joga', 'abre', 'adiciona', 'registra', 'coloca', 'inclui', 'sobe', 'transforma', 'bota', 'conclui', 'fecha', 'finaliza', 'marca', 'move',
  'arrasta', 'atualiza', 'remarca', 'desmarca', 'bloqueia', 'reserva']);
const VERBO_DO_PEDIDO = new RegExp(`\\b(${[ENVIAR, MENSAGEM, LER, CRIAR, MUDAR, AGENDAR].map((x) => x.slice(1, -1)).join('|')})\\b`);
/**
 * "o cliente responde" (português) e "they reply", "when I ask" (inglês): com sujeito logo antes, não é pedido (a terceira
 * pessoa do inglês tem -s e já não casa: "the client replies")
 */
const SUJEITO_EN = /\b(he|she|they|it|who|nobody|no one|someone|somebody|everyone|everybody|i|we)\s+(also\s+|usually\s+|always\s+|never\s+|often\s+|just\s+)?$/;
const TAREFAS = '(tarefas?|cards?|itens|atividades?|pendencias?|tasks?|items?|to-?dos?)';
/** a e b na mesma frase, perto um do outro, nas duas ordens */
const perto = (a: string, b: string, n = 70) => new RegExp(`\\b${a}\\b[^.?!\\n]{0,${n}}\\b${b}|\\b${b}[^.?!\\n]{0,40}\\b${a}\\b`);
/** o aplicativo citado como lugar ("no Planner", "pelo Trello", "in Planner", "on Slack"): "regressão linear" não é o Linear */
const noApp = (app: string) => `(no|na|nos|nas|pelo|pela|do|da|para o|para a|em|ao|in|on|into|via|through|to|from|in my|on my|in the|on the)\\s+${app}\\b`;
/** Como cada aplicativo aparece num pedido de tarefa (o nome dele, ou o do aplicativo de tarefas da conta). */
const APP_TAREFAS: Partial<Record<string, string>> = { microsoft: '(planner|microsoft to ?do|to-do)', google: '(google tasks|tarefas do google)' };
const appDe = (k: string) => APP_TAREFAS[k] ?? fold(integrationDef(k)?.name ?? k).split(/[^a-z0-9]+/)[0];

/**
 * app: 'texto' = o aplicativo da conta tem de aparecer no pedido ("no Planner"); 'perto' = perto do verbo ("no Slack"),
 * e a frase depende dele. Sem app, vale para qualquer conta conectada que tenha a ação.
 */
interface Familia { id: string; oQue: string; envio: boolean; ler?: boolean; acoes: RegExp; app?: 'texto' | 'perto'; quer: (app: string) => RegExp }
/**
 * O que o pedido quer fazer numa conta, pelas palavras dele (sem modelo), e as ações das Conexões que fazem isso. Rascunho,
 * "como faço…", "não envie" e o que nenhuma conexão faz (pagar, assinar) não entram: ali vale a confirmação da pessoa.
 */
const FAMILIAS: Familia[] = [
  { id: 'email.enviar', oQue: 'enviar o e-mail', envio: true, acoes: /^email\.(enviar|responder|enviar_rascunho)$/,
    // "email Ana the proposal" (inglês): o próprio "email" é o verbo, no começo da frase
    quer: () => new RegExp(`${perto(ENVIAR, 'e-?mails?').source}|\\b${ENVIAR}\\b[^.?!\\n]{0,80}\\b${ENDERECO}|(^|[.!?\\n]\\s*)(please\\s+)?e-?mail\\s+(him|her|them|the|this|it|[a-z]+@|[a-z]+\\s+(the|a|an|this|our|my)\\b)`) },
  { id: 'email.ler', oQue: 'ler os e-mails', envio: false, ler: true, acoes: /^email\.(buscar|ler)$/,
    quer: () => new RegExp(`${perto(LER, '(e-?mails?|caixa de entrada|minha caixa|inbox|mailbox)').source}|\\b${LER}\\b[^.?!\\n]{0,60}\\b${ENDERECO}`) },
  { id: 'teams.enviar', oQue: 'mandar a mensagem no Teams', envio: true, acoes: /^teams\.(enviar|nova_conversa|enviar_canal)$/, quer: () => perto(MENSAGEM, 'teams') },
  { id: 'teams.ler', oQue: 'ler as conversas do Teams', envio: false, ler: true, acoes: /^teams\.(ler|conversas)$/,
    quer: () => new RegExp(`${perto(LER, 'teams').source}|\\b(conversas|mensagens|chats?) (do|no|pelo) teams\\b|\\b(conversations|messages|chats?) (in|on|from) teams\\b`) },
  { id: 'agenda.criar', oQue: 'marcar na agenda', envio: false, acoes: /^agenda\.(criar|editar)$/,
    quer: () => new RegExp(`${perto(AGENDAR, '(reuniao|reunioes|compromisso|evento|horario|meetings?|appointments?|events?|calls?)').source}|\\b(criar|crie|colocar|coloque|adicionar|adicione|ponha|create|add|put)\\b[^.?!\\n]{0,40}\\b(na (minha )?agenda|no (meu )?calendario|(on|in|to) (my |our |the )?(calendar|agenda))|${perto(ENVIAR, '(convites?|invites?|invitations?)').source}`) },
  { id: 'whatsapp.enviar', oQue: 'mandar a mensagem no WhatsApp', envio: true, acoes: /^whatsapp\.enviar$/, quer: () => perto(MENSAGEM, '(whatsapp|zap|wpp)') },
  { id: 'tarefa.criar', oQue: 'criar as tarefas', envio: false, app: 'texto', acoes: /^tarefa\.criar$|\.criar_tarefa$/, quer: () => perto(CRIAR, TAREFAS) },
  { id: 'tarefa.mudar', oQue: 'mudar as tarefas', envio: false, app: 'texto', acoes: /^tarefa\.(concluir|mover|editar)$/, quer: () => perto(MUDAR, TAREFAS) },
  { id: 'app.mensagem', oQue: 'mandar a mensagem', envio: true, app: 'perto', acoes: /^(slack|telegram|discord|mattermost|rocketchat)\.(enviar|responder|direta)$/, quer: (app) => perto(MENSAGEM, noApp(app), 60) },
];

/**
 * Texto sobre o assunto, e não pedido para agir na conta: o trabalho pedido é o próprio guia, política, treinamento…
 * ("crie um guia para responder e-mails", "faça um relatório sobre o uso do Teams"). Só quando o verbo principal é
 * produzir o texto: "envie à turma do curso", "mande o manual por e-mail" e "avise que o treinamento mudou" são envio.
 * Na dúvida, a intenção não entra: o card segue a conferência de sempre (e o agente pergunta quando precisar).
 */
const PRODUZ = '(escrever|escreva|escreve|redigir|redija|redige|criar|crie|cria|fazer|faca|faz|montar|monte|monta|elaborar|elabore|elabora|preparar|prepare|prepara|desenvolver|desenvolva|produzir|produza|gerar|gere|gera)';
const OBRA = '(guia|politica|treinamento|manual|cartilha|boas praticas|tutorial|curso|aula|palestra|sobre o uso|sobre como|a importancia de)';
const PRODUZ_EN = '(write|draft|create|make|build|prepare|develop|produce|generate|put together|design)';
const OBRA_EN = '(guide|policy|training|manual|handbook|playbook|best practices|tutorial|course|class|lesson|talk|lecture|about how|about the use|on how|about the importance of)';
const SOBRE_O_ASSUNTO = new RegExp(`\\b${PRODUZ}(\\s+[a-z-]+){0,3}?\\s+${OBRA}\\b|\\b${PRODUZ_EN}(\\s+[a-z-]+){0,3}?\\s+${OBRA_EN}\\b`);
/** Envio pedido de fato, no imperativo e sem negação ("envie", "mande", não "não envie", "me mande" ou "para enviar"). */
const IMPERATIVO_ENVIO = /\b(envie|envia|mande|manda|encaminhe|encaminha|dispare|dispara|repasse|repassa|responda|responde|avise|avisa|poste|publique|send|forward|reply|respond|notify|post|publish)\b/g;
function enviaDeFato(frase: string): boolean {
  for (const m of frase.matchAll(IMPERATIVO_ENVIO)) {
    const antes = frase.slice(Math.max(0, (m.index ?? 0) - 14), m.index);
    // português: "não envie", "me mande", "que eu envie"; inglês: "don't send", "to send", "I'll send", "will send"
    if (!/\b(nao|nunca|sem|me|eu|que)\s+$/.test(antes) && !/(\b(not|never|to|will|i|we|without)|n't|'ll)\s+$/.test(antes)) return true;
  }
  return false;
}
/** Envio que fica com a pessoa, sempre: "não envie", "para eu enviar", "que eu mesmo vou mandar", "me ajude a responder". */
const FICA_COM_A_PESSOA = new RegExp([
  'sem enviar', '\\b(nao|nunca) (envie|mande|enviar|mandar|responda|responder|encaminhe|encaminhar|dispare|disparar)\\b', 'antes de enviar', '\\bso (prepar|redig|redij|escrev)',
  '\\bpara (eu|mim|a gente|voce|nos|que eu|que a gente|que voce) (enviar|mandar|responder|encaminhar|disparar|postar|publicar|repassar)\\b',
  '\\bque (eu|a gente|nos) (mesm[oa]s? )?(vou|vamos|irei|iremos|vai|possa|possamos) (enviar|mandar|responder|encaminhar|disparar|postar|publicar|repassar)\\b',
  '\\beu mesm[oa] (envio|mando|respondo|encaminho|vou)\\b', '\\bajud\\w* a (responder|escrever|redigir|enviar|mandar|montar|preparar)\\b',
  // inglês: "without sending", "don't send", "just draft", "for me to send", "I'll send it myself", "help me reply"
  '\\bwithout (sending|replying|responding|forwarding|posting|publishing)\\b', "\\b(don't|do not|never|dont) (send|reply|respond|forward|post|publish|email)\\b",
  '\\bbefore (sending|replying|you send)\\b', '\\b(just|only) (draft|prepare|write)\\b',
  '\\bfor (me|us|you) to (send|reply|respond|forward|post|publish|review)\\b',
  "\\b(i'll|i will|we'll|we will|i'm going to|i am going to|we're going to|i can|i'd like to) (send|reply|respond|forward|post|publish)( it| them| this)?( myself| ourselves)?\\b",
  '\\b(i|we) (send|reply|forward) (it|them|this) (myself|ourselves)\\b', '\\bhelp me (to )?(reply|respond|write|draft|send|prepare|answer)\\b',
].join('|'));
/** Preparo (rascunho, minuta, modelo): fica com a pessoa só quando não é o que ela manda enviar ("envie o rascunho à Ana"). */
const PREPARO = /rascunho|\b(redij|redig|minuta|modelo de|template|esboco)|\b(drafts?|outline)\b/;
/** Leitura do que a pessoa já trouxe ("as conversas que colei abaixo"): não é para ler na conta. */
const JA_TROUXE = /\b(que (eu )?(colei|mandei|anexei|copiei|enviei aqui)|colad[ao]s?|em anexo|anexad[ao]s?|abaixo|acima|(that|which) i (pasted|attached|copied|sent here|shared)|i (pasted|attached|copied)|pasted|attached|below|above)\b/;
/** O e-mail ou a conversa que a pessoa colou ("responder este e-mail que colei", "o e-mail abaixo"). */
const JA_TROUXE_MENSAGEM = /\b(e-?mails?|mensage(m|ns)|conversas?|messages?|conversations?|chats?)\s+(que (eu )?(colei|mandei|anexei|copiei|enviei aqui)|colad[ao]s?|abaixo|acima|em anexo|anexad[ao]s?|(that |which )?i (pasted|attached|copied|shared)|pasted|attached|below|above)\b/;
/** Pergunta sobre o assunto ("Qual a melhor hora para enviar e-mails?"); o pedido educado ("Pode mandar…?") continua pedido. */
const PERGUNTA = /^\s*(qual|quais|quando|como|por que|porque|onde|quanto|quantos|quantas|o que e|vale a pena|devo|e melhor|existe|tem algum|what|which|when|how|why|where|is it worth|should i|should we|is it better|is there|are there|do you know)\b/;
const EDUCADO = /\b(pode|poderia|podes|consegue|conseguiria|da para|da pra|tem como|por favor|can you|could you|would you|will you|please|would you mind)\b/;
/** "ferramentas para enviar", "a melhor hora para enviar", "tools to send", "the best time to send": o envio é o assunto. */
const PARA_ENVIAR = /\b(ferramentas?|apps?|aplicativos?|programas?|sistemas?|plataformas?|softwares?|servicos?|solucao|solucoes|maneiras?|formas?|jeitos?|dicas?|hora|horario|horarios|momento|dias?|estrategias?|tecnicas?|exemplos?|regras?|motivos?|razoes)\s+([a-z-]+\s+){0,2}(para|pra|de)\s+$|\b(tools?|apps?|applications?|programs?|systems?|platforms?|software|services?|solutions?|ways?|tips?|time|times|hours?|moment|days?|strateg(y|ies)|techniques?|examples?|rules?|reasons?)\s+([a-z-]+\s+){0,2}(to|for)\s+$/;
/** Explicação ou pesquisa ("explicando por que devemos responder e-mails"): com o verbo no infinitivo, é o assunto. */
const EXPLICA = /\b(por que|porque|explic\w*|pesquis\w*|compar\w*|why|explain\w*|research\w*)\b/;
/** o verbo do inglês no infinitivo ("to send", "we should reply"): o "to" ou o modal logo antes */
const INFINITIVO_EN = /\b(to|should|must|shall|ought to)\s+$/;
/**
 * Em inglês, o verbo e o substantivo costumam ser a mesma palavra: "the last message from Ana", "the post on Teams", "the
 * reply from the client". Depois de artigo ou determinante, nunca é o verbo do pedido.
 */
const DETERMINANTE_EN = /\b(the|a|an|this|that|these|those|my|your|his|her|its|our|their|last|latest|first|next|previous|new|each|every|any|some|one|which|whose|of|quick|short|long|same|other)\s+$|'s\s+$/;
/**
 * E estas, que são substantivos tão comuns quanto verbos, só contam como verbo no começo da oração ("Reply to João…"),
 * depois de "please", "can you", "and", "then", "to", ou com a pessoa logo depois ("message Ana", "post it").
 */
const AMBIGUO_EN = new Set(['message', 'post', 'text', 'answer', 'reply', 'dm', 'ping', 'list', 'check', 'file', 'log', 'review', 'search', 'track', 'book', 'block',
  'mark', 'schedule', 'update', 'cancel', 'reserve', 'monitor', 'scan', 'open']);
const COMECO_EN = /(^|[,:;(]|\b(please|pls|kindly|(can|could|would|will) you|and|then|also|now|just|quickly|to|ok|okay|hi|hey))\s*$/;
const OBJETO_EN = /^\s+(it|this|that|them|him|her|us|everyone|everybody|back)\b/;

/**
 * Ação externa pedida de fato: a pergunta ("Qual a melhor hora para enviar e-mails?"), a pesquisa ("ferramentas para
 * enviar e-mails") e a explicação ("por que devemos responder…") falam do envio, não pedem um — e a resposta vai para
 * você aprovar, não para "confirme quando estiver feito".
 */
function externoDeFato(t: string): boolean {
  for (const m of t.matchAll(new RegExp(EXTERNAL.map((s) => `(^|[^a-z])${s}`).join('|'), 'g'))) {
    const at = (m.index ?? 0) + (/^[^a-z]/.test(m[0]) ? 1 : 0);
    const ini = Math.max(...['.', '\n', '?', '!'].map((x) => t.lastIndexOf(x, at))) + 1;
    const fins = ['.', '\n', '?', '!'].map((x) => t.indexOf(x, at)).filter((x) => x >= 0);
    const fim = fins.length ? Math.min(...fins) : t.length;
    const antes = t.slice(ini, at);
    const infinitivo = /^[a-z]+r\b/.test(t.slice(at)) || INFINITIVO_EN.test(antes);
    if ((t[fim] === '?' || PERGUNTA.test(t.slice(ini, fim))) && !EDUCADO.test(antes)) continue;
    if (infinitivo && (PARA_ENVIAR.test(antes) || EXPLICA.test(antes))) continue;
    return true;
  }
  return false;
}

/**
 * O pedido quer isto? Pula "como enviar…", "não envie", o que o outro faz ("o que o cliente responde"), texto sobre o
 * assunto, o envio que fica com a pessoa, pergunta e pesquisa sobre envio, e a leitura do que ela já trouxe.
 */
function pede(t: string, re: RegExp, f: { envio: boolean; ler?: boolean }): boolean {
  for (const m of t.matchAll(new RegExp(re.source, 'g'))) {
    const at = m.index ?? 0;
    const antes = t.slice(Math.max(0, at - 30), at);
    if (/\b(como|ensine|explique|tutorial|passo a passo|dica|nao|nunca|sem)\s+(eu\s+|a gente\s+|se\s+|posso\s+|devo\s+|faco\s+|que\s+)?$/.test(antes)) continue;
    // inglês: "how to send", "how do I reply", "teach me to", "don't send", "never reply", "without"
    if (/(\b(how|teach me|explain|tutorial|step by step|tips? (on|for)|not|never|without)|n't)\s+(to\s+|do i\s+|can i\s+|should i\s+|do you\s+|i\s+|we\s+)?$/.test(antes)) continue;
    const ini = Math.max(...['.', '\n', '?', '!'].map((x) => t.lastIndexOf(x, at))) + 1;
    const fins = ['.', '\n', '?', '!'].map((x) => t.indexOf(x, at + m[0].length)).filter((x) => x >= 0);
    const fim = fins.length ? Math.min(...fins) : t.length;
    const frase = t.slice(ini, fim);
    // o verbo do pedido dentro do trecho achado, e o que vem antes dele na frase
    const v = VERBO_DO_PEDIDO.exec(m[0]);
    const vAt = at + (v?.index ?? 0);
    const antesDoVerbo = t.slice(ini, vAt);
    if (v && COLOQUIAL.has(v[1]) && /\b(o|a|os|as|ele|ela|eles|elas|quem|ninguem|alguem|voce|se)\s+([a-z-]+\s+){0,2}$/.test(antesDoVerbo)) continue;
    const en = !!v && VERBO_EN.test(v[1]);
    if (en && SUJEITO_EN.test(antesDoVerbo)) continue;
    if (v && en) {
      // a palavra do inglês num pedido em português não é o verbo dele ("revise o texto do post do Teams")
      if (idioma(frase) === 'pt') continue;
      // "the last message from Ana", "the post on Teams": o substantivo, não o pedido
      if (DETERMINANTE_EN.test(antesDoVerbo)) continue;
      if (AMBIGUO_EN.has(v[1].split(' ')[0]) && !COMECO_EN.test(antesDoVerbo) && !OBJETO_EN.test(t.slice(vAt + v[1].length))) continue;
    }
    if (SOBRE_O_ASSUNTO.test(frase) && !enviaDeFato(frase)) continue;
    if (f.envio) {
      if (FICA_COM_A_PESSOA.test(frase)) continue;
      if (PREPARO.test(frase) && !enviaDeFato(frase)) continue;
      if (JA_TROUXE_MENSAGEM.test(frase) && !enviaDeFato(frase)) continue;
      if ((t[fim] === '?' || PERGUNTA.test(frase)) && !EDUCADO.test(antesDoVerbo)) continue;
      const infinitivo = !!v && (en ? INFINITIVO_EN.test(antesDoVerbo) : /r$/.test(v[1]));
      if (infinitivo && (PARA_ENVIAR.test(antesDoVerbo) || EXPLICA.test(antesDoVerbo))) continue;
      // "me manda um resumo dos meus e-mails": os e-mails são o que ler, e a resposta vem aqui (a leitura vale pela rede)
      if (/\bme\s+$/.test(antesDoVerbo) && /\b(dos|das|nos|nas|meus|minhas|seus|suas)\s+e-?mails?\b/.test(m[0])) continue;
      // "send me a summary of my emails": o mesmo, em inglês
      if (/\b(send|give|get|bring|forward) me\b[^.?!\n]{0,40}\b(of|from|on|about|in) (my|our|the|all|all my|all the) (e-?mails?|inbox|messages)\b/.test(frase)) continue;
    }
    if (f.ler && JA_TROUXE.test(frase)) continue;
    return true;
  }
  return false;
}

/** As ações que cada conta conectada oferece agora aos agentes: a mesma lista das instruções deles (acoesLigadas). */
function listadas(db: Db, ws: string): Map<string, string[]> {
  return new Map(acoesLigadas(db, ws).filter((x) => x.ids.length).map((x) => [x.kind, x.ids]));
}

export interface Intencao { id: string; oQue: string; envio: boolean; pares: string[] }
/** O que o pedido quer fazer numa conta e por quais ações (conexao:acao) das contas conectadas isso sai. */
export function intencoesDoPedido(db: Db, ws: string, pedido: string): Intencao[] {
  // "the sales teams", "on Monday", "the notion that…": a palavra comum não é o aplicativo
  const t = semNomeComum(pedido, fe(pedido));
  const contas = listadas(db, ws);
  const out: Intencao[] = [];
  for (const f of FAMILIAS) {
    const pares: string[] = [];
    for (const [k, ids] of contas) {
      if (f.app === 'texto' && !new RegExp(`\\b${noApp(appDe(k))}`).test(t)) continue;
      if (f.app === 'perto' && !pede(t, f.quer(appDe(k)), f)) continue;
      for (const a of ids) if (f.acoes.test(a)) pares.push(`${k}:${a}`);
    }
    if (pares.length && (f.app === 'perto' || pede(t, f.quer(''), f))) out.push({ id: f.id, oQue: f.oQue, envio: f.envio, pares });
  }
  return out;
}

/**
 * Rede de segurança: o pedido não casou com nenhuma família, mas uma conta conectada está no meio — o pedido cita o
 * aplicativo como lugar ("no Teams", "meus e-mails") ou a resposta do agente afirma uma ação nele ("respondi o João no
 * Teams", "li seus e-mails"). Aí o card fica preso ao registro do serviço daquele aplicativo, nunca ao texto.
 */
interface Superficie { oQue: string; nome: string; acoes: RegExp; afirma: string; kinds?: string[] }
/** o que o agente diz que fez, na primeira pessoa ("escrevi o e-mail" é texto, não ação na conta: fica de fora) */
// inglês: o passado não diz a pessoa ("the email you sent"), então só com o sujeito do agente ("I sent", "I've replied")
const EU_EN = "(i|i've|i have|we|we've|we have|i just|i've just|i have just|i already|i've already)";
const AFIRMA_ENVIO = `enviei|mandei|respondi|avisei|encaminhei|disparei|repassei|postei|publiquei|${EU_EN} (sent|replied|responded|answered|forwarded|notified|posted|published|messaged)`;
const AFIRMA_LER = `li|olhei|verifiquei|chequei|busquei|procurei|varri|${EU_EN} (read|checked|looked at|looked through|went through|searched|scanned|reviewed)`;
const AFIRMA_CRIAR = `criei|cadastrei|adicionei|coloquei|agendei|marquei|remarquei|movi|atualizei|${EU_EN} (created|added|scheduled|booked|moved|updated|set up|put|logged|marked)`;
const SUPERFICIES: Superficie[] = [
  { oQue: 'usar o Teams', nome: 'teams', acoes: /^teams\./, afirma: `${AFIRMA_ENVIO}|${AFIRMA_LER}` },
  { oQue: 'usar o e-mail', nome: '(e-?mails?|outlook|gmail|caixa de entrada|inbox|mailbox)', acoes: /^email\./, afirma: `${AFIRMA_ENVIO}|${AFIRMA_LER}` },
  { oQue: 'usar a agenda', nome: '(agenda|calendario|calendar)', acoes: /^agenda\./, afirma: `${AFIRMA_CRIAR}|olhei|verifiquei|chequei|${EU_EN} (checked|looked at)` },
  { oQue: 'usar as tarefas da conta', nome: '(planner|microsoft to ?do|to-do|google tasks|tarefas do google)', acoes: /^tarefa\.|\.criar_tarefa$/, afirma: `${AFIRMA_CRIAR}|${AFIRMA_LER}` },
  { oQue: 'usar o WhatsApp', nome: '(whatsapp|zap|wpp)', acoes: /^whatsapp\./, afirma: `${AFIRMA_ENVIO}|${AFIRMA_LER}` },
];
/** comparação e pesquisa sobre o aplicativo ("compare o Teams e o Slack") não são trabalho nele */
const REDE_FORA = /\b(compar\w*|pesquis\w*|diferenca entre|vantagens|desvantagens|research\w*|difference between|pros and cons|advantages|disadvantages)\b/;
export function intencoesPelaConta(db: Db, ws: string, pedido: string, resposta: string): Intencao[] {
  const t = semNomeComum(pedido, fe(pedido)); const r = semNomeComum(resposta, fe(resposta));
  const contas = listadas(db, ws);
  const frasesDoPedido = t.split(/[.?!\n]+/).filter((f) => f.trim() && !SOBRE_O_ASSUNTO.test(f) && !FICA_COM_A_PESSOA.test(f) && !JA_TROUXE.test(f)
    && !REDE_FORA.test(f) && !PERGUNTA.test(f) && !PREPARO.test(f));
  // o que a pessoa colou ou anexou: a resposta fala dele ("li o e-mail que você colou"), não da conta
  const trouxe = JA_TROUXE.test(t);
  const outros: Superficie[] = [...contas.keys()].filter((k) => !['microsoft', 'google', 'whatsapp'].includes(k))
    .map((k) => ({ oQue: `usar o ${nomeDe(k)}`, nome: appDe(k), acoes: /./, afirma: `${AFIRMA_ENVIO}|${AFIRMA_LER}|${AFIRMA_CRIAR}`, kinds: [k] }));
  const out: Intencao[] = [];
  for (const sup of [...SUPERFICIES, ...outros]) {
    const lugar = new RegExp(`\\b(no|na|nos|nas|pelo|pela|meu|minha|meus|minhas|seu|sua|seus|suas|in|on|via|through|my|our|your|in my|on my|in our|on our)\\s+${sup.nome}\\b`);
    const afirma = perto(`(${sup.afirma})`, sup.nome, 80);
    if (!frasesDoPedido.some((f) => lugar.test(f)) && (trouxe || !afirma.test(r))) continue;
    const pares: string[] = [];
    for (const [k, ids] of contas) {
      if (sup.kinds && !sup.kinds.includes(k)) continue;
      for (const a of ids) if (sup.acoes.test(a)) pares.push(`${k}:${a}`);
    }
    if (pares.length) out.push({ id: `conta:${sup.oQue}`, oQue: sup.oQue, envio: false, pares });
  }
  return out;
}

/**
 * "Não saiu do papel", "não consegui enviar", "não tenho acesso": o agente disse que não fez. Vale no começo da resposta,
 * numa resposta curta, ou em qualquer lugar para as frases que não deixam dúvida. "Não consegui acessar o site X, mas…"
 * é ressalva de uma entrega, não declaração. Conta só o que o agente diz de si mesmo ou da ferramenta dele ("não
 * consegui", "não tenho acesso", "as Conexões não estão habilitadas"): "milhões ainda não têm acesso à internet" ou
 * "no plano gratuito a exportação não está disponível" são o assunto do texto. só_forte: o que nenhuma conexão faz e a
 * pessoa faz (pagar um boleto): ali "não tenho acesso ao seu banco" é o esperado, e só contam as frases que não deixam
 * dúvida e as que falam das Conexões, da ferramenta do agente ou de uma conta (Teams, e-mail, agenda…).
 */
const SOBRE_A_CONTA = /\b(conexo(es|ao)|ferramentas?|integrac\w*|teams|e-?mails?|outlook|caixa de entrada|agenda|calendario|planner|to ?do|whatsapp|slack|telegram|discord|conversas|mensage(m|ns)|onedrive|sharepoint|google|connections?|tools?|integrations?|inbox|mailbox|calendar|chats?|conversations?|messages?)\b/;
const NAO_FEITO_FORTE = new RegExp([
  '\\bnao (saiu|sai) do papel\\b', '\\bnada (foi|ficou) (feito|criado|executado|realizado|concluido)\\b',
  // inglês: "nothing was done", "it never got off the ground" — as mesmas do português: "nothing was sent yet: the draft
  // is above for your approval" é o rascunho honesto, como "nada foi enviado ainda"
  '\\bnothing (was|has been|got|could be) (done|created|executed|completed|carried out)\\b', "\\b(never|didn't|did not) (get|got) off the ground\\b",
].join('|'));
const VERBO_FEITO = '(enviar|mandar|criar|acessar|ler|publicar|agendar|executar|concluir|fazer|realizar|completar|terminar|entregar|usar|abrir|conectar|responder|cadastrar|registrar|lancar|avaliar|analisar|marcar|mover|buscar|consultar)';
// os mesmos verbos do português: "find", "get", "make", "reach", "fetch" e "do" sozinhos dão frase de resultado ("I couldn't
// find any errors", "I couldn't get the exact figure, so…", "we can't make this decision for you", "we cannot do much")
const VERBO_FEITO_EN = '(send|create|access|read|publish|post|schedule|book|run|execute|complete|finish|do (it|this|that|the (task|work|job))|perform|deliver|use|open|connect|reply|respond|answer|register|log|analy[sz]e|evaluate|mark|move|search|look up|carry out)';
/** "não consegui", "I couldn't", "I was unable to", "I wasn't able to", "I failed to" */
const NAO_PUDE_EN = "(couldn't|could not|wasn't able to|was not able to|weren't able to|were not able to|was unable to|were unable to|am unable to|are unable to|can't|cannot|can not|failed to|didn't manage to|did not manage to|haven't been able to|have not been able to)";
const NAO_FEITO = new RegExp([
  `\\bnao (consegui|conseguimos|pude|pudemos|fui capaz de|foi possivel|deu para) ${VERBO_FEITO}\\b`,
  '\\bnao (tenho|temos|tive|tivemos) (acesso|permissao|como|a ferramenta|essa ferramenta|ferramenta)\\b',
  '\\b(as conexoes|a conexao|a ferramenta|as ferramentas|essa ferramenta|a integracao|o acesso|minhas ferramentas)( [a-z]+){0,3} (ainda )?nao (esta|estao|estava|estavam|foi|foram) (habilitad|disponive|liberad|ativad|configurad)\\w*',
  // inglês: só o que o agente diz de si mesmo ("I couldn't send", "we don't have access") ou da ferramenta dele
  `\\b(i|we) ${NAO_PUDE_EN} ${VERBO_FEITO_EN}\\b`,
  `\\b(it|this) (wasn't|was not|isn't|is not) possible to ${VERBO_FEITO_EN}\\b`,
  "\\b(i|we) (don't|do not|didn't|did not|no longer) have (access|permission|the permission|the tool|that tool|this tool|a tool|the right tool|a way|any way)\\b",
  '\\b(i|we) (have|had) no (access|permission|way)\\b',
  "\\b(the connections?|the tools?|that tool|this tool|the integrations?|my tools|my access|access)( [a-z]+){0,3} (is|are|was|were)( still)? not (enabled|available|turned on|configured|set up|activated|allowed)\\b",
  "\\b(the connections?|the tools?|that tool|this tool|the integrations?|my tools|my access|access)( [a-z]+){0,3} (isn't|aren't|wasn't|weren't)( yet)? (enabled|available|turned on|configured|set up|activated|allowed)\\b",
].join('|'));
export function naoFeito(texto: string, soForte = false): string | null {
  const t = fe(texto);
  const trecho = (i: number) => {
    const ini = Math.max(...['.', '\n', '!', '?'].map((x) => texto.lastIndexOf(x, i))) + 1;
    const fins = ['.', '\n', '!', '?'].map((x) => texto.indexOf(x, i)).filter((x) => x >= 0);
    return clip(texto.slice(ini, fins.length ? Math.min(...fins) + 1 : texto.length).trim(), 240);
  };
  const forte = NAO_FEITO_FORTE.exec(t);
  if (forte) return trecho(forte.index);
  const m = NAO_FEITO.exec(t);
  if (!m) return null;
  if (soForte) {
    // a frase inteira (da declaração até o fim da frase) tem de falar das Conexões, da ferramenta ou de uma conta
    const fins = ['.', '\n', '!', '?'].map((x) => t.indexOf(x, m.index + m[0].length)).filter((x) => x >= 0);
    if (!SOBRE_A_CONTA.test(t.slice(m.index, fins.length ? Math.min(...fins) : t.length))) return null;
  }
  const ressalva = /^[^.?!\n]{0,80}\b(mas|porem|entao usei|em vez disso|no lugar|but|however|so i used|instead|in its place)\b/.test(t.slice(m.index + m[0].length));
  return !ressalva && (m.index < 300 || words(texto) < 150) ? trecho(m.index) : null;
}

/** Uma ação numa conta registrada pelo serviço das Conexões (servico.ts). */
export interface AcaoRegistrada { conexao: string; acao: string; status: 'pendente' | 'feita' | 'falhou' | 'recusada'; risco: string; erro: string | null; resultado: string | null; resumo: string | null; user_id: string | null; created_at: string }
/** As ações registradas de uma execução, de um card (e dos cards que nasceram dele) ou das duas coisas, desde uma data. */
export function acoesRegistradas(db: Db, ws: string, f: { runId?: string | null; taskId?: string | null; desde?: string }): AcaoRegistrada[] {
  return db.all<AcaoRegistrada>(`SELECT conexao, acao, status, risco, erro, resultado, resumo, user_id, created_at FROM conexao_acoes
     WHERE workspace_id = ? AND (run_id = ? OR task_id = ? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id = ?)) AND created_at > ? ORDER BY created_at`,
  ws, f.runId ?? '', f.taskId ?? '', f.taskId ?? '', f.desde ?? '');
}

type Desfecho = 'feita' | 'recusada' | 'falhou' | 'faltou';
interface Conferencia {
  /** daResposta: o envio foi pedido na resposta a uma pergunta (só vale o registro depois dela) */
  intencoes: Array<Intencao & { desfecho: Desfecho; linhas: AcaoRegistrada[]; daResposta?: boolean }>;
  /** chamou conexoes_executar (o pedido pode ter parado antes de chegar ao serviço: parâmetro faltando, conexão desligada) */
  tentou: number;
  feitas: AcaoRegistrada[];
  /** ninguém que trabalhou no card tem a ferramenta Conexões (o pedido casa com uma conta conectada mesmo assim) */
  semFerramenta: boolean;
  /** o começo do trabalho atual do card (episodio) */
  desde: string;
}
/** conexao="microsoft" acao="email.enviar", para a instrução de quem tenta de novo */
const comoChamar = (pares: string[]) => lista([...new Set(pares)].slice(0, 4).map((p) => { const [k, a] = p.split(':'); return `conexao="${k}" acao="${a}"`; }));
const INCERTO = /pode ter feito ou n[aã]o/i;
const nomeDe = (k: string) => integrationDef(k)?.name ?? k;

/**
 * As Conexões não estão no motor deste workspace agora (já lido): sendo atualizadas, desligadas para a equipe, ou fora
 * até a próxima versão depois de uma atualização que não deu certo. null: estão lá, ou o motor ainda não foi lido.
 */
function conexoesForaDoAr(ws: string): { curto: string; texto: string; depois: string } | null {
  if (!platformToolsets(motorScope(ws)).at) return null;
  const st = toolStatus(TOOLS.contas, { workspaceId: ws }).status;
  if (st === 'atualizando') return { curto: 'as Conexões estão sendo atualizadas neste computador', texto: 'as Conexões estão sendo atualizadas neste computador', depois: 'Quando a atualização da equipe terminar, use "Tentar de novo".' };
  if (st === 'bloqueada') return { curto: 'as Conexões ficaram fora depois da atualização da equipe', texto: 'a atualização da equipe não deu certo neste computador e as Conexões ficaram fora até a próxima versão do Ergon', depois: 'A Saúde mostra o que houve.' };
  if (st === 'desligada') return { curto: 'as Conexões estão desligadas para a equipe', texto: 'a ferramenta Conexões está desligada para a equipe', depois: 'Ligue em Configurações › Ferramentas e use "Tentar de novo".' };
  return null;
}
const lista = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs.at(-1)}`);

export class Results {
  private readonly db: Db; private readonly bus: Bus; private readonly ops: Operations;
  private readonly cfg: { filesDir: string; maxUploadBytes: number; storageQuota: number };
  constructor(db: Db, bus: Bus, ops: Operations, cfg: { filesDir: string; maxUploadBytes: number; storageQuota: number }) {
    this.db = db; this.bus = bus; this.ops = ops; this.cfg = cfg;
  }

  latest(workspaceId: string, taskId: string): (ResultRow & { criteriaList: Criterion[]; evidenceData: Record<string, unknown> }) | null {
    const r = this.db.get<ResultRow>('SELECT * FROM task_results WHERE workspace_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', workspaceId, taskId);
    if (!r) return null;
    const parse = <T>(s: string, d: T): T => { try { return JSON.parse(s) as T; } catch { return d; } };
    return { ...r, criteriaList: parse<Criterion[]>(r.criteria, []), evidenceData: parse<Record<string, unknown>>(r.evidence, {}) };
  }

  kindOf(workspaceId: string, taskId: string): ResultKind {
    const t = getTask(this.db, workspaceId, taskId);
    return classifyTask(`${t.title} ${t.description}`, !!this.ops.csvInput(workspaceId, taskId));
  }

  /** Muda o estado real do card (e a coluna correspondente; "concluída" conclui). Conclusão humana não é tocada. */
  setWorkState(workspaceId: string, taskId: string, state: WorkState, note?: string, by: Actor = { type: 'system', id: 'ergon' }): void {
    const t = this.db.get<{ board_id: string; column_id: string; completed: number; completed_by: string | null; work_state: string | null }>(
      'SELECT board_id, column_id, completed, completed_by, work_state FROM tasks WHERE id = ? AND workspace_id = ?', taskId, workspaceId);
    if (!t) return;
    if (Number(t.completed) && state !== 'concluida') return; // concluída (por você ou com evidência): não volta sozinha
    if (t.work_state !== state) {
      this.db.run('UPDATE tasks SET work_state = ?, updated_at = ? WHERE id = ?', state, now(), taskId);
      audit(this.db, null, { workspaceId, actorType: 'system', actorId: 'ergon', action: 'task.work_state', targetType: 'task', targetId: taskId,
        evidence: { de: t.work_state, para: state }, result: note ? `${WORK_LABEL[state]} — ${note}` : WORK_LABEL[state] });
    }
    const colId = colunaPorChave(this.db, t.board_id, COLUMN[state])
      ?? (COLUMN[state] === WITH_YOU ? colunaPorChave(this.db, t.board_id, 'doing') : null);
    const patch: { columnId?: string; completed?: boolean } = {};
    if (colId && colId !== t.column_id) patch.columnId = colId;
    if (state === 'concluida' && !Number(t.completed)) patch.completed = true;
    // concluir por decisão sua fica registrado como conclusão humana (e nada automático a desfaz depois)
    if (Object.keys(patch).length) updateTask(this.db, null, workspaceId, by, taskId, patch);
    this.bus.publish(workspaceId, 'tasks.changed', { id: taskId });
  }

  /** Grava a decisão (uma por execução: repetir não duplica) e leva o card ao estado que ela determina. */
  private record(workspaceId: string, taskId: string, runId: string | null, kind: ResultKind, state: ResultState, criteria: Criterion[],
    evidence: Record<string, unknown>, justification: string, decidedBy: string): ResultRow {
    const rid = id('res');
    const ts = now();
    const inserted = this.db.tx(() => {
      const r = this.db.run(`INSERT OR IGNORE INTO task_results (id, workspace_id, task_id, run_id, kind, state, criteria, evidence, justification, decided_by, created_at, decided_at)
                             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rid, workspaceId, taskId, runId, kind, state, JSON.stringify(criteria), this.db.seal(workspaceId, JSON.stringify(evidence)), this.db.seal(workspaceId, justification), decidedBy, ts, ts);
      if (!r.changes) return false;
      audit(this.db, null, { workspaceId, actorType: decidedBy.startsWith('usr_') ? 'user' : 'system', actorId: decidedBy, action: 'task.result', targetType: 'task', targetId: taskId,
        evidence: { resultId: rid, runId, kind, state, criteria: criteria.map((c) => `${c.ok ? '✓' : '✗'} ${c.label}`) }, result: justification });
      return true;
    });
    if (!inserted) return this.db.get<ResultRow>('SELECT * FROM task_results WHERE run_id = ?', runId)!;
    const work = WORK_OF[state];
    if (work) this.setWorkState(workspaceId, taskId, work, justification, decidedBy.startsWith('usr_') ? { type: 'user', id: decidedBy } : undefined);
    return this.db.get<ResultRow>('SELECT * FROM task_results WHERE id = ?', rid)!;
  }

  /**
   * Desde quando vale o que o serviço registrou para este card: o começo do trabalho atual — a criação do card, a última
   * conclusão, ou o último pedido novo da pessoa (devolver com instrução). Falha, espera e a resposta a uma pergunta não
   * recomeçam: o que já saiu pela conta antes delas conta (uma nova tentativa não precisa repetir o e-mail enviado).
   */
  episodio(ws: string, taskId: string): string { return episodioDoCard(this.db, ws, taskId); }

  /**
   * O que só a pessoa resolve no trabalho atual do card, marcado pelo serviço das Conexões (MARCA_PESSOA): autorizar a
   * conta de novo, ligar uma ação que ela desligou, conferir um envio que o serviço não confirmou. Vale a marca ainda à
   * vista: a mesma ação feita depois dela, a conta conectada de novo, ou a ação ligada de novo, deixam a marca para trás.
   * pares: só as ações que faltaram (conexao:acao) para autorizar; sem pares, qualquer marca do card. null: nada que só ela resolve.
   */
  daPessoa(ws: string, taskId: string, desde: string, pares?: string[]): string | null {
    const marcas = this.db.all<{ evidence: string; created_at: string }>(
      'SELECT evidence, created_at FROM audit_events WHERE workspace_id = ? AND target_type = ? AND target_id = ? AND action = ? AND created_at > ? ORDER BY created_at DESC LIMIT 20',
      ws, 'task', taskId, MARCA_PESSOA, desde);
    for (const m of marcas) {
      let e: { conexao?: string; acao?: string; motivo?: MotivoPessoa; risco?: string; dedupe?: string } = {};
      try { e = JSON.parse(m.evidence) as typeof e; } catch { continue; }
      const k = String(e.conexao ?? ''); const a = String(e.acao ?? '');
      if (!integrationDef(k as IntegrationKind)) continue;
      // desligada e incerto valem para o card inteiro: uma nova tentativa do que falta poderia refazer o envio que talvez
      // tenha saído, ou contornar o que ela desligou
      if (pares && !pares.includes(`${k}:${a}`) && e.motivo === 'autorizar') continue;
      // a mesma ação deu certo depois da marca: a conta voltou a aceitar (autorizar), ou o mesmo envio incerto saiu (o mesmo
      // hash: um envio a outro destinatário não diz nada sobre este). Ação desligada não sai por aqui: feita depois com outros
      // parâmetros (um evento sem os convidados) não liga o que ela desligou
      if (e.motivo !== 'desligada') {
        const mesma = e.motivo === 'incerto' && e.dedupe ? ' AND dedupe = ?' : '';
        if (this.db.get(`SELECT 1 AS x FROM conexao_acoes WHERE workspace_id = ? AND task_id = ? AND conexao = ? AND acao = ? AND status = 'feita' AND COALESCE(decided_at, created_at) > ?${mesma}`,
          ws, taskId, k, a, m.created_at, ...(mesma ? [String(e.dedupe)] : []))) continue;
      }
      const row = integrationRow(this.db, ws, k as IntegrationKind);
      const nome = nomeDe(k);
      if (e.motivo === 'autorizar') {
        if (row.state === 'connected' && row.connected_at && row.connected_at > m.created_at) continue; // conectou de novo depois
        return `falta você liberar o acesso em Conexões › ${nome} (a tela mostra o que fazer) e usar “Tentar de novo”`;
      }
      if (e.motivo === 'desligada') {
        const acao = acoesDe(k as IntegrationKind).find((x) => x.id === a);
        // o risco desta chamada, gravado na marca (o de algumas ações depende dos parâmetros: um evento com convidados é
        // "enviar"); marca antiga, sem ele: o da ação sem parâmetros
        const risco = (RISCOS as string[]).includes(e.risco ?? '') ? e.risco as Risco : acao ? (typeof acao.risco === 'function' ? acao.risco({}) : acao.risco) : null;
        if (acao && risco && ajusteDe(settingsOf(row), a, risco) !== 'desligado') continue; // ligou de novo
        return `esta ação está desligada em Conexões › ${nome}, e só você decide ligar`;
      }
      if (e.motivo === 'incerto') return `${nome} não confirmou se fez: confira lá antes de pedir de novo, para nada sair duas vezes`;
    }
    return null;
  }

  /**
   * O que o card pediu numa conta e o que o serviço registrou no trabalho atual do card (episodio: as tentativas e a
   * execução que continua depois do clique entram juntas). null: o pedido não casa com nenhuma ação de uma conta
   * conectada — aí vale a conferência de sempre. semFerramenta: casa, mas ninguém no card tem as Conexões.
   */
  private conferencia(ws: string, task: { id: string; title: string; description: string }, r: RunRow, resposta: string): Conferencia | null {
    const purpose = this.db.get<{ purpose: string | null }>('SELECT purpose FROM tasks WHERE id = ?', task.id)?.purpose ?? '';
    const pr = this.pendingReturn(ws, task.id);
    const back = pr?.text ?? '';
    const pedido = `${task.title}\n${task.description}\n${purpose}\n${back}`;
    let intencoes = intencoesDoPedido(this.db, ws, pedido);
    // rede de segurança: nada reconhecido, mas o pedido cita o aplicativo de uma conta conectada ou a resposta afirma
    // uma ação nele — vale o registro do serviço, nunca o texto
    if (!intencoes.length) intencoes = intencoesPelaConta(this.db, ws, pedido, resposta);
    if (!intencoes.length) return null;
    const desde = this.episodio(ws, task.id);
    // a resposta a uma pergunta não recomeça o trabalho, mas o envio novo pedido nela ("Sim, mande também para a
    // Carla") só vale com um registro do serviço depois da resposta: o que saiu antes dela não cobre
    const daResposta = pr?.answer ? new Set(intencoesDoPedido(this.db, ws, pr.text).filter((i) => i.envio).map((i) => i.id)) : new Set<string>();
    // quem trabalhou no card desde então (as etapas e as execuções): alguém com as Conexões
    const agentes = new Set([r.agent_id,
      ...this.db.all<{ a: string }>('SELECT agent_id AS a FROM task_steps WHERE task_id = ?', task.id).map((x) => x.a),
      ...this.db.all<{ a: string }>('SELECT agent_id AS a FROM runs WHERE task_id = ? AND created_at > ?', task.id, desde).map((x) => x.a)]);
    const comContas = [...agentes].some((a) => {
      try { return (JSON.parse(this.db.get<{ tools: string | null }>('SELECT tools FROM agents WHERE id = ?', a)?.tools ?? '[]') as string[]).includes('contas'); } catch { return false; }
    });
    const linhas = acoesRegistradas(this.db, ws, { runId: r.id, taskId: task.id, desde });
    const tentou = Number(this.db.get<{ n: number }>(`SELECT COUNT(*) AS n FROM run_tools t WHERE t.tool = 'conexoes_executar' AND t.started_at > ?
      AND (t.run_id = ? OR t.run_id IN (SELECT id FROM runs WHERE task_id = ?))`, desde, r.id, task.id)?.n ?? 0);
    return {
      desde,
      semFerramenta: !comContas && !linhas.length && !tentou,
      tentou, feitas: linhas.filter((x) => x.status === 'feita'),
      intencoes: intencoes.map((i) => {
        const novo = daResposta.has(i.id) && !!pr;
        const minhas = linhas.filter((x) => i.pares.includes(`${x.conexao}:${x.acao}`) && (!novo || x.created_at > pr!.at));
        const desfecho: Desfecho = minhas.some((x) => x.status === 'feita') ? 'feita' : minhas.some((x) => x.status === 'recusada') ? 'recusada'
          : minhas.some((x) => x.status === 'falhou') ? 'falhou' : 'faltou';
        return { ...i, desfecho, linhas: minhas, ...(novo ? { daResposta: true } : {}) };
      }),
    };
  }

  /**
   * O card espera o clique da pessoa num cartão: uma ação numa conta (conexao_acoes) ou, com a proteção ligada em
   * Conexões, abrir sites ou rodar programas depois de ler as contas. Nada dele avança nem é conferido antes disso
   * (evaluate abaixo; teamwork.ts, advance e decidiuDuranteExecucao).
   */
  cartaoEsperando(taskId: string): 'conexao' | 'depois_de_ler' | null {
    if (this.db.get("SELECT 1 AS x FROM conexao_acoes WHERE task_id = ? AND status = 'pendente'", taskId)) return 'conexao';
    if (this.db.get("SELECT 1 AS x FROM agent_proposals p JOIN runs r ON r.id = p.run_id WHERE r.task_id = ? AND p.kind = 'depois_de_ler' AND p.status = 'proposed'", taskId)) return 'depois_de_ler';
    return null;
  }

  /**
   * Avalia o fim de uma execução da fila da equipe. Idempotente pela execução (reinício do servidor não duplica nem
   * muda a decisão). Devolve null quando não há o que decidir (card já concluído por uma pessoa, ou sem card).
   * plan: card com etapas — o conteúdo conta o que todas as etapas entregaram (o resumo de 3 linhas da última etapa
   * vem depois da pesquisa e do texto completo das anteriores).
   */
  evaluate(r: RunRow, status: RunStatus, output: string | null, plan: { words: number } | null = null): ResultRow | null {
    if (!r.task_id) return null;
    const ws = r.workspace_id;
    const done = this.db.get<ResultRow>('SELECT * FROM task_results WHERE run_id = ?', r.id);
    if (done) return done;
    const task = this.db.get<{ id: string; number: number; title: string; description: string; completed: number; completed_by: string | null; requires_approval: number; archived: number; review: string | null; conversation_id: string | null; review_round: number }>(
      'SELECT id, number, title, description, completed, completed_by, requires_approval, archived, review, conversation_id, review_round FROM tasks WHERE id = ? AND workspace_id = ?', r.task_id, ws);
    // card cancelado: o que a execução ainda devolver não vira entrega nem pedido na conversa
    if (!task || Number(task.archived) || (Number(task.completed) && task.completed_by === 'human')) return null;
    const kind = this.kindOf(ws, task.id);
    const text = control(output ?? '');
    // a conferência conta o trabalho, não a linha para a pessoa ("Feito: …" no fim): "Pronto." seguido de uma linha
    // longa continua sendo só uma declaração. A linha fica na conferência do que o agente diz que não fez (naoFeito)
    const entrega = control(semLinhaParaVoce(output ?? ''));
    const simulated = r.mode === 'simulated' || text.startsWith(SIMULATED);
    const ev: Record<string, unknown> = { runId: r.id, mode: r.mode, model: r.model, status, output: clip(text, 800), words: words(entrega) };
    const c: Criterion[] = [{ id: 'execucao', label: 'Execução terminou sem erro', ok: status === 'succeeded', detail: status === 'succeeded' ? undefined : (r.error ?? status) }];
    if (status !== 'succeeded') {
      // o motivo está na execução já encerrada (o registro recebido é de antes do fim)
      const err = this.db.get<{ error: string | null }>('SELECT error FROM runs WHERE id = ?', r.id)?.error ?? r.error;
      c[0].detail = err ?? status;
      return this.record(ws, task.id, r.id, kind, 'falha', c, ev, `A execução ${status === 'cancelled' ? 'foi cancelada' : 'falhou'}${err ? `: ${clip(err, 160)}` : ''}. Nada foi entregue; o card continua aberto.`, 'ergon');
    }
    // pediu uma ação numa conta que espera o clique da pessoa: ainda não há o que conferir. O card espera com ela, e a
    // decisão no cartão volta ao card e o põe para andar (conexoes/servico.ts, decidirProposta)
    // (ou pediu aprovação para abrir sites ou rodar programas depois de ler as contas, com a proteção ligada: o mesmo)
    const esperando = this.cartaoEsperando(task.id);
    if (esperando) {
      this.setWorkState(ws, task.id, 'aguardando_aprovacao', esperando === 'conexao' ? 'esperando a sua confirmação num cartão (ação numa conta)' : 'esperando a sua aprovação num cartão (abrir sites ou rodar programas)');
      return null;
    }
    const asked = /\[\[\s*perguntar\b/i.test(output ?? '');
    if (asked) ev.pergunta = questionIn(output);
    const help = !!this.db.get('SELECT 1 AS x FROM tasks WHERE parent_task_id = ? AND completed = 0 AND archived = 0', task.id);
    const review = this.db.get<{ status: string }>("SELECT status FROM reviews WHERE task_id = ? AND workspace_id = ? ORDER BY created_at DESC LIMIT 1", task.id, ws);
    const pendingReview = review?.status === 'open';

    if (kind === 'dados') {
      const op = this.db.get<OperationRow>('SELECT * FROM operations WHERE workspace_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', ws, task.id);
      ev.operationId = op?.id ?? null; ev.agentComment = simulated ? 'sem conta de IA conectada: não entra no resultado' : clip(text, 600);
      if (!op) {
        c.push({ id: 'operacao', label: 'Análise calculada pelo sistema a partir do arquivo', ok: false, detail: 'nenhuma análise foi executada' });
        return this.record(ws, task.id, r.id, kind, 'reprovado', c, ev, 'A tarefa pede números calculados do arquivo, mas nenhuma análise do sistema foi executada — texto do agente não substitui o cálculo.', 'ergon');
      }
      if (op.status === 'erro') {
        c.push({ id: 'operacao', label: 'Análise calculada pelo sistema a partir do arquivo', ok: false, detail: op.error ?? 'erro' });
        return this.record(ws, task.id, r.id, kind, 'aguardando_info', c, ev, `O arquivo não pôde ser analisado: ${op.error}. Corrija a planilha, anexe de novo e ponha para trabalhar.`, 'ergon');
      }
      c.push({ id: 'operacao', label: 'Análise calculada pelo sistema a partir do arquivo', ok: true, detail: (() => { try { const p = JSON.parse(op.params) as { referencia: string; versao: string }; return `${OPERATION_LABEL} · referência ${p.referencia.split('-').reverse().join('/')} · ${p.versao}`; } catch { return OPERATION_LABEL; } })() });
      this.setWorkState(ws, task.id, 'resultado', emPt(tx('historico.nota.entregaveis', { n: (JSON.parse(op.outputs) as string[]).length })));
      this.setWorkState(ws, task.id, 'validacao');
      c.push(...this.ops.verify(ws, op));
      ev.deliverables = JSON.parse(op.outputs);
    } else {
      // o que o pedido quer fazer numa conta conectada vale pelo registro do serviço, não pelo texto do agente
      const cx = simulated ? null : this.conferencia(ws, task, r, text);
      const coberta = !!cx && cx.intencoes.every((i) => i.desfecho === 'feita' || i.desfecho === 'recusada') && cx.intencoes.some((i) => i.desfecho === 'feita');
      // ação numa conta, feita e confirmada pelo serviço: a entrega é a ação, e o texto curto ("Enviado.") basta
      const pelaConta = coberta && kind === 'externo';
      c.push({ id: 'modelo', label: 'Escrito pelo agente com a conta de IA', ok: !simulated, detail: simulated ? 'sem conta de IA conectada: não conta como trabalho feito' : (r.model ?? undefined) });
      const n = words(entrega) + (plan?.words ?? 0);
      c.push({ id: 'conteudo', label: `Conteúdo com pelo menos ${MIN_WORDS[kind]} palavras`, ok: pelaConta || n >= MIN_WORDS[kind], detail: pelaConta ? 'a entrega é a ação na conta, confirmada pelo serviço' : plan ? `${n} palavras, somando as etapas` : `${n} palavras` });
      c.push({ id: 'alegacao', label: 'Não é só uma declaração de "concluído"', ok: pelaConta || (!CLAIM.test(entrega) && n > 3) });
      c.push({ id: 'pendencias', label: 'Sem pergunta ou pedido de ajuda pendente', ok: !asked && !help, detail: asked ? 'o agente fez uma pergunta' : help ? 'esperando um colega' : undefined });
      const quem = this.db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', r.agent_id)?.name ?? 'O agente';
      if (cx) {
        ev.conexoes = cx.intencoes.map((i) => ({ pedido: i.oQue, desfecho: i.desfecho, acoes: i.linhas.map((x) => `${nomeDe(x.conexao)} · ${x.acao} · ${x.status}`) }));
        const feitas = cx.intencoes.filter((i) => i.desfecho === 'feita');
        const recusadas = cx.intencoes.filter((i) => i.desfecho === 'recusada');
        const falhas = cx.intencoes.filter((i) => i.desfecho === 'falhou');
        const faltas = cx.intencoes.filter((i) => i.desfecho === 'faltou');
        const contas = lista([...new Set(cx.intencoes.flatMap((i) => i.pares.map((p) => nomeDe(p.split(':')[0]))))]);
        const jaFeito = feitas.length ? ` Feito pela conexão: ${lista(feitas.map((i) => i.oQue))}.` : '';
        // para quem tenta de novo (a equipe, teamwork.ts): o que já saiu pela conta no trabalho atual não sai de novo
        const naoRepita = feitas.length ? ` Já feito pela conexão neste card, com o registro do serviço (não repita): ${lista(feitas.map((i) => i.oQue))}.` : '';
        const crit = (ok: boolean, detail: string) => c.push({ id: 'conexao', label: 'Feito na conta conectada, com o registro do serviço', ok, detail });
        // o que só a pessoa resolve (autorizar a conta, ligar a ação que ela desligou): a equipe não tenta de novo sozinha
        const soVoce = (pessoa: string | null) => { if (pessoa) ev.pessoa = pessoa; return pessoa ? ` Só você resolve isto: ${pessoa}.` : ''; };
        if (!asked && !help) {
          // o pedido é numa conta conectada, mas ninguém no card tem a ferramenta: não é "confirme quando estiver feito"
          if (cx.semFerramenta) {
            crit(false, `${quem} não tem a ferramenta Conexões`);
            ev.honesta = 'sem_ferramenta';
            ev.refazer = `${quem} não tem a ferramenta Conexões, então não tinha como ${lista(cx.intencoes.map((i) => i.oQue))} pela conta ${contas}.${naoRepita}`;
            return this.record(ws, task.id, r.id, kind, 'falha', c, ev,
              `Não foi feito: ${quem} não tem a ferramenta Conexões, então não tinha como ${lista(cx.intencoes.map((i) => i.oQue))} pela conta ${contas}. Ligue as Conexões no perfil dele, em Equipe, ou passe o card a um colega que tenha, e use "Tentar de novo".`, 'ergon');
          }
          // a pessoa recusou no cartão o que era o trabalho do card: nem falha nem entrega. O card fica aberto, esperando
          // o que ela quer mudar (texto, destino) ou que ela cancele o card — recusar muitas vezes é "assim não"
          if (recusadas.length && !feitas.length && !falhas.length && !faltas.length) {
            crit(false, `recusado por você: ${lista(recusadas.map((i) => i.oQue))}`);
            const quemRecusou = recusadas.flatMap((i) => i.linhas).find((x) => x.status === 'recusada' && x.user_id?.startsWith('usr_'))?.user_id ?? 'ergon';
            ev.honesta = 'descartado';
            ev.pergunta = `Você recusou ${lista(recusadas.map((i) => i.oQue))} no cartão. O que a equipe deve mudar para fazer de novo? Se não quer mais, cancele o card.`;
            return this.record(ws, task.id, r.id, kind, 'descartado', c, ev, `Recusado por você no cartão: ${lista(recusadas.map((i) => i.oQue))}. Nada foi feito; o card fica aberto esperando o que mudar (ou cancele o card).`, quemRecusou);
          }
          if (falhas.length) {
            const motivo = falhas.flatMap((i) => i.linhas).filter((x) => x.status === 'falhou').at(-1);
            const erro = clip(motivo?.erro ?? 'sem motivo', 300);
            const nome = nomeDe(motivo?.conexao ?? '');
            crit(false, `o serviço não aceitou: ${clip(motivo?.erro ?? 'sem motivo', 200)}`);
            ev.honesta = 'servico_falhou';
            // o serviço não confirmou se fez (pode ter saído): repetir poderia mandar duas vezes — só a pessoa confere
            const pessoa = INCERTO.test(motivo?.erro ?? '') && motivo?.risco !== 'ler'
              ? `${nome} não confirmou se fez: confira lá antes de pedir de novo, para nada sair duas vezes`
              : this.daPessoa(ws, task.id, cx.desde, falhas.flatMap((i) => i.pares));
            if (!pessoa) {
              ev.refazer = `A conferência de entrega mostra que ${nome} não aceitou ${lista(falhas.map((i) => i.oQue))}: “${erro}”. Corrija o que o serviço apontou (os parâmetros de cada ação vêm em conexoes_listar), faça de novo com conexoes_executar (${comoChamar(falhas.flatMap((i) => i.pares))}) e confira o resultado que o serviço devolver antes de dizer que fez.${naoRepita}`;
            }
            return this.record(ws, task.id, r.id, kind, 'falha', c, ev,
              `Não foi feito: ${nome} não aceitou ${lista(falhas.map((i) => i.oQue))} (${erro}).${jaFeito} O card fica aberto.${soVoce(pessoa)}`, 'ergon');
          }
          if (faltas.length) {
            const nada = !cx.tentou && !cx.feitas.length;
            const oQue = lista(faltas.map((i) => i.oQue));
            const pares = faltas.flatMap((i) => i.pares);
            // o envio novo pedido na sua resposta a uma pergunta não tem registro depois dela (o de antes não cobre)
            if (faltas.every((i) => i.daResposta)) {
              crit(false, `sem registro do serviço depois da sua resposta para: ${oQue}`);
              ev.honesta = 'sem_chamada';
              const pessoa = this.daPessoa(ws, task.id, cx.desde, pares);
              if (!pessoa) ev.refazer = `A conferência de entrega mostra que faltou ${oQue}, pedido pela pessoa na resposta dela: faça agora com conexoes_executar (${comoChamar(pares)}) e confira o resultado que o serviço devolver.${naoRepita}`;
              return this.record(ws, task.id, r.id, kind, 'falha', c, ev,
                `Não foi feito por inteiro: faltou ${oQue} pedido na sua resposta, pela conexão com ${contas} (o serviço não tem registro disso depois dela).${jaFeito} O card fica aberto.${soVoce(pessoa)}`, 'ergon');
            }
            // o motor deste computador não tem as Conexões agora (atualizando, desligadas): não é o agente que deixou de usar
            const fora = nada ? conexoesForaDoAr(ws) : null;
            if (fora) {
              crit(false, fora.curto);
              ev.honesta = 'sem_ferramenta';
              ev.fora = true; // não é a equipe que resolve: espera a atualização ou a pessoa ligar
              return this.record(ws, task.id, r.id, kind, 'falha', c, ev, `Não foi feito: ${fora.texto}, então ${quem} não tinha como ${oQue} pela conta ${contas}. ${fora.depois}`, 'ergon');
            }
            crit(false, nada ? 'nenhuma chamada à conexão' : `sem registro do serviço para: ${oQue}`);
            ev.honesta = 'sem_chamada';
            const pessoa = this.daPessoa(ws, task.id, cx.desde, pares);
            if (!pessoa) {
              ev.refazer = nada
                ? `A conferência de entrega mostra que ${oQue} não foi feito: ninguém chamou a conexão com ${contas}, e nada saiu pela conta. Faça agora com conexoes_executar (${comoChamar(pares)}) e confira o resultado que o serviço devolver antes de dizer que fez.${naoRepita}`
                : !feitas.length
                  ? `A conferência de entrega mostra que a conexão com ${contas} foi chamada para ${oQue}, mas o pedido não chegou ao serviço (parâmetro faltando ou com o nome errado, ou uma ação que não existe). Veja os parâmetros em conexoes_listar, chame conexoes_executar de novo (${comoChamar(pares)}) e confira o resultado.${naoRepita}`
                  : `A conferência de entrega mostra que faltou ${oQue} pela conexão com ${contas} (o serviço não tem registro disso). Faça só o que falta com conexoes_executar (${comoChamar(pares)}) e confira o resultado.${naoRepita}`;
            }
            return this.record(ws, task.id, r.id, kind, 'falha', c, ev, (nada
              ? `Não foi feito: ${quem} não chegou a usar a conexão com ${contas} para ${oQue}. Nada saiu pela conta; o card fica aberto.`
              : !feitas.length
                ? `Não foi feito: ${quem} tentou usar a conexão com ${contas} para ${oQue}, mas o pedido não chegou ao serviço. Nada saiu pela conta; o card fica aberto.`
                : `Não foi feito por inteiro: faltou ${oQue} pela conexão com ${contas} (o serviço não tem registro disso).${jaFeito} O card fica aberto.`) + soVoce(pessoa), 'ergon');
          }
        }
        if (coberta) {
          const ok = cx.feitas.filter((x) => feitas.some((i) => i.pares.includes(`${x.conexao}:${x.acao}`)));
          const res = ok.filter((x) => x.resultado).map((x) => clip(x.resultado!.replace(/\s+/g, ' '), 160));
          crit(true, `${lista([...new Set(ok.map((x) => nomeDe(x.conexao)))])} registrou: ${lista(feitas.map((i) => i.oQue))}${recusadas.length ? `; recusado por você: ${lista(recusadas.map((i) => i.oQue))}` : ''}${res.length ? ` — ${res.slice(0, 3).join(' · ')}` : ''}`);
        }
      }
      // o agente disse que não fez ("não saiu do papel", "não consegui ler o Teams"): falha, nunca uma entrega para
      // aprovar — num texto, numa pesquisa ou num pedido de conta que não foi reconhecido. Só no que nenhuma conexão faz
      // (o agente prepara e a pessoa paga, assina): "não tenho acesso ao seu banco" é o esperado ali
      const disse = !asked && !coberta ? naoFeito(text, !cx && kind === 'externo') : null;
      if (disse) {
        c.push({ id: 'declaracao', label: 'O agente não disse que deixou de fazer', ok: false, detail: disse });
        ev.honesta = 'declarou';
        // parou no que só a pessoa resolve (a conta pediu para autorizar de novo, uma ação desligada): vai para ela
        const pessoa = this.daPessoa(ws, task.id, cx?.desde ?? this.episodio(ws, task.id));
        if (pessoa) ev.pessoa = pessoa;
        else ev.refazer = `${quem} disse que não fez: “${disse.replace(/[.!?;:\s]+$/, '')}”. Resolva com a equipe e faça${cx ? '; o que for numa conta conectada sai com conexoes_executar, e só vale o resultado que o serviço devolver' : ''}.`;
        return this.record(ws, task.id, r.id, kind, 'falha', c, ev, `Não foi feito: ${quem} disse “${disse.replace(/[.!?;:\s]+$/, '')}”. Nada conta como entregue sem evidência; o card fica aberto.${pessoa ? ` Só você resolve isto: ${pessoa}.` : ''}`, 'ergon');
      }
      const base = c.every((x) => x.ok);
      if (kind === 'documental' && base) {
        this.setWorkState(ws, task.id, 'resultado', 'documento produzido');
        const art = this.saveDeliverable(ws, task.id, task.number, r.id, text, output ?? '');
        c.push({ id: 'entregavel', label: 'Documento salvo e ligado ao card', ok: !!art, detail: art?.filename });
        if (art) ev.deliverables = [art.id];
        this.setWorkState(ws, task.id, 'validacao');
      }
      if (kind === 'externo' && coberta) {
        // feito na conta e registrado pelo serviço: é a confirmação da fonte. Exigiu a sua aprovação: espera você
        if (base && (Number(task.requires_approval) || pendingReview)) {
          return this.record(ws, task.id, r.id, kind, 'aguardando_aprovacao', c, ev, pendingReview ? 'Feito na conta e registrado pelo serviço, mas a revisão crítica ainda não terminou: aguardando o veredito ou a sua aprovação.' : 'Feito na conta e registrado pelo serviço; esta tarefa exige a sua aprovação para ser concluída.', 'ergon');
        }
        if (base) return this.record(ws, task.id, r.id, kind, 'validado', c, ev, `Concluída com evidência: ${c.find((x) => x.id === 'conexao')?.detail ?? 'registro do serviço'}.`, 'ergon');
      } else if (kind === 'externo' && !cx) {
        // nenhuma conexão faz isso (pagar, assinar, ligar): só a pessoa confirma que foi feito
        c.push({ id: 'confirmacao', label: 'Confirmação da fonte externa', ok: false, detail: 'nenhuma conta conectada faz isso: a confirmação fica com você' });
        if (base) {
          const art = this.saveDeliverable(ws, task.id, task.number, r.id, text, output ?? '', 'preparo');
          if (art) ev.deliverables = [art.id];
          return this.record(ws, task.id, r.id, kind, 'sem_confirmacao', c, ev, 'Ação externa: o agente preparou o que podia, mas só você confirma que foi feita (enviada, paga, publicada…). Confirme no card quando estiver feito.', 'ergon');
        }
      }
    }
    const failed = c.filter((x) => !x.ok && x.id !== 'confirmacao');
    if (failed.length) {
      if (asked) return this.record(ws, task.id, r.id, kind, 'aguardando_info', c, ev, 'O agente precisa de uma informação sua antes de entregar. Responda e ponha para trabalhar de novo.', 'ergon');
      return this.record(ws, task.id, r.id, kind, 'reprovado', c, ev, `Não concluída: ${failed.map((x) => x.label.toLowerCase() + (x.detail ? ` (${x.detail})` : '')).join('; ')}.`, 'ergon');
    }
    // entrega que depende do seu julgamento (texto, documento, pesquisa): vai para você aprovar ou pedir ajustes no
    // mesmo card. Ação objetiva (revisão "nao"), números calculados e card criado fora de uma conversa: entregar conclui
    const forYou = kind !== 'dados' && (task.review ? task.review !== 'nao' : !!task.conversation_id && (kind === 'documental' || kind === 'informativo'));
    if (forYou && !Number(task.requires_approval) && !pendingReview) {
      this.db.run('UPDATE tasks SET delivered_at = ? WHERE id = ?', now(), task.id);
      return this.record(ws, task.id, r.id, kind, 'aguardando_aprovacao', c, ev,
        `Entregue a você${Number(task.review_round) > 1 ? ` (versão ${task.review_round})` : ''}: Aprovar conclui; Pedir ajustes faz uma nova versão no mesmo card.`, 'ergon');
    }
    if (Number(task.requires_approval) || pendingReview) {
      return this.record(ws, task.id, r.id, kind, 'aguardando_aprovacao', c, ev,
        pendingReview ? 'Resultado validado, mas a revisão crítica ainda não terminou: aguardando o veredito ou a sua aprovação.' : 'Resultado validado; esta tarefa exige a sua aprovação para ser concluída.', 'ergon');
    }
    return this.record(ws, task.id, r.id, kind, 'validado', c, ev, `Concluída com evidência: ${c.length} critérios atendidos${ev.deliverables ? `, ${(ev.deliverables as string[]).length} entregável(is) no card` : ''}.`, 'ergon');
  }

  /** O texto do agente como documento entregue (Markdown), ligado ao card. Idempotente pela execução. */
  saveDeliverable(ws: string, taskId: string, number: number, runId: string, text: string, raw: string, prefix = 'resultado') {
    const name = `${prefix}-T${number}-${runId.slice(4, 12)}.md`;
    const prev = taskFiles(this.db, ws, taskId).find((f) => f.filename === name);
    if (prev) return prev;
    const owner = this.db.get<{ user_id: string }>("SELECT user_id FROM memberships WHERE workspace_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1", ws)?.user_id;
    if (!owner) return null;
    // a linha para a pessoa ("Para você decidir: …") fica na tela do card, não no documento
    const body = semLinhaParaVoce(deliverableBody(raw)) || text;
    try {
      const art = saveArtifact(this.db, this.bus, this.cfg.filesDir, this.cfg.maxUploadBytes, ws, owner,
        { filename: name, mime: 'text/markdown', data: Buffer.from(body, 'utf8'), source: { kind: 'operation', id: runId } }, this.cfg.storageQuota);
      linkFile(this.db, ws, taskId, art.id, 'entregavel');
      return art;
    } catch { return null; }
  }

  /**
   * Decisão humana sobre o card da equipe: aprovar e concluir, confirmar a ação externa, devolver com instrução ou
   * responder à pergunta do agente (a resposta volta para ele como a devolução, e o card volta à fila).
   */
  decide(workspaceId: string, actor: Actor & { type: 'user' }, taskId: string, decision: 'aprovar' | 'devolver' | 'responder', note: string | null): ResultRow {
    const t = getTask(this.db, workspaceId, taskId);
    if (Number(t.completed)) throw new HttpError(409, 'completed', 'Esta tarefa já está concluída.');
    if (this.db.get("SELECT 1 AS x FROM runs WHERE task_id = ? AND status IN ('queued', 'running', 'waiting_user')", taskId)) throw new HttpError(409, 'busy', 'O agente ainda está trabalhando neste card: espere terminar.');
    const kind = this.kindOf(workspaceId, taskId);
    const prev = this.latest(workspaceId, taskId);
    if (decision === 'devolver' || decision === 'responder') {
      const answer = decision === 'responder';
      if (!note || note.trim().length < (answer ? 1 : 3)) throw new HttpError(400, 'note', answer ? 'Escreva a resposta (ela vai para o agente).' : 'Diga o que precisa mudar (a instrução vai para o agente).');
      return this.record(workspaceId, taskId, null, kind, 'devolvido', [], { previous: prev?.id ?? null, instrucao: clip(note.trim(), 200_000), ...(answer ? { resposta: true } : {}) },
        `${answer ? 'Respondida por você' : 'Devolvida com instrução'}: ${clip(note.trim(), 300)}`, actor.id!);
    }
    // o que não foi feito não se aprova: tentar de novo, devolver com instrução ou descartar o card
    if (prev?.state === 'falha' || prev?.state === 'descartado') throw new HttpError(409, 'not_done', 'Isto não foi feito, então não dá para aprovar: tente de novo ou descarte o card.');
    const crit: Criterion[] = [{ id: 'humano', label: 'Conferido e aprovado por você', ok: true }];
    const just = kind === 'externo' && prev?.state === 'sem_confirmacao' ? 'Ação externa confirmada por você.' : 'Aprovada e concluída por você.';
    return this.record(workspaceId, taskId, null, kind, 'confirmado_humano', crit, { previous: prev?.id ?? null, nota: note ? clip(note, 600) : null },
      note ? `${just} ${clip(note, 300)}` : just, actor.id!);
  }

  /**
   * O trabalho não pode começar (arquivo ausente ou inválido, ninguém com a ferramenta): registra o motivo e o card
   * espera, sem chamada de modelo. Sem execução ligada: cada tentativa fica no histórico.
   */
  needInput(workspaceId: string, taskId: string, kind: ResultKind, justification: string, state: 'aguardando_info' | 'reprovado' = 'aguardando_info', opId: string | null = null, decidedBy = 'ergon'): ResultRow {
    const crit: Criterion[] = [{ id: 'entrada', label: kind === 'dados' ? 'Arquivo de dados válido e quem saiba analisá-lo' : 'Arquivo citado no pedido anexado ao card', ok: false, detail: clip(justification, 200) }];
    return this.record(workspaceId, taskId, null, kind, state, crit, { operationId: opId }, justification, decidedBy.startsWith('usr_') ? decidedBy : 'ergon');
  }

  /**
   * A equipe respondeu ao que travou o card (ciclo de persistência, teamwork.ts): vale como a resposta a uma pergunta,
   * mas vinda de quem decidiu na equipe; o card volta a andar sem esperar a pessoa.
   */
  teamAnswer(workspaceId: string, taskId: string, text: string, by: string): ResultRow {
    const kind = this.kindOf(workspaceId, taskId);
    const prev = this.latest(workspaceId, taskId);
    return this.record(workspaceId, taskId, null, kind, 'devolvido', [], { previous: prev?.id ?? null, instrucao: clip(text.trim(), 200_000), resposta: true, equipe: by },
      `Resolvido na equipe por ${by}: ${clip(text.trim(), 300)}`, 'ergon');
  }

  /** O card volta ao estado da última decisão (o ciclo de persistência não chegou a decidir nada). */
  restoreWorkState(workspaceId: string, taskId: string): void {
    const r = this.latest(workspaceId, taskId);
    const work = r ? WORK_OF[r.state] : null;
    if (r && work) this.setWorkState(workspaceId, taskId, work, r.justification);
  }

  /** A instrução da última devolução ainda não atendida (vai para a próxima execução do agente). */
  pendingInstruction(workspaceId: string, taskId: string): string | null {
    return this.pendingReturn(workspaceId, taskId)?.text ?? null;
  }

  /** A devolução ainda não atendida, dizendo se era a resposta a uma pergunta do agente. */
  pendingReturn(workspaceId: string, taskId: string): { text: string; answer: boolean; team: string | null; at: string } | null {
    const r = this.latest(workspaceId, taskId);
    const text = r?.state === 'devolvido' ? String(r.evidenceData.instrucao ?? '') : '';
    // num plano, a devolução vale para a etapa em que foi feita: depois que ela passou adiante, a próxima não a recebe
    if (text && this.db.get('SELECT 1 AS x FROM task_steps WHERE task_id = ? AND done_at > ? LIMIT 1', taskId, r!.decided_at ?? r!.created_at)) return null;
    return text ? { text, answer: r?.evidenceData.resposta === true, team: typeof r?.evidenceData.equipe === 'string' ? r.evidenceData.equipe : null, at: r!.created_at } : null;
  }

  /**
   * Recuperação no boot: execução da fila que terminou sem decisão registrada (o servidor caiu entre o fim e a
   * avaliação) é avaliada agora, uma única vez.
   */
  reconcile(): number {
    const lost = this.db.all<RunRow>(`SELECT r.* FROM runs r JOIN tasks t ON t.id = r.task_id
      WHERE r.idempotency_key LIKE 'queue-%' AND r.status IN ('succeeded', 'failed', 'cancelled') AND t.completed = 0 AND ws_open(r.workspace_id)
        AND NOT EXISTS (SELECT 1 FROM task_results x WHERE x.run_id = r.id)
        AND NOT EXISTS (SELECT 1 FROM runs n WHERE n.task_id = r.task_id AND n.created_at > r.created_at)
        AND NOT EXISTS (SELECT 1 FROM tasks k WHERE k.parent_task_id = r.task_id AND k.completed = 0 AND k.archived = 0)`);
    let n = 0;
    for (const r of lost) { if (this.evaluate(r, r.status, r.output)) n++; }
    return n;
  }
}

const OPERATION_LABEL = 'Análise de desempenho por responsável';
