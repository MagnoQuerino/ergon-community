/**
 * O bloco visual como texto: o Telegram, o Discord, o Teams, o WhatsApp, as notificações, a prévia da lista de
 * conversas e o "copiar" da mensagem. Curto e legível em fonte comum: o número primeiro, a fonte no fim.
 */
import { CERCA_VOTO, type Bloco, type Fonte } from './esquema.ts';
import { blocosDaCerca, cercaVisual, cercasDe, ehCercaVisual } from './cercas.ts';
import { fmtDataIso, fmtValor, fmtVariacao, type Locale } from './formato.ts';
import { QUADRANTES_PADRAO } from './cena.ts';

const ESTADO_MARCO = { feito: '✓ feito', em_dia: 'em dia', atrasado: '⚠ atrasado', risco: '⚠ em risco', previsto: 'previsto' } as const;
const ESTADO_CHECK = { feito: '☑', andamento: '◐', pendente: '☐', bloqueado: '⛔' } as const;
const ESTADO_STATUS = { ok: '🟢', atencao: '🟡', erro: '🔴', parado: '⚪' } as const;
const COR_SEMAFORO = { verde: '🟢', amarelo: '🟡', vermelho: '🔴' } as const;
const TOM_AVISO = { info: 'ℹ️', dica: '💡', alerta: '⚠️', risco: '🛑', sucesso: '✅' } as const;
const NOME_TIPO: Partial<Record<Bloco['tipo'], string>> = { barras: 'gráfico', linhas: 'gráfico', pizza: 'gráfico', tabela: 'tabela', kpi: 'métrica', kpis: 'métricas',
  linha_do_tempo: 'linha do tempo', enquete: 'enquete', relatorio: 'relatório', comparativo: 'comparativo', medidor: 'medidor', matriz: 'matriz', funil: 'funil', calor: 'mapa de calor' };

export function fontesComoTexto(fs: Fonte[] | undefined, estimativa?: boolean): string {
  const partes = (fs ?? []).map((f) => `${f.titulo}${f.periodo ? ` (${f.periodo})` : ''}${f.url ? ` ${f.url}` : ''}`);
  if (estimativa) partes.unshift('estimativa');
  return partes.length ? `Fonte: ${partes.join(' · ')}` : '';
}

