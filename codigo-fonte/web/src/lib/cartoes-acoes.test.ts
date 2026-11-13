// As ações dos cartões (rc.28): os limites que dá para conferir sem navegador (o CSS das classes novas, o recolher, a
// trava do envio e o fim do botão desabilitado esperando). A medição na tela desenhada, com o Edge sem janela, é
// scripts/telas/cartoes-medidos.mjs (sobre a galeria web/galeria.html).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { ACAO, ACAO_GRANDE, ALCANCES, LIMITES, MAX_ACOES_SOLTAS, PRAZOS, PRAZO_PADRAO, alcanceSugerido, escolhaDoSeletor, recolhe } from './cartoes-acoes.ts';
import { criarTrava, criarTravaPorItem, textoCurto, vaiNo } from './envio.ts';
import ptConexoes from '../i18n/pt/conexoes.ts';
import enConexoes from '../i18n/en/conexoes.ts';
import ptTarefa from '../i18n/pt/tarefa.ts';
import enTarefa from '../i18n/en/tarefa.ts';

const ler = (rel: string) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const css = ler('styles.css');
const INICIO = '/* ---- ações dos cartões (rc.28) ---- */';
const FIM = '/* ---- fim das ações dos cartões (rc.28) ---- */';

/** O bloco das ações dos cartões, inteiro e num lugar só (a outra frente da rc.28 mexe no resto do arquivo). */
function bloco(): string {
  const i = css.indexOf(INICIO); const f = css.indexOf(FIM);
  assert.ok(i > 0 && f > i, 'o bloco "ações dos cartões" existe, com começo e fim');
  assert.equal(css.indexOf(INICIO, i + 1), -1, 'um bloco só');
  return css.slice(i, f).replace(/\/\*[\s\S]*?\*\//g, '');
}
/** As regras do bloco: [seletor, corpo, @media/@container em volta ou ''] */
function regras(): Array<{ sel: string; corpo: string; em: string }> {
  const b = bloco(); const out: Array<{ sel: string; corpo: string; em: string }> = [];
  let em = ''; let i = 0;
  while (i < b.length) {
    const a = b.indexOf('{', i); if (a < 0) break;
    const sel = b.slice(i, a).trim();
    if (sel.startsWith('@')) { em = sel; i = a + 1; continue; }
    const f = b.indexOf('}', a);
    out.push({ sel, corpo: b.slice(a + 1, f), em });
    i = f + 1;
    // fecha o @media/@container quando vier "}" logo depois
    const resto = b.slice(i).match(/^\s*\}/);
    if (resto) { em = ''; i += resto[0].length; }
  }
  return out;
}
const decl = (corpo: string, prop: string) => corpo.match(new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;]+)`))?.[1].trim();
const px = (v?: string) => (v ? parseFloat(v) : NaN);
function regra(sel: string, em = ''): string {
  const r = regras().find((x) => x.em === em && x.sel.split(',').map((s) => s.trim()).includes(sel));
  assert.ok(r, `regra "${sel}"${em ? ` em ${em}` : ''}`);
  return r.corpo;
}

test('principal, secundário e perigoso: letra 14 px peso 600, espaço 8 × 16, 40 px; 44 px no toque', () => {
  const c = regra('.card-act');
  assert.equal(px(decl(c, 'font-size')), LIMITES.principal.letra);
  assert.equal(Number(decl(c, 'font-weight')), LIMITES.principal.peso);
  assert.equal(decl(c, 'padding'), '8px 16px');
  assert.equal(px(decl(c, 'min-height')), LIMITES.principal.altura);
  assert.equal(px(decl(regra('.card-act', '@media (pointer: coarse)'), 'min-height')), LIMITES.principal.toque);
  for (const nivel of ['principal', 'secundario', 'perigoso'] as const) assert.match(ACAO[nivel], /\bcard-act\b/, `${nivel} usa .card-act`);
  // o secundário tem contorno de verdade (a cor do texto de apoio), nunca transparente
  const sec = regra('.card-act--sec');
  assert.equal(decl(sec, 'border-color'), 'var(--muted)');
  assert.doesNotMatch(ACAO.secundario, /btn--ghost/);
  assert.match(ACAO.perigoso, /btn--danger/);
  assert.match(ACAO_GRANDE.secundario, /card-act--sec/, 'o secundário grande do card também tem contorno');
});

test('leve, opções, selos: 32 px (44 no toque), 40 px (44), 12,5–13 px peso 600', () => {
  assert.equal(px(decl(regra('.card-act--leve'), 'min-height')), LIMITES.leve.altura);
  assert.equal(px(decl(regra('.card-act--leve', '@media (pointer: coarse)'), 'min-height')), LIMITES.leve.toque);
  const opt = regra('.question-card__opts .card-opt');
  assert.equal(px(decl(opt, 'min-height')), LIMITES.opcao.altura);
  assert.equal(px(decl(regra('.question-card__opts .card-opt', '@media (pointer: coarse)'), 'min-height')), LIMITES.opcao.toque);
  assert.equal(decl(regra('.question-card__opts .card-opt', '@container cartao (max-width: 420px)'), 'flex'), '1 1 100%', 'largura total no cartão estreito');
  const selo = regra('.card-selo');
  const letra = px(decl(selo, 'font-size'));
  assert.ok(letra >= LIMITES.selo.letraMin && letra <= LIMITES.selo.letraMax, `selo com ${letra} px`);
  assert.equal(Number(decl(selo, 'font-weight')), LIMITES.selo.peso);
  // o selo sempre com ícone: o componente desenha o ícone antes do texto
  assert.match(ler('components/Selo.tsx'), /<span className=\{`badge card-selo[^>]*><Icon name=\{icone\}/);
});

