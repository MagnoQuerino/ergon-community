// Fechar a janela do aplicativo (rc.40): a página e o aplicativo (desktop/src-tauri/src/fechar.rs) combinam os mesmos
// endereços; a pergunta do aplicativo fecha na hora sem ninguém segurando e vira o evento quando a sincronia segura.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const guardado = new Map<string, string>();
const g = globalThis as unknown as Record<string, unknown>;
g.sessionStorage = { getItem: (k: string) => guardado.get(k) ?? null, setItem: (k: string, v: string) => { guardado.set(k, v); }, removeItem: (k: string) => { guardado.delete(k); } };
const loc = { href: 'http://localhost:8787/?app=desktop&downloads=1&fechar=1#cidade', pathname: '/', search: '?app=desktop&downloads=1&fechar=1', hash: '#cidade' };
g.location = loc;
g.history = { state: null, replaceState: (_s: unknown, _t: string, u: string) => { loc.href = `http://localhost:8787${u}`; } };
const win = new EventTarget() as EventTarget & { __ergonFechar?: () => void };
g.window = win;

const { rememberDesktopApp, fecharInDesktopApp } = await import('./desktop.ts');
const { EVENTO_FECHAR, FECHAR, guardarFechar, instalarFechar } = await import('./fechar.ts');

test('os endereços da resposta são os que o aplicativo atende (fechar.rs), e a pergunta cai para sair na página de antes', () => {
  const rs = readFileSync(new URL('../../../desktop/src-tauri/src/fechar.rs', import.meta.url), 'utf8');
  for (const [nome, p] of [['ESPERA', FECHAR.espera], ['ENCERRANDO', FECHAR.encerrando], ['CANCELAR', FECHAR.cancelar], ['SAIR', FECHAR.sair]] as const)
    assert.ok(rs.includes(`pub const ${nome}: &str = "${p}";`), nome);
  assert.ok(rs.includes(`location.assign('${FECHAR.sair}')`));
  const janela = readFileSync(new URL('../../../desktop/src-tauri/src/janela.rs', import.meta.url), 'utf8');
  assert.match(janela, /\?app=desktop&downloads=1&fechar=1/, 'o aplicativo diz à página que pergunta antes de fechar');
});

test('no aplicativo que pergunta: sem ninguém segurando, fecha na hora; com a sincronia segurando, vira o evento', () => {
  rememberDesktopApp();
  assert.equal(fecharInDesktopApp(), true);
  assert.ok(!loc.href.includes('fechar=1'), 'o endereço fica limpo');
  instalarFechar();
  assert.equal(typeof win.__ergonFechar, 'function');
  win.__ergonFechar!();
  assert.equal(loc.href, FECHAR.sair);
  let ouviu = 0; win.addEventListener(EVENTO_FECHAR, () => { ouviu++; });
  const sair = guardarFechar();
  loc.href = '/'; win.__ergonFechar!();
  assert.deepEqual([ouviu, loc.href], [1, '/'], 'quem segura decide (a página não sai)');
  sair(); sair(); // sair duas vezes não desconta duas
  win.__ergonFechar!();
  assert.deepEqual([ouviu, loc.href], [1, FECHAR.sair]);
});

test('aplicativo de antes (sem "fechar=1") ou navegador: nada muda no fechamento', () => {
  delete win.__ergonFechar;
  loc.search = '?app=desktop&downloads=1'; loc.href = 'http://localhost:8787/?app=desktop&downloads=1';
  rememberDesktopApp();
  assert.equal(fecharInDesktopApp(), false);
  instalarFechar();
  assert.equal(win.__ergonFechar, undefined);
});
