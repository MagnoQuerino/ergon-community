import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CARD_SKIP, cardClick, cardKey, cardKeyOpens, cardShouldOpen, newSelection, selectionIn, type CardNode, type SelectionLike } from './cardClick.ts';
import { SurfaceStack, markDismissClick, swallowsDismissClick, wasDismissClick, type SurfaceEntry } from './surface-stack.ts';

/** Um pedaço de DOM de mentira: cada nó sabe o pai e se tem clique próprio (botão, campo, menu…). */
class No implements CardNode {
  readonly nome: string; readonly pai: No | null; readonly clicavel: boolean;
  constructor(nome: string, pai: No | null = null, clicavel = false) { this.nome = nome; this.pai = pai; this.clicavel = clicavel; }
  closest(_sel: string): No | null { for (let n: No | null = this; n; n = n.pai) if (n.clicavel) return n; return null; }
  contains(o: CardNode | null): boolean { for (let n = o as No | null; n; n = n.pai) if (n === this) return true; return false; }
}

const arvore = (cardEhBotao = false) => {
  const pagina = new No('página');
  const card = new No('card', pagina, cardEhBotao);
  const titulo = new No('título', card);
  const texto = new No('texto', titulo);
  const botao = new No('botão Remover', card, true);
  const icone = new No('ícone do botão', botao);
  const campo = new No('campo', card, true);
  const portal = new No('painel por cima', pagina); // desenhado fora do card, filho dele só no React
  const dentroDoPortal = new No('botão do painel', portal, true);
  return { card, titulo, texto, botao, icone, campo, portal, dentroDoPortal };
};

test('clicar em qualquer ponto do card abre; nos botões e campos de dentro, não', () => {
  const a = arvore();
  assert.equal(cardShouldOpen(a.card, a.card), true, 'no fundo do card');
  assert.equal(cardShouldOpen(a.card, a.texto), true, 'no texto');
  assert.equal(cardShouldOpen(a.card, a.titulo), true, 'no título');
  assert.equal(cardShouldOpen(a.card, a.botao), false, 'no botão');
  assert.equal(cardShouldOpen(a.card, a.icone), false, 'no ícone dentro do botão');
  assert.equal(cardShouldOpen(a.card, a.campo), false, 'no campo');
});

test('um card que é ele mesmo um botão continua abrindo no texto, mas não nos botões de dentro', () => {
  const a = arvore(true);
  assert.equal(cardShouldOpen(a.card, a.texto), true);
  assert.equal(cardShouldOpen(a.card, a.card), true);
  assert.equal(cardShouldOpen(a.card, a.icone), false);
});

test('o clique que vem de um painel aberto por cima (fora do card) não abre o card', () => {
  const a = arvore();
  assert.equal(cardShouldOpen(a.card, a.portal), false);
  assert.equal(cardShouldOpen(a.card, a.dentroDoPortal), false);
  assert.equal(cardShouldOpen(a.card, null), false);
});

test('terminar de selecionar um texto não abre o card', () => {
  const a = arvore();
  assert.equal(cardShouldOpen(a.card, a.texto, 'Briefing Diário'), false);
  assert.equal(cardShouldOpen(a.card, a.texto, '   '), true, 'seleção vazia (só espaços) conta como clique');
});

test('só a seleção que toca o card impede de abrir: um texto selecionado em outro ponto da página, não', () => {
  const a = arvore();
  const fora = new No('cabeçalho da página', a.portal.pai);
  const sel = (anchor: unknown, focus: unknown, texto = 'Tarefas', extra: Partial<SelectionLike> = {}): SelectionLike =>
    ({ isCollapsed: false, toString: () => texto, anchorNode: anchor, focusNode: focus, ...extra });
  // o caso do Edge/Chrome: clicar num card arrastável ou com user-select:none não desfaz a seleção que já existia
  assert.equal(selectionIn(a.card, sel(fora, fora)), '', 'seleção no cabeçalho: o card abre');
  assert.equal(cardShouldOpen(a.card, a.texto, selectionIn(a.card, sel(fora, fora))), true);
  assert.equal(selectionIn(a.card, sel(a.texto, a.texto, 'Briefing')), 'Briefing', 'seleção no próprio card: não abre');
  assert.equal(cardShouldOpen(a.card, a.texto, selectionIn(a.card, sel(a.texto, a.texto, 'Briefing'))), false);
  assert.equal(selectionIn(a.card, sel(fora, a.texto)), 'Tarefas', 'começou fora e terminou dentro do card');
  assert.equal(selectionIn(a.card, sel(fora, fora, 'tudo', { containsNode: () => true })), 'tudo', 'atravessa o card de ponta a ponta (Ctrl+A por cima dele)');
  assert.equal(selectionIn(a.card, sel(fora, fora, 'x', { containsNode: () => { throw new Error('não deixa'); } })), '');
  assert.equal(selectionIn(a.card, { ...sel(a.texto, a.texto), isCollapsed: true }), '', 'só o cursor, sem texto: abre');
  assert.equal(selectionIn(a.card, sel(a.texto, a.texto, '  ')), '');
  assert.equal(selectionIn(a.card, null), '');
});

