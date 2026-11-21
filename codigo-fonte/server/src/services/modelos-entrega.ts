/**
 * Modelos de entrega (rc.42): o que o agente manda para a pessoa vem num formato fixo, para ela bater o olho e saber o que
 * fazer. Antes, a entrega chegava como um parágrafo ("Ficou para você decidir: hoje, mandar…, liberar…, fazer… e dizer…")
 * que obrigava a ler, lembrar o contexto, rolar e procurar (o card #48). Agora o cartão mostra o tipo ("Aguardando sua
 * decisão", "Entregue", "Resumo", "Pergunta", "Bloqueado") e itens curtos; o relatório completo fica atrás de "Ver
 * detalhes", com o contexto, o objeto e os riscos de cada ponto.
 *
 * Como se força: a última etapa de um card só chega à pessoa com a ferramenta `entregar` (complemento do motor, conjunto
 * ergon_cartoes), que traz o JSON até /internal/bridge/v1/entrega. O servidor valida aqui; fora do modelo, a ferramenta
 * devolve os erros ao agente, que refaz no mesmo turno (até MAX_RECUSAS). Terminou sem registrar, o card volta ao mesmo
 * agente numa continuação curta (teamwork.ts, até MAX_DEVOLUCOES). Esgotado, o Ergon monta o formato mínimo seguro com o
 * que tem (minimoSeguro): itens curtos e o texto inteiro nos detalhes — nunca um parágrafo cru no cartão.
 *
 * O texto livre do agente continua na conversa e no documento; o cartão, "Aguardando você", os avisos dos canais e do
 * Teams usam o modelo.
 *
 * Personalização: a pessoa pede ao coordenador (gestão, rotas /api/modelos-entrega) campos a mais, o tom e uma
 * instrução curta por tipo. O núcleo de cada tipo é travado: ajustar recusa remover ou sobrepor um campo do núcleo, e a
 * validação sempre o exige. "Restaurar originais" apaga a personalização; os originais ficam sempre aqui (PADRAO).
 */
import type { Db } from '../db/db.ts';
import { clip, HttpError, id, now } from '../lib/util.ts';
import { getSetting, setSetting } from './sectors.ts';

export const TIPOS = ['decisao', 'entrega', 'relatorio', 'pergunta', 'bloqueio'] as const;
export type TipoEntrega = (typeof TIPOS)[number];
/** recusas da ferramenta numa mesma execução antes do formato mínimo */
export const MAX_RECUSAS = 3;
/** continuações pedindo a entrega que não veio (cada uma é uma chamada de modelo curta) */
export const MAX_DEVOLUCOES = 2;
/** o título curto de um item: cabe numa linha do painel lateral, mesmo no celular */
export const TITULO_MAX = 60;
const CHAVE_SETTING = 'entrega.modelos';

// ------------------------------------------------------------------------------------------- os cinco modelos

interface Campo { chave: string; rotulo: string; max: number; min?: number; obrigatorio: boolean; lista?: { min: number; max: number } }
interface Modelo {
  tipo: TipoEntrega;
  /** para que serve (vai na instrução do agente) */
  quando: string;
  /** o núcleo: travado, a validação sempre exige */
  nucleo: Campo[];
  /** decisão: cada item tem os detalhes próprios (contexto, objeto, riscos) */
  porItem?: Campo[];
}

/**
 * Os originais. Critério de cada um:
 * - decisao: o que só a pessoa decide ou aprova. Itens curtos (o que decidir, com o verbo) e, por item, de onde veio e por
 *   que pede decisão (contexto), sobre o que exatamente, com os dados (objeto), e o risco (prazo, o que acontece se nada
 *   for feito, o que está em jogo). É o caso do card #48.
 * - entrega: um documento ou arquivo pronto. O que foi entregue em uma linha, os arquivos, até 5 pontos de atenção.
 * - relatorio: um resumo ou levantamento que não pede nada. A conclusão em uma linha e até 6 pontos.
 * - pergunta: falta uma informação que só a pessoa tem. A pergunta, as opções, por que importa.
 * - bloqueio: não deu para fazer. O motivo em uma linha, o que destrava (de quem), o que já foi tentado.
 */
