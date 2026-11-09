/**
 * Resumo da tarefa para a pessoa: o que ela vê de cara ao abrir um card da equipe — a situação em uma palavra e a faixa
 * de decisão, com a frase exata do que se aprova ou do que foi feito. Feito para quem bate o olho e decide.
 *
 * A frase sai, nesta ordem, de:
 *   1. fatos que o sistema registrou: ações numa conta esperando o seu clique (agent_proposals 'conexao', com a linha de
 *      conexao_acoes) e as já feitas pelo serviço (conexao_acoes 'feita'), o documento entregue, a pergunta do agente,
 *      o motivo da falha;
 *   2. a linha que o agente escreve ao entregar ("Para você decidir: …" ou "Feito: …", teamwork.ts), que nunca aparece
 *      repetida no texto da entrega do card (separarLinhaParaVoce). Ela vai abaixo da frase, com o nome do agente
 *      (doAgente); só vira a frase num card concluído sem nenhum fato, e só a "Feito: …";
 *   3. sem nenhum dos dois, uma frase do estado do card.
 * O texto do agente nunca substitui um fato: os destinatários, as quantidades e os títulos vêm do registro do serviço,
 * e sem cartão esperando, Aprovar só conclui o card (a faixa avisa quando a linha do agente fala em enviar ou pagar).
 */
import type { Db } from '../db/db.ts';
import { clip } from '../lib/util.ts';
import { integrationDef } from './integrations.ts';
import { taskFiles } from './operations.ts';

// ------------------------------------------------------------------------------------------- a linha do agente

export type TipoLinha = 'decidir' | 'feito';
export interface LinhaParaVoce { tipo: TipoLinha; texto: string }

/**
 * "Para você decidir: …" / "Feito: …" numa linha própria, com ou sem negrito. Marcador de lista ("- Feito: …") e
 * citação não contam: num documento que termina com um quadro de status ou um checklist, essa linha é conteúdo.
 */
const LINHA = /^\s*(?:\*\*|__)?\s*(para voc[eê] decidir|feito)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+?)\s*(?:\*\*|__)?\s*$/i;
const CONTROLE = /^\s*\[\[(?:[^\]]|\](?!\]))*\]\]\s*$/;

/**
 * Separa a linha para a pessoa do texto da entrega. Só a ÚLTIMA linha com texto (fora as linhas de controle [[...]])
 * vale: uma linha igual no meio ou numa lista do documento é conteúdo e fica onde está. A linha sai do corpo (a tela
 * mostra a frase na faixa de decisão, não duas vezes). Sem a linha, o corpo volta igual.
 */
export function separarLinhaParaVoce(texto: string | null | undefined): { corpo: string; linha: LinhaParaVoce | null } {
  const s = texto ?? '';
  const linhas = s.split(/\r?\n/);
  let i = linhas.length - 1;
  while (i >= 0 && (!linhas[i].trim() || CONTROLE.test(linhas[i]))) i--;
  const m = i >= 0 ? LINHA.exec(linhas[i]) : null;
  if (!m) return { corpo: s, linha: null };
  const frase = m[2].replace(/^["“]|["”]$/g, '').trim();
  if (frase.length < 3) return { corpo: s, linha: null };
  const corpo = [...linhas.slice(0, i), ...linhas.slice(i + 1)].join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { corpo, linha: { tipo: /^feito$/i.test(m[1]) ? 'feito' : 'decidir', texto: clip(frase.replace(/\s+/g, ' '), 400) } };
}

/**
 * A linha do agente fala em enviar, criar, pagar… mas nenhum cartão espera o seu clique: Aprovar só conclui o card.
 * A tela e a conversa dizem isso, para ninguém aprovar achando que algo vai sair.
 */
const PROMETE_ACAO = /\b(enviar|envios?|mandar|criar|pagar|pagamentos?|publicar|agendar|marcar|cobrar|cobran[cç]as?|transferir|transfer[eê]ncias?|apagar|excluir)\b/i;
export const AVISO_SEM_CARTAO = 'Aprovar só conclui este card: nada é enviado, criado ou pago numa conta por este clique.';
export const avisoSemCartao = (linha: LinhaParaVoce | null): string | null => (linha?.tipo === 'decidir' && PROMETE_ACAO.test(linha.texto) ? AVISO_SEM_CARTAO : null);

/** O texto sem a linha para a pessoa (o que aparece na entrega, no documento e na conversa). */
export const semLinhaParaVoce = (texto: string | null | undefined): string => separarLinhaParaVoce(texto).corpo;

// ------------------------------------------------------------------------------------------- etapas curtas

/**
 * A etapa numa frase curta ("Aspásia — verificar as redes"): a primeira oração, até umas 60 letras, sem cortar
 * palavra. O texto inteiro fica para quem passar o mouse ou abrir.
 */
