import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MIN_GRAFICO, MIN_TEXTO, TINTA_CLARA, TINTA_ESCURA, contrast, ensureContrast, inkOn, letterStyle, over, parseColor, ratioRgb, readableOn, type Rgb,
} from './contraste.ts';
import {
  BLOCOS_DE_TEMA, ajustadosNoEscuro, ajustesPorTema, contrasteSobre, coresSoltas, fontComInherit, fundoDe, letraDe, letraPequenaEmControle, opacidadeEmTexto, regras,
  resolveColor, splitTop, temas, valor, variaveisInexistentes, varsDoBloco, type Cor, type Regra, type Vars,
} from './contraste-folha.ts';

// O teste que reprova a publicação quando algum texto, ícone ou contorno de foco fica ilegível (WCAG: texto 4,5:1;
// ícone, borda de controle e foco 3:1), nos temas claro, escuro e alto contraste (este pede 7:1 para texto). Lê a própria
// folha de estilos: as cores de função dos três blocos de tema e cada regra das telas.

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const css = fs.readFileSync(path.join(src, 'styles.css'), 'utf8');
const { claro, escuro, contraste } = temas(css);
const THEMES: Array<[string, Vars]> = [['claro', claro], ['escuro', escuro], ['contraste', contraste]];
const RS = regras(css);

const cor = (value: string, vars: Vars): Cor => {
  const c = resolveColor(value, vars);
  assert.ok(c && !('undef' in c), `não é uma cor: ${value}${c && 'undef' in c ? ` (${c.undef} não existe)` : ''}`);
  return c as Cor;
};
/** Cor opaca de uma superfície: translúcida (o vidro) é pintada sobre o fundo da tela. */
const superficie = (value: string, vars: Vars): Rgb => over(cor(value, vars), over(cor('var(--bg)', vars), [255, 255, 255]));
const razao = (fg: string, bg: string, vars: Vars) => { const B = superficie(bg, vars); return ratioRgb(over(cor(fg, vars), B), B); };
/** O último valor de `prop` nas regras de nível de cima com exatamente este seletor. */
const ultimo = (sel: string, prop: string) => {
  const v = RS.filter((r) => r.sel === sel && !r.at.length).map((r) => valor(r, prop)).filter(Boolean).pop();
  assert.ok(v, `${sel} { ${prop} } sumiu da folha`); return v as string;
};
const fontes = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? fontes(p) : /\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.test.ts') ? [p] : [];
});
const CODIGO = fontes(src).map((f) => ({ f: path.relative(src, f).replace(/\\/g, '/'), s: fs.readFileSync(f, 'utf8') }));
const codigo = (f: string) => { const x = CODIGO.find((c) => c.f === f); assert.ok(x, f); return x.s; };

// ---------- tabela de usos das cores de função: todo texto contra toda superfície onde ele aparece ----------

