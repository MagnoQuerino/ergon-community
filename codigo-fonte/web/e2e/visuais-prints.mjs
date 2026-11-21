// Prints dos blocos visuais (rc.42), a partir da galeria de desenvolvimento (web/visuais.html no vite):
//   cd web && npx vite --port 5199 &        # a galeria
//   GALERIA_URL=http://localhost:5199 PLAYWRIGHT=/caminho/do/playwright SAIDA=/tmp/visuais node e2e/visuais-prints.mjs
// Cada cena em 1440 e 390 px, tema claro e escuro, deviceScaleFactor 1. As imagens de fora (a foto da ficha, a capa do
// link, a galeria) são desenhos de exemplo servidos pela própria conferência; o PNG do Discord é o do servidor
// (server/src/services/visuais/png.ts), o mesmo que o canal recebe. Sem o Playwright, avisa e sai sem falhar.
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.GALERIA_URL ?? 'http://localhost:5199';
const SAIDA = process.env.SAIDA ?? '/tmp/visuais';
const PNGS = process.env.SAIDA_PNG ?? path.join(SAIDA, '..', 'png');
fs.mkdirSync(SAIDA, { recursive: true }); fs.mkdirSync(PNGS, { recursive: true });

let chromium;
try { const pw = await import(process.env.PLAYWRIGHT ?? 'playwright'); chromium = pw.chromium ?? pw.default?.chromium; if (!chromium) throw new Error('sem chromium'); } catch {
  console.log('Playwright não encontrado: aponte PLAYWRIGHT para ele. Nada gerado.');
  process.exit(0);
}

// o PNG que o Discord e o Telegram recebem (gerado pelo servidor) e os desenhos de exemplo das imagens de fora
const { visualParaPng, svgParaPng } = await import('../../server/src/services/visuais/png.ts');
const { EXEMPLOS } = await import('../../shared/visuais/exemplos.ts');
const servidor = {};
for (const t of ['barras', 'kpi']) servidor[t] = (await visualParaPng(EXEMPLOS[t])).png;
fs.writeFileSync(path.join(PNGS, 'servidor-discord-barras.png'), servidor.barras);
const desenho = async (svg) => svgParaPng(svg, 1);
const foto = (fundo, conteudo) => `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fundo[0]}"/><stop offset="1" stop-color="${fundo[1]}"/></linearGradient></defs><rect width="640" height="480" fill="url(#g)"/>${conteudo}</svg>`;
const IMAGENS = {
  'jb-platinum': await desenho(foto(['#f7f7f5', '#e4e4e0'], '<rect x="170" y="200" width="300" height="170" rx="40" fill="#22252a"/><rect x="200" y="225" width="120" height="120" rx="20" fill="#3a3f47"/><text x="215" y="300" font-family="Inter" font-size="30" font-weight="700" fill="#d9dde3">PLATINUM</text><rect x="420" y="150" width="34" height="80" rx="8" fill="#b9bec6"/><circle cx="437" cy="140" r="26" fill="#c9a227"/><rect x="250" y="150" width="140" height="56" rx="16" fill="#8f949b"/><rect x="180" y="370" width="280" height="22" rx="8" fill="#15171a"/>')),
  'vistoria-1': await desenho(foto(['#9cc3e6', '#dfe9f2'], '<rect x="80" y="180" width="480" height="260" fill="#c9bca4"/><polygon points="60,190 320,80 580,190" fill="#8a4a12"/><rect x="270" y="300" width="100" height="140" fill="#5f5b52"/><rect x="120" y="240" width="90" height="70" fill="#e8eef7"/><rect x="430" y="240" width="90" height="70" fill="#e8eef7"/>')),
  'vistoria-2': await desenho(foto(['#7c8794', '#b9c2cc'], '<polygon points="0,300 320,140 640,300 640,480 0,480" fill="#6d4c3d"/><path d="M200 260 C260 300 300 280 360 330 C400 360 420 420 430 480" stroke="#3b2a20" stroke-width="14" fill="none"/><ellipse cx="380" cy="380" rx="70" ry="30" fill="#4b6f8f" opacity=".7"/>')),
  'vistoria-3': await desenho(foto(['#d5cfc2', '#f4f1ea'], '<rect x="190" y="70" width="260" height="340" rx="10" fill="#e9e6df" stroke="#9a948a" stroke-width="6"/><rect x="220" y="110" width="200" height="30" fill="#2b313b"/>' + Array.from({ length: 8 }, (_, i) => `<rect x="${230 + (i % 4) * 48}" y="${170 + Math.floor(i / 4) * 90}" width="30" height="60" rx="4" fill="${i === 5 ? '#b23a26' : '#1f5b6b'}"/>`).join(''))),
  'capa-calendario': await desenho(foto(['#1D184B', '#2a2566'], '<rect x="200" y="110" width="240" height="250" rx="22" fill="#fffdf8"/><rect x="200" y="110" width="240" height="64" rx="22" fill="#1F5B6B"/><text x="320" y="158" font-family="Inter" font-size="34" font-weight="700" fill="#fff" text-anchor="middle">DEZ</text><text x="320" y="300" font-family="Inter" font-size="110" font-weight="700" fill="#1d2a33" text-anchor="middle">20</text>')),
};

