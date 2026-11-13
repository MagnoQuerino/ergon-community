import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  MIN_GRAFICO, MIN_TEXTO, TINTA_CLARA, TINTA_ESCURA, contrast, ensureContrast, inkOn, letterStyle, over, parseColor, ratioRgb, readableOn, type Rgb,
} from './contraste.ts';
import {
  ajustadosNoEscuro, contrasteSobre, fontComInherit, fundoDe, letraDe, letraPequenaEmControle, opacidadeEmTexto, regras, resolveColor, splitTop, temas, valor,
  variaveisInexistentes, type Cor, type Regra, type Vars,
} from './contraste-folha.ts';

// O teste que reprova a publicação quando algum texto, ícone ou contorno de foco fica ilegível (WCAG: texto 4,5:1;
// ícone, borda de controle e foco 3:1), nos temas claro e escuro. Lê a própria folha de estilos.

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const css = fs.readFileSync(path.join(src, 'styles.css'), 'utf8');
const { claro, escuro } = temas(css);
const THEMES: Array<[string, Vars]> = [['claro', claro], ['escuro', escuro]];
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

// ---------- tabela de usos: todo texto oficial contra toda superfície oficial ----------

const SUPERFICIES = ['var(--bg)', 'var(--panel)', 'var(--panel-2)', 'var(--glass)'];
/** fundos coloridos onde aparece texto neutro (secundário, link): cartões amarelos, de pergunta, mensagem sua, estados */
const FUNDOS_TINGIDOS = ['var(--warn-bg)', 'var(--ok-bg)', 'var(--err-bg)', 'var(--fx-f-fffaf0)', 'var(--fx-f-fffaf2)', 'var(--fx-f-fbf4e6)',
  'var(--fx-f-f2f8f9)', 'var(--fx-f-e5eef3)'];
const NEUTROS = ['var(--ink)', 'var(--muted)', 'var(--navy)', 'var(--teal)', 'var(--gold-ink)'];
const ESTADOS: Array<[string, string]> = [['var(--warn)', 'var(--warn-bg)'], ['var(--ok)', 'var(--ok-bg)'], ['var(--err)', 'var(--err-bg)']];
/** [texto, fundo, onde]: selos e botões de cor própria (a lista da auditoria) */
const USOS: Array<[string, string, string]> = [
  ['var(--fx-t-4b2f8f)', 'var(--fx-f-ede4ff)', 'selo de simulação'],
  ['var(--fx-t-3d2c00)', 'var(--fx-f-f6d77c)', 'aviso da barra de cima'],
  ['var(--fx-t-7a5a00)', 'var(--fx-f-fbefd2)', 'selo recomendado'],
  ['var(--fx-t-8f4529)', 'color-mix(in srgb, var(--terracotta) 14%, var(--panel))', 'prioridade / precisa de você'],
  ['var(--gold-ink)', 'color-mix(in srgb, var(--gold) 18%, var(--panel))', 'posição do card'],
  ['var(--gold-ink)', 'var(--fx-f-fbf4e6)', 'fixo / prazo perto'],
  ['#1d1606', 'var(--gold)', 'botão dourado (no escuro o texto é fixo: :root[data-theme="dark"] .btn--gold)'],
  ['#ffffff', 'var(--navy-bg)', 'botão principal / barra de cima'],
];

test('tabela de usos: texto neutro e de estado sobre toda superfície oficial ≥ 4,5, nos dois temas', () => {
  const bad: string[] = [];
  for (const [nome, v] of THEMES) {
    for (const fg of NEUTROS) for (const bg of [...SUPERFICIES, ...FUNDOS_TINGIDOS]) { const r = razao(fg, bg, v); if (r < MIN_TEXTO) bad.push(`${nome}: ${fg} sobre ${bg} = ${r.toFixed(2)}`); }
    for (const [fg, own] of ESTADOS) for (const bg of [...SUPERFICIES, own]) { const r = razao(fg, bg, v); if (r < MIN_TEXTO) bad.push(`${nome}: ${fg} sobre ${bg} = ${r.toFixed(2)}`); }
    for (const [fg, bg, onde] of USOS) { const r = razao(fg, bg, v); if (r < MIN_TEXTO) bad.push(`${nome}: ${onde} (${fg} sobre ${bg}) = ${r.toFixed(2)}`); }
  }
  assert.deepEqual(bad, []);
});