export const PADRAO: Record<TipoEntrega, Modelo> = {
  decisao: {
    tipo: 'decisao', quando: 'a pessoa precisa decidir, aprovar ou escolher algo (um ou vários pontos)',
    nucleo: [],
    porItem: [
      { chave: 'titulo', rotulo: 'o que decidir, com o verbo, até 60 caracteres (ex.: "NF27 da Acelen: mandar orientações de reemissão")', max: TITULO_MAX, min: 4, obrigatorio: true },
      { chave: 'acao', rotulo: 'a ação esperada da pessoa, em uma palavra ou duas (aprovar, escolher, liberar, responder)', max: 40, obrigatorio: false },
      { chave: 'contexto', rotulo: 'de onde veio e por que pede decisão: qual e-mail, mensagem ou arquivo, de quem, quando', max: 1500, min: 20, obrigatorio: true },
      { chave: 'objeto', rotulo: 'sobre o que exatamente, com os dados analisados (números, nomes, valores)', max: 1500, min: 20, obrigatorio: true },
      { chave: 'prazo', rotulo: 'o prazo entendido (ex.: "segunda, 10:00"), ou vazio se não há', max: 160, obrigatorio: false },
      { chave: 'inacao', rotulo: 'o que acontece se nada for feito, ou vazio', max: 400, obrigatorio: false },
      { chave: 'em_jogo', rotulo: 'o que está em jogo (pagamento, acesso, prazo de cliente…)', max: 400, min: 5, obrigatorio: true },
    ],
  },
  entrega: {
    tipo: 'entrega', quando: 'um documento ou arquivo ficou pronto',
    nucleo: [
      { chave: 'resumo', rotulo: 'o que foi entregue, em uma linha', max: 120, min: 4, obrigatorio: true },
      { chave: 'arquivos', rotulo: 'os nomes dos arquivos entregues', max: 120, obrigatorio: false, lista: { min: 0, max: 10 } },
      { chave: 'atencao', rotulo: 'pontos de atenção curtos (até 90 caracteres cada)', max: 90, obrigatorio: false, lista: { min: 0, max: 5 } },
      { chave: 'detalhes', rotulo: 'o relatório completo para revisar', max: 8000, min: 20, obrigatorio: true },
    ],
  },
  relatorio: {
    tipo: 'relatorio', quando: 'um resumo, levantamento ou relatório que não pede decisão',
    nucleo: [
      { chave: 'resumo', rotulo: 'a conclusão, em uma linha', max: 120, min: 4, obrigatorio: true },
      { chave: 'pontos', rotulo: 'os pontos principais, curtos (até 90 caracteres cada)', max: 90, obrigatorio: true, lista: { min: 1, max: 6 } },
      { chave: 'detalhes', rotulo: 'o relatório completo', max: 8000, min: 20, obrigatorio: true },
    ],
  },
  pergunta: {
    tipo: 'pergunta', quando: 'falta uma informação que só a pessoa tem',
    nucleo: [
      { chave: 'pergunta', rotulo: 'a pergunta, em uma linha', max: 160, min: 6, obrigatorio: true },
      { chave: 'opcoes', rotulo: 'as opções, curtas (até 60 caracteres cada)', max: 60, obrigatorio: false, lista: { min: 0, max: 4 } },
      { chave: 'porque', rotulo: 'por que a resposta importa e o que ela destrava', max: 600, min: 10, obrigatorio: true },
    ],
  },
  bloqueio: {
    tipo: 'bloqueio', quando: 'não deu para fazer (erro, acesso que falta, serviço fora)',
    nucleo: [
      { chave: 'motivo', rotulo: 'o motivo, em uma linha', max: 120, min: 4, obrigatorio: true },
      { chave: 'precisa', rotulo: 'o que destrava e de quem', max: 160, min: 4, obrigatorio: true },
      { chave: 'tentado', rotulo: 'o que já foi tentado, curto', max: 120, obrigatorio: false, lista: { min: 0, max: 5 } },
      { chave: 'detalhes', rotulo: 'o que aconteceu, com as mensagens de erro', max: 4000, obrigatorio: false },
    ],
  },
};
/** os itens de uma decisão: de 1 a 8 (mais que isso não se decide de relance: vira mais de um card) */
const ITENS = { min: 1, max: 8 };

// ------------------------------------------------------------------------------------------- personalização

interface CampoExtra { chave: string; rotulo: string; obrigatorio: boolean }
export interface Ajuste { campos: CampoExtra[]; tom: string; instrucao: string }
export type Ajustes = Partial<Record<TipoEntrega, Ajuste>>;
const CHAVE_EXTRA = /^[a-z][a-z0-9_]{1,30}$/;
const EXTRAS_MAX = 10;
/** pedidos que tirariam o essencial (o coordenador pode tentar; a resposta diz que é travado) */
const ESSENCIAL = new Set(['itens', 'titulo', 'detalhes', 'contexto', 'objeto', 'riscos', 'prazo', 'inacao', 'em_jogo', 'resumo', 'pontos', 'arquivos', 'atencao', 'pergunta', 'opcoes', 'porque', 'motivo', 'precisa', 'tentado', 'acao', 'ver_detalhes', 'botao', 'referencias', 'tipo']);

export function lerAjustes(db: Db, ws: string): Ajustes {
  try {
    const v = JSON.parse(getSetting(db, ws, CHAVE_SETTING) ?? '{}') as Ajustes;
    const out: Ajustes = {};
    for (const t of TIPOS) if (v[t]) out[t] = { campos: (v[t]!.campos ?? []).slice(0, EXTRAS_MAX), tom: String(v[t]!.tom ?? ''), instrucao: String(v[t]!.instrucao ?? '') };
    return out;
  } catch { return {}; }
}

export interface PedidoAjuste { tipo: TipoEntrega; campos?: Array<{ chave: string; rotulo: string; obrigatorio?: boolean }>; tom?: string; instrucao?: string; remover?: string[] }
/**
 * Ajusta as partes livres de um modelo. Recusa (422, essencial_travado) tirar ou sobrepor o núcleo: os campos do núcleo,
 * os itens curtos, o botão de detalhes. Campos a mais somam (até 10); remover só tira campos a mais.
 */
