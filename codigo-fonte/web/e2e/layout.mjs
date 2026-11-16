// Conferência de layout no navegador (rc.33): numa janela de 1920 × 1080, nenhum cartão de nenhuma tela passa de 1,5× a
// altura da janela, nenhum texto corrido passa de ~80 caracteres por linha e a página não rola para o lado.
// Precisa do Playwright (fora das dependências do projeto) e do Ergon rodando:
//   ERGON_URL=http://localhost:8787 ERGON_USUARIO=... ERGON_SENHA=... node web/e2e/layout.mjs
// Sem o Playwright instalado, avisa e sai sem falhar (os testes estáticos em web/src/lib/layout.test.ts valem sempre).
const URL_BASE = process.env.ERGON_URL ?? 'http://localhost:8787';
const LARGURA = Number(process.env.LARGURA ?? 1920); const ALTURA = Number(process.env.ALTURA ?? 1080);
const LIMITE = 1.5; const TEXTO_MAX = 84; // 80ch, com folga para a medida do "0"
const TELAS = ['ambiente', 'equipe', 'agentes', 'rotinas', 'tarefas', 'documentos', 'atividade', 'conexoes', 'loja', 'world', 'governanca', 'ajuda', 'configuracao'];

let chromium;
try { ({ chromium } = await import(process.env.PLAYWRIGHT ?? 'playwright')); } catch {
  console.log('Playwright não encontrado: instale-o (npm i -g playwright) ou aponte PLAYWRIGHT para ele. Nada conferido.');
  process.exit(0);
}
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: LARGURA, height: ALTURA }, locale: 'pt-BR', reducedMotion: 'reduce' });
await page.goto(URL_BASE + '/'); await page.waitForTimeout(1500);
if (await page.locator('input[type=password]').count()) {
  const u = page.locator('input[autocomplete=username], input[name=username]');
  if (await u.count() && process.env.ERGON_USUARIO) await u.first().fill(process.env.ERGON_USUARIO);
  await page.locator('input[type=password]').first().fill(process.env.ERGON_SENHA ?? '');
  await page.keyboard.press('Enter'); await page.waitForTimeout(2500);
}
const falhas = [];
for (const tela of TELAS) {
  await page.goto(`${URL_BASE}/#${tela}`); await page.waitForTimeout(1800);
  const r = await page.evaluate(({ limite, textoMax }) => {
    const vh = innerHeight; const out = [];
    const main = document.querySelector('.main') ?? document.body;
    for (const el of main.querySelectorAll('.card, article, .dec-card')) {
      const b = el.getBoundingClientRect();
      if (b.height > limite * vh && !el.closest('.drawer')) out.push(`cartão ${el.className} com ${Math.round(b.height)} px de altura (limite ${Math.round(limite * vh)})`);
    }
    const cv = document.createElement('canvas').getContext('2d');
    for (const el of main.querySelectorAll('p, li:not([class]), dd')) {
      const b = el.getBoundingClientRect(); if (b.height < 30) continue;
      const cs = getComputedStyle(el); cv.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const ch = (b.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight)) / cv.measureText('0').width;
      if (ch > textoMax) out.push(`texto com ${Math.round(ch)} caracteres por linha: "${el.textContent.trim().slice(0, 40)}"`);
    }
    if (document.documentElement.scrollWidth > innerWidth + 1) out.push('a página rola para o lado');
    return out;
  }, { limite: LIMITE, textoMax: TEXTO_MAX });
  for (const x of r) falhas.push(`#${tela}: ${x}`);
  console.log(`${r.length ? 'falhou' : 'ok'} #${tela}`);
}
await browser.close();
if (falhas.length) { console.error(falhas.join('\n')); process.exit(1); }
console.log(`layout ok em ${LARGURA} × ${ALTURA}`);
