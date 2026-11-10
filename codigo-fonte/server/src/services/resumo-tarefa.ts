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
import { emPt, tx, type Codigo, type Texto, type Valor } from '../lib/textos.ts';
import { clip } from '../lib/util.ts';
import { integrationDef } from './integrations.ts';
import { taskFiles } from './operations.ts';

// ------------------------------------------------------------------------------------------- a linha do agente

export type TipoLinha = 'decidir' | 'feito';
export interface LinhaParaVoce { tipo: TipoLinha; texto: string }

/**
 * "Para você decidir: …" / "Feito: …" numa linha própria, com ou sem negrito. Marcador de lista ("- Feito: …") e
 * citação não contam: num documento que termina com um quadro de status ou um checklist, essa linha é conteúdo.
 * A equipe escreve a linha no idioma da conversa: em inglês, "For you to decide: …" / "Done: …" (as palavras-chave que as
 * instruções pedem, PARA_VOCE em teamwork.ts). As duas línguas valem sempre.
 */
const LINHA = /^\s*(?:\*\*|__)?\s*(para voc[eê] decidir|feito|for you to decide|done)\s*(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.+?)\s*(?:\*\*|__)?\s*$/i;
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
  return { corpo, linha: { tipo: /^(feito|done)$/i.test(m[1]) ? 'feito' : 'decidir', texto: clip(frase.replace(/\s+/g, ' '), 400) } };
}

/**
 * A linha do agente fala em enviar, criar, pagar… mas nenhum cartão espera o seu clique: Aprovar só conclui o card.
 * A tela e a conversa dizem isso, para ninguém aprovar achando que algo vai sair.
 */
const PROMETE_ACAO = /\b(enviar|envios?|mandar|criar|pagar|pagamentos?|publicar|agendar|marcar|cobrar|cobran[cç]as?|transferir|transfer[eê]ncias?|apagar|excluir|send|sending|create|pay|payments?|publish|schedule|book|charge|transfers?|delete|remove)\b/i;
export const AVISO_SEM_CARTAO = emPt(tx('resumo.avisoSemCartao'));
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
// As frases saem como Texto (código + valores, lib/textos.ts): a tela traduz; o português (emPt) continua indo junto.

type Grupo = 'apagar' | 'email' | 'resposta' | 'mensagem' | 'cobranca' | 'tarefa' | 'tarefa_mudar' | 'agenda' | 'documento' | 'mover' | 'outro';
/** copia: quem vai em cópia (o cc de um e-mail), que pesa na decisão tanto quanto o destinatário */
interface Fato { grupo: Grupo; app: Valor; alvos: string[]; copia?: string[]; nomes: string[]; resumo: string; verbo?: 'criar' | 'atualizar' | 'cancelar'; coisa?: 'email' | 'mensagem' | 'item' }