/**
 * O caminho do clique de verdade, sem DOM: a superfície de cima decide se fecha (SurfaceStack.dismiss, o mesmo que
 * surface.ts chama), marca o clique se ele fica só no fechar, e o card de baixo (cardClick) abre ou não.
 */
const superficie = (o: Partial<SurfaceEntry> = {}): SurfaceEntry => ({ id: 1, modal: false, outside: true, escape: true, ignoreFromInputs: false, ...o });
function cliqueFora(entrada: SurfaceEntry | null, opts: { perguntou?: boolean; detail?: number; interativo?: boolean } = {}) {
  const a = arvore();
  const pilha = new SurfaceStack();
  if (entrada) pilha.push(entrada);
  const nativo = {};
  let fechou = 0; let abriu = 0;
  const r = pilha.dismiss({ downInside: false, upInside: false, keep: false, interactive: opts.interativo ?? true, count: opts.detail ?? 1 }, () => { fechou++; return !!opts.perguntou; });
  if (r.swallow) markDismissClick(nativo);
  cardClick(() => { abriu++; })({ button: 0, detail: opts.detail ?? 1, defaultPrevented: false, currentTarget: a.card, target: a.texto, nativeEvent: nativo });
  return { fechou, abriu };
}

test('com um menu ou painel comum aberto, o 1º clique no card fecha o painel E abre o card (como na rc.25)', () => {
  // o Estado do Ergon, o menu da conta, a música, Workspaces, Aguardando você, o menu do card do agente
  assert.deepEqual(cliqueFora(superficie()), { fechou: 1, abriu: 1 }, 'Tarefas (quadro ou lista) e o card do agente abrem no 1º clique');
  assert.deepEqual(cliqueFora(superficie({ passThrough: true })), { fechou: 0, abriu: 1 }, 'painel de consulta: o card clicado assume, sem fechar antes');
  assert.deepEqual(cliqueFora(null), { fechou: 0, abriu: 1 }, 'nada aberto: abre');
});

test('quando fechar perguntou se descarta o que foi digitado, ou a janela é modal, o clique fica só no fechar', () => {
  // a gaveta de edição da rotina com alteração: a pessoa decide sobre o que escreveu; o card de outra rotina não abre por cima
  assert.deepEqual(cliqueFora(superficie(), { perguntou: true }), { fechou: 1, abriu: 0 });
  assert.deepEqual(cliqueFora(superficie({ modal: true })), { fechou: 1, abriu: 0 });
  assert.equal(swallowsDismissClick({ modal: false }, false), false);
  assert.equal(swallowsDismissClick({ modal: false }, true), true);
  assert.equal(swallowsDismissClick({ modal: true }, false), true);
  // a marca vale só para aquele clique
  const nativo = {};
  markDismissClick(nativo);
  assert.equal(wasDismissClick(nativo), true);
  assert.equal(wasDismissClick({}), false);
  assert.equal(wasDismissClick(null), false);
  // surface.ts usa esse mesmo caminho e conta as perguntas do keepTyped (não marca mais todo clique fora)
  const s = ler('lib/surface.ts');
  assert.doesNotMatch(s, /if \(!t\.passThrough\) markDismissClick\(e\)/);
  assert.match(s, /stack\.dismiss\(\{[^}]*count: e\.detail \}/);
  assert.match(s, /if \(r\.swallow\) markDismissClick\(e\);/);
  assert.match(s, /if \(!dirty\) return true;\s*discardAsks\+\+;\s*return window\.confirm/);
});

