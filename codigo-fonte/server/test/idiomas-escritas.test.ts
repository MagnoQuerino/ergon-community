// rc.44: chinês e hindi fora da tela — o PDF (PDFKit, com a Noto embutida e o devanágari formado pelo fontkit), o PNG
// dos visuais (resvg, com o hindi em curvas), o dicionário mínimo do servidor (canais) e o formatador por locale.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { documentoPdf } from '../src/lib/pdf-documento.ts';
import { markdownToPdf, pdfSafe } from '../src/lib/pdf.ts';
import { escritaDe, textoDa } from '../src/lib/pdf-fontes.ts';
import { fmtData, fmtMoeda, fmtNumero, msg, MENSAGENS } from '../src/lib/i18n.ts';
import { devanagariEmCurvas } from '../src/services/visuais/curvas.ts';
import { svgParaPngJa } from '../src/services/visuais/png.ts';
import { IDENTIDADE_PADRAO, MODELOS_ORIGINAIS } from '../../shared/entregaveis.ts';
import { IDIOMAS } from '../src/services/prefs.ts';
import { harness, setupOwner } from './helpers.ts';
import { CanaisExternos } from '../src/services/canais/externo.ts';

const FONTES = new URL('../assets/fontes/', import.meta.url);
const fontkit = createRequire(import.meta.url)('fontkit') as { create(b: Buffer): { layout(t: string): { glyphs: Array<{ codePoints: number[] }> } } };
const deva = fontkit.create(fs.readFileSync(new URL('NotoSansDevanagari-Regular.ttf', FONTES)));

