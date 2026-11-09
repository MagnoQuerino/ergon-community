import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { anterioresParaVoltar, LISTA_ANTERIORES, RECENTES_DO_CANAL, rollbackOf, UpdateCheck, VOLTA_ANTERIORES, VOLTA_MINIMA } from '../src/version.ts';
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

  test('voltar pelo aplicativo: só para versão com o pacote assinado do canal e não anterior à mínima', async () => {
    const assinado = (canal: string) => [{ name: `manifesto-${canal}.json` }, { name: `manifesto-${canal}.json.sig` }, { name: 'ergon-local-x.zip' }];
    const lista = [
      { tag_name: 'v1.1.0-rc.26', prerelease: true, html_url: 'https://github.com/x/rc26', assets: assinado('teste') },
      { tag_name: 'v1.1.0-rc.25', prerelease: true, html_url: 'https://github.com/x/rc25', assets: assinado('teste') },
      // só o manifesto, sem a assinatura: não serve
      { tag_name: 'v1.1.0-rc.22', prerelease: true, html_url: 'https://github.com/x/rc22', assets: [{ name: 'manifesto-teste.json' }] },
      // pacote do outro canal: o aplicativo do canal de teste recusaria
      { tag_name: 'v1.1.0-rc.21', prerelease: true, html_url: 'https://github.com/x/rc21', assets: assinado('estavel') },
      { tag_name: 'v1.1.0-rc.23', prerelease: true, html_url: 'https://github.com/x/rc23', assets: assinado('teste') },
      { tag_name: 'v1.1.0-rc.13', prerelease: true, html_url: 'https://github.com/x/rc13', assets: assinado('teste') },
      { tag_name: 'v1.1.0-rc.9', prerelease: true, html_url: 'https://github.com/x/rc9', assets: assinado('teste') },
      { tag_name: 'v1.1.0', prerelease: false, html_url: 'https://github.com/x/110', assets: assinado('estavel') },
      { tag_name: 'v1.1.1', prerelease: false, html_url: 'https://github.com/x/111' },
    ];
    globalThis.fetch = (async () => new Response(JSON.stringify(lista), { status: 200 })) as typeof fetch;
    const st = await new UpdateCheck(URL_MANIFESTO, '1.1.0-rc.26').check();
    const por = Object.fromEntries(st.releases.map((r) => [r.version, r.rollback]));
    assert.deepEqual(por, { '1.1.0-rc.26': 'pode', '1.1.0-rc.25': 'pode', '1.1.0-rc.23': 'antiga', '1.1.0-rc.22': 'antiga', '1.1.0-rc.21': 'antiga', '1.1.0-rc.13': 'antiga', '1.1.0-rc.9': 'antiga', '1.1.1': 'sem-pacote', '1.1.0': 'sem-pacote' });
    const estavel = await new UpdateCheck(URL_MANIFESTO, '1.1.1').check();
    assert.deepEqual(estavel.releases.map((r) => [r.version, r.rollback]), [['1.1.1', 'sem-pacote'], ['1.1.0', 'pode']], 'canal estável: o pacote estável');
    assert.equal(VOLTA_MINIMA, '1.1.0-rc.24', 'antes da rc.24 a equipe não voltaria junto (o gerente não recriava o motor)');
    assert.equal(rollbackOf('1.1.0-rc.24', assinado('teste').map((a) => a.name), 'teste'), 'pode', 'a mínima ainda pode');
    assert.equal(rollbackOf('1.1.0-rc.24', ['manifesto-teste.json'], 'teste'), 'sem-pacote', 'só o manifesto, sem a assinatura: não serve');
    assert.equal(rollbackOf('1.1.0-rc.24', assinado('estavel').map((a) => a.name), 'teste'), 'sem-pacote', 'pacote do outro canal');
    assert.equal(rollbackOf('1.0.1', assinado('estavel').map((a) => a.name), 'estavel'), 'antiga');
  });

  test('as versões anteriores, a mais nova primeiro; o corte nas duas é do Desktop (a tela e o aplicativo), não da lista toda', () => {
    assert.equal(VOLTA_ANTERIORES, 2);
    assert.equal(LISTA_ANTERIORES, 12);
    const r = (version: string) => ({ version, rollback: 'pode' as const });
    const lista = [r('1.1.0-rc.28'), r('1.1.0-rc.24'), r('1.1.0-rc.27'), r('1.1.0-rc.25'), r('1.1.0-rc.26'), r('1.1.0-rc.9')];
    assert.deepEqual(anterioresParaVoltar(lista, '1.1.0-rc.27').map((x) => x.version), ['1.1.0-rc.26', '1.1.0-rc.25', '1.1.0-rc.24', '1.1.0-rc.9'], 'a mais nova primeiro; nem a instalada nem as mais novas');
    assert.deepEqual(anterioresParaVoltar(lista, '1.1.0-rc.25').map((x) => x.version), ['1.1.0-rc.24', '1.1.0-rc.9'], 'número, não texto');
    assert.deepEqual(anterioresParaVoltar(lista, '1.1.0-rc.9'), [], 'nenhuma antes');
    // fora do Desktop, a lista dos instaladores segue com até 12 (antes de 09/11, também 12)
    const muitas = Array.from({ length: 20 }, (_, i) => r(`1.1.0-rc.${i + 1}`));
    assert.equal(anterioresParaVoltar(muitas, '1.1.0-rc.20').length, 12);
    assert.ok(anterioresParaVoltar(muitas, '1.1.0-rc.20').every((x) => x.rollback === 'pode'));
    // a instalada já não está entre as publicadas recentemente (a página dela saiu, ou ficou mais de 12 versões para trás):
    // o aplicativo recusaria sempre; a lista não oferece o botão e diz por quê
    assert.deepEqual(anterioresParaVoltar(lista, '1.1.0-rc.23').map((x) => [x.version, x.rollback]), [['1.1.0-rc.9', 'instalada-fora']], 'a página da instalada saiu');
    assert.ok(anterioresParaVoltar(muitas, '1.1.0-rc.5').every((x) => x.rollback === 'instalada-fora'), 'a 16ª mais nova');
    assert.ok(anterioresParaVoltar(muitas, '1.1.0-rc.9').every((x) => x.rollback === 'pode'), 'a 12ª mais nova ainda está na lista do canal');
    assert.deepEqual(anterioresParaVoltar([{ version: '1.1.0-rc.24', rollback: 'antiga' as const }], '1.1.0-rc.99').map((x) => x.rollback), ['antiga'], 'só o "pode" muda');
    // a rota usa a mesma regra; o aplicativo confere de novo do lado dele
    const app = fs.readFileSync(path.resolve(import.meta.dirname, '../src/app.ts'), 'utf8');
    assert.ok(app.includes('previous: anterioresParaVoltar(st.releases)'));
    const rs = fs.readFileSync(path.resolve(import.meta.dirname, '../../desktop/src-tauri/src/atualizacao.rs'), 'utf8');
    assert.ok(rs.includes('fora_das_duas_anteriores(alvo, instalada'));
    // quantas o manifesto do canal carrega em "recentes" é o que a lista usa para saber se a instalada ainda está nela
    const mjs = fs.readFileSync(path.resolve(import.meta.dirname, '../../scripts/distribuicao/manifesto.mjs'), 'utf8');
    assert.equal(Number(/export const RECENTES = (\d+);/.exec(mjs)?.[1]), RECENTES_DO_CANAL);
  });

  test('a versão mínima para voltar é a mesma no servidor e no aplicativo do computador', () => {
    const rs = fs.readFileSync(path.resolve(import.meta.dirname, '../../desktop/src-tauri/src/atualizacao.rs'), 'utf8');
    const m = /pub const VOLTA_MINIMA: &str = "([^"]+)";/.exec(rs);
    assert.ok(m, 'VOLTA_MINIMA no aplicativo');
    assert.equal(m[1], VOLTA_MINIMA);
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