export function ajustarModelo(db: Db, ws: string, p: PedidoAjuste): Ajustes {
  if (!TIPOS.includes(p.tipo)) throw new HttpError(400, 'tipo', `Tipo desconhecido: use ${TIPOS.join(', ')}.`);
  const todos = lerAjustes(db, ws);
  const atual: Ajuste = todos[p.tipo] ?? { campos: [], tom: '', instrucao: '' };
  const nucleo = new Set([...PADRAO[p.tipo].nucleo, ...(PADRAO[p.tipo].porItem ?? [])].map((c) => c.chave));
  const travado = (k: string) => ESSENCIAL.has(k) || nucleo.has(k);
  for (const k of p.remover ?? []) {
    if (travado(k)) throw new HttpError(422, 'essencial_travado', `“${k}” é do essencial do modelo e não sai. Dá para acrescentar campos, mudar o tom e a instrução; para voltar ao original, restaure.`);
    atual.campos = atual.campos.filter((c) => c.chave !== k);
  }
  for (const c of p.campos ?? []) {
    const chave = String(c.chave ?? '').trim().toLowerCase();
    if (!CHAVE_EXTRA.test(chave)) throw new HttpError(400, 'campo', 'O nome do campo vai em minúsculas, sem espaço (ex.: valor_rs).');
    if (travado(chave)) throw new HttpError(422, 'essencial_travado', `“${chave}” já é do essencial do modelo: não dá para trocar.`);
    const rotulo = clip(String(c.rotulo ?? '').replace(/\s+/g, ' ').trim(), 80);
    if (rotulo.length < 2) throw new HttpError(400, 'campo', 'Diga o rótulo do campo (ex.: Valor em R$).');
    atual.campos = [...atual.campos.filter((x) => x.chave !== chave), { chave, rotulo, obrigatorio: c.obrigatorio === true }];
  }
  if (atual.campos.length > EXTRAS_MAX) throw new HttpError(400, 'campos', `No máximo ${EXTRAS_MAX} campos a mais por modelo: o cartão continua curto.`);
  if (p.tom !== undefined) atual.tom = clip(String(p.tom).replace(/\s+/g, ' ').trim(), 200);
  if (p.instrucao !== undefined) atual.instrucao = clip(String(p.instrucao).replace(/\s+/g, ' ').trim(), 400);
  todos[p.tipo] = atual;
  if (!atual.campos.length && !atual.tom && !atual.instrucao) delete todos[p.tipo];
  setSetting(db, ws, CHAVE_SETTING, JSON.stringify(todos));
  return todos;
}

/** "Volta os modelos originais": tira toda a personalização (ou só a de um tipo). */
export function restaurarModelos(db: Db, ws: string, tipo?: TipoEntrega): Ajustes {
  const todos = tipo ? lerAjustes(db, ws) : {};
  if (tipo) delete todos[tipo];
  setSetting(db, ws, CHAVE_SETTING, JSON.stringify(todos));
  return todos;
}

/** Os modelos ativos para a tela de Configurações e para o coordenador: o núcleo (travado) e o que foi ajustado. */
export function modelosAtivos(db: Db, ws: string) {
  const aj = lerAjustes(db, ws);
  return {
    personalizado: Object.keys(aj).length > 0,
    modelos: TIPOS.map((t) => ({
      tipo: t,
      essencial: [...PADRAO[t].nucleo, ...(PADRAO[t].porItem ?? [])].map((c) => c.chave),
      extras: aj[t]?.campos ?? [], tom: aj[t]?.tom ?? '', instrucao: aj[t]?.instrucao ?? '',
    })),
  };
}

// ------------------------------------------------------------------------------------------- referências

/**
 * Tudo o que a entrega cita vira link direto para o objeto: o e-mail, o documento do Drive ou do OneDrive, o pull request,
 * o evento, a tarefa de outro aplicativo, o arquivo dos Documentos, a conversa, o card. O Ergon é a ponte: a pessoa abre
 * dali, sem procurar. Cada item (e o topo dos outros tipos) leva `referencias`; o agente é obrigado a citar quando a
 * informação veio de um objeto identificável (o trabalho leu as contas). O servidor confere: endereço só http(s) dos
 * aplicativos que as Conexões usam (nada de javascript:, data:, nem de site qualquer), ou um identificador interno que
 * existe neste workspace.
 */