test('fileira: 8 px entre botões; estreita, o principal sozinho na 1ª linha em largura total', () => {
  const f = regra('.card-acts');
  assert.equal(px(decl(f, 'gap')), LIMITES.espaco);
  assert.match(decl(f, 'container') ?? '', /cartao \/ inline-size/);
  assert.equal(decl(regra('.card-act--primary', '@container cartao (max-width: 420px)'), 'flex'), '1 1 100%');
  // os outros dividem a 2ª linha (base 0): nenhum cartão passa de 2 linhas de botões
  assert.match(decl(regra('.card-acts > button:not(.card-act--primary)', '@container cartao (max-width: 420px)'), 'flex') ?? '', /^1 1 0/);
});

test('ações da mensagem: ícone de 16 px, área de 32 px, 4 px; à vista no toque e na última mensagem do agente', () => {
  assert.equal(px(decl(regra('.msg__acts'), 'gap')), LIMITES.mensagem.espaco);
  const b = regra('.msg__acts .linkish');
  assert.equal(px(decl(b, 'min-height')), LIMITES.mensagem.area);
  assert.equal(px(decl(b, 'min-width')), LIMITES.mensagem.area);
  assert.equal(px(decl(regra('.msg__acts .linkish svg'), 'width')), LIMITES.mensagem.icone);
  assert.equal(decl(regra('.msg__acts', '@media (hover: none), (pointer: coarse)'), 'opacity'), '1');
  assert.equal(decl(regra('.msg--ultima .msg__acts'), 'opacity'), '1');
  assert.match(ler('components/ChatPanel.tsx'), /m\.id === lastAgentId \? 'msg--ultima' : ''/);
});

test('botões miúdos (abrir, alfinete, ×): área de clique de 24 px (44 no toque) sem mudar o desenho', () => {
  for (const s of ['.dec-card__open::before', '.convs__pin::before', '.x::before', '.fchip__x::before']) {
    const c = regra(s);
    assert.equal(px(decl(c, 'width')), LIMITES.miudo.area, s);
    assert.equal(px(decl(c, 'height')), LIMITES.miudo.area, s);
    assert.equal(decl(c, 'position'), 'absolute');
    assert.equal(px(decl(regra(s, '@media (pointer: coarse)'), 'width')), LIMITES.miudo.toque, `${s} no toque`);
  }
});

test('recolher: mais de 3 ações viram principal + seletor + o resto; até 3, ficam soltas', () => {
  assert.equal(MAX_ACOES_SOLTAS, 3);
  assert.equal(recolhe(PRAZOS.length, 1), true, 'prazo: 1 h / 8 h / 72 h / sempre + Recusar');
  assert.equal(recolhe(ALCANCES.length, 1), true, 'regra: 3 alcances + Recusar');
  assert.equal(recolhe(2, 1), false);
  assert.equal(PRAZO_PADRAO, '8h', 'o principal é "Aprovar por 8 h"');
  assert.ok(PRAZOS.some(([p]) => p === PRAZO_PADRAO));
});

