/**
 * Notion, além dos quadros: buscar, ler e escrever páginas, com a mesma credencial e a mesma versão de NotionProvider e do escritor
 * (2025-09-03). Campos e ajuda ficam com o catálogo. Referências oficiais (conferidas em 05/11/2026; as páginas já mostram 2026-03-11,
 * que só troca `after`, `archived` e `transcription`, e nada disso é usado aqui):
 *   https://developers.notion.com/guides/get-started/upgrade-guide-2026-03-11   https://developers.notion.com/reference/get-self
 *   https://developers.notion.com/reference/post-search   https://developers.notion.com/reference/get-block-children
 *   https://developers.notion.com/reference/patch-block-children   https://developers.notion.com/reference/post-page
 *   https://developers.notion.com/reference/retrieve-a-data-source   https://developers.notion.com/reference/block
 *   https://developers.notion.com/reference/request-limits (2000 caracteres por texto; 100 blocos e 100 pedaços por vez)
 *   https://developers.notion.com/reference/capabilities   https://developers.notion.com/guides/get-started/internal-connections
 *   https://developers.notion.com/guides/data-apis/working-with-page-content (o id da página serve como id de bloco)
 *
 * A escrita só usa texto corrido: nada do que foi escrito vira menção, e erro do Notion sempre vem com status 4xx/5xx.
 * Criar e acrescentar são enviar: por padrão o Notion avisa quem marcou "Notify me" na página (post-page e patch-block-children,
 * `notifications.mode`). O modo `silent` existe nas páginas da versão 2026-03-11, e não foi testado na 2025-09-03 usada aqui.
 */
import { neutral } from '../../operations.ts';
import { ErroAcao, seg, type Args, type Param } from '../tipos.ts';
import { linhaDe, type ConectorDef } from './declarativo.ts';
import { MAX_TITULO, tamanhoNoCartao, textoLimpo } from './gitlab.ts';

const VERSAO = '2025-09-03';