export const TIPOS_REF = ['email', 'documento', 'arquivo', 'evento', 'tarefa', 'pr', 'issue', 'mensagem', 'conversa', 'card', 'pagina'] as const;
export type TipoRef = (typeof TIPOS_REF)[number];
export interface Referencia { tipo: TipoRef; titulo: string; url: string | null; id: string | null }
/** os domínios dos aplicativos das Conexões (e os subdomínios: empresa.sharepoint.com, empresa.atlassian.net) */
export const DOMINIOS_REF = [
  'outlook.office.com', 'outlook.office365.com', 'outlook.live.com', 'teams.microsoft.com', 'teams.live.com', 'sharepoint.com', 'onedrive.live.com', '1drv.ms', 'planner.cloud.microsoft', 'tasks.office.com', 'to-do.office.com',
  'mail.google.com', 'docs.google.com', 'drive.google.com', 'calendar.google.com', 'meet.google.com', 'sheets.google.com',
  'github.com', 'gitlab.com', 'bitbucket.org', 'app.asana.com', 'trello.com', 'notion.so', 'app.clickup.com', 'monday.com', 'atlassian.net', 'linear.app', 'app.pipefy.com',
  'slack.com', 'discord.com', 'web.whatsapp.com', 'wa.me', 't.me', 'app.hubspot.com', 'asaas.com', 'app.omie.com.br', 'app.smartsheet.com', 'figma.com', 'dropbox.com',
  'zendesk.com', 'freshdesk.com', 'app.intercom.com', 'app.gohighlevel.com', 'pipedrive.com', 'app.rdstation.com',
];
const REF_MAX = { item: 5, topo: 8 };
/** os identificadores internos que viram link no Ergon: arquivo dos Documentos, card, conversa */
const ID_INTERNO = /^(art|tsk|cnv)_[A-Za-z0-9_-]{6,64}$/;

export function urlConhecida(u: string, extras: string[] = []): boolean {
  let x: URL;
  try { x = new URL(u); } catch { return false; }
  if (!['https:', 'http:'].includes(x.protocol) || x.username || x.password) return false;
  const host = x.hostname.toLowerCase();
  return [...DOMINIOS_REF, ...extras].some((d) => host === d || host.endsWith(`.${d}`));
}

export interface Conferencia {
  /** o id interno existe neste workspace (arquivo, card, conversa)? */
  idValido?: (id: string) => boolean;
  /** o trabalho leu objetos das contas: cada item (ou o topo) tem que citar de onde veio */
  exigirReferencias?: boolean;
  /** outros domínios aceitos (o endereço do próprio Ergon) */
  dominios?: string[];
}

function referenciasDe(v: unknown, onde: string, max: number, erros: string[], c: Conferencia): Referencia[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) { erros.push(`${onde}referencias: deve ser uma lista de {tipo, titulo, url ou id}.`); return []; }
  if (v.length > max) erros.push(`${onde}referencias: no máximo ${max}.`);
  return v.slice(0, max).flatMap((b, i): Referencia[] => {
    const o = b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
    const tipo = String(o.tipo ?? '') as TipoRef;
    const titulo = linha(o.titulo);
    const url = typeof o.url === 'string' && o.url.trim() ? o.url.trim() : null;
    const rid = typeof o.id === 'string' && o.id.trim() ? o.id.trim() : null;
    const aqui = `${onde}referencias[${i}]`;
    if (!TIPOS_REF.includes(tipo)) { erros.push(`${aqui}.tipo: use ${TIPOS_REF.join(', ')}.`); return []; }
    if (titulo.length < 2 || titulo.length > 80) { erros.push(`${aqui}.titulo: de 2 a 80 caracteres (o assunto do e-mail, o nome do arquivo).`); return []; }
    if (!url && !rid) { erros.push(`${aqui}: falta url (o link que a ferramenta devolveu) ou id (art_…, tsk_…, cnv_…).`); return []; }
    if (url && (url.length > 2000 || !urlConhecida(url, c.dominios))) { erros.push(`${aqui}.url: só o link do próprio aplicativo (o que a ferramenta devolveu), com https.`); return []; }
    if (rid && (!ID_INTERNO.test(rid) || (c.idValido && !c.idValido(rid)))) { erros.push(`${aqui}.id: não existe neste workspace.`); return []; }
    return [{ tipo, titulo, url, id: url ? null : rid }];
  });
}

// ------------------------------------------------------------------------------------------- validação

export interface ItemDecisao {
  titulo: string; acao: string | null; contexto: string; objeto: string;
  riscos: { prazo: string | null; inacao: string | null; em_jogo: string };
  extras: Record<string, string>; referencias: Referencia[];
}
export type Entrega =
  | { tipo: 'decisao'; itens: ItemDecisao[] }
  | { tipo: 'entrega'; resumo: string; arquivos: string[]; atencao: string[]; detalhes: string; extras: Record<string, string>; referencias: Referencia[] }
  | { tipo: 'relatorio'; resumo: string; pontos: string[]; detalhes: string; extras: Record<string, string>; referencias: Referencia[] }
  | { tipo: 'pergunta'; pergunta: string; opcoes: string[]; porque: string; extras: Record<string, string>; referencias: Referencia[] }
  | { tipo: 'bloqueio'; motivo: string; precisa: string; tentado: string[]; detalhes: string; extras: Record<string, string>; referencias: Referencia[] };

/** uma linha (o que vai no cartão): sem quebra e sem marcação; o detalhe guarda as quebras */
const linha = (v: unknown) => (typeof v === 'string' ? v.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim() : '');
const texto = (v: unknown) => (typeof v === 'string' ? v.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim() : '');

