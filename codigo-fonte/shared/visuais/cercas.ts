/**
 * As cercas ```ergon-visual dentro do texto de uma mensagem: achar, validar e normalizar (o servidor, ao gravar a
 * resposta do agente), e os votos das enquetes (```ergon-voto, mensagens da pessoa).
 */
import { CERCA_VOTO, LIMITES, comTipo, langDoTipo, lerJson, tipoDoLang, validarBloco, type Bloco, type Conferencia } from './esquema.ts';

export interface Trecho { inicio: number; fim: number; lang: string; corpo: string; fechada: boolean }

/** As cercas de código do texto (```lang … ```), na ordem; uma aberta até o fim conta como não fechada. */
export function cercasDe(texto: string): Trecho[] {
  const out: Trecho[] = [];
  const re = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*([\w-]*)[^\n]*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto))) {
    const marca = m[1]; const lang = m[2].toLowerCase(); const inicio = m.index;
    const abreFim = inicio + m[0].length;
    const fecha = new RegExp(`^[ \\t]{0,3}${marca[0] === '`' ? '`' : '~'}{${marca.length},}[ \\t]*$`, 'gm');
    fecha.lastIndex = abreFim + 1;
    const f = fecha.exec(texto);
    const corpo = texto.slice(Math.min(texto.length, abreFim + 1), f ? f.index : texto.length).replace(/\n$/, '');
    const fim = f ? f.index + f[0].length : texto.length;
    out.push({ inicio, fim, lang, corpo, fechada: !!f });
    re.lastIndex = fim;
  }
  return out;
}

/** A cerca de um bloco: ```ergon-<tipo> e o JSON sem o tipo (a linguagem já diz). */
export const cercaVisual = (b: Bloco): string => { const { tipo, ...resto } = b; return `\`\`\`${langDoTipo(tipo)}\n${JSON.stringify(resto)}\n\`\`\``; };
/** É cerca de bloco visual (```ergon-<tipo> ou a genérica ```ergon-visual)? */
export const ehCercaVisual = (lang: string): boolean => tipoDoLang(lang) !== null;
/** Os blocos de uma cerca (a genérica aceita uma lista): valida cada um. */
export function blocosDaCerca(lang: string, corpo: string, c: Conferencia = {}): Array<ReturnType<typeof validarBloco>> | { erro: string } {
  const lido = lerJson(corpo);
  if (!lido.ok) return { erro: lido.erro };
  const itens = Array.isArray(lido.valor) && tipoDoLang(lang) === '' ? lido.valor : [lido.valor];
  return itens.map((v) => validarBloco(comTipo(lang, v), c));
}

export interface Normalizado { texto: string; blocos: Bloco[]; erros: string[] }

/**
 * Valida cada bloco e grava a forma normalizada (JSON compacto, campos vazios fora, ids das enquetes e dos relatórios).
 * Um bloco que não passa vira um bloco de código JSON comum: a pessoa ainda vê os dados, nada some em silêncio.
 * Um JSON com uma lista de blocos vira uma cerca para cada um.
 */
export function normalizarVisuais(texto: string, c: Conferencia = {}): Normalizado {
  const cercas = cercasDe(texto).filter((x) => ehCercaVisual(x.lang));
  if (!cercas.length) return { texto, blocos: [], erros: [] };
  const blocos: Bloco[] = []; const erros: string[] = [];
  let out = ''; let pos = 0; let total = 0;
  cercas.forEach((x, n) => {
    out += texto.slice(pos, x.inicio);
    pos = x.fim;
    const rs = blocosDaCerca(x.lang, x.corpo, c);
    if ('erro' in rs) { erros.push(`bloco ${n + 1}: ${rs.erro}`); out += `\`\`\`json\n${x.corpo.slice(0, 8000)}\n\`\`\``; return; }
    const partes: string[] = [];
    for (const r of rs) {
      if (!r.ok) { erros.push(...r.erros.map((e) => `bloco ${n + 1}: ${e}`)); partes.push(`\`\`\`json\n${x.corpo.trim().slice(0, 8000)}\n\`\`\``); continue; }
      const cerca = cercaVisual(r.bloco);
      if (blocos.length >= LIMITES.blocosPorMensagem || total + cerca.length > LIMITES.jsonMensagem) { erros.push(`bloco ${n + 1}: blocos demais nesta mensagem (até ${LIMITES.blocosPorMensagem})`); continue; }
      total += cerca.length; blocos.push(r.bloco); partes.push(cerca);
    }
    out += partes.join('\n\n');
  });
  out += texto.slice(pos);
  return { texto: out, blocos, erros };
}

/** Os blocos já normalizados de um texto (a tela e os canais leem assim; o que não passa fica de fora). */
export function blocosDe(texto: string): Bloco[] {
  const out: Bloco[] = [];
  for (const x of cercasDe(texto)) {
    if (!ehCercaVisual(x.lang) || !x.fechada) continue;
    const rs = blocosDaCerca(x.lang, x.corpo);
    if (!('erro' in rs)) for (const r of rs) if (r.ok) out.push(r.bloco);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ votos

export interface VotoMsg { enquete: string; opcao: number }
export const cercaVoto = (v: VotoMsg): string => `\`\`\`${CERCA_VOTO}\n${JSON.stringify({ enquete: v.enquete, opcao: v.opcao })}\n\`\`\``;
/** O voto de uma mensagem que é só o voto (null se a mensagem é outra coisa). */
export function votoDe(texto: string): VotoMsg | null {
  const t = texto.trim();
  const cs = cercasDe(t);
  if (cs.length !== 1 || cs[0].lang !== CERCA_VOTO || cs[0].inicio !== 0 || cs[0].fim !== t.length) return null;
  const lido = lerJson(cs[0].corpo);
  if (!lido.ok || !lido.valor || typeof lido.valor !== 'object') return null;
  const o = lido.valor as Record<string, unknown>;
  return typeof o.enquete === 'string' && /^[a-z0-9_-]{3,40}$/i.test(o.enquete) && Number.isInteger(o.opcao) && (o.opcao as number) >= 0 && (o.opcao as number) < 6
    ? { enquete: o.enquete, opcao: o.opcao as number } : null;
}
/** A apuração: o último voto de cada pessoa vale (trocar de ideia é votar de novo). */
export function apurar(votos: Array<VotoMsg & { quem: string }>, enquete: string, nOpcoes: number): { porOpcao: string[][]; total: number } {
  const ultimo = new Map<string, number>();
  for (const v of votos) if (v.enquete === enquete && v.opcao < nOpcoes) ultimo.set(v.quem, v.opcao);
  const porOpcao: string[][] = Array.from({ length: nOpcoes }, () => []);
  for (const [quem, o] of ultimo) porOpcao[o].push(quem);
  return { porOpcao, total: ultimo.size };
}
