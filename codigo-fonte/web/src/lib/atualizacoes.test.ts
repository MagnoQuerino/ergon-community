import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';
import { LISTA_ANTERIORES, PEDIDO_VOLTAR, VOLTA_ANTERIORES, anteriores, textoVersoesAnteriores, voltaNaLista } from './atualizacoes.ts';
import { inDesktopApp, rememberDesktopApp, rollbackInDesktopApp } from './desktop.ts';

const v = (version: string, rollback?: 'pode' | 'antiga' | 'sem-pacote' | 'instalada-fora') => ({ version, url: `https://github.com/x/${version}`, publishedAt: null, prerelease: true, rollback });
const ADMIN = { app: true, admin: true };

test('no Ergon Desktop, a versão com o pacote assinado ganha o botão que leva à tela do aplicativo', () => {
  const r = voltaNaLista(v('1.1.0-rc.25', 'pode'), ADMIN);
  assert.equal(r.voltar, '/__desktop/voltar?versao=1.1.0-rc.25');
  assert.equal(r.nota, null);
});

test('antiga demais ou sem o pacote: sem botão, com o porquê em palavras simples', () => {
  const antiga = voltaNaLista(v('1.1.0-rc.9', 'antiga'), ADMIN);
  assert.equal(antiga.voltar, null);
  assert.match(antiga.nota ?? '', /antiga demais/i);
  assert.match(antiga.nota ?? '', /equipe/, 'diz que a equipe não voltaria junto');
  for (const r of [v('1.1.0-rc.25', 'sem-pacote'), v('1.1.0-rc.25')]) {
    const s = voltaNaLista(r, ADMIN);
    assert.equal(s.voltar, null);
    assert.match(s.nota ?? '', /página dela/);
  }
  // a instalada já não está entre as publicadas recentemente: o aplicativo recusaria sempre, então nem botão, e o porquê
  const fora = voltaNaLista(v('1.1.0-rc.25', 'instalada-fora'), ADMIN);
  assert.equal(fora.voltar, null);
  assert.match(fora.nota ?? '', /já não está entre as publicadas recentemente/);
  assert.match(fora.nota ?? '', /Na página desta versão está o instalador/);
});

test('fora do aplicativo (navegador, servidor) ou onde a volta pelo aplicativo não vale (Linux): só a página da versão', () => {
  assert.deepEqual(voltaNaLista(v('1.1.0-rc.25', 'pode'), { app: false, admin: true }), { voltar: null, nota: null });
  assert.match(textoVersoesAnteriores({ app: false, admin: true }), /Baixe o da versão escolhida/, 'a orientação de baixar o instalador continua');
});

test('quem não administra não ganha o botão: a volta muda o Ergon de todas as pessoas', () => {
  for (const rollback of ['pode', 'antiga', 'sem-pacote'] as const) {
    assert.deepEqual(voltaNaLista(v('1.1.0-rc.25', rollback), { app: true, admin: false }), { voltar: null, nota: null }, rollback);
  }
  const t = textoVersoesAnteriores({ app: true, admin: false });
  assert.match(t, /peça a quem administra/);
  assert.doesNotMatch(t, /Voltar para esta versão/);
  assert.match(textoVersoesAnteriores(ADMIN), /Voltar para esta versão/);
});

