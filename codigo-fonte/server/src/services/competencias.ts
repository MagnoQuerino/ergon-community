/**
 * Adicionar uma competência pronta (rc.29): a pessoa envia um SKILL.md, uma pasta compactada (.zip) no formato de
 * competências da equipe de IA, ou cola o texto. Aqui o Ergon abre o pacote, confere os limites e acerta o cabeçalho
 * (nome e descrição); a varredura de segurança e a gravação na biblioteca da equipe são da ponte do motor
 * (loja/varrer e loja/enviar do plugin), e ligar nos agentes é o mesmo campo das competências da biblioteca.
 *
 * Formato (o do motor): uma pasta com SKILL.md na raiz — cabeçalho YAML entre "---" com name e description, depois o
 * texto em Markdown — e, se quiser, arquivos de apoio (references/, templates/, scripts/ …). Só arquivos de texto.
 */
import path from 'node:path';
import { HttpError, clip, fold } from '../lib/util.ts';
import { readZip } from '../lib/zip.ts';

export interface PacoteCompetencia {
  /** o nome da pasta e do cabeçalho (minúsculas, números e hífens) */
  nome: string;
  titulo: string;
  descricao: string;
  /** caminho relativo → texto; sempre tem SKILL.md */
  arquivos: Record<string, string>;
  /** o que ficou de fora do pacote (binário, oculto, grande demais) */
  ignorados: string[];
}

export const ENVIO_MAX_ARQUIVOS = 80;
export const ENVIO_MAX_ARQUIVO = 400 * 1024;
export const ENVIO_MAX_TOTAL = 800 * 1024;
/** o nome que o motor aceita para uma competência da biblioteca; "ergon-" é das aprendidas no Treinar */
export const NOME_COMPETENCIA = /^[a-z0-9][a-z0-9_.-]{0,80}$/;
const TEXTO = /\.(md|markdown|txt|json|ya?ml|csv|tsv|py|sh|bash|js|mjs|ts|html?|css|xml|toml|ini|cfg|sql|r|rb|ps1|tex|j2|jinja)$/i;

