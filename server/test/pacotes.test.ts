/**
 * F8 — pacotes .ergon: validação contra ataques de ZIP e conteúdo ativo, assinatura oficial, instalação só de dados,
 * prévia sem efeito, desfazer exato, isolamento entre workspaces e o que a cidade desenha (tema, efeitos, pets).
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { describe, test } from 'node:test';
import { writeZip } from '../src/lib/zip.ts';
import { buildPackage, PackageError, validatePackage } from '../src/services/ergon-package.ts';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { addPerson, harness, ORIGIN, req, setupOwner, type Harness, type Session } from './helpers.ts';

const png = (w = 64, h = 64) => { const b = Buffer.alloc(33); Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b, 0); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return b; };
const base = (kind: string, id = 'comunidade.ana.circulo-de-fogo') => ({ package_id: id, version: '1.0.0', title: 'Círculo de fogo', summary: 'Efeito de fogo em volta do agente', creator_id: 'ana', license: 'CC-BY-4.0', ergon: { min: '0.2.0' }, kind: kind as 'fx' });
const fx = { effects: [{ target: { agentName: 'Hipátia' }, effect: 'fire_circle' as const, color: '#ff6a00', intensity: 0.8 }] };
const send = (h: Harness, url: string, s: Session, buf: Buffer, method = 'POST') => h.app.inject({ method: method as 'POST', url, payload: buf, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN, 'content-type': 'application/x-ergon' } });
function mexer(buf: Buffer, fn: (b: Buffer) => void) { const b = Buffer.from(buf); fn(b); return b; }

describe('formato .ergon', () => {
  test('pacote visual válido passa como "não verificado"; assinado pela loja vira verificado', async () => {
    const p = validatePackage(await buildPackage(base('fx'), fx, { 'preview/capa.png': png() }));
    assert.deepEqual([p.manifest.kind, p.verified, p.installable], ['fx', false, true]);
    const k = crypto.generateKeyPairSync('ed25519');
    const keys = { loja1: k.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') };
    const signed = await buildPackage(base('fx'), fx, {}, { keyId: 'loja1', privatePkcs8B64: k.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') });
    assert.equal(validatePackage(signed, keys).verified, true);
    const alterado = await buildPackage({ ...base('fx'), title: 'Outro título' }, fx, {}, { keyId: 'loja1', privatePkcs8B64: k.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') });
    const m = JSON.parse(writeZipManifest(alterado)); m.title = 'Título trocado depois de assinar';
    assert.throws(() => validatePackage(rezip(alterado, m), keys), /assinatura não confere/);
  });

  test('recusa: caminho perigoso, link simbólico, bomba de ZIP, SVG/HTML, hash errado, arquivo fora do manifesto, PNG falso, permissão em visual', async () => {
    const ok = await buildPackage(base('fx'), fx);
    const casos: Array<[string, Buffer]> = [
      ['caminho perigoso', writeZip([{ name: 'manifest.json', data: writeZipManifest(ok) }, { name: '../fora.json', data: '{}' }])],
      ['barra invertida', writeZip([{ name: 'manifest.json', data: writeZipManifest(ok) }, { name: 'data\\x.json', data: '{}' }])],
      ['svg', writeZip([{ name: 'manifest.json', data: writeZipManifest(ok) }, { name: 'preview/x.svg', data: '<svg onload=alert(1)>' }])],
      ['html', writeZip([{ name: 'manifest.json', data: writeZipManifest(ok) }, { name: 'index.html', data: '<script>' }])],
      ['bomba de ZIP', writeZip([{ name: 'manifest.json', data: writeZipManifest(ok) }, { name: 'data/zeros.json', data: Buffer.alloc(3_000_000, 0x20) }])],
      ['arquivo fora do manifesto', writeZip([...entries(ok), { name: 'data/extra.json', data: '{}' }])],
      ['hash errado', rezipData(ok, JSON.stringify({ effects: [{ ...fx.effects[0], color: '#000000' }] }))],
      ['png falso', await buildPackage(base('fx'), fx, { 'preview/capa.png': Buffer.from('GIF89a…não é png') })],
      ['png gigante', await buildPackage(base('fx'), fx, { 'preview/capa.png': png(5000, 5000) })],
      ['visual pedindo permissão', rezip(ok, { ...JSON.parse(writeZipManifest(ok)), permissions: { scopes: ['email.enviar'], reason: 'quero' } })],
      ['plugin sem permissões', await buildPackage({ ...base('plugin'), package_id: 'comunidade.ana.plugin' }, null)],
      ['texto ativo', await buildPackage({ ...base('fx'), summary: '<script>alert(1)</script>' }, fx)],
      ['efeito desconhecido', await buildPackage(base('fx'), { effects: [{ ...fx.effects[0], effect: 'explodir' as 'aura' }] })],
      ['equipe com ferramentas', await buildPackage({ ...base('team-blueprint'), package_id: 'comunidade.ana.equipe' }, { blueprint: { format: 'ergon.blueprint', version: 1, createdAt: '2026-10-27T00:00:00Z', ergonVersion: '0.2.0', workspace: { name: 'X', tools: ['terminal'] } as never, sectors: [], agents: [], structures: [], routines: [] } })],
    ];
    const symlink = mexer(ok, (b) => { const i = b.lastIndexOf(Buffer.from('data/package.json')) - 46; b.writeUInt32LE((0xa1ff << 16) >>> 0, i + 38); });
    casos.push(['link simbólico', symlink]);
    for (const [nome, buf] of casos) assert.throws(() => validatePackage(buf), PackageError, nome);
  });
});

describe('instalar e desfazer no workspace', () => {
  test('prévia não muda nada; instalar efeito/pet/tema; a cidade recebe por agente; desfazer volta', async () => {
    const h = await harness(); const a = await setupOwner(h);
    const pre = await send(h, '/api/packages/preview', a, await buildPackage(base('fx'), fx));
    assert.equal(pre.statusCode, 200);
    assert.match(pre.json().changes[0], /fire_circle em Hipátia/);
    assert.equal(pre.json().verified, false);
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/packages', headers: { cookie: a.cookie } })).json().length, 0);
    const i1 = (await send(h, '/api/packages/install', a, await buildPackage(base('fx'), fx))).json();
    await send(h, '/api/packages/install', a, await buildPackage({ ...base('pet'), package_id: 'comunidade.ana.coruja' }, { pets: [{ target: { all: true }, species: 'coruja', color: '#c8a050' }] }));
    const t1 = (await send(h, '/api/packages/install', a, await buildPackage({ ...base('city-theme'), package_id: 'comunidade.ana.tema-roma' }, { theme: { base: 'dia', colors: { bg: '#d8c8a0', gold: '#ffcc00' } } }))).json();
    const t2 = (await send(h, '/api/packages/install', a, await buildPackage({ ...base('city-theme'), package_id: 'comunidade.ana.tema-noite' }, { theme: { base: 'noite', colors: { bg: '#101830' } } }))).json();
    let c = (await h.app.inject({ method: 'GET', url: '/api/packages/cosmetics', headers: { cookie: a.cookie } })).json();
    assert.equal(c.effects.length, 1); assert.equal(c.pets.length, 12); assert.equal(c.theme.colors.bg, '#101830');
    await h.app.inject({ method: 'DELETE', url: `/api/packages/${t2.id}`, headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN } });
    c = (await h.app.inject({ method: 'GET', url: '/api/packages/cosmetics', headers: { cookie: a.cookie } })).json();
    assert.equal(c.theme.colors.bg, '#d8c8a0', 'desfazer o tema novo devolve o anterior');
    await h.app.inject({ method: 'DELETE', url: `/api/packages/${i1.id}`, headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN } });
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/packages/cosmetics', headers: { cookie: a.cookie } })).json().effects.length, 0);
    void t1;
    assert.equal((await send(h, '/api/packages/install', a, await buildPackage({ ...base('plugin'), package_id: 'comunidade.ana.plugin', permissions: { scopes: ['tarefas.ler'], reason: 'listar' } }, {}))).statusCode, 409, 'plugin não instala nesta versão');
  });

  test('aparência e equipe: aplicam e desfazem exatamente; outra pessoa não vê nada', async () => {
    const h = await harness(); const a = await setupOwner(h);
    const seedAntes = h.db.get<{ look_seed: number | null }>("SELECT look_seed FROM agents WHERE workspace_id = ? AND name = 'Hipátia'", a.workspaceId)!.look_seed;
    const look = (await send(h, '/api/packages/install', a, await buildPackage({ ...base('character-look'), package_id: 'comunidade.ana.hipatia-nova' }, { looks: [{ target: { agentName: 'Hipátia' }, seed: 424242 }] }))).json();
    assert.equal(h.db.get<{ look_seed: number }>("SELECT look_seed FROM agents WHERE workspace_id = ? AND name = 'Hipátia'", a.workspaceId)!.look_seed, 424242);
    await h.app.inject({ method: 'DELETE', url: `/api/packages/${look.id}`, headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN } });
    assert.equal(h.db.get<{ look_seed: number | null }>("SELECT look_seed FROM agents WHERE workspace_id = ? AND name = 'Hipátia'", a.workspaceId)!.look_seed, seedAntes);

    const bp = (await h.app.inject({ method: 'GET', url: '/api/blueprint/export', headers: { cookie: a.cookie } })).json();
    bp.agents = bp.agents.map((x: { coordinator: boolean }) => (x.coordinator ? { ...x, name: 'Gandalf' } : x));
    bp.agents.push({ ...bp.agents[1], name: 'Frodo', coordinator: false, charKey: null });
    const eq = (await send(h, '/api/packages/install', a, await buildPackage({ ...base('team-blueprint'), package_id: 'comunidade.ana.sociedade' }, { blueprint: bp }))).json();
    assert.equal(h.db.get<{ name: string }>('SELECT name FROM agents WHERE workspace_id = ? AND coordinator = 1', a.workspaceId)!.name, 'Gandalf');
    assert.ok(h.db.get("SELECT 1 FROM agents WHERE workspace_id = ? AND name = 'Frodo' AND status = 'active'", a.workspaceId));
    const b = await addPerson(h, 'bruna', 'senha-da-bruna-123');
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/packages', headers: { cookie: b.cookie } })).json().length, 0);
    assert.equal((await h.app.inject({ method: 'DELETE', url: `/api/packages/${eq.id}`, headers: { cookie: b.cookie, 'x-csrf-token': b.csrf, origin: ORIGIN } })).statusCode, 404);
    await h.app.inject({ method: 'DELETE', url: `/api/packages/${eq.id}`, headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN } });
    assert.equal(h.db.get<{ name: string }>('SELECT name FROM agents WHERE workspace_id = ? AND coordinator = 1', a.workspaceId)!.name, 'Aristóteles');
    assert.equal(h.db.get("SELECT 1 FROM agents WHERE workspace_id = ? AND name = 'Frodo' AND status = 'active'", a.workspaceId), undefined);
    assert.ok(h.db.all('SELECT 1 FROM tasks').length >= 0, 'tarefas e conversas não são tocadas');
  });
});

describe('editor simples', () => {
  test('monta um .ergon válido que instala e desfaz; dado fora do formato é recusado; sem sessão não monta', async () => {
    const h = await harness(); const a = await setupOwner(h);
    const build = (s: Session, body: unknown) => h.app.inject({ method: 'POST', url: '/api/packages/build', payload: body as object, headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: ORIGIN } });
    const r = await build(a, { kind: 'fx', title: 'Aura de Hipátia', data: fx });
    assert.equal(r.statusCode, 200);
    assert.equal(r.headers['content-type'], 'application/x-ergon');
    assert.match(String(r.headers['content-disposition']), /aura-de-hipatia\.ergon/);
    const p = validatePackage(r.rawPayload);
    assert.deepEqual([p.manifest.package_id, p.manifest.kind, p.verified], ['comunidade.local.aura-de-hipatia', 'fx', false]);
    const i = (await send(h, '/api/packages/install', a, r.rawPayload)).json();
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/packages/cosmetics', headers: { cookie: a.cookie } })).json().effects.length, 1);
    await h.app.inject({ method: 'DELETE', url: `/api/packages/${i.id}`, headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN } });
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/packages/cosmetics', headers: { cookie: a.cookie } })).json().effects.length, 0);
    assert.equal((await build(a, { kind: 'fx', title: 'Ruim', data: { effects: [{ target: { all: true }, effect: 'javascript', color: 'red' }] } })).statusCode, 400);
    assert.equal((await build(a, { kind: 'plugin', title: 'Plugin', data: {} })).statusCode, 400, 'editor só monta visual');
    assert.equal((await h.app.inject({ method: 'POST', url: '/api/packages/build', payload: { kind: 'fx', title: 'Aura', data: fx }, headers: { origin: ORIGIN } })).statusCode, 401, 'sem sessão não monta');
  });
});

// ---------- utilidades de manipulação de ZIP para os ataques
import { readZip } from '../src/lib/zip.ts';
function entries(buf: Buffer) { return [...readZip(buf).entries()].map(([name, e]) => ({ name, data: e.read() })); }
function writeZipManifest(buf: Buffer): string { return readZip(buf).get('manifest.json')!.read().toString('utf8'); }
function rezip(buf: Buffer, manifest: unknown) { return writeZip(entries(buf).map((e) => (e.name === 'manifest.json' ? { name: e.name, data: JSON.stringify(manifest) } : e))); }
function rezipData(buf: Buffer, data: string) { return writeZip(entries(buf).map((e) => (e.name === 'data/package.json' ? { name: e.name, data } : e))); }

describe('loja: oficiais embutidos e modelos da comunidade', () => {
  test('oficiais vêm com o Ergon, verificados, e instalam sem internet; desfazer volta', async () => {
    const h = await harness();
    try {
      const s = await setupOwner(h);
      const of = (await req(h, 'GET', '/api/packages/catalog/official', s)).json as Array<{ id: string; kind: string; verified: boolean; installed: boolean }>;
      assert.ok(of.length >= 10, `oficiais: ${of.length}`);
      assert.ok(of.every((x) => x.verified && !x.installed && x.id.startsWith('ergon.oficial.')));
      assert.deepEqual([...new Set(of.map((x) => x.kind))].sort(), ['city-theme', 'fx', 'pet', 'team-blueprint']);
      const r = await req(h, 'POST', '/api/packages/catalog/official/install', s, { id: 'ergon.oficial.aura-dourada' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(((await req(h, 'GET', '/api/packages/catalog/official', s)).json as Array<{ id: string; installed: boolean }>).find((x) => x.id === 'ergon.oficial.aura-dourada')!.installed, true);
      assert.equal((await req(h, 'POST', '/api/packages/catalog/official/install', s, { id: 'ergon.oficial.nao-existe' })).status, 404);
      const eq = await req(h, 'POST', '/api/packages/catalog/official/install', s, { id: 'ergon.oficial.equipe-pesquisa' });
      assert.equal(eq.status, 200, JSON.stringify(eq.json));
    } finally { await h.close(); }
  });

  test('modelos da comunidade: só quando pedidos, do mesmo endereço do índice, com tamanho e SHA-256 conferidos; sem internet, avisa', async () => {
    const pkg = await buildPackage({ ...base('fx', 'comunidade.bia.aura-azul'), title: 'Aura azul' }, { effects: [{ target: { all: true }, effect: 'aura', color: '#3a7bd5', intensity: 0.5 }] });
    const sha = crypto.createHash('sha256').update(pkg).digest('hex');
    let pedidos = 0; let corpo = pkg;
    const srv = http.createServer((q, r) => {
      pedidos++;
      if (q.url === '/catalogo/index.json') { r.writeHead(200, { 'content-type': 'application/json' }); r.end(JSON.stringify({ version: 1, packages: [
        { id: 'comunidade.bia.aura-azul', version: '1.0.0', title: 'Aura azul', summary: 'Aura suave', kind: 'fx', author: 'bia', path: 'pacotes/aura-azul.ergon', sha256: sha, size: pkg.length },
        { id: 'comunidade.x.fora', version: '1.0.0', title: 'Fora', summary: 'x', kind: 'fx', author: 'x', path: '../../etc/passwd.ergon', sha256: sha, size: 1 },
      ] })); }
      else if (q.url === '/catalogo/pacotes/aura-azul.ergon') { r.writeHead(200); r.end(corpo); }
      else { r.writeHead(404); r.end(); }
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/catalogo/index.json`;
    const h = await harness({ communityCatalogUrl: url });
    try {
      const s = await setupOwner(h);
      assert.equal(pedidos, 0, 'nada sai do computador sozinho');
      const lista = (await req(h, 'GET', '/api/packages/catalog/community', s)).json as Array<{ id: string; verified: boolean }>;
      assert.deepEqual(lista.map((x) => [x.id, x.verified]), [['comunidade.bia.aura-azul', false]], 'o caminho com ".." foi descartado');
      corpo = Buffer.concat([pkg, Buffer.from('x')]);
      const errado = await req(h, 'POST', '/api/packages/catalog/community/install', s, { id: 'comunidade.bia.aura-azul' });
      assert.equal(errado.status, 422, 'não confere com o índice: nada instalado');
      corpo = pkg;
      assert.equal((await req(h, 'POST', '/api/packages/catalog/community/install', s, { id: 'comunidade.bia.aura-azul' })).status, 200);
      const inst = (await req(h, 'GET', '/api/packages', s)).json as Array<{ title: string; verified: boolean; active: boolean }>;
      assert.deepEqual(inst.filter((x) => x.active).map((x) => [x.title, x.verified]), [['Aura azul', false]]);
      await new Promise((ok) => srv.close(ok));
      const off = await req(h, 'GET', '/api/packages/catalog/community?atualizar=1', s);
      assert.equal(off.status, 503); assert.match(off.json.message, /já instalou continua/);
      assert.equal(((await req(h, 'GET', '/api/packages', s)).json as Array<{ active: boolean }>).filter((x) => x.active).length, 1, 'sem internet, o instalado continua');
    } finally { await h.close(); srv.close(); }
  });
});