const browser = await chromium.launch();
const CENAS = ['galeria', 'hipatia', 'aspasia', 'sala', 'relatorio', 'discord'];
const LARGURAS = [1440, 390];
const TEMAS = ['claro', 'escuro'];
let n = 0;
for (const largura of LARGURAS) {
  for (const tema of TEMAS) {
    const ctx = await browser.newContext({ viewport: { width: largura, height: largura > 500 ? 900 : 844 }, deviceScaleFactor: 1, locale: 'pt-BR', acceptDownloads: true });
    await ctx.route('**/api/visuais/imagem?**', (r) => {
      const u = decodeURIComponent(new URL(r.request().url()).searchParams.get('url') ?? '');
      const nome = Object.keys(IMAGENS).find((k) => u.includes(k));
      return nome ? r.fulfill({ status: 200, contentType: 'image/png', body: IMAGENS[nome] }) : r.fulfill({ status: 404 });
    });
    await ctx.route('**/__png/*.png', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: servidor[path.basename(new URL(r.request().url()).pathname, '.png')] }));
    const page = await ctx.newPage();
    for (const cena of CENAS) {
      const extra = cena === 'sala' ? ['', '&votado=1'] : [''];
      for (const x of extra) {
        await page.goto(`${BASE}/visuais.html?cena=${cena}&tema=${tema}${x}`);
        await page.waitForTimeout(cena === 'galeria' ? 2600 : 2000);
        if (cena === 'relatorio') {
          await page.locator('button:has-text("Abrir relatório")').last().click();
          await page.waitForTimeout(1500);
        }
        const nome = `${cena}${x ? '-decidida' : ''}-${largura}-${tema}.png`;
        await page.screenshot({ path: path.join(SAIDA, nome), fullPage: cena !== 'relatorio' });
        n++;
      }
    }
    // dois PNGs baixados pelo botão do bloco (no tema da tela)
    if (largura === 1440) {
      await page.goto(`${BASE}/visuais.html?cena=galeria&tema=${tema}`);
      await page.waitForTimeout(2000);
      for (const tipo of tema === 'claro' ? ['barras', 'icones'] : ['medidor', 'versus']) {
        const bloco = page.locator(`.gv__item[data-tipo="${tipo}"] .vis`).first();
        await bloco.hover();
        const [down] = await Promise.all([page.waitForEvent('download'), bloco.locator('.vis__baixar').click()]);
        await down.saveAs(path.join(PNGS, `baixado-${tipo}-${tema}.png`));
      }
    }
    await ctx.close();
  }
}
await browser.close();
console.log(`${n} prints em ${SAIDA}; PNGs em ${PNGS}`);
