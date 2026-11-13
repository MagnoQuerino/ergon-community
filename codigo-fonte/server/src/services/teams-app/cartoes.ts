/**
 * O que vai para o Teams: o texto das respostas (markdown simples, sem as linhas de controle dos agentes nem HTML) e os
 * cartões (Adaptive Card 1.4) com Aprovar/Recusar dentro de um ActionSet no corpo, Action.Execute com reserva
 * Action.Submit (contrato, 3.5). O mesmo desenho serve ao cartão de uma confirmação na conversa e ao aviso de "Com você".
 */
import { MAX_CARTAO, MAX_TEXTO_SAIDA, tokenCartao, type ChavesInstalacao } from './protocolo.ts';

const NOME_DO_MOTOR = new RegExp('\\bHer' + 'mes\\b', 'gi');
const corta = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`);

/**
 * Links com o endereço por extenso: "[Abra o Ergon](https://site)" vira "Abra o Ergon (https://site)". Um texto que veio de
 * fora (um e-mail com instrução escondida, por exemplo) não consegue esconder o destino atrás de uma frase igual às do
 * sistema; o Teams ainda torna clicável o endereço, que fica à vista.
 */
export function linksPorExtenso(s: string): string {
  return s
    .replace(/!?\[([^\]\n]{0,500})\]\(\s*<?([^)\s>]{1,2000})>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g, (_m, txt: string, url: string) => {
      const t = txt.trim();
      return !t || t === url ? url : `${t} (${url})`;
    })
    .replace(/<((?:https?|mailto):[^>\s]{1,2000})>/gi, '$1');
}

/**
 * Resposta do agente como texto do Teams: sem [[controle]], sem {{marcas}}, sem HTML, sem o nome do motor, e com os
 * links por extenso.
 */
export function textoParaTeams(t: string, max = MAX_TEXTO_SAIDA): string {
  let s = linksPorExtenso(String(t ?? '')
    .replace(/\[\[[^\]]*(?:\][^\]]+)*\]\]/g, ''))
    .replace(/\{\{[^}\n]{0,200}\}\}/g, '')
    .replace(/<\/?[a-zA-Z][^>\n]{0,200}>/g, '')
    .replace(NOME_DO_MOTOR, 'a equipe')
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length > max) s = `${s.slice(0, max - 60).trimEnd()}\n\n… (a resposta continua no Ergon)`;
  return s;
}
/** Os cartões em que a pessoa aprova exatamente o que lê (o pedido aplicado é o texto do cartão): ou cabem inteiros, ou não decidem fora do Ergon. */
export const KINDS_INTEIROS: readonly string[] = ['gestao', 'conexao'];
/** O texto aparece inteiro num canal com este limite: nada cortado nem tirado (marcadores, chaves duplas, etiquetas). */
export function apareceInteiro(texto: string, max: number): boolean {
  const t = String(texto ?? '');
  return !/\[\[|\{\{|<\/?[a-zA-Z]/.test(t) && textoParaTeams(t, Number.MAX_SAFE_INTEGER).length <= max;
}
/** O limite do texto de um cartão no Telegram e no Discord, e o maior do Teams (o cartão do Teams encolhe se não couber). */
export const LIMITE_CANAL = 2500;
export const LIMITE_TEAMS = 6000;
/** O cartão pode ter Aprovar fora do Ergon: o tipo não exige o texto inteiro, ou o título e o texto cabem inteiros. */
export function cabeNoCanal(kind: string, summary: string, max: number): boolean {
  if (!KINDS_INTEIROS.includes(kind)) return true;
  const s = String(summary ?? '').trim();
  const i = s.indexOf('\n');
  const titulo = i < 0 ? s : s.slice(0, i); const texto = i < 0 ? '' : s.slice(i + 1).trim();
  return titulo.length <= 200 && apareceInteiro(titulo, 200) && apareceInteiro(texto, max);
}
export const ABRIR_LONGO = 'Abra o Ergon para decidir: o pedido é longo demais para aparecer aqui inteiro.';
/** Texto curto da notificação do Teams (≤ 120). */
export const resumoParaTeams = (t: string) => corta(textoParaTeams(t, 2000).replace(/\s+/g, ' '), 120);

/** Um item do cartão: uma decisão (aprovar/recusar aqui) ou um aviso que se responde no Ergon. */
export type ItemCartao =
  | { tipo: 'decisao'; p: string; titulo: string; texto: string; /** só decide aqui se o texto aparecer inteiro (KINDS_INTEIROS) */ inteiro?: boolean }
  /** p: a proposta, quando o aviso é de uma (pedido de senha, pergunta): decidida no Ergon, o cartão mostra a linha final */
  | { tipo: 'aviso'; titulo: string; texto: string; abrir: string; p?: string };
export interface DesenhoCartao { titulo: string; itens: ItemCartao[] }
/** O estado atual de cada decisão (para o cartão final, sem botões). */
export interface EstadoDecisao { status: string; result?: string | null; decidedAt?: string | null; jaDecidido?: boolean }

function hora(iso: string | null | undefined, tz: string): string {
  const d = iso ? new Date(iso) : new Date();
  try {
    const p = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
    return `${p.find((x) => x.type === 'hour')?.value ?? '00'}h${p.find((x) => x.type === 'minute')?.value ?? '00'}`;
  } catch { return `${String(d.getUTCHours()).padStart(2, '0')}h${String(d.getUTCMinutes()).padStart(2, '0')}`; }
}

/** "06/11 às 17h02", no fuso do workspace. */
export function dataHora(iso: string, tz: string): string {
  const d = new Date(iso);
  try {
    const p = new Intl.DateTimeFormat('pt-BR', { timeZone: tz, day: '2-digit', month: '2-digit' }).formatToParts(d);
    return `${p.find((x) => x.type === 'day')?.value ?? '00'}/${p.find((x) => x.type === 'month')?.value ?? '00'} às ${hora(iso, tz)}`;
  } catch { return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')} às ${hora(iso, tz)}`; }
}