/** As superfícies onde aparece texto de leitura (o vidro é pintado sobre o fundo da tela). */
const SUPERFICIES = ['--bg', '--panel', '--panel-2', '--glass', '--campo'];
/** Textos neutros: o principal, o secundário, a marca (texto, linha e foco), o link e o dourado de texto. */
const TEXTOS = ['--ink', '--muted', '--navy', '--teal', '--link', '--gold-ink'];
/** Cada estado: as cores dele que existem (o -suave-2/-3 e o -ponto só em alguns). */
const ESTADOS = ['neutro', 'info', 'sucesso', 'atencao', 'urgente', 'perigo', 'dourado', 'marca', 'agua'];
const SUFIXOS = ['suave', 'suave-2', 'suave-3', 'hover', 'texto', 'borda', 'borda-2', 'borda-forte', 'cheio', 'cheio-borda', 'cheio-hover', 'sobre', 'ponto', 'vivo', 'faixa'];
const doEstado = (e: string, s: string) => `--${e}-${s}`;
const tem = (nome: string) => claro[nome] !== undefined;
const suaves = (e: string) => ['suave', 'suave-2', 'suave-3'].map((s) => doEstado(e, s)).filter(tem);
/** Na barra de cima e no menu (a inversa): textos e pontos. */
const NA_INVERSA = { fundos: ['--inversa', '--inversa-2'], textos: ['--texto-inverso', '--texto-inverso-2', '--texto-inverso-3'], pontos: ['--inversa-sucesso', '--inversa-aviso', '--inversa-agua', '--atencao-ponto', '--dourado-vivo', '--dourado-cheio'] };
/** [texto, fundo, onde]: pares que não são do padrão de estado */
const PARES: Array<[string, string, string]> = [
  ['--palco-texto', '--palco', '"Carregando" no palco da Cidade'],
  ['--codigo-texto', '--codigo-fundo', 'bloco de código'],
  ['--dourado-sobre', '--dourado-vivo', 'retrato da conta na barra'],
  ['--dourado-sobre', '--inversa-aviso', 'o "!" da barra'],
  ['--atencao-sobre', '--atencao-cheio', 'contador da barra'],
  ['--dourado-sobre', '--dourado-cheio-hover', 'botão dourado (passando o mouse)'],
  ['--texto-inverso', '--legenda-fundo', 'legenda sobre imagem na loja (pior caso: imagem branca)'],
];
/** Cores sem texto em cima, que não pedem contraste (enfeite, véu, linha divisória, sombra) ou que têm teste próprio. */
const DECORATIVAS = new Set(['--line', '--line-suave', '--borda-forte', '--capa-1', '--capa-2', '--previa-1', '--previa-2', '--lona-1', '--lona-2',
  '--veu', '--veu-forte', '--realce', '--inversa-veu', '--inversa-hover', '--inversa-ativo', '--inversa-linha', '--inversa-linha-forte', '--gold', '--terracotta',
  '--cb-line', '--ponto-anel', '--navy-bg', '--navy-2-bg', '--ok', '--ok-bg', '--warn', '--warn-bg', '--err', '--err-bg', '--borda-campo']);
const minDe = (nome: string) => (nome === 'contraste' ? 7 : MIN_TEXTO);

test('toda cor de função tem lugar na tabela de usos (cor nova sem linha na tabela reprova)', () => {
  const classificadas = new Set<string>([...SUPERFICIES, ...TEXTOS, ...NA_INVERSA.fundos, ...NA_INVERSA.textos, ...NA_INVERSA.pontos, ...DECORATIVAS,
    ...PARES.flat().filter((x) => x.startsWith('--')), ...ESTADOS.flatMap((e) => SUFIXOS.map((s) => doEstado(e, s)))]);
  const cores = Object.keys(claro).filter((k) => { const c = resolveColor(claro[k], claro); return !!c && !('undef' in c); });
  assert.ok(cores.length > 80, `poucas cores lidas: ${cores.length}`);
  assert.deepEqual(cores.filter((k) => !classificadas.has(k)), []);
  // os temas só redefinem cores que existem no claro (nada de nome novo escondido num tema)
  for (const sel of BLOCOS_DE_TEMA.slice(1)) assert.deepEqual(Object.keys(varsDoBloco(css, sel)).filter((k) => !(k in claro)), [], sel);
  // cada estado tem as cinco: suave, texto, borda, cheio e texto-sobre-cheio
  for (const e of ESTADOS) for (const s of ['suave', 'texto', 'borda', 'cheio', 'sobre']) assert.ok(tem(doEstado(e, s)), `falta ${doEstado(e, s)}`);
});

test('tabela de usos: texto ≥ 4,5 (alto contraste: 7) sobre toda superfície e todo fundo de estado, nos três temas', () => {
  const bad: string[] = [];
  const medir = (nome: string, v: Vars, fg: string, bg: string, min: number, onde = '') => { const r = razao(`var(${fg})`, `var(${bg})`, v); if (r < min) bad.push(`${nome}: ${fg} sobre ${bg}${onde ? ` (${onde})` : ''} = ${r.toFixed(2)}`); };
  for (const [nome, v] of THEMES) {
    const min = minDe(nome);
    // texto neutro: nas superfícies e nos fundos suaves de todo estado (o secundário aparece dentro dos cartões coloridos)
    for (const fg of TEXTOS) for (const bg of [...SUPERFICIES, ...ESTADOS.flatMap(suaves)]) medir(nome, v, fg, bg, min);
    for (const e of ESTADOS) {
      for (const bg of [...SUPERFICIES, ...suaves(e), ...[doEstado(e, 'hover')].filter(tem)]) medir(nome, v, doEstado(e, 'texto'), bg, min);
      medir(nome, v, doEstado(e, 'sobre'), doEstado(e, 'cheio'), min, 'texto sobre o cheio');
    }
    for (const fg of NA_INVERSA.textos) for (const bg of NA_INVERSA.fundos) medir(nome, v, fg, bg, min, 'barra / menu');
    for (const [fg, bg, onde] of PARES) {
      if (fg === '--texto-inverso' && bg === '--legenda-fundo') { const B = over(cor(`var(${bg})`, v), [255, 255, 255]); const r = ratioRgb(over(cor(`var(${fg})`, v), B), B); if (r < min) bad.push(`${nome}: ${onde} = ${r.toFixed(2)}`); continue; }
      medir(nome, v, fg, bg, min, onde);
    }
  }
  assert.deepEqual(bad, []);
});

