import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { NIVEL_MAX, indicadores, modoCidade, noMenuMais, pedeCreditos, proximoNivel } from './barra.ts';
import { abrirBalao, balaoAberto, fecharBalao } from './balao.ts';
import { PATHS } from './icones.ts';

const ler = (p: string) => fs.readFileSync(new URL(p, import.meta.url), 'utf8');
const css = ler('../styles.css');
const app = ler('../App.tsx');
const cidade = ler('../views/AmbienteView.tsx');
const barra = ler('../components/CityBar.tsx');

test('degraus da barra da Cidade: sobe um por vez enquanto não cabe, para no último', () => {
  assert.equal(proximoNivel(0, 600, 800), 0, 'cabe: fica com tudo escrito');
  assert.equal(proximoNivel(0, 801, 800), 1);
  assert.equal(proximoNivel(2, 800.4, 800), 2, 'meio pixel de arredondamento não conta');
  assert.equal(proximoNivel(NIVEL_MAX, 2000, 300), NIVEL_MAX, 'não passa do último degrau');
  // a barra encolhe a cada degrau (texto das ferramentas, indicadores compactos, menu "Mais", Localizar só ícone)
  const precisa = [900, 780, 640, 560, 470, 400];
  const ate = (largura: number) => { let n = 0; for (;;) { const p = proximoNivel(n, precisa[n], largura); if (p === n) return n; n = p; } };
  assert.equal(ate(1000), 0);
  assert.equal(ate(800), 1);
  assert.equal(ate(700), 2);
  assert.equal(ate(600), 3);
  assert.equal(ate(500), 4);
  assert.equal(ate(420), 5);
  assert.equal(ate(300), 5);
});

test('modo da cidade: um botão só, com ícone próprio (andando = viva, parado = calmo), nunca o do Modo Foco', () => {
  const viva = modoCidade(false); const calmo = modoCidade(true);
  assert.equal(viva.icon, 'walk'); assert.equal(viva.label, 'Cidade viva');
  assert.equal(calmo.icon, 'stand'); assert.equal(calmo.label, 'Modo calmo');
  for (const m of [viva, calmo]) {
    assert.notEqual(m.icon, 'focus');
    assert.ok(PATHS[m.icon], `o ícone ${m.icon} existe`);
    assert.match(m.title, new RegExp(m.label));
  }
  assert.notEqual(PATHS.walk, PATHS.stand);
  assert.notEqual(PATHS.walk, PATHS.focus);
  // traço no mesmo quadro de 24×24 dos outros ícones (coordenadas absolutas dentro da caixa)
  for (const nome of ['walk', 'stand']) {
    for (const m of PATHS[nome].matchAll(/[ML]\s*(-?[\d.]+)[ ,](-?[\d.]+)/g)) {
      const [x, y] = [Number(m[1]), Number(m[2])];
      assert.ok(x >= 0 && x <= 24 && y >= 0 && y <= 24, `${nome}: ${x},${y} fora do quadro`);
    }
  }
  assert.doesNotMatch(cidade, /name="focus"/, 'a Cidade não usa o ícone do Modo Foco');
  assert.match(barra, /modoCidade\(calm\)/);
});

test('indicadores: só o que existe; compacto = número; singular e plural', () => {
  const um = indicadores({ busy: 0, limit: 5, decisoes: 0, entregas: 0 });
  assert.deepEqual(um.map((i) => i.key), ['trabalho']);
  assert.equal(um[0].texto, '0 em andamento de 5');
  const sem = indicadores({ busy: 3, limit: null, decisoes: 1, entregas: 1 });
  assert.deepEqual(sem.map((i) => [i.key, i.texto, i.curto]), [['trabalho', '3 em andamento', '3'], ['voce', '1 precisa de você', '1'], ['entregas', '1 entrega', '1']]);
  const muitos = indicadores({ busy: 12, limit: 20, decisoes: 14, entregas: 37 });
  assert.deepEqual(muitos.map((i) => i.texto), ['12 em andamento de 20', '14 precisam de você', '37 entregas']);
  assert.equal(muitos.find((i) => i.key === 'voce')?.atencao, true);
});