function campo(c: Campo, v: unknown, onde: string, erros: string[], multilinha: boolean): string | string[] | null {
  const limpar = multilinha ? texto : linha;
  if (c.lista) {
    const xs = v === undefined || v === null ? [] : Array.isArray(v) ? v.map(linha).filter(Boolean) : null;
    if (!xs) { erros.push(`${onde}${c.chave}: deve ser uma lista de textos curtos.`); return []; }
    if (xs.length < c.lista.min) erros.push(`${onde}${c.chave}: precisa de pelo menos ${c.lista.min} (${c.rotulo}).`);
    if (xs.length > c.lista.max) erros.push(`${onde}${c.chave}: no máximo ${c.lista.max}.`);
    xs.forEach((x, i) => { if (x.length > c.max) erros.push(`${onde}${c.chave}[${i}]: ${x.length} caracteres; o máximo é ${c.max}. Encurte.`); });
    return xs;
  }
  const s = limpar(v);
  if (!s) { if (c.obrigatorio) erros.push(`${onde}${c.chave}: falta (${c.rotulo}).`); return null; }
  if (c.min && s.length < c.min) erros.push(`${onde}${c.chave}: curto demais (${c.rotulo}).`);
  if (s.length > c.max) erros.push(`${onde}${c.chave}: ${s.length} caracteres; o máximo é ${c.max}. ${c.max <= 160 ? 'Encurte: o detalhe vai em outro campo.' : 'Resuma.'}`);
  return s;
}
const MULTILINHA = new Set(['detalhes', 'contexto', 'objeto']);

function extrasDe(v: unknown, aj: Ajuste | undefined, onde: string, erros: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const obj = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  for (const c of aj?.campos ?? []) {
    const s = linha(obj[c.chave]);
    if (!s && c.obrigatorio) erros.push(`${onde}extras.${c.chave}: falta (${c.rotulo}; a pessoa pediu este campo).`);
    if (s.length > 300) erros.push(`${onde}extras.${c.chave}: no máximo 300 caracteres.`);
    if (s) out[c.chave] = s;
  }
  return out;
}

/** Confere a entrega contra o modelo ativo. ok = a entrega normalizada; senão, os erros em frases que o agente entende. */
export function validarEntrega(bruta: unknown, ajustes: Ajustes = {}, conf: Conferencia = {}): { ok: true; entrega: Entrega } | { ok: false; erros: string[] } {
  const erros: string[] = [];
  const e = bruta && typeof bruta === 'object' && !Array.isArray(bruta) ? (bruta as Record<string, unknown>) : null;
  if (!e) return { ok: false, erros: ['A entrega deve ser um objeto JSON com "tipo" e os campos do modelo.'] };
  const tipo = String(e.tipo ?? '') as TipoEntrega;
  if (!TIPOS.includes(tipo)) return { ok: false, erros: [`tipo: use um destes: ${TIPOS.join(', ')}.`] };
  const m = PADRAO[tipo]; const aj = ajustes[tipo];
  if (tipo === 'decisao') {
    const brutos = Array.isArray(e.itens) ? e.itens : null;
    if (!brutos) return { ok: false, erros: ['itens: deve ser uma lista, um objeto por ponto a decidir (titulo, contexto, objeto, riscos).'] };
    if (brutos.length < ITENS.min) erros.push('itens: precisa de pelo menos 1 ponto a decidir.');
    if (brutos.length > ITENS.max) erros.push(`itens: no máximo ${ITENS.max}; junte o que for do mesmo assunto.`);
    const itens: ItemDecisao[] = brutos.slice(0, ITENS.max).map((b, i) => {
      const o = b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
      // riscos pode vir aninhado (riscos.prazo) ou no próprio item
      const r = o.riscos && typeof o.riscos === 'object' ? (o.riscos as Record<string, unknown>) : o;
      const fonte: Record<string, unknown> = { ...o, prazo: r.prazo, inacao: r.inacao, em_jogo: r.em_jogo };
      const v = Object.fromEntries(m.porItem!.map((c) => [c.chave, campo(c, fonte[c.chave], `itens[${i}].${['prazo', 'inacao', 'em_jogo'].includes(c.chave) ? 'riscos.' : ''}`, erros, MULTILINHA.has(c.chave))])) as Record<string, string | null>;
      return { titulo: v.titulo ?? '', acao: v.acao, contexto: v.contexto ?? '', objeto: v.objeto ?? '',
        riscos: { prazo: v.prazo, inacao: v.inacao, em_jogo: v.em_jogo ?? '' }, extras: extrasDe(o.extras, aj, `itens[${i}].`, erros),
        referencias: (() => {
          const r = referenciasDe(o.referencias, `itens[${i}].`, REF_MAX.item, erros, conf);
          if (conf.exigirReferencias && !r.length && !(Array.isArray(o.referencias) && o.referencias.length)) erros.push(`itens[${i}].referencias: cite o e-mail, a mensagem ou o arquivo de onde veio (o link que a ferramenta devolveu): a pessoa abre direto.`);
          return r;
        })() };
    });
    const vistos = new Set<string>();
    itens.forEach((x, i) => { const k = x.titulo.toLowerCase(); if (k && vistos.has(k)) erros.push(`itens[${i}].titulo: repetido.`); vistos.add(k); });
    return erros.length ? { ok: false, erros } : { ok: true, entrega: { tipo, itens } };
  }
  const v = Object.fromEntries(m.nucleo.map((c) => [c.chave, campo(c, e[c.chave], '', erros, MULTILINHA.has(c.chave))])) as Record<string, never>;
  const extras = extrasDe(e.extras, aj, '', erros);
  const referencias = referenciasDe(e.referencias, '', REF_MAX.topo, erros, conf);
  if (conf.exigirReferencias && ['entrega', 'relatorio'].includes(tipo) && !referencias.length && !(Array.isArray(e.referencias) && e.referencias.length)) {
    erros.push('referencias: cite os e-mails, mensagens ou arquivos de onde veio (os links que as ferramentas devolveram).');
  }
  if (erros.length) return { ok: false, erros };
  const lista = (k: string) => (v[k] ?? []) as string[];
  const s = (k: string) => (v[k] ?? '') as string;
  switch (tipo) {
    case 'entrega': return { ok: true, entrega: { tipo, resumo: s('resumo'), arquivos: lista('arquivos'), atencao: lista('atencao'), detalhes: s('detalhes'), extras, referencias } };
    case 'relatorio': return { ok: true, entrega: { tipo, resumo: s('resumo'), pontos: lista('pontos'), detalhes: s('detalhes'), extras, referencias } };
    case 'pergunta': return { ok: true, entrega: { tipo, pergunta: s('pergunta'), opcoes: lista('opcoes'), porque: s('porque'), extras, referencias } };
    default: return { ok: true, entrega: { tipo: 'bloqueio', motivo: s('motivo'), precisa: s('precisa'), tentado: lista('tentado'), detalhes: s('detalhes'), extras, referencias } };
  }
}