test('tabela de usos: contorno de campo, foco, ícones e pontinhos ≥ 3, nos três temas (o dourado fica só como enfeite)', () => {
  const bad: string[] = [];
  const claras = [...SUPERFICIES, '--atencao-suave', '--dourado-suave-2', '--info-suave', '--agua-suave'];
  const foco = valor(RS.find((r) => r.sel.startsWith(':where(a, button') && r.sel.endsWith(':focus-visible')) as Regra, 'outline') ?? '';
  assert.match(foco, /^var\(--foco-largura\) solid var\(--navy\)$/, `o contorno de foco de tudo é o azul-marinho (está: ${foco})`);
  assert.equal(contraste['--foco-largura'], '3px', 'no alto contraste o foco é mais largo');
  const anel = ultimo(':is(.topbar, .sidebar, .navdrawer) :focus-visible', 'box-shadow').replace(/^0 0 0 2px\s+/, '');
  const icones = ['.tip__ico', '.ditem__icon--folder'].map((s) => [s, ultimo(s, 'color')] as const);
  const dots = ['.dot', '.dot--green', '.dot--amber'].map((s) => ultimo(s, 'background'));
  assert.match(ultimo('.dot', 'box-shadow'), /^inset 0 0 0 [\d.]+px var\(--ponto-anel\)$/);
  for (const [nome, v] of THEMES) {
    const medir = (fg: string, bg: string, onde: string) => { const r = razao(fg, bg, v); if (r < MIN_GRAFICO) bad.push(`${nome}: ${onde} = ${r.toFixed(2)}`); };
    for (const bg of claras) { medir('var(--navy)', `var(${bg})`, `foco sobre ${bg}`); medir('var(--borda-campo)', `var(${bg})`, `contorno de campo sobre ${bg}`); }
    // na barra e no menu: o anel claro por dentro (ou o próprio contorno, no escuro)
    for (const bg of NA_INVERSA.fundos) { const r = Math.max(razao('var(--navy)', `var(${bg})`, v), razao(anel, `var(${bg})`, v)); if (r < MIN_GRAFICO) bad.push(`${nome}: foco na barra sobre ${bg} = ${r.toFixed(2)}`); }
    for (const p of NA_INVERSA.pontos) for (const bg of NA_INVERSA.fundos) medir(`var(${p})`, `var(${bg})`, `${p} na barra`);
    for (const [s, c] of icones) for (const bg of claras) medir(c, `var(${bg})`, `ícone ${s} sobre ${bg}`);
    const ring = cor('var(--ponto-anel)', v);
    for (const fill of dots) for (const bg of claras) {
      // o pontinho se destaca pela cor ou pelo contorno de dentro (no escuro o contorno é transparente)
      const B = superficie(`var(${bg})`, v); const F = over(cor(fill, v), B);
      const r = Math.max(ratioRgb(F, B), ring.a > 0 ? ratioRgb(over(ring, F), B) : 0);
      if (r < MIN_GRAFICO) bad.push(`${nome}: pontinho ${fill} sobre ${bg} = ${r.toFixed(2)}`);
    }
    // no alto contraste toda borda de estado aparece (selos e cartões com contorno visível)
    if (nome === 'contraste') for (const e of ESTADOS) for (const bg of [...SUPERFICIES, ...suaves(e)]) medir(`var(${doEstado(e, 'borda')})`, `var(${bg})`, `${doEstado(e, 'borda')} sobre ${bg}`);
  }
  assert.deepEqual(bad, []);
});