export function etapaCurta(titulo: string, max = 72): string {
  let t = titulo.replace(/\s+/g, ' ').trim();
  // a primeira oração; o corte não deixa só um nome ("Pedro Alves: levantar os custos" fica inteiro)
  const re = /[.;:!?](?=\s|$)/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const antes = t.slice(0, m.index).trim().split(' ').length;
    if (antes >= (m[0] === ':' ? 3 : 2)) { t = t.slice(0, m.index); break; }
  }
  t = t.replace(/[,\s]+$/, '');
  if (t.length > max) {
    const corte = t.slice(0, max + 1);
    // a oração principal, quando a vírgula ou o travessão a separam do resto ("…nos últimos 30 dias, listando…");
    // vírgula cedo é lista ("alcance, engajamento e…"): aí corta na palavra, com reticências
    const pausa = Math.max(corte.lastIndexOf(', '), corte.lastIndexOf(' — '), corte.lastIndexOf(' - '));
    if (pausa >= 30) t = t.slice(0, pausa);
    else { const sp = corte.lastIndexOf(' '); t = `${t.slice(0, sp > 24 ? sp : max).replace(/[,\s]+$/, '').replace(/\s+(e|de|da|do|das|dos|para|com|em|no|na|a|o|os|as)$/i, '')}…`; }
  }
  // "Verificar as redes" → "verificar as redes" (o nome do agente vem antes). Só verbo no infinitivo: nome próprio,
  // cliente e sigla no começo ficam como estão ("Ana revisa o contrato", "Acme: proposta")
  const primeira = /^(\p{Lu}\p{Ll}+)(?=[\s,]|$)/u.exec(t)?.[1];
  if (primeira && /(ar|er|ir|[oô]r)$/.test(primeira) && !NOMES_COMO_VERBO.has(primeira)) t = t.charAt(0).toLowerCase() + t.slice(1);
  return t;
}
/** nomes de gente e de marca que terminam como verbo no infinitivo ("Oscar", "Walter"): ficam em maiúscula */
const NOMES_COMO_VERBO = new Set(['Oscar', 'Edgar', 'Baltazar', 'Itamar', 'Omar', 'Gilmar', 'Vilmar', 'Valdemar', 'Waldemar', 'Altamir', 'Ademir', 'Valdir', 'Jair', 'Aldair', 'Altair', 'Adir', 'Walter', 'Peter', 'Esther', 'Ester', 'Heitor', 'Vitor', 'Victor', 'Igor', 'Nestor', 'Junior', 'Planner', 'Hubspot', 'Twitter', 'Messenger', 'Docker', 'Flor', 'Amor']);

// ------------------------------------------------------------------------------------------- fatos das contas

type Grupo = 'apagar' | 'email' | 'resposta' | 'mensagem' | 'cobranca' | 'tarefa' | 'tarefa_mudar' | 'agenda' | 'documento' | 'mover' | 'outro';
/** copia: quem vai em cópia (o cc de um e-mail), que pesa na decisão tanto quanto o destinatário */
interface Fato { grupo: Grupo; app: string; alvos: string[]; copia?: string[]; nomes: string[]; resumo: string; verbo?: 'criar' | 'atualizar' | 'cancelar'; coisa?: 'email' | 'mensagem' | 'item' }