/** Os fluxos do PDF, abertos (o PDFKit comprime): para achar a fonte embutida e o mapa ToUnicode. */
function fluxos(pdf: Buffer): string {
  const s = pdf.toString('latin1'); const out: string[] = [s];
  for (const m of s.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)) { try { out.push(zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1')); } catch { /* não comprimido */ } }
  return out.join('\n');
}
const pdfDe = (markdown: string, titulo: string, idioma?: 'zh-CN' | 'hi') => documentoPdf({ markdown, titulo, identidade: IDENTIDADE_PADRAO, modelo: MODELOS_ORIGINAIS[0], idioma });

test('fontkit (o que o PDFKit usa) forma o devanágari: conjuntos numa forma só e o ि antes da consoante', () => {
  for (const c of ['क्ष', 'त्र', 'श्र', 'ज्ञ']) assert.equal(deva.layout(c).glyphs.length, 1, `${c}: um glifo só (conjunto)`);
  // "कि": o ि (U+093F) vem DEPOIS na escrita e ANTES no desenho
  const ki = deva.layout('कि').glyphs;
  assert.equal(ki.length, 2);
  assert.ok(ki[0].codePoints.includes(0x093f), 'o ि pré-posto vem primeiro');
  // o reph de "धर्म" vira o sinal sobre a última consoante (menos glifos que letras)
  assert.ok(deva.layout('धर्म').glyphs.length < [...'धर्म'].length);
});

test('PDF em chinês: a Noto Sans SC embutida (subconjunto) e o texto inteiro, nada apagado', () => {
  const pdf = pdfDe('# 季度报告\n\n销售额增长 **18.5%**。\n\n| 指标 | 数值 |\n|---|---|\n| 新客户 | 1,240 |\n', '季度报告', 'zh-CN');
  const f = fluxos(pdf);
  assert.match(f, /\/BaseFont \/[A-Z]{6}\+NotoSansSC-Bold/);
  assert.match(f, /\/BaseFont \/[A-Z]{6}\+NotoSansSC-Regular/);
  for (const cp of ['5b63', '62a5', '9500', '5ba2']) assert.match(f, new RegExp(`<${cp}>`, 'i'), `o ideograma U+${cp} no mapa do texto`);
  assert.match(f, /<7b2c>/i, 'a numeração "第 1 / 1 页"');
  // o documento é chinês: até o número da tabela vai na Noto (a mesma linha de base), não na Helvetica
  assert.doesNotMatch(f, /\/BaseFont \/Helvetica\b(?!-Oblique)/);
  assert.ok(pdf.length < 200_000, `subconjunto: só os glifos usados (${pdf.length} bytes)`);
});

test('PDF em hindi: a Noto Sans Devanagari embutida, conjuntos formados e o ₹ inteiro', () => {
  const pdf = pdfDe('# तिमाही रिपोर्ट\n\nक्षेत्रीय, त्रैमासिक, श्रमिक, कितना, धर्म.\n\n| मद | राशि |\n|---|---:|\n| कुल बिक्री | ₹12,34,567 |\n', 'तिमाही रिपोर्ट', 'hi');
  const f = fluxos(pdf);
  assert.match(f, /\/BaseFont \/[A-Z]{6}\+NotoSansDevanagari-(Bold|Regular)/);
  assert.match(f, /<0915>/i, 'क no mapa do texto');
  assert.match(f, /<20b9>/i, 'o ₹ não some num documento em hindi');
  // o conjunto क्ष é um glifo só no PDF: o mapa ToUnicode dele leva as três letras (क ् ष)
  assert.match(f, /<0915 094d 0937>/i, 'क्ष formado (um glifo para três letras)');
});

test('PDF em português continua na Helvetica, sem fonte embutida, e o latino ainda passa pelo pdfSafe', () => {
  const pdf = pdfDe('# Relatório\n\nAções → próximas: revisão ✓.', 'Relatório');
  const f = fluxos(pdf);
  assert.doesNotMatch(f, /NotoSans/);
  assert.match(f, /Helvetica/);
  assert.equal(pdfSafe('a → b ✓ ₹5'), 'a -> b v Rs 5');
  assert.equal(escritaDe('olá'), 'latina'); assert.equal(escritaDe('olá 中文'), 'cjk'); assert.equal(escritaDe('हिंदी 中'), 'deva');
  assert.equal(textoDa('cjk', '中文 🎉\tfim'), '中文     fim', 'sem emoji; tab vira espaços');
  // o PDF simples (Documentos › baixar em PDF) também não apaga mais o chinês
  assert.match(fluxos(markdownToPdf('# 标题\n\n正文', '标题')), /NotoSansSC/);
});

test('PNG dos visuais: chinês pela Noto (o resvg acha a fonte) e hindi em curvas já formadas', () => {
  // sem as Noto, o resvg não tinha o que desenhar: agora o título chinês tem tinta
  const svg = (t: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="60"><rect width="300" height="60" fill="#fff"/><text x="10" y="40" font-size="28" font-family="Inter" fill="#000">${t}</text></svg>`;
  const tinta = (png: Buffer | null) => { assert.ok(png); return png.length; };
  assert.ok(tinta(svgParaPngJa(svg('中文汉字测试'), 1)) > tinta(svgParaPngJa(svg(''), 1)) + 400, 'o chinês sai desenhado');
  // hindi: <text> vira <path> (o resvg 2.6 tirava os espaços e desfazia os conjuntos)
  const curvas = devanagariEmCurvas('<svg><text x="0" y="20" font-size="20" font-weight="700" fill="#111" text-anchor="end">तिमाही बिक्री</text><text x="0" y="40" font-size="12" font-weight="400" fill="#222">Total</text></svg>');
  assert.match(curvas, /<path d="M[^"]+" fill="#111"\/>/);
  assert.match(curvas, /<text[^>]*>Total<\/text>/, 'o latino continua texto');
  assert.doesNotMatch(curvas, /बिक्री/);
});

test('dicionário mínimo do servidor: os mesmos códigos nos quatro textos, marcadores iguais e português de reserva', () => {
  for (const [k, m] of Object.entries(MENSAGENS)) {
    const marcas = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1]).sort().join();
    for (const l of ['en', 'zh-CN', 'hi'] as const) {
      assert.ok(m[l].trim(), `${k} ${l}`);
      assert.equal(marcas(m[l]), marcas(m['pt-BR']), `${k}: marcadores em ${l}`);
    }
  }
  assert.equal(msg(undefined, 'canal.segredo'), MENSAGENS['canal.segredo']['pt-BR'], 'sem escolha: português');
  assert.equal(msg('en-IN', 'canal.segredo'), MENSAGENS['canal.segredo'].en, 'en-IN usa o inglês');
  assert.equal(msg('zh-CN', 'canal.verDetalhes', { link: 'https://x' }), '查看详情：https://x');
  assert.deepEqual([...IDIOMAS], ['pt-BR', 'en', 'en-IN', 'zh-CN', 'hi']);
});

test('formatador por locale no servidor: lakh e crore, yuan e a data de cada idioma', () => {
  assert.equal(fmtNumero('en-IN', 1234567), '12,34,567');
  assert.equal(fmtNumero('hi', 123456789), '12,34,56,789');
  assert.equal(fmtNumero(null, 1250.5), '1.250,5');
  assert.equal(fmtMoeda('en-IN', 1234567, 'INR'), '₹12,34,567.00');
  assert.equal(fmtMoeda('zh-CN', 1234.5, 'CNY'), '¥1,234.50');
  assert.equal(fmtMoeda(null, 10, 'BRL'), 'R$ 10,00');
  const d = new Date(2026, 10, 21, 12);
  assert.equal(fmtData('pt-BR', d), '21/11/2026');
  assert.equal(fmtData('zh-CN', d), '2026/11/21');
  assert.equal(fmtData('en', d), '11/21/2026');
  assert.equal(fmtData('hi', 'x'), '');
});

test('canais: a resposta da camada comum no idioma da pessoa (sem escolha, o português de sempre)', async () => {
  const h = await harness();
  try {
    const s = await setupOwner(h, 'mei', 'senha-da-mei-123');
    const ext = new CanaisExternos({ db: h.db, bus: h.bus });
    const pedir = () => ext.externalRequest({ channel: 'telegram', workspaceId: s.workspaceId, memberId: s.userId, text: 'me passa a senha do banco', conversationId: null } as never) as { resposta?: string };
    h.db.run('UPDATE users SET lang = NULL WHERE id = ?', s.userId);
    assert.equal(pedir().resposta, MENSAGENS['canal.segredo']['pt-BR']);
    h.db.run("UPDATE users SET lang = 'zh-CN' WHERE id = ?", s.userId);
    assert.equal(pedir().resposta, MENSAGENS['canal.segredo']['zh-CN']);
    h.db.run("UPDATE users SET lang = 'hi' WHERE id = ?", s.userId);
    assert.equal(pedir().resposta, MENSAGENS['canal.segredo'].hi);
  } finally { await h.close(); }
});