/** A linha final de uma decisão já tomada. */
export function linhaFinal(e: EstadoDecisao, tz: string): string {
  if (e.jaDecidido && e.status === 'proposed') return 'Já decidido no Ergon.';
  if (e.status === 'applied') return `Aprovado por você às ${hora(e.decidedAt, tz)}.`;
  if (e.status === 'rejected') return `Recusado por você às ${hora(e.decidedAt, tz)}.`;
  if (e.status === 'failed') return `Aprovado, mas não deu certo: ${corta(textoParaTeams(e.result ?? 'o motivo não foi informado', 400), 300)}`;
  return 'Já decidido no Ergon.';
}

const bloco = (text: string, extra: Record<string, unknown> = {}) => ({ type: 'TextBlock', text, wrap: true, ...extra });
function botoes(p: string, t: string) {
  const um = (title: string, d: 'apply' | 'reject', style: string) => ({
    type: 'Action.Execute', title, verb: 'ergon.decidir', style, data: { p, d, t },
    fallback: { type: 'Action.Submit', title, data: { verb: 'ergon.decidir', p, d, t } },
  });
  return { type: 'ActionSet', actions: [um('Aprovar', 'apply', 'positive'), um('Recusar', 'reject', 'destructive')] };
}

/**
 * O cartão para um vínculo. Decisões ainda abertas levam os botões (com o `t` deste vínculo); as decididas, a linha final.
 * O texto encolhe até caber em 28 KiB.
 */
export function montarCartao(d: DesenhoCartao, estados: Map<string, EstadoDecisao>, bindingId: string, chaves: Pick<ChavesInstalacao, 'hmac'>, tz: string): Record<string, unknown> {
  for (const max of [6000, 2500, 1200, 500, 200]) {
    const body: unknown[] = [bloco(corta(d.titulo, 200), { weight: 'Bolder', size: 'Medium' })];
    for (const it of d.itens) {
      body.push(bloco(corta(textoParaTeams(it.titulo, 400), 200), { weight: 'Bolder', spacing: 'Medium' }));
      if (it.texto) body.push(bloco(corta(textoParaTeams(it.texto, max * 2), max)));
      if (it.tipo === 'aviso') {
        const ea = it.p ? estados.get(it.p) : undefined;
        body.push(ea && ea.status !== 'proposed' ? bloco(linhaFinal({ ...ea, status: ea.status === 'applied' ? 'decidido' : ea.status }, tz), { weight: 'Bolder' }) : bloco(it.abrir, { isSubtle: true }));
        continue;
      }
      const e = estados.get(it.p);
      // o pedido aplicado é o texto inteiro: cortado neste tamanho de cartão, nada de botões (decide no Ergon)
      if (it.inteiro && it.texto && !apareceInteiro(it.texto, max) && (!e || e.status === 'proposed')) { body.push(bloco(ABRIR_LONGO, { isSubtle: true })); continue; }
      if (!e || (e.status === 'proposed' && !e.jaDecidido)) body.push(botoes(it.p, tokenCartao(chaves, it.p, bindingId)));
      else body.push(bloco(linhaFinal(e, tz), { weight: 'Bolder', color: e.status === 'applied' ? 'Good' : e.status === 'failed' ? 'Attention' : 'Default' }));
    }
    const card = { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body, actions: [] };
    if (Buffer.byteLength(JSON.stringify(card)) <= MAX_CARTAO) return card;
  }
  return { type: 'AdaptiveCard', $schema: 'http://adaptivecards.io/schemas/adaptive-card.json', version: '1.4', body: [bloco(corta(d.titulo, 200), { weight: 'Bolder' }), bloco('Abra o Ergon para ver os detalhes.')], actions: [] };
}

/** O título e o texto de uma proposta: a primeira linha do resumo e o resto. */
export function partesDoResumo(summary: string): { titulo: string; texto: string } {
  const s = String(summary ?? '').trim();
  const i = s.indexOf('\n');
  return i < 0 ? { titulo: corta(s, 200), texto: '' } : { titulo: corta(s.slice(0, i), 200), texto: s.slice(i + 1).trim() };
}