const lista = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs.at(-1)}`);
const aspas = (s: string) => `“${s}”`;
const unicos = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
/** no máximo 3 nomes; o resto vira "e mais N" */
const poucos = (xs: string[], n = 3) => (xs.length <= n ? lista(xs) : `${xs.slice(0, n).join(', ')} e mais ${xs.length - n}`);

/** valor de texto de um parâmetro (lista, texto separado por vírgula, ou nada) */
function valores(a: Record<string, unknown>, ...chaves: string[]): string[] {
  for (const k of chaves) {
    const v = a[k];
    if (Array.isArray(v)) return v.map((x) => String(x ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (typeof v === 'string' && v.trim()) return v.split(/[;,]\s*/).map((x) => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }
  return [];
}
const umValor = (a: Record<string, unknown>, ...chaves: string[]) => {
  for (const k of chaves) { const v = a[k]; if (typeof v === 'string' && v.trim()) return clip(v.replace(/\s+/g, ' ').trim(), 80); }
  return '';
};

/** O nome do aplicativo de uma ação: o Teams e o WhatsApp pelo nome, o resto pelo nome da conexão. */
function appDe(conexao: string, acao: string): string {
  if (acao.startsWith('teams.')) return 'Teams';
  if (acao.startsWith('whatsapp.')) return 'WhatsApp';
  if (acao.startsWith('email.')) return 'e-mail';
  if (acao.startsWith('agenda.')) return 'agenda';
  return integrationDef(conexao as never)?.name ?? conexao;
}

/** Uma ação numa conta (a linha de conexao_acoes) como fato: o que é, onde, para quem e com que nome. */
export function fatoDaAcao(x: { conexao: string; acao: string; args: string | null; resumo: string | null }): Fato {
  let a: Record<string, unknown> = {};
  try { a = x.args ? (JSON.parse(x.args) as Record<string, unknown>) : {}; } catch { a = {}; }
  const app = appDe(x.conexao, x.acao);
  const resumo = clip((x.resumo ?? x.acao).split('\n')[0].replace(/\s+/g, ' ').trim(), 160);
  const id = x.acao;
  // apagar vem antes de tudo, com o verbo à vista: nunca vira "fazer N ações"
  if (/\.(apagar|excluir)$/.test(id)) {
    return { grupo: 'apagar', app, alvos: [], nomes: [], resumo, coisa: id.startsWith('email.') ? 'email' : /^(discord|slack|mattermost|rocketchat|teams|telegram|whatsapp)\./.test(id) ? 'mensagem' : 'item' };
  }
  if (id === 'email.mover') return { grupo: 'mover', app, alvos: [], nomes: [umValor(a, 'pasta')].filter(Boolean), resumo };
  if (/^email\.(enviar|enviar_rascunho)$/.test(id)) return { grupo: 'email', app, alvos: valores(a, 'para'), copia: valores(a, 'cc'), nomes: [umValor(a, 'assunto')].filter(Boolean), resumo };
  if (id === 'asaas.criar_cobranca') return { grupo: 'cobranca', app, alvos: [], nomes: [reais(a.valor)].filter(Boolean), resumo };
  if (id === 'email.responder') return { grupo: 'resposta', app, alvos: [], nomes: [], resumo };
  if (/\.(enviar|direta|responder|enviar_canal|nova_conversa)$/.test(id) || /^(freshdesk|zendesk|intercom)\.responder$/.test(id)) {
    return { grupo: 'mensagem', app, alvos: valores(a, 'para', 'conversa', 'destinatario', 'contato', 'canal'), nomes: [], resumo };
  }
  if (/^tarefa\.criar$|\.criar_tarefa$/.test(id)) return { grupo: 'tarefa', app, alvos: [], nomes: [umValor(a, 'titulo', 'nome')].filter(Boolean), resumo };
  if (/^tarefa\.(concluir|mover|editar|comentar)$/.test(id)) return { grupo: 'tarefa_mudar', app, alvos: [], nomes: [umValor(a, 'tarefa', 'titulo')].filter(Boolean), resumo };
  if (/^agenda\.(criar|editar|cancelar)$/.test(id)) return { grupo: 'agenda', app, alvos: valores(a, 'participantes'), nomes: [umValor(a, 'titulo', 'evento')].filter(Boolean), resumo, verbo: id.endsWith('cancelar') ? 'cancelar' : id.endsWith('editar') ? 'atualizar' : 'criar' };
  if (/^arquivos\.criar$|\.(criar_pagina|atualizar_pagina|acrescentar)$/.test(id)) {
    const nome = umValor(a, 'titulo', 'caminho', 'nome', 'pagina').replace(/^.*[\\/]/, '');
    return { grupo: 'documento', app, alvos: [], nomes: [nome].filter(Boolean), resumo, verbo: /criar/.test(id) ? 'criar' : 'atualizar' };
  }
  return { grupo: 'outro', app, alvos: [], nomes: [], resumo };
}

const ORDEM: Grupo[] = ['apagar', 'email', 'resposta', 'mensagem', 'cobranca', 'tarefa', 'tarefa_mudar', 'agenda', 'documento', 'mover', 'outro'];
const juntar = (fatos: Fato[]) => ORDEM.map((g) => fatos.filter((f) => f.grupo === g)).filter((x) => x.length);
const em = (fs: Fato[]) => { const apps = unicos(fs.map((f) => f.app)); return apps.length ? ` em ${lista(apps)}` : ''; };
const no = (fs: Fato[]) => { const apps = unicos(fs.map((f) => f.app)); return apps.length ? ` no ${lista(apps)}` : ''; };
const qtd = (n: number, um: string, varios: string) => (n === 1 ? um : `${n} ${varios}`);
/** R$ 1.290,50: o valor de uma cobrança, como o parâmetro veio */
function reais(v: unknown): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) && n > 0 ? `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
}
/** o que se apaga: [um, vários, um feito, vários feitos] */
const COISA = {
  email: ['um e-mail', 'e-mails', 'E-mail apagado', 'e-mails apagados'], mensagem: ['uma mensagem', 'mensagens', 'Mensagem apagada', 'mensagens apagadas'],
  item: ['um item', 'itens', 'Item apagado', 'itens apagados'],
} as const;
const copiaDe = (fs: Fato[]) => { const cc = unicos(fs.flatMap((f) => f.copia ?? [])); return cc.length ? `, com cópia para ${poucos(cc)}` : ''; };
/** o resumo de cada ação (que já diz o verbo), no máximo 3: nunca "fazer N ações" sem dizer quais */
const cada = (fs: Fato[]) => poucos(unicos(fs.map((f) => clip(f.resumo.replace(/[.:\s]+$/, ''), 110))).map((r) => r.charAt(0).toLowerCase() + r.slice(1)));