/** O nome da competência a partir de um texto qualquer (o nome do cabeçalho, o título ou o nome do arquivo). */
export function nomeDeCompetencia(s: string): string {
  const base = fold(s).replace(/\.(md|zip)$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').replace(/^ergon-+/, '');
  const cortado = base.length <= 60 ? base : (/^(.*)-/.exec(base.slice(0, 61))?.[1] ?? base.slice(0, 60));
  return cortado.replace(/-+$/g, '') || 'competencia';
}

const aspas = (v: string) => JSON.stringify(v); // JSON é YAML válido

/**
 * Separa o cabeçalho do texto. Lê só os campos simples (nome: valor numa linha), que é o que o Ergon precisa; o resto do
 * cabeçalho fica como está.
 */
function cabecalho(md: string): { linhas: string[] | null; corpo: string } {
  const s = md.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/.exec(s);
  return m ? { linhas: m[1].split('\n'), corpo: s.slice(m[0].length) } : { linhas: null, corpo: s };
}
const campo = (linhas: string[] | null, k: string): string => {
  const l = linhas?.find((x) => new RegExp(`^${k}\\s*:`).test(x));
  if (!l) return '';
  const v = l.replace(new RegExp(`^${k}\\s*:\\s*`), '').trim();
  if (!v || v === '|' || v === '>' || v === '|-' || v === '>-') {
    // valor em bloco (descrição em várias linhas): as linhas recuadas logo abaixo
    const i = linhas!.indexOf(l);
    const bloco: string[] = [];
    for (const x of linhas!.slice(i + 1)) { if (!/^\s+\S/.test(x)) break; bloco.push(x.trim()); }
    return bloco.join(' ');
  }
  try { return v.startsWith('"') ? String(JSON.parse(v)) : v.replace(/^'(.*)'$/, '$1'); } catch { return v.replace(/^"|"$/g, ''); }
};

/**
 * O SKILL.md com o cabeçalho certo: o nome é o da pasta (o motor acha a competência pela pasta e pelo nome), a descrição
 * existe (sem ela o motor não lista a competência). Sem cabeçalho, ele é criado a partir do título e do primeiro parágrafo.
 */
export function acertarCabecalho(md: string, sugestao: string): { texto: string; nome: string; titulo: string; descricao: string } {
  const { linhas, corpo } = cabecalho(md);
  const titulo = clip((/^#\s+(.+)$/m.exec(corpo)?.[1] ?? '').trim(), 120);
  const primeiro = corpo.split(/\n\s*\n/).map((p) => p.replace(/^#.*$/gm, '').trim()).find((p) => p.length > 0) ?? '';
  const nome = nomeDeCompetencia(campo(linhas, 'name') || titulo || sugestao);
  const descricao = clip((campo(linhas, 'description') || primeiro || titulo || nome).replace(/\s+/g, ' ').trim(), 300);
  // o resto do cabeçalho fica; name e description saem (com as linhas recuadas de um valor em bloco deles)
  const resto: string[] = [];
  let pulando = false;
  for (const l of linhas ?? []) {
    if (/^(name|description)\s*:/.test(l)) { pulando = true; continue; }
    if (pulando && /^\s+\S/.test(l)) continue;
    pulando = false;
    resto.push(l);
  }
  const head = [`name: ${aspas(nome)}`, `description: ${aspas(descricao)}`, ...resto].join('\n');
  return { texto: `---\n${head}\n---\n${corpo.replace(/^\n+/, '')}`, nome, titulo: titulo || nome, descricao };
}

const ehTexto = (b: Buffer) => !b.subarray(0, 8000).includes(0);

/** Um caminho relativo simples (sem subir de pasta, sem pasta oculta, sem barra invertida). */
const caminhoBom = (rel: string) => !!rel && rel.length <= 200 && !rel.startsWith('/') && !rel.includes('\\')
  && rel.split('/').every((p) => p && p !== '.' && p !== '..' && !p.startsWith('.'));

function montar(arquivos: Record<string, string>, ignorados: string[], sugestao: string): PacoteCompetencia {
  if (!arquivos['SKILL.md']?.trim()) throw new HttpError(400, 'sem_skill_md', 'Não achei o arquivo principal da competência (SKILL.md).');
  const c = acertarCabecalho(arquivos['SKILL.md'], sugestao);
  const out = { ...arquivos, 'SKILL.md': c.texto };
  const total = Object.values(out).reduce((n, t) => n + Buffer.byteLength(t), 0);
  if (total > ENVIO_MAX_TOTAL) throw new HttpError(413, 'grande', `A competência tem ${Math.round(total / 1024)} KB de texto; o limite é ${ENVIO_MAX_TOTAL / 1024} KB.`);
  return { nome: c.nome, titulo: c.titulo, descricao: c.descricao, arquivos: out, ignorados };
}

/** Do texto colado ou de um SKILL.md enviado sozinho. */
export function pacoteDeTexto(texto: string, nomeArquivo = ''): PacoteCompetencia {
  const t = texto.replace(/^﻿/, '');
  if (!t.trim()) throw new HttpError(400, 'vazio', 'Cole o texto da competência ou envie o arquivo SKILL.md.');
  if (Buffer.byteLength(t) > ENVIO_MAX_ARQUIVO) throw new HttpError(413, 'grande', `O texto passa de ${ENVIO_MAX_ARQUIVO / 1024} KB.`);
  const sugestao = /^skill\.md$/i.test(nomeArquivo) || !nomeArquivo ? 'competencia' : nomeArquivo;
  return montar({ 'SKILL.md': t }, [], sugestao);
}

/**
 * De uma pasta compactada: o SKILL.md mais perto da raiz manda (a pasta dele é a competência); com dois no mesmo nível,
 * a pessoa envia um de cada vez. Só arquivos de texto, dentro dos limites; o resto fica listado como ignorado.
 */
export function pacoteDeZip(buf: Buffer, nomeArquivo = ''): PacoteCompetencia {
  let entradas: ReturnType<typeof readZip>;
  try { entradas = readZip(buf); } catch { throw new HttpError(400, 'zip', 'Não consegui abrir o arquivo compactado.'); }
  const nomes = [...entradas.keys()].map((n) => n.replace(/\\/g, '/')).filter((n) => !n.startsWith('__MACOSX/'));
  const principais = nomes.filter((n) => /(^|\/)SKILL\.md$/i.test(n)).sort((a, b) => a.split('/').length - b.split('/').length);
  if (!principais.length) throw new HttpError(400, 'sem_skill_md', 'O arquivo compactado não tem um SKILL.md (o arquivo principal da competência).');
  const nivel = principais[0].split('/').length;
  if (principais.filter((n) => n.split('/').length === nivel).length > 1) throw new HttpError(400, 'varias', 'O arquivo compactado tem mais de uma competência no mesmo nível: envie uma de cada vez.');
  const raiz = principais[0].slice(0, -'SKILL.md'.length);
  const arquivos: Record<string, string> = {};
  const ignorados: string[] = [];
  for (const n of nomes) {
    if (!n.startsWith(raiz)) continue;
    const rel = n.slice(raiz.length);
    const e = entradas.get(n) ?? entradas.get(n.replace(/\//g, '\\'));
    if (!e) continue;
    const ehPrincipal = rel.toLowerCase() === 'skill.md';
    // outra competência dentro desta (subpasta com SKILL.md) também fica de fora
    if (!ehPrincipal && /(^|\/)SKILL\.md$/i.test(rel)) { ignorados.push(rel); continue; }
    if (!caminhoBom(rel) || (!ehPrincipal && !TEXTO.test(rel)) || e.size > ENVIO_MAX_ARQUIVO) { ignorados.push(rel); continue; }
    if (Object.keys(arquivos).length >= ENVIO_MAX_ARQUIVOS) { ignorados.push(rel); continue; }
    let dado: Buffer;
    try { dado = e.read(); } catch { ignorados.push(rel); continue; }
    if (!ehTexto(dado)) { ignorados.push(rel); continue; }
    arquivos[ehPrincipal ? 'SKILL.md' : rel] = dado.toString('utf8');
  }
  const pasta = raiz.replace(/\/$/, '').split('/').pop() || path.basename(nomeArquivo || 'competencia');
  return montar(arquivos, ignorados.slice(0, 40), pasta);
}

/** O que a tela manda: o texto (colado ou de um SKILL.md lido no navegador) ou o zip em base64. */
export function pacoteDoPedido(b: { texto?: string; zip?: string; nomeArquivo?: string }): PacoteCompetencia {
  if (b.zip) return pacoteDeZip(Buffer.from(b.zip, 'base64'), b.nomeArquivo ?? '');
  return pacoteDeTexto(b.texto ?? '', b.nomeArquivo ?? '');
}