// ------------------------------------------------------------------------------------------- a instrução do agente

/** O que o agente lê ao fim da última etapa: a ferramenta, os cinco modelos (com a personalização) e um exemplo. */
export function instrucaoEntregar(ajustes: Ajustes = {}): string {
  const desc = (c: Campo) => `${c.chave}${c.obrigatorio ? '*' : ''}${c.lista ? ' (lista)' : ''}: ${c.rotulo}`;
  const tipos = TIPOS.map((t) => {
    const m = PADRAO[t]; const aj = ajustes[t];
    const campos = t === 'decisao' ? `itens* (1 a ${ITENS.max}), cada um com ${m.porItem!.map((c) => (['prazo', 'inacao', 'em_jogo'].includes(c.chave) ? `riscos.${desc(c)}` : desc(c))).join('; ')}; referencias` : `${m.nucleo.map(desc).join('; ')}; referencias`;
    const extra = aj?.campos.length ? ` Campos que a pessoa pediu (em extras${t === 'decisao' ? ' de cada item' : ''}): ${aj.campos.map((c) => `${c.chave}${c.obrigatorio ? '*' : ''} = ${c.rotulo}`).join('; ')}.` : '';
    const tom = aj?.tom ? ` Tom: ${aj.tom}.` : '';
    const ins = aj?.instrucao ? ` A pessoa pediu: ${aj.instrucao}` : '';
    return `- ${t} — quando ${m.quando}. Campos: ${campos}.${extra}${tom}${ins}`;
  }).join('\n');
  return [
    'Ao terminar, registre a entrega para a pessoa com a ferramenta entregar (obrigatório: o cartão dela mostra só isso; o texto continua aqui na conversa).',
    'Escolha UM tipo. Itens e linhas curtos, com números, nomes e destinos de verdade; o detalhe vai nos campos longos. * = obrigatório.',
    tipos,
    `referencias: a lista do que você citou, para a pessoa abrir direto — {tipo (${TIPOS_REF.join(', ')}), titulo, url} com o link que a ferramenta devolveu (link= / url / endereço), ou {tipo, titulo, id} para um arquivo dos Documentos (art_…), um card (tsk_…) ou uma conversa (cnv_…). Obrigatório quando a informação veio de um e-mail, mensagem, arquivo ou tarefa que você leu. Nunca invente link.`,
    'Exemplo (decisao): {"tipo":"decisao","itens":[{"titulo":"NF27 da Acelen: mandar orientações de reemissão","acao":"aprovar","contexto":"E-mail da Acelen de 18/11 pedindo a NF 27 reemitida com o CNPJ novo","objeto":"NF 27, R$ 12.400; o pagamento só sai com a nota certa","riscos":{"prazo":"hoje","inacao":"o pagamento de novembro atrasa","em_jogo":"R$ 12.400 a receber"},"referencias":[{"tipo":"email","titulo":"NF 27 recusada","url":"https://outlook.office.com/owa/?ItemID=..."}]}]}',
    'Se a ferramenta devolver erros, corrija e chame de novo.',
  ].join('\n');
}

// ------------------------------------------------------------------------------------------- o formato mínimo seguro

