// Motoristas dos testes do Ergon Desktop: os mesmos passos dentro do WebView de verdade — WebView2 (Windows) pelo
// protocolo de depuração (CDP) e WebKitGTK (Linux) pelo WebDriver (tauri-driver + WebKitWebDriver).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * WebView2 via CDP. `origem`: espera a janela chegar a essa origem (null = qualquer página, ex.: a tela de abertura).
 */
export async function cdp({ base, origem = null, saida }) {
  let alvo;
  for (let i = 0; i < 90 && !alvo; i++) {
    try { alvo = (await (await fetch(`${base}/json`)).json()).find((t) => t.type === 'page' && (!origem || t.url.startsWith(origem))); } catch { /* abrindo */ }
    if (!alvo) await sleep(1000);
  }
  if (!alvo) throw new Error(origem ? `a janela não chegou a ${origem}` : 'a janela não abriu');
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok, erro) => { ws.onopen = ok; ws.onerror = erro; });
  let n = 0; const espera = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && espera.has(d.id)) { espera.get(d.id)(d); espera.delete(d.id); } };
  const send = (method, params = {}) => new Promise((ok, erro) => {
    const id = ++n; espera.set(id, (d) => (d.error ? erro(new Error(`${method}: ${d.error.message}`)) : ok(d.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Runtime.enable'); await send('Page.enable'); await send('DOM.enable');
  return {
    nome: 'WebView2 (CDP)',
    send,
    async eval(js) {
      const r = await send('Runtime.evaluate', { expression: `(async () => (${js}))()`, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
    async type(sel, texto) {
      await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.focus(); e.select?.(); return true })()`);
      await send('Input.insertText', { text: texto });
    },
    /** clique de verdade (eventos de mouse do sistema), no centro do elemento */
    async click(sel) {
      const r = await this.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); e.scrollIntoView({ block: 'center' }); const b = e.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 } })()`);
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: r.x, y: r.y, button: 'left', clickCount: 1 });
    },
    async setFiles(sel, files) {
      const { root } = await send('DOM.getDocument', { depth: 0 });
      const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: sel });
      await send('DOM.setFileInputFiles', { nodeId, files });
    },
    async shot(nome) {
      const { data } = await send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(saida, nome), Buffer.from(data, 'base64'));
    },
    async passkeyVirtual() {
      await send('WebAuthn.enable', { enableUI: false });
      await send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
      return true;
    },
    async fim() { ws.close(); },
  };
}

/** WebKitGTK via WebDriver: abre o aplicativo (`app`) numa sessão nova. */
export async function webdriver({ base, app, origem = null, saida }) {
  // prazo em toda chamada: um WebDriver travado vira erro com nome, não uma espera sem fim
  const req = async (metodo, caminho, corpo, prazo = caminho === '/session' ? 90000 : 60000) => {
    const r = await fetch(`${base}${caminho}`, { method: metodo, headers: { 'content-type': 'application/json' }, body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(prazo) })
      .catch((e) => { throw new Error(`WebDriver ${metodo} ${caminho.replace(/\/session\/[^/]+/, '/session/…')}: ${e.message}`); });
    const j = await r.json();
    if (j.value?.error) throw new Error(`${caminho}: ${j.value.message}`);
    return j.value;
  };
  const sessao = await req('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: app } } } });
  const id = sessao.sessionId;
  const EL = 'element-6066-11e4-a52e-4f735466cecf';
  const achar = async (sel) => (await req('POST', `/session/${id}/element`, { using: 'css selector', value: sel }))[EL];
  const m = {
    nome: 'WebKitGTK (WebDriver)',
    async eval(js) {
      const v = await req('POST', `/session/${id}/execute/async`, {
        script: `const fim = arguments[arguments.length - 1]; (async () => (${js}))().then((v) => fim({ v }), (e) => fim({ erro: String(e && e.message || e) }));`, args: [],
      });
      if (v && 'erro' in v) throw new Error(v.erro);
      return v?.v;
    },
    async type(sel, texto) { const e = await achar(sel); await req('POST', `/session/${id}/element/${e}/clear`, {}); await req('POST', `/session/${id}/element/${e}/value`, { text: texto }); },
    async click(sel) { const e = await achar(sel); await req('POST', `/session/${id}/element/${e}/click`, {}); },
    async setFiles(sel, files) { const e = await achar(sel); await req('POST', `/session/${id}/element/${e}/value`, { text: files.join('\n') }); },
    /** a captura do WebKitWebDriver às vezes não volta sob Xvfb: tenta 15 s e cai para a captura do X (a tela inteira) */
    async shot(nome) {
      const destino = path.join(saida, nome);
      try { fs.writeFileSync(destino, Buffer.from(await req('GET', `/session/${id}/screenshot`, null, 15000), 'base64')); }
      catch { try { execFileSync('import', ['-window', 'root', destino]); } catch { /* sem captura: o passo segue */ } }
    },
    async passkeyVirtual() { return false; },
    async fim() { await req('DELETE', `/session/${id}`).catch(() => {}); },
  };
  if (origem) for (let i = 0; i < 90; i++) { try { if ((await m.eval('location.origin')) === origem) break; } catch { /* navegando */ } await sleep(1000); }
  return m;
}
