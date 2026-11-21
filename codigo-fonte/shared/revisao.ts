/**
 * Revisão de documento com a equipe (rc.42): o documento em trechos, o plano do coordenador (quem edita qual trecho) e
 * a cor de cada agente. Puro: o servidor (services/revisao-documento.ts) e a tela (o documento ao vivo) usam o mesmo.
 *
 * Edição concorrente segura por trecho: cada frente reserva os trechos dela; ninguém escreve no trecho de outro, e o
 * revisor final só pega trechos já liberados, de cima para baixo.
 */

/** O documento em trechos: os blocos separados por linha em branco (o bloco de código fica inteiro). */
export function trechosDe(md: string): string[] {
  const ls = md.replace(/\r\n?/g, '\n').split('\n');
  const out: string[] = [];
  let cur: string[] = [];
  let cerca: string | null = null;
  const fecha = () => { if (cur.some((l) => l.trim())) out.push(cur.join('\n').replace(/\s+$/, '')); cur = []; };
  for (const l of ls) {
    const f = l.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (cerca) { cur.push(l); if (f && f[1][0] === cerca[0] && f[1].length >= cerca.length && !l.trim().slice(f[1].length).trim()) cerca = null; continue; }
    if (f) { if (cur.length && !/^\s/.test(l)) fecha(); cerca = f[1]; cur.push(l); continue; }
    if (!l.trim()) { fecha(); continue; }
    // linha recuada logo depois de uma linha em branco continua o bloco de cima (item de lista com parágrafo)
    if (!cur.length && /^\s{2,}\S/.test(l) && out.length) { cur = [...out.pop()!.split('\n'), '', l]; continue; }
    cur.push(l);
  }
  fecha();
  return out;
}

export const juntarTrechos = (t: readonly string[]): string => `${t.filter((x) => x.trim()).join('\n\n')}\n`;

export type Acao = 'revisar' | 'reescrever' | 'conferir';
export type Especialidade = 'codigo' | 'juridico' | 'texto';