/** O título curto a partir de uma frase: sem parênteses, até 60 caracteres, sem cortar palavra. */
export function tituloCurto(s: string, max = TITULO_MAX): string {
  let t = linha(s).replace(/\s*\([^)]*\)/g, '').replace(/[.;:,\s]+$/, '').trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length <= max) return t;
  const corte = t.slice(0, max);
  const sp = corte.lastIndexOf(' ');
  return `${corte.slice(0, sp > 20 ? sp : max - 1).replace(/[,\s]+$/, '').replace(/\s+(e|de|da|do|das|dos|para|com|em|no|na|a|o|os|as|ao)$/i, '')}…`;
}
const PRAZO = /\b(hoje|amanh[ãa]|at[ée] [^,;.]{2,40}|(segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo)(-feira)?(\s+[àa]s\s+\d{1,2}(:\d{2}|h\d{0,2})?)?|\d{1,2}\/\d{1,2}(\/\d{2,4})?|\d{1,2}:\d{2}|\d{1,2}h\d{0,2})\b/i;
/** infinitivo depois de " e ": começa outro ponto ("… com o Sérgio e dizer quem assume …") */
const OUTRO_VERBO = /\s+e\s+(?=\p{Ll}+(ar|er|ir|or)\b)/u;
/** " e " logo depois de um parêntese fecha o ponto ("… (leadcoins, advogada, Asaas) e a cotação da Fieb …") */
const DEPOIS_DO_PARENTESE = /(?<=\))\s+e\s+/u;

/** Separa a frase do agente em pontos: vírgula e ponto e vírgula fora de parênteses, e " e " antes de outro verbo. */
export function dividirPontos(frase: string): Array<{ texto: string; prazo: string | null }> {
  const s = linha(frase).replace(/[.]+$/, '');
  const partes: string[] = []; let fundo = 0; let atual = '';
  for (const ch of s) {
    if (ch === '(') fundo++;
    if (ch === ')') fundo = Math.max(0, fundo - 1);
    if (!fundo && (ch === ',' || ch === ';')) { partes.push(atual); atual = ''; continue; }
    atual += ch;
  }
  partes.push(atual);
  const pontos = partes.flatMap((p) => p.split(DEPOIS_DO_PARENTESE)).flatMap((p) => p.split(OUTRO_VERBO).filter((x, i) => i % 2 === 0 || !/^(ar|er|ir|or)$/.test(x))).map((p) => p.trim()).filter(Boolean);
  // "hoje", "amanhã": uma palavra só é o prazo do ponto seguinte, não um ponto
  const out: Array<{ texto: string; prazo: string | null }> = []; let prazoSolto: string | null = null;
  for (const p of pontos) {
    if (p.split(/\s+/).length <= 2 && PRAZO.test(p)) { prazoSolto = p; continue; }
    out.push({ texto: p, prazo: PRAZO.exec(p)?.[0] ?? prazoSolto });
    prazoSolto = null;
  }
  return out.slice(0, ITENS.max);
}

interface Origem { agente: string; card: number | null; titulo: string }
/**
 * O formato mínimo seguro: a entrega que não veio no modelo, montada com o que o Ergon tem (a linha "Para você decidir"
 * do agente, o texto da entrega). Itens curtos e o texto inteiro nos detalhes; o cartão nunca recebe o parágrafo cru.
 */