/** O que espera o seu clique, numa frase no infinitivo ("enviar 2 e-mails para Ana e Bruno, sobre “Orçamento”"). */
export function fraseDoPendente(fatos: Fato[]): string {
  return lista(juntar(fatos).map((fs) => {
    const n = fs.length; const alvos = unicos(fs.flatMap((f) => f.alvos)); const nomes = unicos(fs.flatMap((f) => f.nomes));
    switch (fs[0].grupo) {
      case 'apagar': { const c = COISA[fs[0].coisa ?? 'item']; return `apagar ${qtd(n, c[0], c[1])}${fs[0].coisa === 'email' ? '' : em(fs)}`; }
      case 'mover': return `mover ${qtd(n, 'um e-mail', 'e-mails')}${nomes.length ? ` para ${nomes.length === 1 ? 'a pasta' : 'as pastas'} ${poucos(nomes.map(aspas))}` : ''}`;
      case 'cobranca': return `criar ${qtd(n, 'uma cobrança', 'cobranças')}${em(fs)}${nomes.length ? ` (${poucos(nomes)})` : ''}, e o Asaas avisa o cliente`;
      case 'email': return `enviar ${qtd(n, 'um e-mail', 'e-mails')}${alvos.length ? ` para ${poucos(alvos)}` : ''}${copiaDe(fs)}${nomes.length ? `, sobre ${poucos(nomes.map(aspas))}` : ''}`;
      case 'resposta': return `responder ${qtd(n, 'um e-mail', 'e-mails')}`;
      case 'mensagem': return `mandar ${qtd(n, 'uma mensagem', 'mensagens')}${alvos.length ? ` para ${poucos(alvos)}` : ''}${no(fs)}`;
      case 'tarefa': return nomes.length ? `criar ${n === 1 ? 'a tarefa' : 'as tarefas'} ${poucos(nomes.map(aspas), 4)}${em(fs)}` : `criar ${qtd(n, 'uma tarefa', 'tarefas')}${em(fs)}`;
      case 'tarefa_mudar': return `mudar ${n === 1 ? 'a tarefa' : 'as tarefas'}${nomes.length ? ` ${poucos(nomes.map(aspas))}` : ''}${em(fs)}`;
      case 'agenda': return `${fs[0].verbo === 'cancelar' ? 'desmarcar' : 'marcar'} na agenda${nomes.length ? ` ${poucos(nomes.map(aspas))}` : ''}${alvos.length ? `, com convite para ${poucos(alvos)}` : ''}`;
      case 'documento': return `${fs[0].verbo === 'criar' ? 'criar' : 'atualizar'} ${n === 1 ? 'o documento' : 'os documentos'}${nomes.length ? ` ${poucos(nomes.map(aspas))}` : ''}${em(fs)}`;
      default: return cada(fs);
    }
  }));
}