test('duplo clique: o 2º clique não abre (nem alterna) o card, e não fecha a gaveta que o 1º acabou de abrir', () => {
  const a = arvore();
  let aberta = false;
  const alternar = cardClick(() => { aberta = !aberta; }); // a linha de Pessoas abre e fecha
  const ev = (detail: number) => ({ button: 0, detail, defaultPrevented: false, currentTarget: a.card, target: a.texto });
  alternar(ev(1)); alternar(ev(2));
  assert.equal(aberta, true, 'duplo clique em Pessoas deixa os detalhes abertos');
  alternar(ev(1));
  assert.equal(aberta, false, 'um clique depois fecha, como antes');
  // clique pelo teclado (Enter num botão) chega com detail 0: conta como um clique
  alternar(ev(0)); assert.equal(aberta, true);
  // a gaveta de edição que o 1º clique abriu: o 2º clique cai fora dela, mas não fecha
  assert.deepEqual(cliqueFora(superficie(), { detail: 2 }), { fechou: 0, abriu: 0 });
  const pilha = new SurfaceStack(); pilha.push(superficie());
  assert.equal(pilha.onOutsideClick(false, false, false, false, 2), null);
  assert.equal(pilha.onOutsideClick(false, false, false, false, 1)?.id, 1, 'um clique fora comum continua fechando');
});

test('o que tem clique próprio fica de fora: botão, link, campos, menus, painéis, formulário', () => {
  for (const s of ['button', 'a[href]', 'input', 'select', 'textarea', 'label', 'summary', 'form', '[role="menu"]', '[role="menuitem"]', '[role="dialog"]', '[role="switch"]', '[role="checkbox"]', '[role="tab"]', '[data-card-skip]']) {
    assert.ok(CARD_SKIP.split(', ').includes(s), `falta ${s}`);
  }
});

test('cardClick: só o botão principal do mouse, sem Ctrl/Shift, e só se ninguém já tratou o clique', () => {
  const a = arvore();
  let n = 0;
  const h = cardClick(() => { n++; });
  const ev = (o: Partial<{ button: number; defaultPrevented: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean; target: unknown }> = {}) =>
    ({ button: 0, defaultPrevented: false, currentTarget: a.card, target: a.texto, ...o });
  h(ev()); assert.equal(n, 1);
  h(ev({ button: 2 })); h(ev({ defaultPrevented: true })); h(ev({ ctrlKey: true })); h(ev({ shiftKey: true })); h(ev({ metaKey: true }));
  assert.equal(n, 1);
  h(ev({ target: a.icone })); assert.equal(n, 1, 'o botão de dentro faz só o dele');
});

test('teclado: Enter e Espaço no card abrem; num campo ou botão de dentro, não; segurar a tecla não repete', () => {
  const a = arvore();
  assert.equal(cardKeyOpens({ key: 'Enter', target: a.card, currentTarget: a.card }), true);
  assert.equal(cardKeyOpens({ key: ' ', target: a.card, currentTarget: a.card }), true);
  assert.equal(cardKeyOpens({ key: 'Enter', target: a.campo, currentTarget: a.card }), false);
  assert.equal(cardKeyOpens({ key: 'Enter', target: a.botao, currentTarget: a.card }), false);
  assert.equal(cardKeyOpens({ key: 'a', target: a.card, currentTarget: a.card }), false);
  assert.equal(cardKeyOpens({ key: 'Enter', target: a.card, currentTarget: a.card, repeat: true }), false);
  let aberto = 0; let semRolar = 0;
  cardKey(() => { aberto++; })({ key: ' ', target: a.card, currentTarget: a.card, preventDefault: () => { semRolar++; } });
  assert.equal(aberto, 1); assert.equal(semRolar, 1, 'Espaço não rola a página');
  cardKey(() => { aberto++; })({ key: ' ', target: a.campo, currentTarget: a.card, preventDefault: () => { semRolar++; } });
  assert.equal(aberto, 1); assert.equal(semRolar, 1, 'Espaço num campo de dentro continua escrevendo');
});

// verificação de código: as telas usam o mesmo padrão (o card abre; o título é o botão do teclado)
const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ler = (f: string) => fs.readFileSync(path.join(raiz, f), 'utf8');