export function minimoSeguro(o: Origem & { corpo: string; linha: { tipo: 'decidir' | 'feito'; texto: string } | null; aprovar: boolean }): Entrega {
  const de = `Da entrega de ${o.agente}${o.card ? ` no card #${o.card}` : ''} (“${clip(o.titulo, 90)}”).`;
  const corpo = texto(o.corpo);
  if (o.linha?.tipo === 'decidir') {
    const pontos = dividirPontos(o.linha.texto);
    if (pontos.length) {
      return { tipo: 'decisao', itens: pontos.map((p) => ({
        titulo: tituloCurto(p.texto), acao: null,
        contexto: `${de} O agente não registrou o detalhe deste ponto; o texto da entrega está abaixo.${corpo ? `\n\n${clip(corpo, 1200)}` : ''}`,
        objeto: p.texto, riscos: { prazo: p.prazo, inacao: null, em_jogo: /\(([^)]+)\)/.exec(p.texto)?.[1] ?? 'O agente não disse: veja o texto da entrega.' }, extras: {}, referencias: [],
      })) };
    }
  }
  // sem a linha de decidir: o que foi feito (a linha "Feito:", o primeiro cabeçalho ou a primeira frase) e os tópicos
  const titulo = /^#{1,3}\s+(.+)$/m.exec(corpo)?.[1];
  const primeira = corpo.replace(/^#.*$/gm, '').split(/(?<=[.!?])\s|\n/).map(linha).find((x) => x.length > 8);
  const resumo = clip(linha(o.linha?.texto ?? titulo ?? primeira ?? o.titulo), 120);
  const pontos = [...corpo.matchAll(/^\s*(?:[-*•]|\d+[.)]|#{2,3})\s+(.+)$/gm)].map((m) => tituloCurto(m[1], 90)).filter((x) => x.length > 3).slice(0, 5);
  const detalhes = clip(corpo || `${de} ${resumo}`, 8000);
  return o.aprovar
    ? { tipo: 'entrega', resumo, arquivos: [], atencao: pontos.slice(0, 5), detalhes, extras: {}, referencias: [] }
    : { tipo: 'relatorio', resumo, pontos: pontos.length ? pontos : [tituloCurto(resumo, 90)], detalhes, extras: {}, referencias: [] };
}

// ------------------------------------------------------------------------------------------- o registro

interface EntregaRow { id: string; task_id: string | null; run_id: string | null; tipo: string; estado: string; conteudo: string; decisoes: string | null; created_at: string }
export interface EntregaRegistrada { id: string; entrega: Entrega; minimo: boolean; decisoes: Record<string, 'aprovado' | 'devolvido'>; created_at: string }

export function registrar(db: Db, ws: string, x: { taskId: string | null; runId: string | null; entrega: Entrega; minimo?: boolean }): string {
  const eid = id('ent');
  db.run('INSERT INTO entregas (id, workspace_id, task_id, run_id, tipo, estado, conteudo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    eid, ws, x.taskId, x.runId, x.entrega.tipo, x.minimo ? 'minima' : 'valida', db.seal(ws, JSON.stringify(x.entrega)), now());
  return eid;
}
export function registrarRecusa(db: Db, ws: string, x: { taskId: string | null; runId: string; erros: string[] }): number {
  db.run("INSERT INTO entregas (id, workspace_id, task_id, run_id, tipo, estado, conteudo, created_at) VALUES (?, ?, ?, ?, 'recusa', 'recusada', ?, ?)",
    id('ent'), ws, x.taskId, x.runId, db.seal(ws, JSON.stringify(x.erros.slice(0, 20))), now());
  return recusas(db, x.runId);
}
export const recusas = (db: Db, runId: string): number => Number(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM entregas WHERE run_id = ? AND estado = 'recusada'", runId)?.n ?? 0);

/** A entrega mais recente do card (a do agente ou a mínima), desde `desde` (o trabalho atual). */
export function ultimaEntrega(db: Db, ws: string, taskId: string, desde = ''): EntregaRegistrada | null {
  const r = db.get<EntregaRow>("SELECT * FROM entregas WHERE workspace_id = ? AND task_id = ? AND estado IN ('valida', 'minima') AND created_at >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1", ws, taskId, desde);
  if (!r) return null;
  try {
    return { id: r.id, entrega: JSON.parse(r.conteudo) as Entrega, minimo: r.estado === 'minima', decisoes: r.decisoes ? (JSON.parse(r.decisoes) as Record<string, 'aprovado' | 'devolvido'>) : {}, created_at: r.created_at };
  } catch { return null; }
}
/** O agente já registrou (no modelo) a entrega deste trabalho? O mínimo não conta. */
export const entregaDoAgente = (db: Db, ws: string, taskId: string, desde: string): boolean =>
  !!db.get("SELECT 1 AS x FROM entregas WHERE workspace_id = ? AND task_id = ? AND estado = 'valida' AND created_at >= ?", ws, taskId, desde);
/** O card de uma execução: o dela, ou o da continuação que pede a entrega (pede-entrega-<n>-<execução do card>). */
export function cardDaExecucao(db: Db, r: { task_id: string | null; idempotency_key: string }): string | null {
  if (r.task_id) return r.task_id;
  const m = /^pede-entrega-\d+-(.+)$/.exec(r.idempotency_key);
  return m ? db.get<{ task_id: string | null }>('SELECT task_id FROM runs WHERE id = ?', m[1])?.task_id ?? null : null;
}
export function marcarDecisao(db: Db, ws: string, entregaId: string, indice: number, decisao: 'aprovado' | 'devolvido'): Record<string, 'aprovado' | 'devolvido'> {
  const r = db.get<{ decisoes: string | null }>('SELECT decisoes FROM entregas WHERE id = ? AND workspace_id = ?', entregaId, ws);
  let d: Record<string, 'aprovado' | 'devolvido'> = {};
  try { d = r?.decisoes ? JSON.parse(r.decisoes) : {}; } catch { d = {}; }
  d[String(indice)] = decisao;
  db.run('UPDATE entregas SET decisoes = ? WHERE id = ? AND workspace_id = ?', JSON.stringify(d), entregaId, ws);
  return d;
}

// ------------------------------------------------------------------------------------------- o resumo curto

/** Os itens curtos do cartão: a linha de cima (quando o tipo tem) e os pontos. */
export function itensCurtos(e: Entrega): { lead: string | null; itens: string[] } {
  switch (e.tipo) {
    case 'decisao': return { lead: null, itens: e.itens.map((x) => x.titulo) };
    case 'entrega': return { lead: e.resumo, itens: [...e.arquivos, ...e.atencao] };
    case 'relatorio': return { lead: e.resumo, itens: e.pontos };
    case 'pergunta': return { lead: e.pergunta, itens: e.opcoes };
    default: return { lead: e.motivo, itens: [e.precisa] };
  }
}
export const TITULO_DO_TIPO: Record<TipoEntrega, string> = { decisao: 'Aguardando sua decisão', entrega: 'Entregue', relatorio: 'Resumo', pergunta: 'Pergunta', bloqueio: 'Bloqueado' };

/** Para os canais (Telegram, Discord, Teams) e os avisos: o título do tipo, os itens curtos e o link dos detalhes. */
export function avisoCurto(e: Entrega, card: { number: number }, link: string | null): string {
  const { lead, itens } = itensCurtos(e);
  return [`Card #${card.number} — ${TITULO_DO_TIPO[e.tipo]}:`, ...(lead ? [lead] : []), ...itens.slice(0, 6).map((x) => `• ${x}`), ...(link ? [`Ver detalhes: ${link}`] : [])].join('\n');
}