test('no Ergon Desktop só as duas versões anteriores aparecem (decisão de 09/11), e o texto diz isso; fora dele, a lista dos instaladores segue', () => {
  assert.equal(VOLTA_ANTERIORES, 2);
  assert.equal(LISTA_ANTERIORES, 12);
  const lista = [v('1.1.0-rc.26'), v('1.1.0-rc.25'), v('1.1.0-rc.24')];
  assert.deepEqual(anteriores(lista, true).map((x) => x.version), ['1.1.0-rc.26', '1.1.0-rc.25']);
  assert.deepEqual(anteriores(lista, false).map((x) => x.version), ['1.1.0-rc.26', '1.1.0-rc.25', '1.1.0-rc.24'], 'fora do Desktop: a volta é pelo instalador da página');
  assert.equal(anteriores(Array.from({ length: 20 }, (_, i) => v(`1.1.0-rc.${i}`)), false).length, 12);
  assert.deepEqual(anteriores(undefined, true), []);
  assert.match(textoVersoesAnteriores(ADMIN), /só para as duas versões anteriores/);
  assert.doesNotMatch(textoVersoesAnteriores({ app: false, admin: true }), /duas/, 'fora do Desktop, o texto não fala em duas');
  assert.match(textoVersoesAnteriores(ADMIN), /se o backup não der certo, você escolhe se volta mesmo assim/);
  const tsx = readFileSync(new URL('../views/AtualizacoesPanel.tsx', import.meta.url), 'utf8');
  assert.ok(tsx.includes('anteriores(d.previous, voltaPeloApp).map'));
  // a segunda chance sem backup continua na tela do aplicativo
  const js = readFileSync(new URL('../../../desktop/ui/abertura.js', import.meta.url), 'utf8');
  assert.ok(js.includes("semBackup: 'Voltar mesmo sem backup'"));
});

test('o endereço do pedido é o que o aplicativo intercepta (janela.rs) e a versão vai codificada', () => {
  const rs = readFileSync(new URL('../../../desktop/src-tauri/src/janela.rs', import.meta.url), 'utf8');
  assert.ok(rs.includes(`pub const PEDIDO_VOLTAR: &str = "${PEDIDO_VOLTAR}";`));
  assert.equal(voltaNaLista(v('1.1.0#x', 'pode'), ADMIN).voltar, '/__desktop/voltar?versao=1.1.0%23x');
});

test('a tela de Atualizações usa o botão no aplicativo, só onde vale e para quem administra', () => {
  const tsx = readFileSync(new URL('../views/AtualizacoesPanel.tsx', import.meta.url), 'utf8');
  assert.match(tsx, /Voltar para esta versão/);
  assert.match(tsx, /voltaNaLista\(r, \{ app: voltaPeloApp, admin \}\)/);
  assert.match(tsx, /textoVersoesAnteriores\(\{ app: voltaPeloApp, admin \}\)/);
  assert.match(tsx, /const voltaPeloApp = rollbackInDesktopApp\(\)/);
  assert.doesNotMatch(tsx, /a volta ainda não é feita pelo próprio aplicativo/);
});

// ---- o aplicativo diz à página se a volta vale ali ("?app=desktop&volta=1", janela.rs endereco_do_ergon)
const g = globalThis as unknown as Record<string, unknown>;
function pagina(href: string) {
  const guardado = new Map<string, string>();
  g.sessionStorage = { getItem: (k: string) => guardado.get(k) ?? null, setItem: (k: string, x: string) => { guardado.set(k, x); }, removeItem: (k: string) => { guardado.delete(k); } };
  const loc = { href };
  g.location = loc;
  g.history = { state: null, replaceState: (_s: unknown, _t: string, u: string) => { loc.href = new URL(u, href).href; } };
  return loc;
}
afterEach(() => { delete g.sessionStorage; delete g.location; delete g.history; });

test('no aplicativo do Windows com o ambiente próprio, a página guarda que a volta vale ali', () => {
  const loc = pagina('http://localhost:8787/?app=desktop&volta=1');
  rememberDesktopApp();
  assert.equal(inDesktopApp(), true);
  assert.equal(rollbackInDesktopApp(), true);
  assert.equal(loc.href, 'http://localhost:8787/', 'o endereço fica limpo');
  // a aba navega dentro do Ergon: continua valendo
  loc.href = 'http://localhost:8787/configuracoes';
  rememberDesktopApp();
  assert.equal(rollbackInDesktopApp(), true);
});

test('no aplicativo do Linux (sem "volta=1"): é o aplicativo, mas a volta não é por ele', () => {
  pagina('http://localhost:8787/?app=desktop');
  rememberDesktopApp();
  assert.equal(inDesktopApp(), true);
  assert.equal(rollbackInDesktopApp(), false);
});

test('no navegador, nem aplicativo nem volta, mesmo com "volta=1" solto no endereço', () => {
  pagina('http://localhost:8787/?volta=1');
  rememberDesktopApp();
  assert.equal(inDesktopApp(), false);
  assert.equal(rollbackInDesktopApp(), false);
});