const aspas = (s: string) => `“${s}”`;
const unicos = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
/** no máximo 3 nomes; o resto vira "e mais N" (a lista vai como lista: cada idioma junta do seu jeito) */
const poucos = (xs: readonly Valor[], n = 3): Valor => (xs.length <= n ? xs : tx('resumo.eMais', { itens: xs.slice(0, n).map((x) => emPt(x)).join(', '), mais: xs.length - n }));

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
function appDe(conexao: string, acao: string): Valor {
  if (acao.startsWith('teams.')) return 'Teams';
  if (acao.startsWith('whatsapp.')) return 'WhatsApp';
  if (acao.startsWith('email.')) return tx('resumo.app.email');
  if (acao.startsWith('agenda.')) return tx('resumo.app.agenda');
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
/** os aplicativos das ações, sem repetir (o e-mail e a agenda pelo nome de cada idioma) */
const appsDe = (fs: Fato[]): Valor[] => { const vistos = new Set<string>(); return fs.map((f) => f.app).filter((a) => { const k = emPt(a).trim(); if (!k || vistos.has(k)) return false; vistos.add(k); return true; }); };
const em = (fs: Fato[]): Valor => { const apps = appsDe(fs); return apps.length ? tx('resumo.em', { apps }) : ''; };
const no = (fs: Fato[]): Valor => { const apps = appsDe(fs); return apps.length ? tx('resumo.no', { apps }) : ''; };
/** R$ 1.290,50: o valor de uma cobrança, como o parâmetro veio */
function reais(v: unknown): string {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(',', '.')) : NaN;
  return Number.isFinite(n) && n > 0 ? `R$ ${n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '';
}
const para = (alvos: string[]): Valor => (alvos.length ? tx('resumo.para', { quem: poucos(alvos) }) : '');
const copiaDe = (fs: Fato[]): Valor => { const cc = unicos(fs.flatMap((f) => f.copia ?? [])); return cc.length ? tx('resumo.comCopia', { quem: poucos(cc) }) : ''; };
const sobre = (nomes: string[]): Valor => (nomes.length ? tx('resumo.sobre', { nomes: poucos(nomes.map(aspas)) }) : '');
const espaco = (nomes: string[], n?: number): Valor => (nomes.length ? tx('resumo.espaco', { t: poucos(nomes.map(aspas), n) }) : '');
const convite = (alvos: string[]): Valor => (alvos.length ? tx('resumo.comConvite', { quem: poucos(alvos) }) : '');
/** o resumo de cada ação (que já diz o verbo), no máximo 3: nunca "fazer N ações" sem dizer quais */
const cada = (fs: Fato[]) => poucos(unicos(fs.map((f) => clip(f.resumo.replace(/[.:\s]+$/, ''), 110))).map((r) => r.charAt(0).toLowerCase() + r.slice(1)));

/** O que espera o seu clique, com código para a tela traduzir ("enviar 2 e-mails para Ana e Bruno, sobre “Orçamento”"). */
export function textoDoPendente(fatos: Fato[]): Valor[] {
  return juntar(fatos).map((fs): Valor => {
    const n = fs.length; const alvos = unicos(fs.flatMap((f) => f.alvos)); const nomes = unicos(fs.flatMap((f) => f.nomes));
    switch (fs[0].grupo) {
      case 'apagar': { const c = fs[0].coisa ?? 'item'; return tx('resumo.pendente.apagar', { qtd: tx(`resumo.qtd.${c}`, { n }), em: c === 'email' ? '' : em(fs) }); }
      case 'mover': return tx('resumo.pendente.mover', { qtd: tx('resumo.qtd.email', { n }), pasta: nomes.length ? tx('resumo.paraPasta', { n: nomes.length, nomes: poucos(nomes.map(aspas)) }) : '' });
      case 'cobranca': return tx('resumo.pendente.cobranca', { qtd: tx('resumo.qtd.cobranca', { n }), em: em(fs), valores: nomes.length ? tx('resumo.parenteses', { t: poucos(nomes) }) : '' });
      case 'email': return tx('resumo.pendente.email', { qtd: tx('resumo.qtd.email', { n }), para: para(alvos), copia: copiaDe(fs), sobre: sobre(nomes) });
      case 'resposta': return tx('resumo.pendente.resposta', { qtd: tx('resumo.qtd.email', { n }) });
      case 'mensagem': return tx('resumo.pendente.mensagem', { qtd: tx('resumo.qtd.mensagem', { n }), para: para(alvos), no: no(fs) });
      case 'tarefa': return nomes.length ? tx('resumo.pendente.tarefaComNome', { n, nomes: poucos(nomes.map(aspas), 4), em: em(fs) }) : tx('resumo.pendente.tarefa', { qtd: tx('resumo.qtd.tarefa', { n }), em: em(fs) });
      case 'tarefa_mudar': return tx('resumo.pendente.tarefaMudar', { n, nomes: espaco(nomes), em: em(fs) });
      case 'agenda': return tx(fs[0].verbo === 'cancelar' ? 'resumo.pendente.agendaDesmarcar' : 'resumo.pendente.agendaMarcar', { nomes: espaco(nomes), convite: convite(alvos) });
      case 'documento': return tx(fs[0].verbo === 'criar' ? 'resumo.pendente.documentoCriar' : 'resumo.pendente.documentoAtualizar', { n, nomes: espaco(nomes), em: em(fs) });
      default: return cada(fs);
    }
  });
}
/** O que espera o seu clique, numa frase no infinitivo ("enviar 2 e-mails para Ana e Bruno, sobre “Orçamento”"). */
export const fraseDoPendente = (fatos: Fato[]): string => emPt(textoDoPendente(fatos));

const doisPontos = (nomes: string[], n?: number): Valor => (nomes.length ? tx('resumo.doisPontos', { t: poucos(nomes.map(aspas), n) }) : '');
/** O que já foi feito, uma frase por tipo, com código ("2 e-mails enviados para Ana e Bruno." · "Tarefas criadas: X, Y e Z."). */
export function textosDoFeito(fatos: Fato[]): Texto[] {
  return juntar(fatos).map((fs): Texto => {
    const n = fs.length; const alvos = unicos(fs.flatMap((f) => f.alvos)); const nomes = unicos(fs.flatMap((f) => f.nomes));
    switch (fs[0].grupo) {
      case 'apagar': { const c = fs[0].coisa ?? 'item'; return tx(`resumo.feito.apagar.${c}`, { n, em: c === 'email' ? '' : em(fs) }, 'maiuscula'); }
      case 'mover': return tx('resumo.feito.mover', { n, para: nomes.length ? tx('resumo.para', { quem: poucos(nomes.map(aspas)) }) : '' }, 'maiuscula');
      case 'cobranca': return tx('resumo.feito.cobranca', { n, em: em(fs), valores: nomes.length ? tx('resumo.parenteses', { t: poucos(nomes) }) : '' }, 'maiuscula');
      case 'email': return tx('resumo.feito.email', { n, para: para(alvos), copia: copiaDe(fs), sobre: sobre(nomes) }, 'maiuscula');
      case 'resposta': return tx('resumo.feito.resposta', { n }, 'maiuscula');
      case 'mensagem': return tx('resumo.feito.mensagem', { n, para: para(alvos), no: no(fs) }, 'maiuscula');
      case 'tarefa': return nomes.length ? tx('resumo.feito.tarefaComNome', { n, em: em(fs), nomes: poucos(nomes, 6) }, 'maiuscula') : tx('resumo.feito.tarefa', { n, em: em(fs) }, 'maiuscula');
      case 'tarefa_mudar': return tx('resumo.feito.tarefaMudar', { n, em: em(fs), nomes: nomes.length ? tx('resumo.doisPontos', { t: poucos(nomes, 6) }) : '' }, 'maiuscula');
      case 'agenda': return tx(fs[0].verbo === 'cancelar' ? 'resumo.feito.agendaDesmarcar' : fs[0].verbo === 'atualizar' ? 'resumo.feito.agendaAtualizar' : 'resumo.feito.agendaMarcar', { nomes: doisPontos(nomes), convite: convite(alvos) }, 'maiuscula');
      case 'documento': return tx(fs[0].verbo === 'criar' ? 'resumo.feito.documentoCriar' : 'resumo.feito.documentoAtualizar', { n, nomes: espaco(nomes), em: em(fs) }, 'maiuscula');
      default: return tx('resumo.feito.outro', { acoes: cada(fs), em: em(fs) }, 'maiuscula');
    }
  });
}
/** O que já foi feito, uma frase por tipo ("2 e-mails enviados para Ana e Bruno." · "Tarefas criadas: X, Y e Z."). */
export const frasesDoFeito = (fatos: Fato[]): string[] => textosDoFeito(fatos).map((t) => emPt(t));

// ------------------------------------------------------------------------------------------- o resumo

export type Tom = 'decidir' | 'precisa' | 'trabalhando' | 'fila' | 'feito' | 'falhou';
/**
 * Cada texto vai em português e, ao lado (campo_t), com código e valores para a tela traduzir. O que o agente escreveu
 * (a linha "Feito: …", a pergunta) vai como veio: já está no idioma da conversa.
 */
export interface ResumoTarefa {
  /** a situação em uma palavra (ou quase), com a cor pelo tom */
  situacao: { tom: Tom; texto: string; texto_t: Valor };
  /** a faixa de decisão: título curto, a frase exata, os fatos já feitos e a linha do agente quando ela complementa */
  faixa: { titulo: string; titulo_t: Valor; frase: string; frase_t: Valor; itens: string[]; itens_t: Valor[]; doAgente: string | null; doAgente_t: Valor | null };
}

/** os critérios que não passaram, em palavras de todo dia (a conferência inteira fica em "Como foi conferido") */
const MOTIVO = new Set(['execucao', 'modelo', 'conteudo', 'alegacao', 'pendencias', 'entregavel', 'operacao', 'conexao', 'declaracao']);

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
/** o texto como frase (maiúscula e ponto): no Texto, pela forma (cada idioma aplica depois de traduzir) */
const comoFrase = (v: Valor): Valor => (typeof v === 'string' ? ponto(maiuscula(v)) : typeof v === 'number' || Array.isArray(v) ? v : { ...(v as Texto), forma: 'frase' });

/**
 * A proteção "depois de ler": o que o clique libera, com o endereço ou o programa exato que o cartão mostra
 * ("que Aspásia abra o site exemplo.com depois de ler as suas contas"). É uma decisão à parte, nunca em lote.
 */
export function textoDepoisDeLer(p: { agente?: string; grupo?: string; chaves?: string[]; alvo?: string }, quem: Valor): Texto {
  const agente: Valor = p.agente ?? quem;
  const chaves = Array.isArray(p.chaves) ? p.chaves : [];
  if (chaves[0] === 'pagina') return tx('resumo.depoisDeLer.pagina', { agente });
  const sites = chaves.filter((k) => k.startsWith('site:')).map((k) => { const o = k.slice(5); try { return new URL(o).host; } catch { return o; } });
  if (p.grupo !== 'programas' && sites.length) return tx('resumo.depoisDeLer.sites', { agente, n: sites.length, sites: sites.length > 1 ? poucos(sites) : sites[0] });
  const alvo = clip((p.alvo ?? '').replace(/\s+/g, ' ').trim(), 90);
  if (p.grupo === 'programas') return alvo ? tx('resumo.depoisDeLer.programa', { agente, alvo: aspas(alvo) }) : tx('resumo.depoisDeLer.umPrograma', { agente });
  return alvo ? tx('resumo.depoisDeLer.navegador', { agente, alvo: aspas(alvo) }) : tx('resumo.depoisDeLer.umSite', { agente });
}
export const fraseDepoisDeLer = (p: { agente?: string; grupo?: string; chaves?: string[]; alvo?: string }, quem: string): string => emPt(textoDepoisDeLer(p, quem));

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
  const semNome = !nome(t.agent_id);
  const quem: Valor = nome(t.agent_id) ?? tx('resumo.aEquipe');
  const concluida = !!Number(t.completed);
  const res = db.get<{ state: string; justification: string; evidence: string; criteria: string; decided_by: string }>(
    'SELECT state, justification, evidence, criteria, decided_by FROM task_results WHERE workspace_id = ? AND task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', ws, taskId);
  let ev: Record<string, unknown> = {};
  try { ev = res ? (JSON.parse(res.evidence) as Record<string, unknown>) : {}; } catch { ev = {}; }
  const desde = desdeDoResumo(db, ws, taskId, concluida);

  // fatos: o que espera o seu clique, e o que o serviço já fez neste trabalho (o card e os que nasceram dele)
  const cartoes = db.all<{ kind: string; payload: string; summary: string | null }>(`SELECT p.kind, p.payload, p.summary FROM agent_proposals p JOIN runs r ON r.id = p.run_id
     WHERE r.task_id = ? AND p.workspace_id = ? AND p.kind IN ('conexao', 'depois_de_ler') AND p.status = 'proposed' ORDER BY p.created_at`, taskId, ws);
  const pendentes: Fato[] = []; const aprovacoes: Texto[] = [];
  for (const c of cartoes) {
    let p: { acaoId?: string; agente?: string; grupo?: string; chaves?: string[]; alvo?: string } = {};
    try { p = JSON.parse(c.payload) as typeof p; } catch { continue; }
    if (c.kind === 'depois_de_ler') { aprovacoes.push(textoDepoisDeLer(p, quem)); continue; }
    const row = p.acaoId ? db.get<{ conexao: string; acao: string; args: string | null; resumo: string | null }>('SELECT conexao, acao, args, resumo FROM conexao_acoes WHERE id = ? AND workspace_id = ?', p.acaoId, ws) : undefined;
    if (row) pendentes.push(fatoDaAcao(row));
  }
  const feitos = textosDoFeito(db.all<{ conexao: string; acao: string; args: string | null; resumo: string | null }>(
    `SELECT conexao, acao, args, resumo FROM conexao_acoes WHERE workspace_id = ? AND status = 'feita' AND risco <> 'ler' AND created_at > ?
       AND (task_id = ? OR task_id IN (SELECT id FROM tasks WHERE parent_task_id = ?)) ORDER BY created_at LIMIT 60`, ws, desde, taskId, taskId).map(fatoDaAcao));
  const jaFeito = (f: Valor) => tx('resumo.item.jaFeito', { feito: f });

  // a entrega mais recente deste trabalho: a linha para a pessoa e o título do documento
  const saida = db.get<{ output: string | null; agent_id: string }>(
    "SELECT output, agent_id FROM runs WHERE task_id = ? AND workspace_id = ? AND status = 'succeeded' AND idempotency_key LIKE 'queue-%' AND created_at > ? ORDER BY created_at DESC, rowid DESC LIMIT 1", taskId, ws, desde);
  const { corpo, linha } = separarLinhaParaVoce(saida?.output ?? null);
  const autor: Valor = nome(saida?.agent_id) ?? quem;
  // o que o trabalho entregou como arquivo neste trabalho: a análise da planilha, ou o texto salvo como documento
  const arquivos = taskFiles(db, ws, taskId).filter((f) => f.role === 'entregavel' && f.created_at > desde).length;
  const analise = arquivos > 0 && !!db.get("SELECT 1 AS x FROM operations WHERE task_id = ? AND workspace_id = ? AND status <> 'erro' AND created_at > ?", taskId, ws, desde);
  const doc = arquivos > 0 && !analise ? tituloDoDocumento(corpo) : null;
  const entregue: Texto | null = !arquivos ? null : analise ? tx('resumo.entregue.analise')
    : doc ? tx('resumo.entregue.documento', { documento: aspas(doc) }) : tx('resumo.entregue.arquivos', { n: arquivos });
  const daLinha: Texto | null = linha ? tx('resumo.doAgente', { autor, texto: ponto(linha.texto) }) : null;

  const ativa = db.get<{ agent_id: string; status: string }>("SELECT agent_id, status FROM runs WHERE task_id = ? AND workspace_id = ? AND status IN ('queued', 'running', 'waiting_user') ORDER BY created_at DESC LIMIT 1", taskId, ws);
  const montar = (tom: Tom, texto: Texto, titulo: Texto, frase: Valor, itens: Valor[] = [], doAgente: Texto | null = null): ResumoTarefa => {
    const f = comoFrase(frase);
    return {
      situacao: { tom, texto: emPt(texto), texto_t: texto },
      faixa: { titulo: emPt(titulo), titulo_t: titulo, frase: emPt(f), frase_t: f, itens: itens.map((x) => emPt(x)), itens_t: itens, doAgente: doAgente ? emPt(doAgente) : null, doAgente_t: doAgente },
    };
  };

  // 1. espera o seu clique num cartão: a frase vem do que o serviço vai fazer, nunca do texto do agente
  // A proteção "depois de ler" é uma decisão à parte (a tela não a junta no "Aprovar" das ações nas contas): com ações
  // esperando, ela vai como item próprio; sozinha, é a frase
  if (!concluida && (pendentes.length || aprovacoes.length)) {
    const frase = pendentes.length ? tx('resumo.frase.aprovarPara', { acoes: textoDoPendente(pendentes) }) : tx('resumo.frase.aprovar', { itens: aprovacoes.map((x) => tx('resumo.frase.paraX', { x })) });
    const aParte = pendentes.length ? aprovacoes.map((x) => tx('resumo.item.aParte', { x: comoFrase(x) })) : [];
    return montar('decidir', tx('resumo.situacao.esperandoAprovacao'), tx('resumo.titulo.paraDecidir'), frase, [...aParte, ...feitos.map(jaFeito)], linha?.tipo === 'decidir' ? daLinha : null);
  }
  // 2. concluída: o que foi feito, pelos fatos; a linha "Feito: …" do agente completa (ou é a frase, sem fatos). A linha
  // "Para você decidir: …" num card que concluiu sozinho nunca vira "o que foi feito": fica à parte, como o que é seu
  if (concluida) {
    const porVoce = res?.state === 'confirmado_humano' || t.completed_by === 'human';
    const feito = linha?.tipo === 'feito' ? linha : null;
    const frase: Valor = feitos[0] ?? entregue ?? (feito ? ponto(maiuscula(feito.texto)) : porVoce ? tx('resumo.frase.aprovadaPorVoce') : tx('resumo.frase.conferidaSistema'));
    const resto: Valor[] = feitos.length ? [...feitos.slice(1), ...(entregue ? [entregue] : [])] : [];
    const seu = linha?.tipo === 'decidir' ? [tx('resumo.item.ficouParaVoce', { x: ponto(linha.texto) })] : [];
    return montar('feito', tx('resumo.situacao.feito'), tx('resumo.titulo.feito'), frase, [...resto, ...seu], (feitos.length || entregue) && feito ? daLinha : null);
  }
  // 3. trabalhando agora (a etapa da vez, quando há plano)
  if (ativa) {
    const etapas = db.all<{ position: number; title: string; status: string; agent_id: string }>('SELECT position, title, status, agent_id FROM task_steps WHERE task_id = ? ORDER BY position', taskId);
    const cur = etapas.find((s) => s.status === 'em_andamento');
    const quemAgora: Valor = nome(ativa.agent_id) ?? quem;
    const frase = cur ? tx('resumo.frase.naEtapa', { quem: quemAgora, etapa: cur.position, total: etapas.length, titulo: etapaCurta(cur.title) }) : tx('resumo.frase.trabalhandoAgora', { quem: quemAgora });
    return montar('trabalhando', tx('resumo.situacao.trabalhando'), tx('resumo.titulo.agora'), frase, feitos.map(jaFeito));
  }
  const ajuda = db.all<{ number: number; name: string | null }>('SELECT t.number, a.name FROM tasks t LEFT JOIN agents a ON a.id = t.agent_id WHERE t.parent_task_id = ? AND t.completed = 0 AND t.archived = 0 ORDER BY t.number', taskId);
  const state = t.work_state ?? 'solicitada';
  const pessoa = typeof ev.pessoa === 'string' && ev.pessoa ? ev.pessoa : null;
  // 4. o que só você resolve, a pergunta do agente, e o que você recusou
  if (state === 'aguardando_info' || res?.state === 'descartado') {
    const pergunta = typeof ev.pergunta === 'string' && ev.pergunta ? ev.pergunta : null;
    if (pergunta) return montar('precisa', tx('resumo.situacao.precisaDeVoce'), tx('resumo.titulo.responder'), tx('resumo.frase.pergunta', { quem, pergunta }), feitos.map(jaFeito));
    const falta: Valor = res?.justification !== undefined && res?.justification !== null ? sem(res.justification, /\s*Responda e ponha para trabalhar de novo\.?$/) : tx('resumo.umaInformacao');
    return montar('precisa', tx('resumo.situacao.precisaDeVoce'), tx('resumo.titulo.falta'), tx('resumo.frase.faltaAlgo', { falta }), feitos.map(jaFeito));
  }
  if (state === 'falha') {
    if (pessoa) return montar('precisa', tx('resumo.situacao.precisaDeVoce'), tx('resumo.titulo.soVoce'), maiuscula(pessoa), feitos.map(jaFeito));
    const motivo = sem(res?.justification ?? '', /^Não foi feito( por inteiro)?:\s*/i).replace(/\s*O card (fica|continua) aberto\.?/g, '').replace(/\s*Nada conta como entregue sem evidência;?/g, '').trim();
    return montar('falhou', tx('resumo.situacao.naoFeito'), tx('resumo.titulo.aconteceu'),
      motivo ? tx('resumo.frase.naoFeitoMotivo', { motivo: `${motivo.charAt(0).toLowerCase()}${motivo.slice(1)}` }) : tx('resumo.frase.naoFeito'), feitos.map(jaFeito));
  }
  // 5. esperando a sua aprovação da entrega (ou a sua confirmação do que é fora do sistema). Nenhum cartão espera o
  // clique: Aprovar só conclui o card. A frase sai dos fatos (o documento, o que o serviço fez, quem entregou); a
  // linha do agente vai abaixo, com o nome dele, e um aviso quando ela fala em enviar, criar ou pagar
  if (state === 'aguardando_aprovacao') {
    const aviso = avisoSemCartao(linha) ? tx('resumo.avisoSemCartao') : null;
    if (res?.state === 'sem_confirmacao') {
      return montar('decidir', tx('resumo.situacao.esperandoConfirmacao'), tx('resumo.titulo.confirmar'), tx('resumo.frase.confirme', { titulo: aspas(t.title) }), entregue ? [entregue] : [], daLinha);
    }
    const comDoc = !feitos.length && !!doc;
    const base = feitos.length ? tx('resumo.frase.aprovarFeito', { feito: feitos[0] })
      : comDoc ? tx('resumo.frase.aprovarDocumento', { documento: aspas(doc!), autor })
      : tx('resumo.frase.aprovarEntrega', { autor });
    const itens: Valor[] = [...feitos.slice(1).map(jaFeito), ...(entregue && !comDoc ? [entregue] : []), ...(aviso ? [aviso] : [])];
    return montar('decidir', tx('resumo.situacao.esperandoAprovacao'), tx('resumo.titulo.paraDecidir'), base, itens, daLinha);
  }
  // 6. não passou na conferência: você decide se aprova assim mesmo
  if (state === 'revisao') {
    let crit: Array<{ id: string; ok: boolean }> = [];
    try { crit = JSON.parse(res?.criteria ?? '[]') as typeof crit; } catch { crit = []; }
    const motivos = [...new Set(crit.filter((c) => !c.ok && MOTIVO.has(c.id)).map((c) => c.id))].map((id) => tx(`resumo.motivo.${id}` as Codigo));
    return montar('decidir', tx('resumo.situacao.precisaDecisao'), tx('resumo.titulo.paraDecidir'), tx('resumo.frase.naoPassou', { autor, motivos: motivos.length ? tx('resumo.doisPontos', { t: motivos }) : '' }), [], daLinha);
  }
  if (ajuda.length) {
    const nomes = unicos(ajuda.map((x) => x.name ?? '\u0000')).map((n): Valor => (n === '\u0000' ? tx('resumo.umColega') : n));
    return montar('trabalhando', tx('resumo.situacao.trabalhando'), tx('resumo.titulo.agora'), tx('resumo.frase.esperandoColegas', { nomes, cards: ajuda.map((x) => `#${x.number}`).join(', ') }), feitos.map(jaFeito));
  }
  if (ctx.queue) {
    const { position: posicao, total } = ctx.queue;
    return montar('fila', tx('resumo.situacao.naFila'), tx('resumo.titulo.agora'), semNome ? tx('resumo.frase.naFilaCoordenacao', { posicao, total }) : tx('resumo.frase.naFila', { posicao, total, quem }));
  }
  if (['processamento', 'resultado', 'validacao'].includes(state)) return montar('trabalhando', tx('resumo.situacao.trabalhando'), tx('resumo.titulo.agora'), tx('resumo.frase.trabalhando', { quem }));
  return montar('fila', tx('resumo.situacao.esperandoComecar'), tx('resumo.titulo.agora'), t.agent_id ? tx('resumo.frase.comecaLogo', { quem }) : tx('resumo.frase.coordenacaoVaiEncaminhar'));
}