/** O que já foi feito, uma frase por tipo ("2 e-mails enviados para Ana e Bruno." · "Tarefas criadas: X, Y e Z."). */
export function frasesDoFeito(fatos: Fato[]): string[] {
  return juntar(fatos).map((fs) => {
    const n = fs.length; const alvos = unicos(fs.flatMap((f) => f.alvos)); const nomes = unicos(fs.flatMap((f) => f.nomes));
    switch (fs[0].grupo) {
      case 'apagar': { const c = COISA[fs[0].coisa ?? 'item']; return `${qtd(n, c[2], c[3])}${fs[0].coisa === 'email' ? '' : em(fs)}.`; }
      case 'mover': return `${qtd(n, 'E-mail movido', 'e-mails movidos')}${nomes.length ? ` para ${poucos(nomes.map(aspas))}` : ''}.`;
      case 'cobranca': return `${qtd(n, 'Cobrança criada', 'cobranças criadas')}${em(fs)}${nomes.length ? ` (${poucos(nomes)})` : ''}.`;
      case 'email': return `${qtd(n, 'E-mail enviado', 'e-mails enviados')}${alvos.length ? ` para ${poucos(alvos)}` : ''}${copiaDe(fs)}${nomes.length ? `, sobre ${poucos(nomes.map(aspas))}` : ''}.`;
      case 'resposta': return `${qtd(n, 'Resposta enviada', 'respostas enviadas')} por e-mail.`;
      case 'mensagem': return `${qtd(n, 'Mensagem enviada', 'mensagens enviadas')}${alvos.length ? ` para ${poucos(alvos)}` : ''}${no(fs)}.`;
      case 'tarefa': return nomes.length ? `${n === 1 ? 'Tarefa criada' : 'Tarefas criadas'}${em(fs)}: ${poucos(nomes, 6)}.` : `${qtd(n, 'Tarefa criada', 'tarefas criadas')}${em(fs)}.`;
      case 'tarefa_mudar': return `${n === 1 ? 'Tarefa atualizada' : 'Tarefas atualizadas'}${em(fs)}${nomes.length ? `: ${poucos(nomes, 6)}` : ''}.`;
      case 'agenda': return `${fs[0].verbo === 'cancelar' ? 'Desmarcado na agenda' : fs[0].verbo === 'atualizar' ? 'Atualizado na agenda' : 'Marcado na agenda'}${nomes.length ? `: ${poucos(nomes.map(aspas))}` : ''}${alvos.length ? `, com convite para ${poucos(alvos)}` : ''}.`;
      case 'documento': return `${n === 1 ? 'Documento' : 'Documentos'}${nomes.length ? ` ${poucos(nomes.map(aspas))}` : ''} ${fs[0].verbo === 'criar' ? (n === 1 ? 'criado' : 'criados') : (n === 1 ? 'atualizado' : 'atualizados')}${em(fs)}.`;
      default: return `${cada(fs)} (feito${em(fs)}).`;
    }
  }).map((s) => s.charAt(0).toUpperCase() + s.slice(1));
}

// ------------------------------------------------------------------------------------------- o resumo

export type Tom = 'decidir' | 'precisa' | 'trabalhando' | 'fila' | 'feito' | 'falhou';
export interface ResumoTarefa {
  /** a situação em uma palavra (ou quase), com a cor pelo tom */
  situacao: { tom: Tom; texto: string };
  /** a faixa de decisão: título curto, a frase exata, os fatos já feitos e a linha do agente quando ela complementa */
  faixa: { titulo: string; frase: string; itens: string[]; doAgente: string | null };
}

/** os critérios que não passaram, em palavras de todo dia (a conferência inteira fica em "Como foi conferido") */
const MOTIVO: Record<string, string> = {
  execucao: 'o trabalho parou no meio', modelo: 'a resposta não foi escrita pela conta de IA', conteudo: 'a entrega ficou curta demais',
  alegacao: 'a resposta só disse que terminou', pendencias: 'ficou uma pergunta sem resposta', entregavel: 'o documento não foi salvo',
  operacao: 'a análise do arquivo não foi feita', conexao: 'a ação na conta não foi confirmada pelo aplicativo', declaracao: 'o agente disse que não fez',
};

interface Ctx { queue?: { position: number; total: number } | null }

/** Desde quando contam as ações feitas para este resumo: o trabalho que terminou agora (a conclusão de antes fica de fora). */
function desdeDoResumo(db: Db, ws: string, taskId: string, concluida: boolean): string {
  const rows = db.all<{ state: string; evidence: string; decided_by: string; created_at: string }>(
    "SELECT state, evidence, decided_by, created_at FROM task_results WHERE workspace_id = ? AND task_id = ? AND state IN ('validado', 'confirmado_humano', 'devolvido') ORDER BY created_at DESC, rowid DESC LIMIT 100", ws, taskId);
  let pulou = !concluida;
  for (const x of rows) {
    if (x.state !== 'devolvido') { if (!pulou) { pulou = true; continue; } return x.created_at; }
    if (!x.decided_by.startsWith('usr_')) continue;
    let ev: { resposta?: unknown } = {};
    try { ev = JSON.parse(x.evidence) as { resposta?: unknown }; } catch { /* ilegível: pedido novo */ }
    if (ev.resposta !== true) return x.created_at;
  }
  return '';
}

const maiuscula = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const ponto = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const sem = (s: string, re: RegExp) => s.replace(re, '').trim();

/**
 * A proteção "depois de ler": o que o clique libera, com o endereço ou o programa exato que o cartão mostra
 * ("que Aspásia abra o site exemplo.com depois de ler as suas contas"). É uma decisão à parte, nunca em lote.
 */
