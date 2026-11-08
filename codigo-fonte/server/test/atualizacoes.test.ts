import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { UpdateCheck } from '../src/version.ts';
import { harness, req, setupOwner } from './helpers.ts';

const URL_MANIFESTO = 'https://github.com/dono/ergon-community/releases/latest/download/latest.json';
const RELEASES = [
  { tag_name: 'canal-teste', prerelease: true, html_url: 'https://github.com/x/canal' },
  { tag_name: 'v1.1.0-rc.23', prerelease: true, html_url: 'https://github.com/x/rc23', body: 'novidades da rc.23', published_at: '2026-11-08T00:00:00Z' },
  { tag_name: 'v1.1.0-rc.22', prerelease: true, html_url: 'https://github.com/x/rc22' },
  { tag_name: 'v1.1.0-rc.21', prerelease: true, html_url: 'https://github.com/x/rc21' },
  { tag_name: 'v1.0.1', prerelease: false, html_url: 'https://github.com/x/101' },
  { tag_name: 'v1.0.2', draft: true, prerelease: false },
];

describe('Atualizações: canal pela versão instalada, versões anteriores e aviso desligável', () => {
  const realFetch = globalThis.fetch;
  let calls: string[] = [];
  const mock = (ok = true) => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input); calls.push(url);
      if (!ok) throw new Error('sem rede');
      if (url.startsWith('https://api.github.com/repos/dono/ergon-community/releases')) return new Response(JSON.stringify(RELEASES), { status: 200 });
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
  };
  after(() => { globalThis.fetch = realFetch; });

  test('pré-versão instalada vê as pré-versões; a mais nova e as anteriores em ordem; ignora canal-teste e rascunho', async () => {
    mock(); calls = [];
    const u = new UpdateCheck(URL_MANIFESTO, '1.1.0-rc.22');
    const st = await u.check();
    assert.equal(st.latest?.version, '1.1.0-rc.23');
    assert.equal(st.latest?.notes, 'novidades da rc.23');
    assert.deepEqual(st.releases.map((r) => r.version), ['1.1.0-rc.23', '1.1.0-rc.22', '1.1.0-rc.21', '1.0.1']);
    assert.ok(st.checkedAt);
    await u.check();
    assert.equal(calls.length, 1, 'no máximo uma consulta por minuto');
  });

  test('versão final só enxerga versões finais', async () => {
    mock();
    const st = await new UpdateCheck(URL_MANIFESTO, '1.0.1').check();
    assert.deepEqual(st.releases.map((r) => r.version), ['1.0.1']);
  });

  test('sem rede: não quebra e não inventa versão', async () => {
    mock(false);
    const st = await new UpdateCheck(URL_MANIFESTO, '1.1.0-rc.22').check();
    assert.equal(st.latest, null);
    assert.equal(st.checkedAt, null);
  });

  test('/api/version sem ?verificar não vai à rede; o aviso ao abrir é preferência da pessoa (ligado por padrão)', async () => {
    mock(); calls = [];
    const h = await harness({ updateUrl: URL_MANIFESTO });
    const s = await setupOwner(h);
    const v = (await req(h, 'GET', '/api/version', s)).json;
    assert.equal(calls.length, 0);
    assert.equal(v.configured, true);
    const v2 = (await req(h, 'GET', '/api/version?verificar=1', s)).json;
    assert.equal(calls.length, 1);
    assert.ok(Array.isArray(v2.previous));
    assert.equal((await req(h, 'GET', '/api/me', s)).json.prefs.updateNotice, true);
    assert.equal((await req(h, 'PUT', '/api/me/prefs', s, { updateNotice: false })).json.updateNotice, false);
    assert.equal((await req(h, 'GET', '/api/me', s)).json.prefs.updateNotice, false);
    await h.close();
  });
});