/** O bloco em texto. `curto`: uma linha (prévia, notificação). */
export function visualComoTexto(b: Bloco, o: { locale?: Locale; curto?: boolean } = {}): string {
  const l = o.locale ?? 'pt-BR';
  const v = (x: number | null | undefined, f?: { formato?: Bloco extends never ? never : string; moeda?: string }) => fmtValor(x ?? null, { formato: f?.formato as never, moeda: f?.moeda as never, locale: l });
  if (o.curto) {
    if (b.tipo === 'kpi') return `${b.rotulo}: ${v(b.valor, b)}`;
    if (b.tipo === 'decisao') return `Decisão: ${b.escolha}`;
    if (b.tipo === 'enquete') return `Enquete: ${b.pergunta}`;
    return `[${NOME_TIPO[b.tipo] ?? 'visual'}${b.titulo ? `: ${b.titulo}` : ''}]`;
  }
  const L: string[] = [];
  if (b.titulo) L.push(`**${b.titulo}**`);
  if (b.subtitulo) L.push(b.subtitulo);
  const kpi = (k: { rotulo: string; valor: number; formato?: string; moeda?: string; unidade?: string; variacao?: number; comparacao?: string; meta?: number }) =>
    `${k.rotulo}: **${fmtValor(k.valor, { formato: k.formato as never, moeda: k.moeda as never, unidade: k.unidade, locale: l })}**${k.variacao !== undefined ? ` (${k.variacao > 0 ? '▲' : k.variacao < 0 ? '▼' : ''} ${fmtVariacao(k.variacao, l)}${k.comparacao ? ` ${k.comparacao}` : ''})` : ''}${k.meta !== undefined ? ` · meta ${fmtValor(k.meta, { formato: k.formato as never, moeda: k.moeda as never, locale: l })}` : ''}`;
  switch (b.tipo) {
    case 'kpi': L.push(kpi(b)); break;
    case 'kpis': b.itens.forEach((k) => L.push(`• ${kpi(k)}`)); break;
    case 'nota': L.push(`${b.rotulo ? `${b.rotulo}: ` : ''}**${fmtValor(b.valor, { locale: l })}/${b.escala ?? 10}**${b.legenda ? ` — ${b.legenda}` : ''}`); break;
    case 'barras': case 'linhas':
      if (b.series.length === 1) b.categorias.forEach((c, i) => L.push(`• ${c}: ${v(b.series[0].valores[i], b)}`));
      else b.categorias.forEach((c, i) => L.push(`• ${c}: ${b.series.map((s) => `${s.nome} ${v(s.valores[i], b)}`).join(' · ')}`));
      if (b.meta !== undefined) L.push(`Meta: ${v(b.meta, b)}`);
      break;
    case 'pizza': {
      const t = b.fatias.reduce((a, x) => a + x.valor, 0) || 1;
      b.fatias.forEach((x) => L.push(`• ${x.rotulo}: ${v(x.valor, b)} (${fmtValor((x.valor / t) * 100, { formato: 'percentual', locale: l })})`));
      break;
    }
    case 'tabela': {
      const cel = (x: string | number | null, j: number) => (typeof x === 'number' || b.colunas[j]?.formato === 'data' ? fmtValor(x, { formato: b.colunas[j]?.formato, moeda: b.colunas[j]?.moeda, locale: l }) : x ?? '—');
      for (const linha of b.linhas.slice(0, 15)) L.push(`• ${linha.map((x, j) => (j === 0 ? `${cel(x, j)}` : `${b.colunas[j].titulo} ${cel(x, j)}`)).join(' · ')}`);
      if (b.linhas.length > 15) L.push(`… e mais ${b.linhas.length - 15} linhas no Ergon`);
      break;
    }
    case 'comparativo': b.opcoes.forEach((x) => {
      L.push(`▸ ${x.nome}${x.recomendada ? ' (recomendada)' : ''}${x.valor !== undefined ? `: ${v(x.valor, b)}` : ''}`);
      (x.pros ?? []).forEach((p) => L.push(`  + ${p}`)); (x.contras ?? []).forEach((p) => L.push(`  − ${p}`));
    }); break;
    case 'versus': L.push(`${b.a.rotulo}: **${v(b.a.valor, b)}**${b.melhor === 'a' ? ' ✓' : ''}${b.a.legenda ? ` (${b.a.legenda})` : ''}`, `${b.b.rotulo}: **${v(b.b.valor, b)}**${b.melhor === 'b' ? ' ✓' : ''}${b.b.legenda ? ` (${b.b.legenda})` : ''}`); break;
    case 'placar': b.itens.forEach((x) => L.push(`• ${x.rotulo}: ${fmtValor(x.nota, { locale: l })}/${b.escala ?? 10}`)); break;
    case 'linha_do_tempo': b.marcos.forEach((m) => L.push(`• ${fmtDataIso(m.data, l)} — ${m.titulo}${m.estado ? ` (${ESTADO_MARCO[m.estado]})` : ''}`)); break;
    case 'progresso': b.itens.forEach((x) => L.push(`• ${x.rotulo}: ${fmtValor(x.atual, { formato: x.formato, moeda: x.moeda, locale: l })} de ${fmtValor(x.meta, { formato: x.formato, moeda: x.moeda, locale: l })} (${fmtValor((x.atual / x.meta) * 100, { formato: 'percentual', locale: l })})${x.prazo ? ` até ${fmtDataIso(x.prazo, l)}` : ''}`)); break;
    case 'checklist': b.itens.forEach((x) => L.push(`${ESTADO_CHECK[x.estado]} ${x.texto}`)); break;
    case 'status': b.itens.forEach((x) => L.push(`${ESTADO_STATUS[x.estado]} ${x.rotulo}${x.detalhe ? ` — ${x.detalhe}` : ''}`)); break;
    case 'semaforo': b.itens.forEach((x) => L.push(`${COR_SEMAFORO[x.cor]} ${x.rotulo}${x.detalhe ? ` — ${x.detalhe}` : ''}`)); break;
    case 'pessoa': L.push(`**${b.nome}**${b.cargo ? `, ${b.cargo}` : ''}${b.empresa ? ` · ${b.empresa}` : ''}`, ...[b.email, b.telefone, b.site, b.local].filter((x): x is string => !!x)); break;
    case 'aviso': L.push(`${TOM_AVISO[b.tom]} ${b.texto}`); break;
    case 'galeria': L.push(`${b.imagens.length} imagem(ns): ${b.imagens.map((x) => x.legenda ?? x.alt).join(' · ')}`); break;
    case 'link': L.push(`${b.descricao ? `${b.descricao} ` : ''}${b.url}`); break;
    case 'arquivo': L.push(`[documento: ${b.id} ${b.titulo ?? 'arquivo'}]`); break;
    case 'mapa': L.push(`📍 ${b.endereco}`); break;
    case 'referencias': b.itens.forEach((r) => L.push(`• ${r.titulo}${r.url ? ` ${r.url}` : ''}`)); break;
    case 'ficha': b.linhas.forEach((x) => L.push(`• ${x.parametro}: ${x.destaque ? `**${x.valor}**` : x.valor}`)); break;
    case 'medidor': L.push(`${b.rotulo ?? 'Valor'}: **${fmtValor(b.valor, { formato: b.formato, locale: l })}** (de ${fmtValor(b.min ?? 0, { formato: b.formato, locale: l })} a ${fmtValor(b.max ?? 100, { formato: b.formato, locale: l })})${b.tendencia !== undefined ? ` · tendência ${fmtVariacao(b.tendencia, l)}` : ''}`); break;
    case 'sparkline': { const s = b.serie; L.push(`${b.rotulo}: **${v(s.at(-1), b)}** (${fmtVariacao(((s.at(-1)! - s[0]) / (Math.abs(s[0]) || 1)) * 100, l)} no período)`); break; }
    case 'icones': L.push(`${'●'.repeat(Math.round(b.valor))}${'○'.repeat(Math.max(0, b.total - Math.round(b.valor)))} ${b.rotulo}`); break;
    case 'funil': b.etapas.forEach((e, i) => L.push(`${i ? '↓ ' : ''}${e.rotulo}: ${v(e.valor, b)}`)); break;
    case 'calor': {
      let p = { i: 0, j: 0, x: -Infinity };
      b.valores.forEach((r, i) => r.forEach((x, j) => { if (x > p.x) p = { i, j, x }; }));
      L.push(`Pico: ${b.linhas[p.i]} ${b.colunas[p.j]} (${fmtValor(p.x, { formato: b.formato, locale: l })})`);
      break;
    }
    case 'enquete': L.push(`🗳 ${b.pergunta}`, ...b.opcoes.map((x, i) => `${i + 1}. ${x}${b.decisao === i ? ' ✓' : ''}`)); break;
    case 'decisao': L.push(`✅ Decisão: **${b.escolha}**${b.votos !== undefined ? ` · ${b.votos}${b.total ? ` de ${b.total}` : ''} votos` : ''}`, ...(b.porque ? [b.porque] : []), ...(b.proximos ?? []).map((x) => `→ ${x}`)); break;
    case 'matriz': { const q = b.quadrantes ?? QUADRANTES_PADRAO; b.itens.forEach((x) => L.push(`• ${x.rotulo}: ${q[(x.x > 5 ? 1 : 0) + (x.y > 5 ? 0 : 2)]}`)); break; }
    case 'fontes': break;
    case 'relatorio':
      if (b.resumo) L.push(b.resumo);
      L.push(...b.secoes.map((s) => `• ${s.titulo}`), 'O relatório completo está no Ergon.');
      break;
  }
  if (b.nota) L.push(b.nota);
  const f = fontesComoTexto(b.tipo === 'fontes' ? b.itens : b.fontes, b.estimativa);
  if (f) L.push(`_${f}_`);
  return L.join('\n');
}