test('recolher não muda o que é enviado: cada escolha do seletor volta como o mesmo valor do botão de antes', () => {
  // os valores que a API espera (server/src/services/conexoes/regras.ts)
  assert.deepEqual(PRAZOS.map(([p]) => p), ['1h', '8h', '72h', 'sempre']);
  assert.deepEqual(ALCANCES.map(([a]) => a), ['pedido', '24h', 'sempre']);
  for (const [p] of PRAZOS) assert.equal(escolhaDoSeletor(p, PRAZOS, PRAZO_PADRAO), p);
  for (const [a] of ALCANCES) assert.equal(escolhaDoSeletor(a, ALCANCES, 'pedido'), a);
  assert.equal(escolhaDoSeletor('2h', PRAZOS, PRAZO_PADRAO), PRAZO_PADRAO, 'o que não está na lista fica no padrão');
  assert.equal(alcanceSugerido('{"alcance":"sempre"}'), 'sempre');
  assert.equal(alcanceSugerido('x'), 'pedido');
  // o componente: o seletor lista as mesmas escolhas e o principal manda a escolhida; o Recusar continua o mesmo
  const c = ler('components/CartaoRegra.tsx');
  assert.match(c, /\{escolhas\.map\(\(\[v\]\) => <option key=\{v\} value=\{v\}>/);
  assert.match(c, /onChange=\{\(e\) => setValor\(escolhaDoSeletor\(e\.target\.value, escolhas, inicial\)\)\}/);
  assert.match(c, /onClick=\{\(\) => \{ if \(!indo\) onEscolher\(valor\); \}\}/);
  assert.match(c, /onClick=\{\(\) => \{ if \(!indo\) onRecusar\(\); \}\}/);
  assert.match(c, /<Recolhido escolhas=\{PRAZOS\} inicial=\{PRAZO_PADRAO\}/);
  assert.match(c, /<Recolhido escolhas=\{ALCANCES\} inicial=\{sugerido\}/);
  // e quem usa continua mandando o prazo e o alcance do jeito de antes
  assert.match(ler('components/ChatPanel.tsx'), /onEscolher=\{\(prazo\) => void decide\(p\.id, 'apply', \{ prazo \}\)\}/);
  assert.match(ler('components/DecisionsPanel.tsx'), /onEscolher=\{\(prazo\) => void proposal\(p\.id, 'apply', \{ prazo \}\)\}/);
  assert.match(ler('components/TaskDetail.tsx'), /onEscolher=\{\(prazo\) => void decidir\(c\.id, 'apply', prazo\)\}/);
});

test('o seletor de prazo e o principal falam pt e en (nome acessível incluído)', () => {
  for (const [d, nome] of [[ptConexoes, 'pt'], [enConexoes, 'en']] as const) {
    const x = d as Record<string, unknown>;
    for (const k of ['cartao.aprovarPorPrazo', 'cartao.aprovarSempre', 'cartao.prazo', 'cartao.permitir.pedido', 'cartao.permitir.24h', 'cartao.permitir.sempre', 'cartao.enviando', 'cartao.recusando'])
      assert.equal(typeof x[k], 'string', `${nome}: ${k}`);
    assert.match(String(x['cartao.aprovarPorPrazo']), /\{prazo\}/);
  }
  assert.equal(ptConexoes['cartao.aprovarPorPrazo'].replace('{prazo}', ptConexoes['prazo.8h']), 'Aprovar por 8 h');
  const c = ler('components/CartaoRegra.tsx');
  assert.match(c, /<select [^>]*aria-label=\{seletor\}/, 'o seletor tem nome');
  assert.match(c, /role="group" aria-label=\{grupo\}/);
});

test('a trava do envio: o segundo clique não envia de novo; deu erro, abre para tentar de novo', async () => {
  const mudancas: Array<string | null> = [];
  const trava = criarTrava((v) => mudancas.push(v));
  let envios = 0;
  let solta!: () => void;
  const fn = () => { envios++; return new Promise<string>((ok) => { solta = () => ok('foi'); }); };
  const p1 = trava.rodar('aprovar', fn);
  const p2 = trava.rodar('aprovar', fn); // o segundo clique, com o primeiro indo
  const p3 = trava.rodar('recusar', fn); // e outro botão do mesmo cartão
  assert.equal(envios, 1);
  assert.equal(trava.indo, 'aprovar');
  assert.equal(await p2, undefined);
  assert.equal(await p3, undefined);
  solta();
  assert.equal(await p1, 'foi');
  assert.equal(trava.indo, null);
  assert.deepEqual(mudancas, ['aprovar', null]);
  // segurar: o cartão vai sumir quando a tela reler; até lá, nada passa
  const t2 = criarTrava();
  await t2.rodar('responder', async () => 1, true);
  assert.equal(t2.indo, 'responder');
  assert.equal(await t2.rodar('responder', async () => { envios++; return 2; }), undefined);
  assert.equal(envios, 1);
  // erro: abre, mesmo com segurar
  const t3 = criarTrava();
  await assert.rejects(t3.rodar('x', async () => { throw new Error('caiu'); }, true));
  assert.equal(t3.indo, null);
  assert.equal(await t3.rodar('x', async () => 'de novo'), 'de novo');
});

test('fim do botão desabilitado esperando: nada de disabled={busy} nos cartões; o botão diz "enviando" (aria-busy)', () => {
  const arquivos = ['components/ChatCards.tsx', 'components/CartaoRegra.tsx', 'components/DecisionsPanel.tsx', 'components/TaskDetail.tsx'];
  for (const f of arquivos) {
    const s = ler(f);
    assert.doesNotMatch(s, /disabled=\{[^}]*\b(busy|ocupado|indo|batchBusy)\b/, `${f}: disabled esperando`);
    assert.match(s, /aria-busy=\{/, `${f}: o botão marca aria-busy`);
  }
  // nos três primeiros, nenhum disabled (o campo vazio é "required": quem pede para escrever é o próprio formulário)
  for (const f of arquivos.slice(0, 3)) assert.doesNotMatch(ler(f), /\bdisabled\b/, f);
  // nem o "aplicar todas" da conversa
  assert.doesNotMatch(ler('components/ChatPanel.tsx'), /disabled=\{batchBusy\}/);
  // os cartões da conversa e de "Aguardando você" usam a trava (lib/envio.ts); o card e a conversa, uma trava em ref
  assert.match(ler('components/ChatCards.tsx'), /useEnvio\(\)/);
  assert.match(ler('components/DecisionsPanel.tsx'), /useEnvioPorItem\(\)/);
  assert.match(ler('components/TaskDetail.tsx'), /if \(busy \|\| indoRef\.current\) return;/);
  assert.match(ler('components/ChatPanel.tsx'), /if \(decidindo\.current\.has\(id\)\) return;/);
});

test('os cartões usam os níveis novos, não os botões pequenos', () => {
  for (const f of ['components/ChatCards.tsx', 'components/CartaoRegra.tsx', 'components/DecisionsPanel.tsx']) {
    const s = ler(f);
    assert.doesNotMatch(s, /btn--sm|btn--ghost/, `${f}: botão pequeno ou fantasma no cartão`);
    assert.doesNotMatch(s, /className="badge/, `${f}: selo sem ícone`);
  }
  // o card aberto (TaskDetail) usa os mesmos níveis nas ações dele
  const td = ler('components/TaskDetail.tsx');
  assert.doesNotMatch(td.slice(td.indexOf('const confirmBox'), td.indexOf('// o menu "⋯"')), /btn--sm|btn--ghost|className="btn /);
  const cartoes = td.slice(td.indexOf('{conexoes.length > 0 && ('), td.indexOf('{/* trabalho contínuo'));
  assert.doesNotMatch(cartoes, /btn--sm|btn--ghost/);
});

test('a trava por item: o clique noutro cartão enquanto um vai é enviado de verdade; o duplo clique no mesmo, não', async () => {
  const mudancas: string[] = [];
  const trava = criarTravaPorItem((m) => mudancas.push([...m].map(([k, v]) => `${k}:${v}`).join(',')));
  const enviados: string[] = [];
  const soltas = new Map<string, () => void>();
  const fn = (nome: string) => () => { enviados.push(nome); return new Promise<string>((ok) => { soltas.set(nome, () => ok(nome)); }); };
  const p12 = trava.rodar('12', 'approve', fn('12'));
  const p12b = trava.rodar('12', 'approve', fn('12 de novo')); // duplo clique no mesmo item
  const p12c = trava.rodar('12', 'return', fn('12 recusar')); // outro botão do mesmo item
  const p13 = trava.rodar('13', 'approve', fn('13')); // outro cartão, com o #12 indo: vai de verdade (como na rc.27)
  assert.deepEqual(enviados, ['12', '13']);
  assert.equal(await p12b, undefined);
  assert.equal(await p12c, undefined);
  // cada item diz o dele: nenhum "Aprovando…" num item que está devolvendo
  assert.equal(vaiNo(trava.indo, '12', 'approve'), true);
  assert.equal(vaiNo(trava.indo, '12', 'return'), false);
  assert.equal(vaiNo(trava.indo, '13'), true);
  assert.equal(vaiNo(trava.indo, '14'), false);
  soltas.get('13')!();
  assert.equal(await p13, '13');
  assert.equal(vaiNo(trava.indo, '13'), false, 'o #13 terminou e abriu');
  assert.equal(vaiNo(trava.indo, '12'), true, 'o #12 continua indo');
  soltas.get('12')!();
  assert.equal(await p12, '12');
  assert.equal(trava.indo.size, 0);
  assert.deepEqual(mudancas, ['12:approve', '12:approve,13:approve', '12:approve', '']);
  // segurar: o cartão vai sumir quando a tela reler; até lá só ele fica preso
  const t2 = criarTravaPorItem();
  await t2.rodar('a', 'answer', async () => 1, true);
  assert.equal(await t2.rodar('a', 'answer', async () => 2), undefined);
  assert.equal(await t2.rodar('b', 'answer', async () => 3), 3);
  // erro: abre o item, mesmo com segurar
  await assert.rejects(t2.rodar('c', 'x', async () => { throw new Error('caiu'); }, true));
  assert.equal(await t2.rodar('c', 'x', async () => 'de novo'), 'de novo');
});

test('"Aguardando você" e Conexões › Regras travam por item; o Aprovar só diz "Aprovando…" quando é a aprovação que vai', () => {
  const d = ler('components/DecisionsPanel.tsx');
  assert.match(d, /const \{ vai, enviar \} = useEnvioPorItem\(\);/);
  // nenhuma saída que descarta o clique por causa de OUTRO item
  assert.doesNotMatch(d, /if \(busy\) return|if \(!busy\)|useEnvio\(\)/);
  assert.match(d, /const act = \(id: string, acao: string, fn: [^\n]+=> enviar\(id, acao, async/);
  assert.match(d, /aria-busy=\{vai\(c\.id, 'approve'\)\} onClick=\{\(\) => void respond\(c\.id, 'approve'\)\}>\{vai\(c\.id, 'approve'\) \? t\('servidor\.decisoes\.aprovando'\)/);
  assert.match(d, /aria-busy=\{vai\(c\.id, 'return'\)\}>\{vai\(c\.id, 'return'\) \? t\('servidor\.decisoes\.enviando'\) : t\('servidor\.decisoes\.devolver'\)/);
  // o Cancelar da devolução não age no meio do envio (o formulário fica até ela terminar)
  assert.match(d, /onClick=\{\(\) => \{ if \(!vai\(c\.id\)\) \{ semAviso\(c\.id\); setReturning\(null\); \} \}\}>\{t\('servidor\.decisoes\.cancelar'\)\}/);
  // o fim de um envio fecha só o formulário dele, não o que a pessoa abriu noutro cartão
  assert.match(d, /setReturning\(\(cur\) => \(cur === taskId \? null : cur\)\)/);
  // abrir o Recusar de OUTRO card no meio de uma devolução não some com o formulário dela (o `returning` é um só):
  // sem isto, o card que está devolvendo voltava a mostrar Aprovar/Recusar parados, sem dizer que algo vai
  assert.match(d, /\) : returning === c\.id \|\| vai\(c\.id, 'return'\) \? \(/);
  // enviar a resposta tira o aviso do campo vazio daquele card ("seguir sem" não fica com o aviso embaixo)
  assert.match(d, /const respond = \([^)]*\) => \{ semAviso\(taskId\); return act\(taskId, action,/);
  assert.match(ler('components/ChatCards.tsx'), /setErr\(null\); setAviso\(false\);\n    await api\.post\(`\/api\/proposals\/\$\{p\.id\}\/respond`/);
  const cx = ler('views/ConexoesView.tsx');
  const i = cx.indexOf('function Regras()');
  const regrasTela = cx.slice(i, cx.indexOf('\nfunction ', i + 1));
  assert.match(regrasTela, /const \{ vai, enviar \} = useEnvioPorItem\(\);/);
  assert.match(regrasTela, /=> enviar\(id, acao, async/);
  assert.doesNotMatch(regrasTela, /fazendo\.current|useRef\(|disabled=/,'nem trava do painel inteiro, nem botão cinza esperando');
  assert.match(regrasTela, /ocupado=\{vai\(c\.id, 'recusar'\) \? 'recusar' : vai\(c\.id\) \? 'aplicar' : false\}/);
});

test('campo só com espaços (ou curto demais no Devolver): o clique e o Enter avisam no cartão, em pt e en', () => {
  assert.equal(textoCurto(''), true);
  assert.equal(textoCurto('   '), true);
  assert.equal(textoCurto(' \n\t'), true);
  assert.equal(textoCurto(' a '), false);
  assert.equal(textoCurto('ab ', 3), true, '"ab " passa no minLength do navegador, mas aparado é curto');
  assert.equal(textoCurto(' abc ', 3), false);
  for (const [dic, nome] of [[ptTarefa, 'pt'], [enTarefa, 'en']] as const) {
    const x = dic as Record<string, unknown>;
    assert.equal(typeof x.escrevaResposta, 'string', `${nome}: escrevaResposta`);
    assert.equal(typeof x['ajuste.minimo'], 'string', `${nome}: ajuste.minimo`);
  }
  const c = ler('components/ChatCards.tsx');
  // RequestCard: o botão e o Enter passam pelo mesmo enviar1, que avisa em vez de sair calado
  assert.match(c, /const enviar1 = \(\) => \{ if \(textoCurto\(text\)\) \{ setAviso\(true\); return; \}/);
  assert.match(c, /onKeyDown=\{\(e\) => \{ if \(e\.key === 'Enter' && !e\.shiftKey\) \{ e\.preventDefault\(\); enviar1\(\); \} \}\}/);
  assert.match(c, /onSubmit=\{\(e\) => \{ e\.preventDefault\(\); enviar1\(\); \}\}/);
  // QuestionCard "Outra resposta" (o Enter no campo envia o formulário, que passa pelo mesmo answer)
  assert.match(c, /if \(textoCurto\(a\)\) \{ setAviso\(true\); return; \}/);
  assert.match(c, /onSubmit=\{\(e\) => \{ e\.preventDefault\(\); answer\('outra', other\); \}\}/);
  assert.equal((c.match(/role="alert">\{t\('tarefa\.escrevaResposta'\)\}<\/p>/g) ?? []).length, 2, 'o aviso nos dois cartões');
  assert.doesNotMatch(c, /if \(!a\.trim\(\)\) return|if \(v\) send\(/);
  // "Aguardando você": Responder e Devolver (este com o mínimo de 3 letras depois de aparar), aviso no próprio cartão
  const d = ler('components/DecisionsPanel.tsx');
  assert.match(d, /if \(textoCurto\(v\)\) \{ setAviso\(\{ id: c\.id, texto: t\('tarefa\.escrevaResposta'\) \}\); return; \}/);
  assert.match(d, /if \(textoCurto\(v, 3\)\) \{ setAviso\(\{ id: c\.id, texto: t\('tarefa\.ajuste\.minimo'\) \}\); return; \}/);
  assert.match(d, /aviso=\{aviso\?\.id === c\.id \? aviso\.texto : null\}/);
  assert.match(d, /\{aviso && <p className="error small dec-card__aviso" role="alert" data-card-skip>\{aviso\}<\/p>\}/);
  assert.doesNotMatch(d, /if \(v\.trim\(\)\) void|v\.trim\(\)\.length >= 3\) void/);
});