export function especialidadeDe(trecho: string): Especialidade {
  if (/^\s{0,3}(`{3,}|~{3,})/m.test(trecho)) return 'codigo';
  if (/\b(cl[áa]usula|contrat(o|ante|ada)|lei\s+n?º?|artigo\s+\d|art\.\s*\d|jur[íi]dic|rescis[ãa]o|foro|LGPD|multa contratual|obriga[çc][õo]es das partes)/i.test(trecho)) return 'juridico';
  return 'texto';
}

export interface Colega { id: string; name: string; role: string; skey?: string; tools?: string[]; skills?: string[]; coordinator?: boolean }
export interface Frente { agentId: string; acao: Acao; blocos: number[]; especialidade: Especialidade | 'geral' }

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const perfil = (c: Colega) => fold(`${c.role} ${c.skey ?? ''} ${(c.skills ?? []).join(' ')} ${(c.tools ?? []).join(' ')}`);
const QUEM: Record<Especialidade | 'revisor', RegExp> = {
  codigo: /(desenvolv|program|codigo|software|engenh|devops|\bti\b|tecnolog|dados)/,
  juridico: /(jurid|advog|legal|contrat|compliance|direito)/,
  texto: /(reda|escrit|conteud|texto|copy|jornal|editoria)/,
  revisor: /(revis|qualidade|confer|editor|auditor)/,
};

/** Pedido que manda reescrever (e não só revisar). */
export const acaoDoPedido = (pedido: string): Acao => (/(reescrev|reformul|refa[cz]|reda[çc][ãa]o nova|rewrite|traduz|resum|encurt|simplifi)/i.test(fold(pedido)) ? 'reescrever' : 'revisar');

/** Tamanho máximo do que vai para um agente de uma vez (cabe no card). */
export const FRENTE_MAX = 6000;

/**
 * O plano do coordenador: quem edita o quê. Com trecho escolhido, uma frente só. Sem: um especialista por tipo de
 * trecho (código, jurídico, texto), em pedaços contíguos, e — com gente para isso — um revisor que confere de cima para
 * baixo o que os outros já liberaram.
 */
export function planejar(trechos: readonly string[], pedido: string, equipe: readonly Colega[], opts: { selecionados?: number[]; autorId?: string | null } = {}): Frente[] {
  const time = equipe.filter((c) => !c.coordinator);
  if (!time.length || !trechos.length) return [];
  const acao = acaoDoPedido(pedido);
  // o cargo vale antes das competências (quem é "Produção de texto" ganha de quem só cita texto nas competências)
  const achar = (k: keyof typeof QUEM, exceto: string[] = []) => time.find((c) => !exceto.includes(c.id) && QUEM[k].test(fold(c.role)))
    ?? time.find((c) => !exceto.includes(c.id) && QUEM[k].test(perfil(c)));
  const redator = time.find((c) => c.id === opts.autorId) ?? achar('texto') ?? time[0];
  if (opts.selecionados?.length) {
    const sel = [...new Set(opts.selecionados)].filter((i) => i >= 0 && i < trechos.length).sort((a, b) => a - b);
    const esp = especialidadeDe(sel.map((i) => trechos[i]).join('\n\n'));
    const quem = (esp !== 'texto' && achar(esp)) || redator;
    return sel.length ? [{ agentId: quem.id, acao, blocos: sel, especialidade: esp }] : [];
  }
  const dono = (i: number): { id: string; esp: Especialidade } => {
    const esp = especialidadeDe(trechos[i]);
    return { id: (esp !== 'texto' && achar(esp)?.id) || redator.id, esp };
  };
  const frentes: Frente[] = [];
  let atual: Frente | null = null; let tam = 0;
  trechos.forEach((t, i) => {
    const d = dono(i);
    if (atual && atual.agentId === d.id && atual.especialidade === d.esp && tam + t.length <= FRENTE_MAX) { atual.blocos.push(i); tam += t.length; return; }
    atual = { agentId: d.id, acao, blocos: [i], especialidade: d.esp };
    tam = t.length;
    frentes.push(atual);
  });
  const usados = [...new Set(frentes.map((f) => f.agentId))];
  const revisor = achar('revisor', usados) ?? (time.length > usados.length ? time.find((c) => !usados.includes(c.id)) : undefined);
  if (revisor && time.length >= 2) frentes.push({ agentId: revisor.id, acao: 'conferir', blocos: trechos.map((_, i) => i), especialidade: 'geral' });
  return frentes;
}

/** Os trechos que o revisor pode pegar agora: a partir de `desde`, enquanto ninguém mais tem o trecho reservado. */
export function liberadosAPartir(total: number, desde: number, reservados: ReadonlySet<number>, max = FRENTE_MAX, tamanho: (i: number) => number = () => 0): number[] {
  const out: number[] = [];
  let soma = 0;
  for (let i = desde; i < total; i++) {
    if (reservados.has(i)) break;
    if (out.length && soma + tamanho(i) > max) break;
    out.push(i); soma += tamanho(i);
  }
  return out;
}

// ------------------------------------------------------------------------------------------------ cor de cada agente

const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
function hsl(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0), f(8), f(4)];
}
const lum = (rgb: [number, number, number]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
/** fundos da página: o papel claro e o escuro do tema da noite */
const L_CLARO = lum([1, 1, 1]); const L_ESCURO = lum([0x1b / 255, 0x1a / 255, 0x22 / 255]);

/**
 * A cor fixa de um agente (borda do avatar, realce do trecho, cursor): sorteada pelo id, sempre a mesma, com 3:1 no
 * claro e no escuro.
 */
export function corDoAgente(agentId: string): string {
  let h = 2166136261;
  for (const ch of agentId) { h ^= ch.codePointAt(0)!; h = Math.imul(h, 16777619) >>> 0; }
  const hue = h % 360;
  const sat = 0.55 + ((h >>> 9) % 25) / 100;
  let best: [number, number, number] = hsl(hue, sat, 0.5); let melhor = 0;
  for (let l = 0.32; l <= 0.68; l += 0.01) {
    const rgb = hsl(hue, sat, l);
    const m = Math.min(ratio(lum(rgb), L_CLARO), ratio(lum(rgb), L_ESCURO));
    if (m > melhor) { melhor = m; best = rgb; }
  }
  return `#${best.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** O texto que o agente devolve: o que está entre as marcas (ou tudo, sem as linhas de controle). Ao vivo: até onde chegou. */
export const MARCA_INICIO = '=== TRECHO REVISADO ===';
export const MARCA_FIM = '=== FIM ===';
export function textoDaResposta(saida: string, aoVivo = false): string | null {
  const i = saida.indexOf(MARCA_INICIO);
  if (i < 0) return aoVivo ? null : saida.replace(/\[\[(?:[^\]]|\](?!\]))*\]\]/g, '').trim() || null;
  const resto = saida.slice(i + MARCA_INICIO.length).replace(/^\s*\n/, '');
  const j = resto.indexOf(MARCA_FIM);
  const corpo = j < 0 ? (aoVivo ? resto : resto) : resto.slice(0, j);
  return corpo.replace(/\s+$/, '') || (aoVivo ? '' : null);
}