/** Troca cada cerca de bloco visual do texto pelo texto do bloco; o voto vira uma linha curta. */
export function visuaisComoTexto(texto: string, o: { locale?: Locale; curto?: boolean } = {}): string {
  const cs = cercasDe(texto).filter((x) => ehCercaVisual(x.lang) || x.lang === CERCA_VOTO);
  if (!cs.length) return texto;
  let out = ''; let pos = 0;
  for (const x of cs) {
    out += texto.slice(pos, x.inicio); pos = x.fim;
    if (x.lang === CERCA_VOTO) { out += o.curto ? '🗳' : '(votou na enquete)'; continue; }
    const rs = blocosDaCerca(x.lang, x.corpo);
    out += ('erro' in rs ? [] : rs).map((r) => (r.ok ? visualComoTexto(r.bloco, o) : '')).filter(Boolean).join(o.curto ? ' ' : '\n\n');
  }
  return out + texto.slice(pos);
}

/** O relatório como documento Markdown: títulos, texto e cada bloco na cerca dele (```ergon-<tipo>), como o documento
 * dos Entregáveis lê, revisa por trechos e exporta. */
export function relatorioComoMarkdown(r: Extract<Bloco, { tipo: 'relatorio' }>): string {
  const L: string[] = [`# ${r.titulo ?? 'Relatório'}`];
  if (r.subtitulo) L.push(`_${r.subtitulo}_`);
  if (r.resumo) L.push(r.resumo);
  for (const b of r.destaques ?? []) L.push(cercaVisual(b));
  for (const s of r.secoes) {
    L.push(`## ${s.titulo}`);
    if (s.texto) L.push(s.texto);
    for (const b of s.blocos ?? []) L.push(cercaVisual(b));
  }
  const f = fontesComoTexto(r.fontes, r.estimativa);
  if (f) L.push(`---\n\n${f}`);
  return `${L.join('\n\n')}\n`;
}