test('tabela de usos: foco, ícones e pontinhos ≥ 3, nos dois temas (o dourado fica só como enfeite)', () => {
  const bad: string[] = [];
  const claras = [...SUPERFICIES, 'var(--warn-bg)', 'var(--fx-f-fffaf0)'];
  const escuras = ['var(--navy-bg)', 'var(--navy-2-bg)']; // barra de cima e menu
  const foco = valor(RS.find((r) => r.sel.startsWith(':where(a, button') && r.sel.endsWith(':focus-visible')) as Regra, 'outline') ?? '';
  assert.match(foco, /^2px solid var\(--navy\)$/, `o contorno de foco de tudo é o azul-marinho (está: ${foco})`);
  const navy = 'var(--navy)';
  const anel = ultimo(':is(.topbar, .sidebar, .navdrawer) :focus-visible', 'box-shadow').replace(/^0 0 0 2px\s+/, '');
  const icones = ['.tip__ico', '.ditem__icon--folder'].map((s) => [s, ultimo(s, 'color')] as const);
  const dots = ['.dot', '.dot--green', '.dot--amber'].map((s) => ultimo(s, 'background'));
  const ring = parseColor(ultimo('.dot', 'box-shadow').replace(/^inset 0 0 0 [\d.]+px\s+/, '')); assert.ok(ring);
  assert.equal(ultimo(':root[data-theme="dark"] .dot', 'box-shadow'), 'none');
  for (const [nome, v] of THEMES) {
    for (const bg of claras) { const r = razao(navy, bg, v); if (r < MIN_GRAFICO) bad.push(`${nome}: foco sobre ${bg} = ${r.toFixed(2)}`); }
    // na barra e no menu: o anel claro por dentro (ou o próprio contorno, no escuro)
    for (const bg of escuras) { const r = Math.max(razao(navy, bg, v), razao(anel, bg, v)); if (r < MIN_GRAFICO) bad.push(`${nome}: foco na barra sobre ${bg} = ${r.toFixed(2)}`); }
    for (const [s, c] of icones) for (const bg of claras) { const r = razao(c, bg, v); if (r < MIN_GRAFICO) bad.push(`${nome}: ícone ${s} sobre ${bg} = ${r.toFixed(2)}`); }
    for (const fill of dots) for (const bg of [...claras, ...escuras]) {
      // o pontinho se destaca pela cor ou pelo contorno de dentro (no escuro o contorno sai)
      const B = superficie(bg, v); const F = over(cor(fill, v), B);
      const r = Math.max(ratioRgb(F, B), nome === 'escuro' ? 0 : ratioRgb(over(ring, F), B));
      if (r < MIN_GRAFICO) bad.push(`${nome}: pontinho ${fill} sobre ${bg} = ${r.toFixed(2)}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('nenhum contorno de foco dourado (o dourado não chega a 3:1 sobre o fundo claro)', () => {
  const bad = RS.filter((r) => /:focus(-visible|-within)?\b/.test(r.sel) && r.decls.some((d) => /^(outline(-color)?|box-shadow)$/.test(d.prop) &&/--gold\b|#c9a227/.test(d.value)))
    .map((r) => `linha ${r.line}: ${r.sel}`);
  assert.deepEqual(bad, []);
});

// ---------- regras com texto sobre fundo próprio ----------

/** Fundo de trás de uma regra translúcida: a barra de cima / o menu são azul-marinho; o resto, o painel. */
const CROMO = /\.(topbar|tb-|sidebar|navdrawer|nav\b|nav--|nav__|brand)/;

test('nenhuma regra com texto sobre fundo próprio abaixo de 4,5, no claro e no escuro (inclusive transparência e color-mix)', () => {
  // ajustes próprios do escuro: o seletor ajustado é avaliado pelo ajuste, não pela regra de base (seletor inteiro:
  // '.btn' continua medido no escuro mesmo existindo '.btn--gold' ajustado)
  const darkFixed = ajustadosNoEscuro(RS);
  const bad: string[] = [];
  for (const r of RS) {
    if (r.at.some((a) => /keyframes/.test(a))) continue;
    const bg = fundoDe(r);
    // sem cor própria, o texto herda a cor principal (--ink): o caso do botão claro fixo com texto claro no escuro
    const fg = valor(r, 'color') ?? (r.decls.some((d) => /^(font|font-size|padding)$/.test(d.prop)) ? 'var(--ink)' : undefined);
    if (!bg || !fg || /inherit|currentcolor/i.test(fg)) continue;
    const scopedDark = r.sel.includes('data-theme="dark"');
    const op = Number(valor(r, 'opacity') ?? 1);
    for (const [nome, vars] of THEMES) {
      if (scopedDark && nome === 'claro') continue;
      if (!scopedDark && nome === 'escuro' && splitTop(r.sel, ',').some((s) => darkFixed.has(s.trim()))) continue;
      const b = resolveColor(bg, vars); const f = resolveColor(fg, vars);
      if (!b || !f || 'undef' in b || 'undef' in f || b.a === 0) continue;
      const base = over(cor(CROMO.test(r.sel) ? 'var(--navy-bg)' : 'var(--panel)', vars), [255, 255, 255]);
      const c = contrasteSobre(f, b, base, Number.isFinite(op) && op > 0 ? op : 1);
      if (c < MIN_TEXTO) bad.push(`${nome} ${c.toFixed(2)}: linha ${r.line} ${r.sel.slice(0, 80)} (${fg} sobre ${bg})`);
    }
  }
  assert.deepEqual(bad, []);
});

test('o ajuste do escuro vale por seletor inteiro: ".btn" continua medido no escuro mesmo com ".btn--gold" ajustado', () => {
  const mini = regras(':root[data-theme="dark"] .btn--primary, :root[data-theme="dark"] .msg--user { color: #fff; }\n'
    + ':root[data-theme="dark"] :is(.btn--gold, .user .avatar) { color: #000; }\n.btn { color: red; }');
  assert.deepEqual([...ajustadosNoEscuro(mini)].sort(), ['.btn--gold', '.btn--primary', '.msg--user', '.user .avatar']);
  // na folha de verdade: as regras de base que eram puladas por pedaço de nome agora são medidas no escuro
  const fixos = ajustadosNoEscuro(RS);
  for (const s of ['.btn', '.chip', '.msg', 'code', '.avatar', '.topbar', '.switch']) assert.equal(fixos.has(s), false, `${s} é medido no escuro`);
  for (const s of ['.btn--primary', '.chip--on', '.msg--user', '.md__code', 'img.avatar', '.btn--gold', '.switch--on']) assert.equal(fixos.has(s), true, `${s} tem ajuste no escuro`);
});

test('selo amarelo dentro de cartão amarelo: borda ou fundo do selo com 3:1 contra o cartão (nunca suave sobre suave)', () => {
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

test('na fila e enviando: só o corpo da mensagem fica translúcido, e mesmo assim se lê (≥ 4,5); a hora segue legível', () => {
  for (const s of ['.msg--queued', '.msg--sending']) assert.equal(RS.find((r) => r.sel === s && valor(r, 'opacity')), undefined, `${s} não pode apagar a mensagem inteira`);
  const corpo = RS.find((r) => r.sel.includes('.msg--queued > .msg__body')); assert.ok(corpo);
  const op = Number(valor(corpo, 'opacity')); assert.ok(op > 0 && op < 1);
  const fundoSeu = { claro: ultimo('.msg--user', 'background'), escuro: ultimo(':root[data-theme="dark"] .msg--user', 'background') };
  for (const [nome, v] of THEMES) {
    for (const bg of [nome === 'claro' ? fundoSeu.claro : fundoSeu.escuro, 'var(--panel-2)']) {
      const B = superficie(bg, v);
      const corpoR = contrasteSobre(cor('var(--ink)', v), { rgb: B, a: 1 }, B, op);
      assert.ok(corpoR >= MIN_TEXTO, `${nome}: corpo na fila sobre ${bg} = ${corpoR.toFixed(2)}`);
      assert.ok(razao('var(--muted)', bg, v) >= MIN_TEXTO, `${nome}: hora "na fila" sobre ${bg}`);
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