test('opção escolhida (ferramenta, habilidade, andar): a borda que marca a escolha ≥ 3 sobre o painel e sobre o próprio fundo, nos três temas', () => {
  // no escuro da rc.28 essas bordas eram claras (bem visíveis); com as cores de função, a escolha não pode sumir
  const ESCOLHA: Array<[string, string]> = [['.tool-opt--on', '--sucesso-borda-forte'], ['.skill-item--on', '--marca-borda-forte'], ['.scard__floor--on', '--agua-borda-forte']];
  const bad: string[] = [];
  for (const [sel, borda] of ESCOLHA) {
    assert.equal(ultimo(sel, 'border-color'), `var(${borda})`, `${sel} marca a escolha com ${borda}`);
    const fundo = ultimo(sel, 'background');
    for (const [nome, v] of THEMES) for (const bg of ['var(--panel)', fundo]) {
      const r = razao(`var(${borda})`, bg, v); if (r < MIN_GRAFICO) bad.push(`${nome}: ${sel} sobre ${bg} = ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('o dourado da marca (bronze) nos enfeites de estado: música tocando, espaço atual e posto ocupado', () => {
  // a rc.28 pintava esses três com --gold; continuam no mesmo tom (o --dourado-vivo é o amarelo do retrato da conta)
  for (const [sel, prop] of [['.tb-dot--music', 'background'], ['.ws-item.is-current', 'border-color'], ['.posto--on', 'background']] as const) assert.equal(ultimo(sel, prop), 'var(--dourado-cheio)', sel);
  assert.equal(claro['--dourado-cheio'], 'var(--gold)');
});

test('nenhum contorno de foco dourado (o dourado não chega a 3:1 sobre o fundo claro)', () => {
  const bad = RS.filter((r) => /:focus(-visible|-within)?\b/.test(r.sel) && r.decls.some((d) => /^(outline(-color)?|box-shadow)$/.test(d.prop) && /--gold\b|#c9a227/.test(d.value)))
    .map((r) => `linha ${r.line}: ${r.sel}`);
  assert.deepEqual(bad, []);
});

test('cores só nos três blocos de tema: nenhuma cor solta nem --fx-* nas regras das telas (as sombras ficam de fora)', () => {
  assert.deepEqual(coresSoltas(css), []);
  assert.doesNotMatch(css, /--fx-/);
  // o leitor pega cada caso (prova com uma folha de mentira)
  const mini = `:root { --a: #fff; --fx-b-ddd: #ddd; }\n.x { color: #123456; }\n.y { background: var(--a, #fff); }\n.z { border: 1px solid rgba(0, 0, 0, .1); }\n`
    + `.s { box-shadow: 0 1px 2px rgba(0, 0, 0, .2); }\n.n { color: var(--navy); }\n.w { color: white; }\n.f { color: var(--fx-t-1d1606); }\n.t { background: transparent; color: currentColor; }`;
  assert.deepEqual(coresSoltas(mini).map((l) => l.split(': ')[1].split(' ')[0]), ['--fx-b-ddd', '.x', '.y', '.z', '.w', '.f']);
});

test('nenhuma regra de tela tem ajuste próprio por tema (cada tema só redefine as cores de função: acabaram as listas de remendo)', () => {
  assert.deepEqual(ajustesPorTema(css), []);
  // o leitor dos ajustes por seletor inteiro continua certo (abre :is e não confunde pedaço de nome)
  const mini = regras(':root[data-theme="dark"] .btn--primary, :root[data-theme="dark"] .msg--user { color: #fff; }\n'
    + ':root[data-theme="dark"] :is(.btn--gold, .user .avatar) { color: #000; }\n.btn { color: red; }');
  assert.deepEqual([...ajustadosNoEscuro(mini)].sort(), ['.btn--gold', '.btn--primary', '.msg--user', '.user .avatar']);
  assert.equal(ajustesPorTema(':root[data-theme="dark"] { --a: #000; }\n:root[data-theme="contraste"] .x { color: var(--a); }').length, 1);
});

// ---------- regras com texto sobre fundo próprio ----------

/** Fundo de trás de uma regra translúcida: a barra de cima / o menu são a inversa; o resto, o painel. */
const CROMO = /\.(topbar|tb-|sidebar|navdrawer|nav\b|nav--|nav__|brand)/;

test('nenhuma regra com texto sobre fundo próprio abaixo de 4,5 (alto contraste: 7), nos três temas (inclusive transparência e color-mix)', () => {
  const bad: string[] = [];
  for (const r of RS) {
    if (r.at.some((a) => /keyframes/.test(a))) continue;
    const bg = fundoDe(r);
    // sem cor própria, o texto herda a cor principal (--ink)
    const fg = valor(r, 'color') ?? (r.decls.some((d) => /^(font|font-size|padding)$/.test(d.prop)) ? 'var(--ink)' : undefined);
    if (!bg || !fg || /inherit|currentcolor/i.test(fg)) continue;
    const op = Number(valor(r, 'opacity') ?? 1);
    for (const [nome, vars] of THEMES) {
      const b = resolveColor(bg, vars); const f = resolveColor(fg, vars);
      if (!b || !f || 'undef' in b || 'undef' in f || b.a === 0) continue;
      const base = over(cor(CROMO.test(r.sel) ? 'var(--inversa)' : 'var(--panel)', vars), [255, 255, 255]);
      const c = contrasteSobre(f, b, base, Number.isFinite(op) && op > 0 ? op : 1);
      if (c < minDe(nome)) bad.push(`${nome} ${c.toFixed(2)}: linha ${r.line} ${r.sel.slice(0, 80)} (${fg} sobre ${bg})`);
    }
  }
  assert.deepEqual(bad, []);
});

test('selo dentro de cartão da mesma cor: borda ou fundo do selo com 3:1 contra o cartão (nunca suave sobre suave), nos três temas', () => {
  const CARTOES = ['.perm-card', '.req-card', '.ask-box', '.proposal-card', '.dec-card--routine', '.lock-warn', '.confirm', '.device', '.onb__invite', '.fixed-note'];
  const SELOS = ['.badge--warn', '.badge--rec', '.due--soon', '.due--today', '.prio--alta', '.rt-need', '.msg__card-state--com-você', '.tdet__sit--decidir'];
  const proprio = (s: string) => RS.filter((r) => !r.at.length && splitTop(r.sel, ',').some((p) => p.trim() === s));
  const corDaBorda = (r: Regra) => valor(r, 'border-color') ?? valor(r, 'border')?.match(/(var\([^)]*\)|#[0-9a-f]{3,8}|rgba?\([^)]*\))\s*$/i)?.[1];
  const bad: string[] = [];
  for (const c of CARTOES) for (const s of SELOS) {
    const cbg = proprio(c).map(fundoDe).filter(Boolean).pop(); assert.ok(cbg, `${c} sem fundo`);
    const sbg = proprio(s).map(fundoDe).filter(Boolean).pop() ?? 'transparent';
    const dentro = RS.filter((r) => !r.at.length && !r.sel.includes('data-theme') && r.sel.includes(c) && r.sel.includes(s));
    const borda = [...proprio(s), ...dentro].map(corDaBorda).filter(Boolean).pop();
    for (const [nome, v] of THEMES) {
      const base = superficie(cbg as string, v);
      const pelaBorda = borda ? ratioRgb(over(cor(borda, v), base), base) : 1;
      const S = resolveColor(sbg, v); const peloFundo = S && !('undef' in S) ? ratioRgb(over(S, base), base) : 1;
      if (Math.max(pelaBorda, peloFundo) < MIN_GRAFICO) bad.push(`${nome}: ${s} em ${c}: borda ${pelaBorda.toFixed(2)}, fundo ${peloFundo.toFixed(2)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('na fila e enviando: só o corpo da mensagem fica translúcido, e mesmo assim se lê; a hora segue legível', () => {
  for (const s of ['.msg--queued', '.msg--sending']) assert.equal(RS.find((r) => r.sel === s && valor(r, 'opacity')), undefined, `${s} não pode apagar a mensagem inteira`);
  const corpo = RS.find((r) => r.sel.includes('.msg--queued > .msg__body')); assert.ok(corpo);
  const op = Number(valor(corpo, 'opacity')); assert.ok(op > 0 && op < 1);
  const fundoSeu = ultimo('.msg--user', 'background');
  for (const [nome, v] of THEMES) {
    for (const bg of [fundoSeu, 'var(--panel-2)']) {
      const B = superficie(bg, v);
      const corpoR = contrasteSobre(cor('var(--ink)', v), { rgb: B, a: 1 }, B, op);
      assert.ok(corpoR >= MIN_TEXTO, `${nome}: corpo na fila sobre ${bg} = ${corpoR.toFixed(2)}`);
      assert.ok(razao('var(--muted)', bg, v) >= minDe(nome), `${nome}: hora "na fila" sobre ${bg}`);
    }
  }
});

// ---------- leitura endurecida: defeitos que a conta simples não via ----------

/** Variáveis que o código põe na hora (style={{ '--x': … }}, setProperty('--x')): existem, mesmo fora da folha. */
const POSTAS_PELO_CODIGO = new Set(CODIGO.flatMap(({ s }) => [...s.matchAll(/['"`](--[a-z][\w-]*)['"`]/g)].map((m) => m[1])));

test('nenhuma variável inexistente (nem com reserva: --green, --amber, --accent… pintavam a cor errada ou nenhuma)', () => {
  assert.deepEqual(variaveisInexistentes(css, POSTAS_PELO_CODIGO), []);
});

test('nenhum atalho `font` com `inherit` misturado (o navegador joga a linha inteira fora)', () => {
  assert.deepEqual(fontComInherit(css), []);
});

/**
 * Opacidade abaixo de .8 que não apaga texto de leitura. Lista curta e justificada; o resto reprova:
 * - .task--dragging: o lugar vazio do card enquanto é arrastado (some ao soltar);
 * - .seg-gate__fundo: a prévia borrada atrás do cadeado (enfeite; o texto que vale está no quadro da frente);
 * - .nuvem-coberta__lona, .caret, .typing i: desenhos sem texto (lona, cursor e pontinhos de "digitando");
 * - corpo da mensagem na fila/enviando: medido no teste acima (≥ 4,5 mesmo translúcido).
 * Também ficam de fora, pela regra: :disabled (o WCAG não pede contraste de controle inativo), ::before/::after e
 * o que é só imagem (canvas, ícone, figura, logo).
 */
const OPACIDADE_OK = ['.task--dragging', '.seg-gate__fundo', '.nuvem-coberta__lona', '.caret', '.typing i', '.msg--queued > .msg__body', '.msg--sending > .msg__body'];
const SO_IMAGEM = /(^|\s)(canvas|img|svg)$|\.[\w-]*(__fig|__icon|__ico|__thumb|logo)$/;

test('nenhuma opacidade abaixo de .8 aplicada a texto (desligado, em breve, pausado, o × de fechar…)', () => {
  const bad = opacidadeEmTexto(css, OPACIDADE_OK).filter((linha) => {
    const sel = linha.replace(/^linha \d+: /, '').replace(/ \{ opacity: .*\}$/, '');
    return !splitTop(sel, ',').every((p) => SO_IMAGEM.test(p.trim()));
  });
  assert.deepEqual(bad, []);
});

/** Nenhuma exceção: cada uma, se vier, entra aqui com a justificativa (as ações da mensagem passaram a 12 px na rc.28). */
const LETRA_OK: string[] = [];

test('nenhuma letra abaixo de 12 px em controle (botão, campo, tecla de atalho)', () => {
  assert.deepEqual(letraPequenaEmControle(css, 12, LETRA_OK), []);
});

test('texto nunca menor que 11,5 px (legibilidade); o selo numérico da barra (10 px em negrito) é a exceção', () => {
  const small = RS.filter((r) => !r.at.some((a) => /keyframes/.test(a))).flatMap((r) => { const px = letraDe(r); return px !== undefined && px < 11.5 ? [`${r.sel} ${px}px`] : []; });
  assert.deepEqual(small, ['.tb-badge 10px']);
});

test('o leitor da folha pega cada defeito (prova com folhas de mentira)', () => {
  const mini = ':root { --a: #fff; --b: var(--a); }\n.x { color: var(--nao-existe); }\n.y { color: var(--zz, red); }\n.z { color: var(--a); }';
  assert.deepEqual(variaveisInexistentes(mini).map((s) => s.split(' usa ')[1]), ['--nao-existe', '--zz']);
  assert.equal(variaveisInexistentes(mini, ['--zz']).length, 1);
  assert.equal(fontComInherit('.a { font: 700 10px/1 inherit; } .b { font: inherit; } .c { font: 12px/1 var(--f); }').length, 1);
  assert.equal(opacidadeEmTexto('.a { opacity: .6; } .b:disabled { opacity: .5; } .c { opacity: 0; } @keyframes k { 50% { opacity: .3; } } .d::before { opacity: .5; } .e { opacity: .85; }').length, 1);
  assert.equal(letraPequenaEmControle('.a button { font-size: 11px; } .p { font-size: 11px; } .q kbd { font: 11px/1 var(--f); } .btn--x { font-size: 13px; } .linkish { font-size: 11.5px; }').length, 3);
  // dentro de @media também conta; comentário não atrapalha a contagem de linhas
  assert.equal(fontComInherit('@media (max-width: 600px) { .a { font: 600 11px/1 inherit; } }').length, 1);
  assert.equal(regras('/* a\nb */\n.x { color: red; }')[0].line, 3);
  // color-mix, reservas e transparência
  const v = { '--k': '#000000', '--w': '#ffffff' };
  assert.deepEqual((resolveColor('color-mix(in srgb, var(--k) 50%, var(--w))', v) as Cor).rgb.map(Math.round), [128, 128, 128]);
  assert.deepEqual((resolveColor('var(--nada, #ff0000)', v) as Cor).rgb, [255, 0, 0]);
  assert.deepEqual(resolveColor('var(--nada)', v), { undef: '--nada' });
  assert.equal((resolveColor('color-mix(in srgb, var(--k) 20%, transparent)', v) as Cor).a.toFixed(2), '0.20');
  assert.equal(resolveColor('linear-gradient(red, blue)', v), null);
  assert.ok(contrasteSobre({ rgb: [0, 0, 0], a: 1 }, { rgb: [255, 255, 255], a: 1 }, [255, 255, 255], 0.3) < 4.5);
});

// ---------- regra automática "texto legível sobre este fundo" (readableOn) ----------

const lerCores = (arquivo: string, re: RegExp) => [...fs.readFileSync(path.resolve(src, arquivo), 'utf8').matchAll(re)].map((m) => m[1].toLowerCase());
const PERSONAGENS = lerCores('../../server/src/services/characters.ts', /color: '(#[0-9a-f]{6})'/gi);
const NOVO_AGENTE = [...new Set([
  ...lerCores('components/NewAgentDialog.tsx', /const COLORS = \[([^\]]+)\]/g).flatMap((s) => s.match(/#[0-9a-f]{6}/g) ?? []),
  ...lerCores('../../server/src/services/capacity.ts', /const COLORS = \[([^\]]+)\]/g).flatMap((s) => s.match(/#[0-9a-f]{6}/g) ?? []),
])];
const RESERVA = lerCores('../../server/src/services/blueprint.ts', /\? a\.color : '(#[0-9a-f]{6})'/g);

test('retratos de letra: os 12 personagens se leem sem mudar de cor (Fídias continua dourado, com letra escura)', () => {
  assert.equal(PERSONAGENS.length, 12);
  for (const c of PERSONAGENS) {
    const r = readableOn(c); assert.ok(r);
    assert.equal(r.adjusted, false, `${c} não pode mudar`); assert.equal(r.bg, c);
    assert.ok(r.ratio >= MIN_TEXTO, `${c}: ${r.ratio.toFixed(2)}`);
  }
  const fidias = readableOn('#c08a2a'); assert.ok(fidias);
  assert.equal(fidias.fg, TINTA_ESCURA); assert.ok(fidias.ratio > 5.9, fidias.ratio.toFixed(2)); // era branco: 3,04
});

test('retratos de letra: a paleta de novo agente e a cor reserva também se leem (≥ 4,5)', () => {
  assert.ok(NOVO_AGENTE.length >= 10); assert.deepEqual(RESERVA, ['#888888']);
  for (const c of [...NOVO_AGENTE, ...RESERVA]) {
    const r = readableOn(c); assert.ok(r);
    assert.ok(contrast(r.fg, r.bg) >= MIN_TEXTO, `${c} → ${r.fg} sobre ${r.bg}: ${contrast(r.fg, r.bg).toFixed(2)}`);
  }
  assert.equal(readableOn('#b07d1f')?.fg, TINTA_ESCURA); // era branco: 3,62
});

const hue = (h: string) => { const [r, g, b] = (parseColor(h) as Cor).rgb.map((x) => x / 255); const mx = Math.max(r, g, b); const mn = Math.min(r, g, b); const d = mx - mn;
  if (!d) return 0; const x = mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return x * 60; };

test('readableOn: quando nenhuma tinta chega a 4,5, ajusta o fundo pelo menor passo, mantendo o tom', () => {
  for (const c of ['#7a7a7a', '#c2603a', '#3f8f6f', '#4f86c6', '#b0558a']) {
    const r = readableOn(c); assert.ok(r);
    assert.ok(r.ratio >= MIN_TEXTO, `${c}: ${r.ratio.toFixed(2)}`);
    assert.ok(contrast(r.fg, r.bg) >= MIN_TEXTO);
    if (r.adjusted) assert.ok(Math.abs(hue(r.bg) - hue(c)) < 3, `${c} → ${r.bg} mudou de tom`);
    else assert.equal(r.bg, c);
  }
  assert.equal(readableOn('#7a7a7a')?.adjusted, true);
  // cor com transparência: tratada pela cor cheia; entrada que não é cor: nada
  assert.equal(readableOn('#c08a2a80')?.bg, '#c08a2a');
  assert.equal(readableOn('não é cor'), null); assert.equal(readableOn(undefined), null);
  assert.equal(letterStyle(undefined), undefined); assert.equal(letterStyle('url(x)'), undefined);
  assert.deepEqual(letterStyle('#c08a2a'), { background: '#c08a2a', color: TINTA_ESCURA });
  // ensureContrast: devolve o mesmo fundo se já passa; senão, um que passa
  assert.equal(ensureContrast('#ffffff', '#1d184b'), '#1d184b');
  assert.ok(contrast('#ffffff', ensureContrast('#ffffff', '#c08a2a')) >= MIN_TEXTO);
  assert.ok(contrast(TINTA_ESCURA, ensureContrast(TINTA_ESCURA, '#2f4f8a')) >= MIN_TEXTO);
  // texto cinza médio sobre fundo claro: clarear não chega; escurece o fundo (o outro lado) em vez de desistir
  assert.ok(contrast('#8a8a8a', ensureContrast('#8a8a8a', '#f3e7c3')) >= MIN_TEXTO);
  assert.equal(inkOn('#ffe066'), TINTA_ESCURA); assert.equal(inkOn('#1d184b'), TINTA_CLARA); assert.equal(inkOn(null), TINTA_CLARA);
});

test('nenhum retrato de letra pinta a cor do agente com letra fixa (todos passam por letterStyle/readableOn)', () => {
  const bad = CODIGO.flatMap(({ f, s }) => [...s.matchAll(/style=\{\{\s*background:\s*[\w.?]+\.color\b/g)].map(() => f));
  assert.deepEqual(bad, []);
  for (const f of ['components/AgentFigure.tsx', 'components/AgentAvatar.tsx', 'components/Board.tsx', 'components/ChatPanel.tsx', 'views/AmbienteView.tsx']) {
    assert.match(codigo(f), /letterStyle\(/, f);
  }
  // o "Carregando" da Cidade usa a tinta que se lê sobre o chão do tema da cidade (de dia, a escura)
  assert.match(codigo('views/AmbienteView.tsx'), /inkOn\(THEMES\[themeId\]\.bg\)/);
});

test('logos de conexão: o desenho e a inicial usam a tinta que se lê sobre a cor da marca (≥ 3)', () => {
  const logo = codigo('components/BrandLogo.tsx');
  assert.doesNotMatch(logo, /<path d=\{icon\.path\} fill="#fff"/); assert.match(logo, /fill=\{inkOn\(m\.hex\)\}/);
  const icones = fs.readFileSync(path.join(src, 'components/simple-icons.ts'), 'utf8');
  for (const h of new Set([...icones.matchAll(/hex: '(#[0-9a-f]{6})'/gi), ...logo.matchAll(/hex: '(#[0-9a-f]{6})'/gi)].map((m) => m[1]))) {
    assert.ok(contrast(inkOn(h), h) >= MIN_GRAFICO, `${h}: ${contrast(inkOn(h), h).toFixed(2)}`);
  }
});