export function fraseDepoisDeLer(p: { agente?: string; grupo?: string; chaves?: string[]; alvo?: string }, quem: string): string {
  const ag = p.agente ?? quem;
  const chaves = Array.isArray(p.chaves) ? p.chaves : [];
  if (chaves[0] === 'pagina') return `que ${ag} mexa na página aberta no navegador depois de ler as suas contas`;
  const sites = chaves.filter((k) => k.startsWith('site:')).map((k) => { const o = k.slice(5); try { return new URL(o).host; } catch { return o; } });
  if (p.grupo !== 'programas' && sites.length) return `que ${ag} abra ${sites.length > 1 ? `os sites ${poucos(sites)}` : `o site ${sites[0]}`} depois de ler as suas contas`;
  const alvo = clip((p.alvo ?? '').replace(/\s+/g, ' ').trim(), 90);
  if (p.grupo === 'programas') return `que ${ag} rode ${alvo ? `o programa ${aspas(alvo)}` : 'um programa'} depois de ler as suas contas`;
  return `que ${ag} ${alvo ? `use o navegador em ${aspas(alvo)}` : 'abra um site'} depois de ler as suas contas`;
}

/** O título do documento entregue: o primeiro cabeçalho do texto ("# Relatório de outubro"). */
function tituloDoDocumento(texto: string | null): string | null {
  const m = /^#{1,3}\s+(.+?)\s*#*\s*$/m.exec(texto ?? '');
  return m ? clip(m[1].replace(/[*_`]/g, '').trim(), 90) : null;
}

/**
 * O resumo de um card da equipe para a pessoa (GET /api/tasks/:id). null: card fora do quadro da equipe (suas tarefas e
 * as ligadas a um aplicativo, que não esperam decisão).
 */
export function resumoDaTarefa(db: Db, ws: string, taskId: string, ctx: Ctx = {}): ResumoTarefa | null {
  const t = db.get<{ id: string; title: string; completed: number; completed_by: string | null; work_state: string | null; agent_id: string | null; audience: string }>(
    'SELECT t.id, t.title, t.completed, t.completed_by, t.work_state, t.agent_id, b.audience FROM tasks t JOIN boards b ON b.id = t.board_id WHERE t.id = ? AND t.workspace_id = ?', taskId, ws);
  if (!t || t.audience !== 'team') return null;
  const nome = (agentId: string | null | undefined) => (agentId ? db.get<{ name: string }>('SELECT name FROM agents WHERE id = ?', agentId)?.name ?? null : null);
  const quem = nome(t.agent_id) ?? 'A equipe';
  const concluida = !!Number(t.completed);
  const res = db.get<{ state: string; justification: string; evidence: string; criteria: string; decided_by: string }>(
    'SELECT state, justification, evidence, criteria, decided_by FROM task_results WHERE workspace_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', ws, taskId);
  let ev: Record<string, unknown> = {};
  try { ev = res ? (JSON.parse(res.evidence) as Record<string, unknown>) : {}; } catch { ev = {}; }
  const desde = desdeDoResumo(db, ws, taskId, concluida);

  // fatos: o que espera o seu clique, e o que o serviço já fez neste trabalho (o card e os que nasceram dele)
  const cartoes = db.all<{ kind: string; payload: string; summary: string | null }>(`SELECT p.kind, p.payload, p.summary FROM agent_proposals p JOIN runs r ON r.id = p.run_id
     WHERE r.task_id = ? AND p.workspace_id = ? AND p.kind IN ('conexao', 'depois_de_ler') AND p.status = 'proposed' ORDER BY p.created_at`, taskId, ws);
  const pendentes: Fato[] = []; const aprovacoes: string[] = [];
  for (const c of cartoes) {
    let p: { acaoId?: string; agente?: string; grupo?: string; chaves?: string[]; alvo?: string } = {};
    try { p = JSON.parse(c.payload) as typeof p; } catch { continue; }
    if (c.kind === 'depois_de_ler') { aprovacoes.push(fraseDepoisDeLer(p, quem)); continue; }
    const row = p.acaoId ? db.get<{ conexao: string; acao: string; args: string | null; resumo: string | null }>('SELECT conexao, acao, args, resumo FROM conexao_acoes WHERE id = ? AND workspace_id = ?', p.acaoId, ws) : undefined;
    if (row) pendentes.push(fatoDaAcao(row));
  }
  const feitos = frasesDoFeito(db.all<{ conexao: string; acao: string; args: string | null; resumo: string | null }>(
    `SELECT conexao, acao, args, resumo FROM conexao_acoes WHERE workspace_id = ? AND status = 'feita' AND risco <> 'ler' AND created_at > ?
       AND (task_id = ? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id = ?)) ORDER BY created_at LIMIT 60`, ws, desde, taskId, taskId).map(fatoDaAcao));

  // a entrega mais recente deste trabalho: a linha para a pessoa e o título do documento
  const saida = db.get<{ output: string | null; agent_id: string }>(
    "SELECT output, agent_id FROM runs WHERE task_id = ? AND workspace_id = ? AND status = 'succeeded' AND idempotency_key LIKE 'queue-%' AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1", taskId, ws, desde);
  const { corpo, linha } = separarLinhaParaVoce(saida?.output ?? null);
  const autor = nome(saida?.agent_id) ?? quem;
  // o que o trabalho entregou como arquivo neste trabalho: a análise da planilha, ou o texto salvo como documento
  const arquivos = taskFiles(db, ws, taskId).filter((f) => f.role === 'entregavel' && f.created_at > desde).length;
  const analise = arquivos > 0 && !!db.get("SELECT 1 AS x FROM operations WHERE task_id = ? AND workspace_id = ? AND status <> 'erro' AND created_at > ?", taskId, ws, desde);
  const doc = arquivos > 0 && !analise ? tituloDoDocumento(corpo) : null;
  const entregue = !arquivos ? null : analise ? 'Relatório e indicadores calculados a partir da planilha, nos arquivos abaixo.'
    : `${doc ? `Documento ${aspas(doc)}` : arquivos === 1 ? 'Documento' : `${arquivos} arquivos`} ${arquivos === 1 || doc ? 'entregue' : 'entregues'}, nos arquivos abaixo.`;
  const daLinha = linha ? `${autor}: ${ponto(linha.texto)}` : null;

  const ativa = db.get<{ agent_id: string; status: string }>("SELECT agent_id, status FROM runs WHERE task_id = ? AND workspace_id = ? AND status IN ('queued', 'running', 'waiting_user') ORDER BY created_at DESC LIMIT 1", taskId, ws);
  const montar = (tom: Tom, texto: string, titulo: string, frase: string, itens: string[] = [], doAgente: string | null = null): ResumoTarefa =>
    ({ situacao: { tom, texto }, faixa: { titulo, frase: ponto(maiuscula(frase)), itens, doAgente } });

  // 1. espera o seu clique num cartão: a frase vem do que o serviço vai fazer, nunca do texto do agente
  // A proteção "depois de ler" é uma decisão à parte (a tela não a junta no "Aprovar" das ações nas contas): com ações
  // esperando, ela vai como item próprio; sozinha, é a frase
  if (!concluida && (pendentes.length || aprovacoes.length)) {
    const frase = pendentes.length ? `Aguardando sua aprovação para ${fraseDoPendente(pendentes)}` : `Aguardando sua aprovação ${lista(aprovacoes.map((x) => `para ${x}`))}`;
    const aParte = pendentes.length ? aprovacoes.map((x) => `À parte, decida no cartão abaixo: ${ponto(maiuscula(x))}`) : [];
    return montar('decidir', 'Esperando sua aprovação', 'Para você decidir', frase, [...aParte, ...feitos.map((f) => `Já feito: ${f}`)], linha?.tipo === 'decidir' ? daLinha : null);
  }
  // 2. concluída: o que foi feito, pelos fatos; a linha "Feito: …" do agente completa (ou é a frase, sem fatos). A linha
  // "Para você decidir: …" num card que concluiu sozinho nunca vira "o que foi feito": fica à parte, como o que é seu
  if (concluida) {
    const porVoce = res?.state === 'confirmado_humano' || t.completed_by === 'human';
    const feito = linha?.tipo === 'feito' ? linha : null;
    const frase = feitos[0] ?? entregue ?? (feito ? ponto(maiuscula(feito.texto)) : porVoce ? 'Aprovada por você' : 'Concluída e conferida pelo sistema');
    const resto = feitos.length ? [...feitos.slice(1), ...(entregue ? [entregue] : [])] : [];
    const seu = linha?.tipo === 'decidir' ? [`Ficou para você decidir: ${ponto(linha.texto)}`] : [];
    return montar('feito', 'Feito', 'O que foi feito', frase, [...resto, ...seu], (feitos.length || entregue) && feito ? daLinha : null);
  }
  // 3. trabalhando agora (a etapa da vez, quando há plano)
  if (ativa) {
    const etapas = db.all<{ position: number; title: string; status: string; agent_id: string }>('SELECT position, title, status, agent_id FROM task_steps WHERE task_id = ? ORDER BY position', taskId);
    const cur = etapas.find((s) => s.status === 'em_andamento');
    const quemAgora = nome(ativa.agent_id) ?? quem;
    const frase = cur ? `${quemAgora} está na etapa ${cur.position} de ${etapas.length}: ${etapaCurta(cur.title)}` : `${quemAgora} está trabalhando nisto agora`;
    return montar('trabalhando', 'Trabalhando', 'Agora', frase, feitos.map((f) => `Já feito: ${f}`));
  }
  const ajuda = db.all<{ number: number; name: string | null }>('SELECT t.number, a.name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.parent_task_id = ? AND t.completed = 0 AND t.archived = 0 ORDER BY t.number', taskId);
  const state = t.work_state ?? 'solicitada';
  const pessoa = typeof ev.pessoa === 'string' && ev.pessoa ? ev.pessoa : null;
  // 4. o que só você resolve, a pergunta do agente, e o que você recusou
  if (state === 'aguardando_info' || res?.state === 'descartado') {
    const pergunta = typeof ev.pergunta === 'string' && ev.pergunta ? ev.pergunta : null;
    if (pergunta) return montar('precisa', 'Precisa de você', 'Para você responder', `${quem} pergunta: ${pergunta}`, feitos.map((f) => `Já feito: ${f}`));
    return montar('precisa', 'Precisa de você', 'O que falta', `Falta algo seu: ${sem(res?.justification ?? 'uma informação', /\s*Responda e ponha para trabalhar de novo\.?$/)}`, feitos.map((f) => `Já feito: ${f}`));
  }
  if (state === 'falha') {
    if (pessoa) return montar('precisa', 'Precisa de você', 'Só você resolve', maiuscula(pessoa), feitos.map((f) => `Já feito: ${f}`));
    const motivo = sem(res?.justification ?? '', /^Não foi feito( por inteiro)?:\s*/i).replace(/\s*O card (fica|continua) aberto\.?/g, '').replace(/\s*Nada conta como entregue sem evidência;?/g, '').trim();
    return montar('falhou', 'Não foi feito', 'O que aconteceu', motivo ? `Não foi feito: ${motivo.charAt(0).toLowerCase()}${motivo.slice(1)}` : 'Não foi feito', feitos.map((f) => `Já feito: ${f}`));
  }
  // 5. esperando a sua aprovação da entrega (ou a sua confirmação do que é fora do sistema). Nenhum cartão espera o
  // clique: Aprovar só conclui o card. A frase sai dos fatos (o documento, o que o serviço fez, quem entregou); a
  // linha do agente vai abaixo, com o nome dele, e um aviso quando ela fala em enviar, criar ou pagar
  if (state === 'aguardando_aprovacao') {
    const aviso = avisoSemCartao(linha);
    if (res?.state === 'sem_confirmacao') {
      return montar('decidir', 'Esperando sua confirmação', 'Para você confirmar', `Confirme quando estiver feito: ${aspas(t.title)}`, entregue ? [entregue] : [], daLinha);
    }
    const comDoc = !feitos.length && !!doc;
    const base = feitos.length ? `Aguardando sua aprovação. ${feitos[0]}`
      : comDoc ? `Aguardando sua aprovação do documento ${aspas(doc!)}, entregue por ${autor}`
      : `Aguardando sua aprovação da entrega de ${autor}`;
    const itens = [...feitos.slice(1).map((f) => `Já feito: ${f}`), ...(entregue && !comDoc ? [entregue] : []), ...(aviso ? [aviso] : [])];
    return montar('decidir', 'Esperando sua aprovação', 'Para você decidir', base, itens, daLinha);
  }
  // 6. não passou na conferência: você decide se aprova assim mesmo
  if (state === 'revisao') {
    let crit: Array<{ id: string; ok: boolean }> = [];
    try { crit = JSON.parse(res?.criteria ?? '[]') as typeof crit; } catch { crit = []; }
    const motivos = unicos(crit.filter((c) => !c.ok && MOTIVO[c.id]).map((c) => MOTIVO[c.id]));
    return montar('decidir', 'Precisa da sua decisão', 'Para você decidir', `A entrega de ${autor} não passou na conferência${motivos.length ? `: ${lista(motivos)}` : ''}. Aprove assim mesmo ou peça um ajuste`, [], daLinha);
  }
  if (ajuda.length) return montar('trabalhando', 'Trabalhando', 'Agora', `Esperando ${lista(unicos(ajuda.map((x) => x.name ?? 'um colega')))} terminar a parte que falta (card ${ajuda.map((x) => `#${x.number}`).join(', ')})`, feitos.map((f) => `Já feito: ${f}`));
  if (ctx.queue) return montar('fila', 'Na fila', 'Agora', `Na fila: ${ctx.queue.position}º de ${ctx.queue.total}. ${quem === 'A equipe' ? 'A coordenação encaminha' : `${quem} começa`} quando chegar a vez`);
  if (['processamento', 'resultado', 'validacao'].includes(state)) return montar('trabalhando', 'Trabalhando', 'Agora', `${quem} está trabalhando nisto`);
  return montar('fila', 'Esperando para começar', 'Agora', t.agent_id ? `${quem} começa assim que puder` : 'A coordenação vai encaminhar a quem faz');
}
