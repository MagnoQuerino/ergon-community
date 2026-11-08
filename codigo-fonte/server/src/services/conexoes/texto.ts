/**
 * Texto do que vem de fora, num só lugar: HTML vira texto em tempo linear (e-mail e mensagem são conteúdo hostil), a resposta
 * ao agente cabe no teto sem perder o rodapé, e o cartão de confirmação não deixa um nome de terceiro imitar outra linha.
 */
import crypto from 'node:crypto';
import { xmlText } from '../doc-text.ts';

const MAX_HTML = 2_000_000;
const ENTIDADES: Record<string, string> = {
  nbsp: ' ', aacute: 'á', agrave: 'à', acirc: 'â', atilde: 'ã', eacute: 'é', ecirc: 'ê', iacute: 'í', oacute: 'ó', ocirc: 'ô', otilde: 'õ', uacute: 'ú', uuml: 'ü', ccedil: 'ç',
  Aacute: 'Á', Agrave: 'À', Acirc: 'Â', Atilde: 'Ã', Eacute: 'É', Ecirc: 'Ê', Iacute: 'Í', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Uacute: 'Ú', Uuml: 'Ü', Ccedil: 'Ç',
  ordf: 'ª', ordm: 'º', mdash: '—', ndash: '–', hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', bull: '•', laquo: '«', raquo: '»', euro: '€', copy: '©', reg: '®', trade: '™',
};
const SEM_TEXTO = new Set(['head', 'style', 'script', 'title', 'noscript', 'template']);
const QUEBRA = new Set(['br', 'p', 'div', 'tr', 'li', 'table', 'ul', 'ol', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']);

/**
 * Texto de um HTML, numa passada só (linear): uma expressão regular com `[\s\S]*?` ou `<[^>]+>` levaria tempo quadrático com
 * "<!--<!--<!--…" e travaria o servidor. A marca `<attachment>` das mensagens do Teams vira "[anexo]", para o texto não sumir calado.
 */
export function htmlParaTexto(html: string): string {
  const h = html.slice(0, MAX_HTML);
  let out = ''; let i = 0;
  while (i < h.length) {
    const lt = h.indexOf('<', i);
    if (lt < 0) { out += h.slice(i); break; }
    out += h.slice(i, lt);
    if (h.startsWith('<!--', lt)) {
      const f = h.indexOf('-->', lt + 4);
      if (f < 0) break;
      i = f + 3;
      continue;
    }
    const inicio = /^<(\/?)([a-z][a-z0-9]*)|^<[!?]/i.exec(h.slice(lt, lt + 24));
    if (!inicio) { out += '<'; i = lt + 1; continue; } // "a < b": é texto
    const gt = h.indexOf('>', lt + 1);
    if (gt < 0) break;
    const nome = (inicio[2] ?? '').toLowerCase();
    i = gt + 1;
    if (!inicio[1] && SEM_TEXTO.has(nome)) {
      const re = new RegExp(`</${nome}`, 'gi');
      re.lastIndex = gt;
      const f = re.exec(h);
      const fim = f ? h.indexOf('>', f.index) : -1;
      if (fim < 0) break;
      i = fim + 1;
      continue;
    }
    if (nome === 'attachment' && !inicio[1]) out += ' [anexo] ';
    else if (nome === 'li' && !inicio[1]) out += '\n- ';
    else if (QUEBRA.has(nome)) out += '\n';
    else out += ' ';
  }
  return xmlText(out.replace(/&([a-z]+);/gi, (m, e: string) => ENTIDADES[e] ?? m)).replace(/[^\S\n]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** A resposta ao agente tem teto (servico.ts, 30 mil caracteres): corta por linha, diz o que não coube, e o cursor do rodapé não se perde. */
export function caber(linhas: string[], teto = 25_000): { linhas: string[]; nota: string } {
  const fica: string[] = []; let n = 0;
  for (const l of linhas) { if (n + l.length + 1 > teto && fica.length) break; fica.push(l); n += l.length + 1; }
  const sobra = linhas.length - fica.length;
  return { linhas: fica, nota: sobra ? `\n(${sobra} desta página não couberam na resposta: repita com "limite" menor para vê-los.)` : '' };
}

/** Sem caractere de controle, de formatação (inverte a ordem do texto, some da tela) e separador de linha: um nome de terceiro fica na linha dele. */
export const semControle = (v: unknown): string => String(v ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ');

/** Impressão do que a pessoa viu no cartão: muda se o conteúdo mudar antes do clique. */
export const marcaDe = (x: unknown): string => crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