test('barra geral: Modo Foco com ícone e texto (o texto nunca some) e a música sempre à vista, fora da Cidade', () => {
  assert.match(app, /className=\{`tb-pill topbar__focus[\s\S]{0,400}?>\s*<Icon name="focus" size=\{16\} \/><span className="topbar__focus-txt">Modo Foco<\/span>/);
  assert.match(app, /<MusicButton onCredits=/);
  assert.doesNotMatch(cidade, /MusicButton/, 'a música saiu da tela da Cidade');
  // nenhuma regra esconde o texto do Modo Foco, o próprio botão ou a música
  for (const sel of ['.topbar__focus-txt', '.topbar__focus', '.topbar__musicwrap']) {
    const esc = sel.replace(/[.]/g, '\\.');
    const regras = [...css.matchAll(new RegExp(`([^{}]*${esc}(?![\\w-])[^{}]*)\\{([^{}]*)\\}`, 'g'))];
    for (const [, s, corpo] of regras) assert.doesNotMatch(corpo, /display:\s*none|visibility:\s*hidden/, `${sel} escondido por "${s.trim()}"`);
  }
});

test('pílulas da barra da Cidade: uma altura, raio inteiro, ícone de 16 px', () => {
  const regra = css.match(/\.cb-pill \{([^}]*)\}/)?.[1] ?? '';
  assert.match(regra, /height: 34px/);
  assert.match(regra, /border-radius: 999px/);
  assert.match(css, /\.cb-pill > svg \{[^}]*width: 16px; height: 16px/);
  // nenhuma outra regra muda a altura ou o raio das pílulas
  for (const m of css.matchAll(/([^{}]*\.cb-pill[^{}]*)\{([^{}]*)\}/g)) {
    // só as regras da própria pílula (não as do ícone ou do texto dentro dela)
    const daPilula = m[1].split(',').some((x) => /\.cb-pill(?![\w-])[^\s>+~]*$/.test(x.trim()));
    if (!daPilula || m[1].trim() === '.cb-pill') continue;
    assert.doesNotMatch(m[2], /(?:^|;|\s)(height|border-radius|line-height)\s*:/, `"${m[1].trim()}" muda a forma da pílula`);
  }
  for (const m of barra.matchAll(/<Icon name=\{?[^ ]+ size=\{(\d+)\}/g)) if (!/check/.test(m[0])) assert.equal(m[1], '16');
});

/** especificidade (ids, classes/atributos/pseudo-classes, elementos) do último seletor composto */
const especificidade = (sel: string): [number, number, number] => {
  const s = sel.replace(/::[\w-]+/g, ' x');
  return [(s.match(/#[\w-]+/g) ?? []).length, (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g) ?? []).length, (s.match(/(?:^|[\s>+~])[a-z][\w-]*/gi) ?? []).length];
};
const vence = (a: [number, number, number], b: [number, number, number]) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

test('alternadores: o botão ligado vence o fundo transparente do grupo (Quadro/Lista legível no claro)', () => {
  const regras = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sels: m[1].replace(/\/\*[\s\S]*?\*\//g, '').split(',').map((x) => x.trim()), corpo: m[2] }));
  // toda regra "grupo button { background: … }" que zera o fundo dos botões de um grupo
  const zeram = regras.flatMap((r) => r.sels.filter((s) => /^\.[\w-]+ button$/.test(s) && /background\s*:/.test(r.corpo)).map((s) => s));
  assert.ok(zeram.includes('.seg button'));
  for (const base of zeram) {
    const grupo = base.split(' ')[0];
    // os "ligados" do mesmo grupo (o modificador --on do bloco, ou .is-on) com fundo próprio
    const ligados = regras.flatMap((r) => r.sels.filter((s) => !s.includes('data-theme') && (s.includes(`${grupo}__`) || s.startsWith(`${grupo} `)) && /--on|\.is-on/.test(s) && /background\s*:/.test(r.corpo)));
    for (const on of ligados) {
      // basta um seletor da mesma regra vencer o fundo do grupo
      const irmaos = regras.find((r) => r.sels.includes(on))!.sels;
      assert.ok(irmaos.some((s) => vence(especificidade(s), especificidade(base))), `"${irmaos.join(', ')}" perde para "${base}"`);
    }
  }
});

test('degrau 5 (janela bem estreita): só as entregas vão para o "Mais"; antes dele, nada sai', () => {
  const t = indicadores({ busy: 12, limit: 20, decisoes: 14, entregas: 37 });
  for (let n = 0; n < 5; n++) assert.deepEqual(noMenuMais(t, n), [t, []]);
  const [vis, menu] = noMenuMais(t, 5);
  assert.deepEqual(vis.map((x) => x.key), ['trabalho', 'voce'], 'o trabalho e o que precisa de você nunca saem');
  assert.deepEqual(menu.map((x) => x.key), ['entregas']);
  assert.match(barra, /noMenuMais\(track, nivel\)/);
  assert.match(barra, /items=\{doMenu\}/);
  // os degraus se somam: o Localizar só com o ícone vale do 4 em diante (no 5 o nome não pode voltar)
  for (let n = 4; n <= NIVEL_MAX; n++) assert.match(css, new RegExp(`\\.citybar--n${n} \\.picker__name[^{]*\\{ display: none; \\}`), `degrau ${n} mostra o nome do Localizar de novo`);
});

test('barra da Cidade: o nome no Localizar entra na assinatura dos degraus (voltar para a Cidade volta ao degrau certo)', () => {
  assert.match(barra, /const assinatura = `\$\{largura\}\|\$\{pickKey\}\|/);
  assert.match(cidade, /pickKey=\{structs\.find\(\(x\) => x\.id === card\)\?\.name \?\? 'Cidade'\}/);
});

test('barra da Cidade recolhida: preferência da pessoa (servidor), não do navegador', () => {
  assert.doesNotMatch(barra, /localStorage/, 'nada de chave fixa no navegador (na multiconta passaria de uma pessoa a outra)');
  assert.match(barra, /usePrefs\(\)\.cityBarCollapsed === true/);
  assert.match(barra, /savePrefs\(\{ cityBarCollapsed: v \}\)/);
});

test('balões da barra: um aberto por vez; fechar um não fecha o que abriu depois', () => {
  abrirBalao(null);
  abrirBalao('musica'); assert.equal(balaoAberto(), 'musica');
  abrirBalao('estado'); assert.equal(balaoAberto(), 'estado', 'abrir o Estado fecha a música');
  fecharBalao('musica'); assert.equal(balaoAberto(), 'estado', 'fechar a música (já fechada) não fecha o Estado');
  fecharBalao('estado'); assert.equal(balaoAberto(), null);
  // todos os balões da barra usam o mesmo armazém
  const comp = (p: string) => ler(`../components/${p}`);
  assert.match(app, /useBalao\('estado'\)/);
  assert.match(app, /useBalao\('decisoes'\)/);
  assert.match(comp('MusicButton.tsx'), /useBalao\('musica'\)/);
  assert.match(comp('Workspaces.tsx'), /useBalao\('workspace'\)/);
  assert.match(comp('AccountMenu.tsx'), /useBalao\('conta'\)/);
});

test('janela estreita: o Estado e o workspace saem da barra, mas o balão deles continua abrindo (pela gaveta)', () => {
  // esconder o contêiner esconderia também o balão que mora nele (o Estado ficava inalcançável no celular)
  for (const sel of ['.topbar__statuswrap', '.topbar__wswrap']) {
    const esc = sel.replace('.', '\\.');
    for (const m of css.matchAll(new RegExp(`(?:^|[\\s}])${esc}\\s*\\{([^{}]*)\\}`, 'g'))) assert.doesNotMatch(m[1], /display:\s*none/, `${sel} escondido (o balão some junto)`);
  }
  assert.match(css, /\.topbar__statuswrap \{ display: contents; \}/);
  assert.match(css, /\.topbar__statuswrap > \.tb-icon \{ display: none; \}/);
  assert.match(css, /\.topbar__wswrap \{ display: contents; \}/);
  assert.match(css, /\.topbar__ws \{ display: none; \}/);
  // a gaveta tem o que saiu: Estado, Workspace (abre o balão dele), Atualização disponível
  assert.match(app, /abrirBalao\('workspace'\)[\s\S]{0,200}Workspace: \{s\.workspace\.name\}/);
  assert.match(app, /\{upd && <button className="nav" onClick=\{\(\) => \{ setNavOpen\(false\); openUpdates\(\); \}\}>/);
  assert.match(app, /setStatusOpen\(true\); \}\}><Icon name="pulse" \/>/);
});

test('aviso de versão nova nos degraus da barra geral; nada encolhe até deformar', () => {
  assert.match(css, /@media \(max-width: 1000px\) \{ \.tb-upd__txt \{ display: none; \} \.tb-upd \{ width: 34px;/);
  assert.match(css, /\.tb-upd \{ display: none; \} \/\* Atualização disponível: na gaveta \*\//);
  assert.match(css, /\.tb-icon \{ position: relative; flex: none;/, 'os ícones da barra não encolhem');
  assert.match(css, /\.topbar__ask \{ flex: 0 1 auto; min-width: 120px;/, 'o "Pedir a…" encolhe só até um mínimo legível');
  assert.match(css, /\.topbar__grow \{ justify-content: flex-end; padding: 0; min-width: 34px; \}/, 'a lupa não fica por baixo do vizinho');
  assert.match(app, /className="tb-upd" onClick=\{openUpdates\} aria-label=/, 'só com o ícone, o aviso continua com nome');
});

test('faixa de Editar mapa no celular: a regra estreita vem depois da regra base (antes, nunca valia)', () => {
  const base = css.search(/\n\.editbar \{ position: absolute;/);
  const estreita = css.indexOf('@media (max-width: 900px) { .editbar { left: 12px; right: 12px; transform: none; max-width: none; flex-wrap: wrap; } }');
  assert.ok(base > 0 && estreita > base, 'a regra da janela estreita precisa vir depois da base');
  assert.equal((css.match(/\.editbar \{ left: 12px/g) ?? []).length, 1, 'sem a regra antiga, que perdia para a base');
});

test('créditos da música: o link leva a Configurações com o bloco aberto e à vista', () => {
  const mb = ler('../components/MusicButton.tsx');
  assert.match(app, /goHash\('#configuracao\?creditos'\)/);
  assert.match(mb, /id="creditos-musica"/);
  assert.match(mb, /el\.open = true;[\s\S]{0,200}el\.scrollIntoView/);
  // já em Configurações (o mesmo endereço): o link avisa de novo e o bloco confere outra vez depois que o balão fecha
  // (o foco que volta ao botão da música interrompe a rolagem suave começada no clique)
  assert.match(app, /window\.dispatchEvent\(new HashChangeEvent\('hashchange'\)\)/);
  assert.match(mb, /addEventListener\('hashchange', agora\)/);
  assert.match(mb, /t = window\.setTimeout\(ver, 400\)/);
  assert.equal(pedeCreditos('#configuracao?creditos'), true);
  assert.equal(pedeCreditos('#configuracao?atualizacoes&creditos'), true);
  assert.equal(pedeCreditos('#configuracao?creditosx'), false);
  assert.equal(pedeCreditos('#configuracao'), false);
  assert.doesNotMatch(mb, /\x08/, 'nada de caractere de controle perdido no código');
  assert.match(ler('../views/ConfiguracaoView.tsx'), /<MusicCreditsBlock \/>/);
});