/** Aceita o id, com ou sem traços, ou o link da página. */
const UUID = /([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32})(?:[?#/]|$)/i;
function idNotion(v: unknown, oQue: string): string {
  const m = UUID.exec(String(v ?? '').trim());
  if (!m) throw new ErroAcao(`"${oQue}" precisa ser o id ou o link do Notion`);
  return m[1].toLowerCase();
}

/** Corta sem partir um emoji ao meio. */
function pedacos(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length;) {
    let f = Math.min(i + n, s.length);
    if (f < s.length && /[\uD800-\uDBFF]/.test(s[f - 1])) f--;
    out.push(s.slice(i, f));
    i = f;
  }
  return out;
}
const rico = (t: string) => pedacos(t, 2000).map((content) => ({ type: 'text', text: { content } }));
/** Um parágrafo por trecho separado por linha em branco. O Notion recusa mais de 100 blocos por vez: melhor dizer antes. */
function blocosDe(texto: unknown): unknown[] {
  const blocos = String(texto ?? '').replace(/\r/g, '').split(/\n{2,}/).map((p) => p.trim()).filter(Boolean).map((p) => ({ type: 'paragraph', paragraph: { rich_text: rico(p) } }));
  if (blocos.length > 100) throw new ErroAcao('o texto tem mais de 100 parágrafos: envie em partes');
  return blocos;
}

const puro = (r: unknown): string => (Array.isArray(r) ? r.map((x: any) => String(x?.plain_text ?? '')).join('') : '');
/** O título de uma página está na propriedade do tipo título, com o nome que a base der; o de uma base está no próprio objeto. */
const tituloDe = (x: any): string => puro(x?.title) || puro((Object.values(x?.properties ?? {}) as any[]).find((p) => p?.type === 'title')?.title) || 'Sem título';

/** Um bloco em texto. Itens dentro de itens são lidos à parte, com o id que a linha mostra. */
function blocoParaTexto(b: any): string {
  const t = String(b?.type ?? '');
  const c = b?.[t] ?? {};
  const r = puro(c.rich_text);
  let s: string;
  if (/^heading_\d$/.test(t)) s = `${'#'.repeat(Number(t.slice(-1)))} ${r}`;
  else if (t === 'bulleted_list_item') s = `- ${r}`;
  else if (t === 'numbered_list_item') s = `1. ${r}`;
  else if (t === 'to_do') s = `${c.checked ? '(feito)' : '(a fazer)'} ${r}`;
  else if (t === 'quote') s = `> ${r}`;
  else if (t === 'code') s = `\`\`\`${c.language ?? ''}\n${r}\n\`\`\``;
  else if (t === 'divider') s = '---';
  else if (t === 'child_page' || t === 'child_database') s = `${t === 'child_page' ? 'página' : 'base'}: ${c.title ?? ''} (id: ${b.id})`;
  else if (t === 'table_row') s = (Array.isArray(c.cells) ? c.cells : []).map(puro).join(' | ');
  else if (t === 'bookmark' || t === 'embed' || t === 'link_preview') s = String(c.url ?? '');
  else if (t === 'image' || t === 'video' || t === 'file' || t === 'pdf' || t === 'audio') s = `(${t}${puro(c.caption) ? `: ${puro(c.caption)}` : ''})`;
  else s = r || `(${t || 'bloco'})`;
  return b?.has_children && t !== 'child_page' && t !== 'child_database' ? `${s} (tem conteúdo dentro; leia com o id ${b.id})` : s;
}

const P_LIMITE: Param = { tipo: 'numero', descricao: 'itens por vez, até 100 (padrão 30)', padrao: 30, max: 100 };

export const NOTION_EXTRAS: ConectorDef = {
  kind: 'notion', nome: 'Notion', site: 'notion.so', grupo: 'documentos',
  sobre: 'Páginas do Notion que você compartilhar com a conexão: os agentes buscam, leem, criam páginas e acrescentam conteúdo quando você pede.',
  campos: [],
  ajuda: { url: 'https://app.notion.com/developers/connections', passos: 'No portal de desenvolvedores do Notion: Internal connections › Create a new connection. Na aba Configuration, ligue ler e inserir conteúdo e copie o token. Depois, em cada página: ••• › Connections › Add connection.' },
  base: 'https://api.notion.com/v1',
  auth: { tipo: 'cabecalhos', cabecalhos: (c) => ({ Authorization: `Bearer ${c.token}`, 'Notion-Version': VERSAO }) },
  quemSou: { caminho: '/users/me', nome: (j) => String(j.bot?.workspace_name || j.name || 'Notion'), id: (j) => j.id },
  acoes: [
    // POST com o cursor no corpo: o `proximo` do motor o poria na consulta, então o cursor é declarado aqui
    { id: 'notion.buscar', descricao: 'procura pelo título, nas páginas ou nas bases compartilhadas com a conexão; sem "busca", traz as mais recentes', rotulo: 'procura pelo título, nas páginas ou nas bases compartilhadas com a conexão', risco: 'ler',
      params: { busca: { tipo: 'texto', descricao: 'parte do título' }, tipo: { tipo: 'texto', descricao: 'o que procurar', opcoes: ['pagina', 'base'], padrao: 'pagina' }, limite: P_LIMITE, cursor: { tipo: 'texto', descricao: 'continua de onde parou: use o que veio em "cursor" na resposta anterior' } },
      resumo: (a) => `buscar no Notion: ${a.busca ?? '(as mais recentes)'}`, metodo: 'POST', caminho: '/search',
      corpo: (a: Args) => ({ ...(a.busca ? { query: a.busca } : { sort: { timestamp: 'last_edited_time', direction: 'descending' } }), filter: { property: 'object', value: a.tipo === 'base' ? 'data_source' : 'page' }, page_size: a.limite, ...(a.cursor ? { start_cursor: a.cursor } : {}) }),
      texto: (j) => {
        const l: any[] = Array.isArray(j.results) ? j.results : [];
        const linhas = l.map((x) => `- ${linhaDe('{titulo} (id: {id}) {url}', { titulo: tituloDe(x), id: x.id, url: x.url })}`).join('\n') || 'nada encontrado';
        return `${linhas}${j.has_more && j.next_cursor ? `\ncursor: ${j.next_cursor}` : ''}`;
      } },
    { id: 'notion.ler', descricao: 'lê o conteúdo de uma página, em texto. Itens com conteúdo dentro mostram o id: leia de novo com ele', rotulo: 'lê o conteúdo de uma página, em texto', risco: 'ler',
      params: { pagina: { tipo: 'texto', obrigatorio: true, descricao: 'id ou link da página' }, limite: P_LIMITE }, resumo: 'ler a página {pagina} do Notion',
      antes: async (_c, a) => ({ ...a, pagina: idNotion(a.pagina, 'pagina') }), metodo: 'GET', caminho: '/blocks/{pagina}/children', consulta: { page_size: '{limite}' },
      proximo: (j) => (j.has_more ? j.next_cursor : null), paramCursor: 'start_cursor',
      texto: (j) => { const l: any[] = Array.isArray(j.results) ? j.results : []; return l.length ? textoLimpo(l.map(blocoParaTexto).join('\n'), 25_000) : '(página sem conteúdo)'; } },
    { id: 'notion.criar_pagina', descricao: 'cria uma página dentro de outra página ou de uma base. Diga "pai" ou "base", um dos dois. Quem acompanha a página acima pode receber aviso', rotulo: 'cria uma página dentro de outra página ou de uma base. Quem acompanha a página acima pode receber aviso', risco: 'enviar',
      params: { titulo: { tipo: 'texto', obrigatorio: true, descricao: 'o título, até 500 caracteres', max: MAX_TITULO }, texto: { tipo: 'texto', descricao: 'o conteúdo; linha em branco separa parágrafos' }, pai: { tipo: 'texto', descricao: 'id ou link da página acima desta' }, base: { tipo: 'texto', descricao: 'id da base (use notion.buscar com tipo base)' } },
      resumo: (a) => `Criar no Notion a página "${a.titulo}", ${a.base ? `na base ${a.base}` : `dentro da página ${a.pai}`}${tamanhoNoCartao(a.texto)}:\n${a.texto ?? '(sem texto)'}`,
      antes: async (ctx, a) => {
        if (!a.pai === !a.base) throw new ErroAcao('diga onde criar: "pai" (uma página) ou "base", um dos dois');
        if (a.pai) return { ...a, pai: idNotion(a.pai, 'pai') };
        // numa base, a propriedade do título tem o nome que a base der
        const base = idNotion(a.base, 'base');
        const ds = await ctx.http(`/data_sources/${base}`);
        const propriedade = Object.entries((ds?.properties ?? {}) as Record<string, any>).find(([, p]) => p?.type === 'title')?.[0];
        if (!propriedade) throw new ErroAcao('esta base não tem um campo de título que a conexão possa ver: nada foi criado');
        return { ...a, base, propriedade };
      },
      metodo: 'POST', caminho: '/pages',
      corpo: (a: Args) => ({
        parent: a.base ? { type: 'data_source_id', data_source_id: a.base } : { page_id: a.pai },
        properties: { [String(a.propriedade ?? 'title')]: { title: rico(String(a.titulo ?? '').replace(/[\r\n]+/g, ' ')) } },
        ...(a.texto ? { children: blocosDe(a.texto) } : {}),
      }),
      texto: (j) => linhaDe('Página criada: {url} (id: {id})', j), url: (j) => j.url },
    { id: 'notion.acrescentar', descricao: 'acrescenta texto ao fim de uma página, sem mexer no que já está lá. Quem acompanha a página pode receber aviso', risco: 'enviar',
      params: { pagina: { tipo: 'texto', obrigatorio: true, descricao: 'id ou link da página' }, texto: { tipo: 'texto', obrigatorio: true, descricao: 'o conteúdo; linha em branco separa parágrafos' } },
      resumo: (a) => `Acrescentar ao fim da página ${a.pagina} do Notion${tamanhoNoCartao(a.texto)}:\n${a.texto}`,
      // o cartão de confirmação diz o título da página: o agente só tem o id
      preparar: async (ctx, a) => ({ detalhe: `Página: ${neutral(tituloDe(await ctx.http(`/pages/${seg(idNotion(a.pagina, 'pagina'))}`, { method: 'GET', kind: 'read' })), 200)}` }),
      antes: async (_c, a) => ({ ...a, pagina: idNotion(a.pagina, 'pagina') }), metodo: 'PATCH', caminho: '/blocks/{pagina}/children',
      corpo: (a: Args) => ({ children: blocosDe(a.texto) }),
      texto: (j) => { const n = Array.isArray(j.results) ? j.results.length : 0; return `Conteúdo acrescentado: ${n} ${n === 1 ? 'parágrafo' : 'parágrafos'}.`; } },
  ],
};
