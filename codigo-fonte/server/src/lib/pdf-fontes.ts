/**
 * As fontes do PDF para o que não é latino (rc.44): chinês (Noto Sans SC) e hindi (Noto Sans Devanagari), embutidas em
 * server/assets/fontes (licença OFL, subconjuntos: ver OFL.txt). Antes, o pdfSafe() tirava do texto tudo o que não
 * fosse WinAnsi e um documento em chinês ou hindi saía em branco.
 *
 * Como: cada pedaço de texto vai na fonte da escrita dele — Helvetica/Times como sempre para o latino (com o pdfSafe),
 * a Noto do chinês ou do hindi quando o pedaço tem esses caracteres (elas também têm as letras latinas, os números e a
 * pontuação comum, e o pedaço sai inteiro numa fonte só). O PDFKit monta o devanágari pelo fontkit, que aplica as regras
 * de formação da fonte (GSUB/GPOS): conjuntos (क्ष, त्र, श्र, ज्ञ), o ि antes da consoante, o reph e os matras ficam
 * certos — conferido em test/idiomas-escritas.test.ts (o mapa do texto e os glifos). O resvg dos PNG não forma o
 * hindi direito: lá o devanágari vai em curvas (services/visuais/curvas.ts). Por isso não foi preciso
 * gerar o PDF em hindi pelo navegador nem pelo harfbuzz (web/src/i18n/COMO-TRADUZIR.md, "Chinês e hindi").
 *
 * As fontes só são lidas no primeiro PDF que precisa delas, uma vez, e o PDFKit embute só os glifos usados.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pdfSafe } from './pdf.ts';

const PASTA = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../assets/fontes');

export type Escrita = 'latina' | 'cjk' | 'deva';
/** ideogramas, kana, pontuação CJK e as formas de largura cheia */
export const CJK = /[⺀-⿟　-ヿ㄀-ㄯ㈀-㏿㐀-䶿一-鿿豈-﫿︰-﹏＀-￯]/u;
export const DEVA = /[ऀ-ॿ᳐-᳿꣠-ꣿ]/u;

/** A escrita de um texto: devanágari > chinês > latino (um pedaço misto vai na Noto, que tem as letras latinas). */
export const escritaDe = (s: string): Escrita => (DEVA.test(s) ? 'deva' : CJK.test(s) ? 'cjk' : 'latina');

const ARQUIVOS = { cjk: ['NotoSansSC-Regular.ttf', 'NotoSansSC-Bold.ttf'], deva: ['NotoSansDevanagari-Regular.ttf', 'NotoSansDevanagari-Bold.ttf'] } as const;
const lidas = new Map<string, Buffer | null>();
function ler(arquivo: string): Buffer | null {
  if (!lidas.has(arquivo)) { try { lidas.set(arquivo, fs.readFileSync(path.join(PASTA, arquivo))); } catch { lidas.set(arquivo, null); } }
  return lidas.get(arquivo) ?? null;
}

/** As fontes da escrita existem nesta instalação? (sem elas, o texto cai no pdfSafe, como antes) */
export const temFonte = (e: Exclude<Escrita, 'latina'>): boolean => ARQUIVOS[e].every((a) => ler(a) !== null);

const registradas = new WeakMap<object, Set<string>>();
/**
 * O nome da fonte no documento para a escrita e o peso (registra na primeira vez). Latino: a fonte padrão pedida.
 * Itálico não existe nas Noto daqui: vai o regular (o chinês e o hindi não usam itálico).
 */
export function fonteDa(doc: PDFKit.PDFDocument, e: Escrita, padrao: string, negrito: boolean): string {
  if (e === 'latina' || !temFonte(e)) return padrao;
  const nome = `ergon-${e}-${negrito ? 'b' : 'r'}`;
  let feitas = registradas.get(doc);
  if (!feitas) { feitas = new Set(); registradas.set(doc, feitas); }
  if (!feitas.has(nome)) { doc.registerFont(nome, ler(ARQUIVOS[e][negrito ? 1 : 0])!); feitas.add(nome); }
  return nome;
}

// o que nenhuma das fontes tem: emoji e símbolos pictográficos saem (o mesmo que o pdfSafe faz no latino)
const SEM_GLIFO = /[\p{Extended_Pictographic}\u{FE0F}\u{200B}]/gu;
const CONTROLE = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** O texto pronto para a fonte da escrita: latino pelo pdfSafe; chinês e hindi como vieram, sem emoji nem controle. */
export function textoDa(e: Escrita, s: string): string {
  if (e === 'latina' || !temFonte(e)) return pdfSafe(s);
  return s.replace(/\t/g, '    ').replace(CONTROLE, '').replace(SEM_GLIFO, '');
}

/** Texto para os metadados do PDF (título, autor): Unicode, sem controle (o PDFKit grava em UTF-16 quando precisa). */
export const metadado = (s: string): string => s.replace(CONTROLE, '').replace(SEM_GLIFO, '').trim();