test('Rotinas: o card inteiro da rotina abre a edição, e o nome é o botão do teclado', () => {
  const s = ler('views/RotinasView.tsx');
  assert.match(s, /className=\{`card rt-item card-click[^`]*`\} onClick=\{cardClick\(onEdit\)\}/);
  assert.match(s, /<h3><button type="button" className="card-open" onClick=\{onEdit\}/);
  // os botões de antes continuam lá
  assert.match(s, /<Icon name="edit" size=\{13\} \/> Editar<\/button>/);
});

test('Rotinas: trocar de rotina com a gaveta aberta nunca leva o que foi digitado para a outra', () => {
  const s = ler('views/RotinasView.tsx');
  // cada rotina monta a própria gaveta (antes: a gaveta de B mostrava os campos de A, e Salvar gravava A em B)
  assert.match(s, /<EditDrawer key=\{edit\.id\} /);
  // com alteração não salva, abrir outra rotina não troca a gaveta (mesmo depois do "Cancelar" no descartar)
  assert.match(s, /if \(edit && edit\.id !== r\.id && dirtyEdit\.current\) return;/);
  assert.match(s, /useEffect\(\(\) => \{ onDirty\?\.\(dirty\); \}, \[dirty\]\)/);
  assert.match(s, /const closeEdit = \(\) => \{ dirtyEdit\.current = false; setEdit\(null\); \};/);
  assert.match(s, /onEdit=\{\(\) => openEdit\(r\)\}/);
});

test('Documentos: arquivos, pastas e o resultado da busca abrem pela linha inteira, e a busca agora tem botão', () => {
  const s = ler('views/DocumentosView.tsx');
  assert.match(s, /onClick=\{cardClick\(\(\) => setOpenFile\(f\)\)\}/);
  assert.match(s, /cardClick\(\(\) => go\(f\.id\)\)/);
  assert.doesNotMatch(s, /<li key=\{f\.id\} className="ditem" onClick=/, 'a linha da busca sem botão (só mouse) voltou');
  assert.match(s, /aria-label=\{`\$\{f\.filename\}: abrir a prévia`\}/);
  // sair da renomeação clicando na própria linha não entra na pasta (o campo perde o foco já no pressionar)
  assert.match(s, /onPointerDown=\{\(\) => \{ leftRename\.current = renaming\?\.id === f\.id \? f\.id : null; \}\}/);
  assert.match(s, /if \(leftRename\.current === f\.id\) \{ leftRename\.current = null; return; \} cardClick\(\(\) => go\(f\.id\)\)\(e\);/);
});

test('Loja: o card abre a prévia sem ser um botão por fora (o Instalar de dentro funciona no teclado)', () => {
  const s = ler('views/PacotesPanel.tsx');
  assert.doesNotMatch(s, /className="loja-card"[^>]*role="button"/);
  assert.match(s, /<article className="loja-card" onClick=\{cardClick\(\(\) => setAberto\(x\)\)\}>/);
  assert.match(s, /className="card-open" onClick=\{\(\) => setAberto\(x\)\}/);
});

test('Tarefas: no quadro e na lista, o card e a linha inteira abrem, com Enter e Espaço', () => {
  const s = ler('components/Board.tsx');
  assert.equal((s.match(/onClick=\{cardClick\(\(\) => onOpen\(t\.id\)\)\}/g) ?? []).length, 2);
  assert.equal((s.match(/onKeyDown=\{cardKey\(\(\) => onOpen\(t\.id\)\)\}/g) ?? []).length, 2);
  assert.doesNotMatch(s, /if \(e\.key === 'Enter'\) onOpen/, 'o Enter na situação abria o card');
  // a linha da lista diz ao leitor de tela o que é, como o card do quadro
  assert.ok(s.includes('aria-label={`Tarefa #${t.number}: ${t.title}, ${c.name}`} title="Abrir o card"'), 'rótulo da linha da lista');
});

test('Atividade: cada linha do registro, dos eventos e das execuções abre o que aconteceu', () => {
  const s = ler('views/OtherViews.tsx');
  for (const d of ['destinoDoRegistro(e)', 'destinoDoEvento(e)', 'destinoDaExecucao(r)']) assert.ok(s.includes(`const d = ${d}; return <tr key=`), d);
  assert.equal((s.match(/\{\.\.\.linha\(d, /g) ?? []).length, 3);
  // a linha diz o que abre ao leitor de tela, e a seta marca as que abrem (a dica fala da seta)
  assert.match(s, /'aria-label': rotuloDaLinha\(d, resumo\)/);
  assert.equal((s.match(/\{seta\(d\)\}/g) ?? []).length, 3);
  assert.match(s, /As linhas com › abrem o que aconteceu/);
  // a evidência e o erro são para ler e copiar: clicar (ou dar duplo clique) neles não leva para outra área
  assert.match(s, /<td className="pre small" data-card-skip>\{e\.evidence/);
  assert.match(s, /<td className="small" data-card-skip>\{r\.error/);
  assert.match(ler('App.tsx'), /<AtividadeView onOpenAgent=/);
  // a conexão citada abre pelo endereço
  assert.match(ler('views/ConexoesView.tsx'), /get\('app'\)/);
});

test('Pessoas, Aguardando você, Equipe e a janela do agente usam o mesmo padrão', () => {
  const p = ler('views/PessoasPanel.tsx');
  assert.match(p, /<li key=\{p\.id\} className="card-click" onClick=\{cardClick\(abrir\)\}>/);
  assert.match(p, /aria-expanded=\{aberta === p\.id\}/);
  // clicar nos detalhes abertos (para ler, copiar) não fecha
  assert.match(p, /className="pessoa__det" data-card-skip>/);
  // nada de presença que não confere: a chave na memória não quer dizer que ela está usando agora
  assert.doesNotMatch(p, /abertos agora|ela entrou/);
  assert.match(p, /Você gera em Configurações › Segurança/);
  const d = ler('components/DecisionsPanel.tsx');
  assert.match(d, /onClick=\{onOpen \? cardClick\(onOpen\) : undefined\}/);
  // errar Aprovar/Recusar por pouco não tira a pessoa do painel
  assert.ok(d.includes('<div className="row row--wrap dec-card__acts" data-card-skip>{actions}</div>'));
  // o cartão que pede para Confirmar um envio em nome da pessoa não abre inteiro: só pelo "#N · quem"
  assert.match(d, /<article key=\{p\.id\} className="dec-card">\s*<div className="dec-card__top">\s*<span className="badge">\{KIND\[p\.kind\]\}/);
  assert.doesNotMatch(d, /cardClick\(\(\) => openCard\(p\.task_id!\)\)/);
  const e = ler('views/AgentesView.tsx');
  assert.match(e, /onClick=\{cardClick\(open\)\}/);
  assert.match(e, /className="group__head card-click"/);
  assert.match(e, /className="building__head card-click"/);
  const w = ler('components/AgentWindow.tsx');
  assert.match(w, /onClick=\{cardClick\(\(\) => openCard\(x\.id\)\)\}/);
  assert.match(w, /'aria-label': rotuloDaLinha\(dest, /);
});

test('quem usa cardClick importa da mesma peça, e o estilo do card clicável existe', () => {
  const arquivos = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true })
    .flatMap((x) => x.isDirectory() ? arquivos(path.join(d, x.name)) : x.name.endsWith('.tsx') ? [path.join(d, x.name)] : []);
  for (const f of arquivos(raiz)) {
    const s = fs.readFileSync(f, 'utf8');
    if (/cardClick\(|cardKey\(/.test(s)) assert.match(s, /from '\.\.\/lib\/cardClick\.ts'|from '\.\/lib\/cardClick\.ts'/, path.relative(raiz, f));
  }
  const css = ler('styles.css');
  for (const r of ['.card-click {', '.card-click:hover', '.card-open {', '.card-click:has(.card-open:focus-visible)', '.row-click:focus-visible']) assert.ok(css.includes(r), r);
  // passar o mouse não mexe no lugar (nada de deslocar o card)
  const bloco = css.slice(css.indexOf('.card-click {'), css.indexOf('.pessoa__det dd'));
  assert.doesNotMatch(bloco, /transform|translate/);
});

test('clicar em cima de um texto que já estava selecionado é um clique (depois do duplo clique numa palavra)', () => {
  // a palavra que o duplo clique selecionou continua selecionada no clique seguinte: antes, o card não abria nem fechava
  assert.equal(newSelection('Ana', 'Ana'), '', 'a mesma seleção de antes do clique: abre');
  assert.equal(newSelection('Briefing', ''), 'Briefing', 'arrastou e selecionou agora: não abre');
  assert.equal(newSelection('Briefing', 'Tarefas'), 'Briefing', 'havia outra seleção e a pessoa arrastou uma nova: não abre');
  assert.equal(newSelection('', 'Tarefas'), '');
  const a = arvore();
  assert.equal(cardShouldOpen(a.card, a.texto, newSelection('Ana', 'Ana')), true);
  assert.equal(cardShouldOpen(a.card, a.texto, newSelection('Ana', '')), false);
  assert.match(ler('lib/cardClick.ts'), /newSelection\(selectedText\(card\), selAtDown\)/);
});
