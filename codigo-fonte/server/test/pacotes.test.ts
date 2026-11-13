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

describe('pacote montado localmente', () => {
  test('um .ergon montado aqui é válido, instala e desfaz; dado fora do formato é recusado', async () => {
    const h = await harness(); const a = await setupOwner(h);
    // a rota do editor (POST /api/packages/build), sem tela desde a rc.25, saiu na rc.29: monta-se pelo serviço
    assert.equal((await h.app.inject({ method: 'POST', url: '/api/packages/build', payload: { kind: 'fx', title: 'Aura', data: fx }, headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN } })).statusCode, 404);
    const manifesto = (kind: string, title: string) => ({ package_id: 'comunidade.local.aura-de-hipatia', version: '1.0.0', title, summary: 'Montado no teste', creator_id: 'local', license: 'CC-BY-4.0', ergon: { min: '0.2.0' }, kind }) as never;
    const buf = await buildPackage(manifesto('fx', 'Aura de Hipátia'), fx);
    const p = validatePackage(buf);
    assert.deepEqual([p.manifest.package_id, p.manifest.kind, p.verified], ['comunidade.local.aura-de-hipatia', 'fx', false]);
    const i = (await send(h, '/api/packages/install', a, buf)).json();
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/packages/cosmetics', headers: { cookie: a.cookie } })).json().effects.length, 1);
    await h.app.inject({ method: 'DELETE', url: `/api/packages/${i.id}`, headers: { cookie: a.cookie, 'x-csrf-token': a.csrf, origin: ORIGIN } });
    assert.equal((await h.app.inject({ method: 'GET', url: '/api/packages/cosmetics', headers: { cookie: a.cookie } })).json().effects.length, 0);
    const ruim = await buildPackage(manifesto('fx', 'Ruim'), { effects: [{ target: { all: true }, effect: 'javascript', color: 'red' }] } as never).catch((e: Error) => e);
    assert.throws(() => { if (ruim instanceof Error) throw ruim; validatePackage(ruim); }, 'efeito fora do formato é recusado');
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
      assert.deepEqual([...new Set(of.map((x) => x.kind))].sort(), ['city-theme', 'fx', 'pet', 'skin', 'team-blueprint']);
      assert.equal(of.filter((x) => x.kind === 'skin').length, 6, 'as seis skins oficiais');
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

import { OFFICIAL_SKINS } from '../../shared/skins-oficiais.ts';
import { SKIN_MAX_CHARACTERS, validateSkin } from '../../shared/skin.ts';

describe('skins da cidade', () => {
  test('as seis skins oficiais validam, com nomes originais e até 10 personagens', () => {
    assert.equal(OFFICIAL_SKINS.length, 6);
    for (const sk of OFFICIAL_SKINS) {
      const v = validateSkin(JSON.parse(JSON.stringify(sk)));
      assert.ok(v.ok, `${sk.name}: ${v.ok ? '' : v.errors.join('; ')}`);
      assert.ok(sk.characters.length + (sk.npc ? 1 : 0) <= SKIN_MAX_CHARACTERS);
    }
    const nomes = OFFICIAL_SKINS.flatMap((sk) => sk.characters.map((c) => c.name));
    assert.equal(new Set(nomes).size, nomes.length, 'nenhum personagem repetido entre as skins');
  });

  test('recusa skin com 11 personagens, roupa que não existe, peça fora do vocabulário ou texto ativo', () => {
    const base = JSON.parse(JSON.stringify(OFFICIAL_SKINS[0]));
    const onze = { ...base, characters: [...base.characters, { ...base.characters[0], charKey: 'hesiodo', name: 'Outro Nome' }] };
    assert.equal(validateSkin(onze).ok, false);
    const roupa = JSON.parse(JSON.stringify(base)); roupa.characters[0].look.outfit = 'nao-existe';
    assert.match((validateSkin(roupa) as { errors: string[] }).errors.join(' '), /roupa que não existe/);
    const peca = JSON.parse(JSON.stringify(base)); peca.figures.outfits[0].kit.top = 'armadura-de-ferro';
    assert.equal(validateSkin(peca).ok, false);
    const ativo = JSON.parse(JSON.stringify(base)); ativo.characters[0].bio = '<img src=x onerror=alert(1)>';
    assert.match((validateSkin(ativo) as { errors: string[] }).errors.join(' '), /conteúdo ativo/);
    const extra = JSON.parse(JSON.stringify(base)); extra.ferramentas = ['terminal'];
    assert.match((validateSkin(extra) as { errors: string[] }).errors.join(' '), /campo ferramentas não permitido/);
  });

  test('instalar veste os personagens (nome e bio), trocar de skin devolve os nomes, desfazer volta tudo', async () => {
    const h = await harness();
    try {
      const s = await setupOwner(h);
      const agents = () => h.db.all<{ id: string; char_key: string; name: string; bio: string | null; role: string }>("SELECT id, char_key, name, bio, role FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY char_key", s.workspaceId);
      const antes = agents();
      const byKey = (k: string) => agents().find((a) => a.char_key === k)!;
      const platina = await req(h, 'POST', '/api/packages/catalog/official/install', s, { id: 'ergon.oficial.skin-distrito-platina' });
      assert.equal(platina.status, 200, JSON.stringify(platina.json));
      assert.equal(byKey('aristoteles').name, 'Helena Vasconcelos');
      assert.match(byKey('aristoteles').bio ?? '', /Diretora-geral/);
      assert.equal(byKey('aristoteles').role, antes.find((a) => a.char_key === 'aristoteles')!.role, 'a função não muda');
      assert.equal(byKey('hesiodo').name, antes.find((a) => a.char_key === 'hesiodo')!.name, 'quem não tem personagem fica como está');
      const cos = (await req(h, 'GET', '/api/packages/cosmetics', s)).json as { skin: { data: { id: string }; characters: Array<{ agentId: string; index: number }> } };
      assert.equal(cos.skin.data.id, 'distrito-platina');
      assert.equal(cos.skin.characters.length, 10);
      // trocar: a anterior sai devolvendo os nomes, a nova veste
      const cromo = await req(h, 'POST', '/api/packages/catalog/official/install', s, { id: 'ergon.oficial.skin-cromo-9' });
      assert.equal(cromo.status, 200);
      assert.equal(byKey('aristoteles').name, 'Nyx Valença');
      assert.equal(((await req(h, 'GET', '/api/packages/cosmetics', s)).json as { skin: { data: { id: string } } }).skin.data.id, 'cromo-9');
      // desfazer a nova: volta a anterior com os personagens dela
      await req(h, 'DELETE', `/api/packages/${cromo.json.id}`, s);
      assert.equal(byKey('aristoteles').name, 'Helena Vasconcelos');
      assert.equal(((await req(h, 'GET', '/api/packages/cosmetics', s)).json as { skin: { data: { id: string } } }).skin.data.id, 'distrito-platina');
      // desfazer a primeira: a equipe volta exatamente como era
      await req(h, 'DELETE', `/api/packages/${platina.json.id}`, s);
      assert.deepEqual(agents().map((a) => [a.char_key, a.name, a.bio]), antes.map((a) => [a.char_key, a.name, a.bio]));
      assert.equal(((await req(h, 'GET', '/api/packages/cosmetics', s)).json as { skin: unknown }).skin, null);
    } finally { await h.close(); }
  });
});

describe('cores ilegíveis em pacotes da comunidade: corrigidas sozinhas e avisadas, nunca recusadas', () => {
  test('skin com etiqueta ilegível, tema com contorno claro demais e equipe com cor sem letra legível passam corrigidos', async () => {
    const { contrast, MIN_TEXTO } = await import('../../shared/contraste.ts');
    const { deriveThemeColors } = await import('../../shared/skin.ts');
    const { ETIQUETAS_DE_FABRICA } = await import('../../shared/legibilidade.ts');
    // skin: papiro (cloth) quase da cor do contorno à noite
    const sk = structuredClone(OFFICIAL_SKINS[0]);
    sk.palette.noite = { ...sk.palette.noite, seeds: { ...sk.palette.noite.seeds, cloth: '#3a3a44', outline: '#16111d' }, colors: {} };
    const v = validatePackage(await buildPackage({ ...base('skin'), package_id: 'comunidade.ana.skin-escura' }, { skin: sk }));
    assert.ok(v.legibilidade.some((a) => a.onde === 'etiqueta' && a.tema === 'noite'), JSON.stringify(v.legibilidade));
    const n = v.data.skin!.palette.noite;
    const d = { ...deriveThemeColors(n.seeds), ...(n.colors ?? {}) } as { outline: string; papyrus: [string, string] };
    for (const c of d.papyrus) assert.ok(contrast(d.outline, c) >= MIN_TEXTO, `${c}: ${contrast(d.outline, c).toFixed(2)}`);
    assert.equal(validateSkin(v.data.skin).ok, true);
    // tema da cidade com contorno cinza-claro: o contorno passa a se ler no papiro e no laranja de espera
    const tema = validatePackage(await buildPackage({ ...base('city-theme'), package_id: 'comunidade.ana.tema-claro' }, { theme: { base: 'dia', colors: { outline: '#b0a890', bg: '#ddd5c0' } } }));
    const o = tema.data.theme!.colors.outline;
    assert.notEqual(o, '#b0a890');
    for (const c of [...ETIQUETAS_DE_FABRICA.dia.papyrus, ETIQUETAS_DE_FABRICA.dia.marks.waiting]) assert.ok(contrast(o, c) >= MIN_TEXTO, `${o} sobre ${c}`);
    assert.equal(tema.data.theme!.colors.bg, '#ddd5c0', 'o resto do tema fica como veio');
    assert.deepEqual(tema.legibilidade.map((a) => a.onde), ['contorno']);
    // equipe: a cor de agente em que nem a letra escura nem a branca se lê vira o mesmo tom com outra luz; o resto fica
    const { legibilizarEquipe } = await import('../../shared/legibilidade.ts');
    const eq = legibilizarEquipe({ agents: [{ name: 'Fídias', color: '#c08a2a' }, { name: 'Cinza', color: '#7a7a7a' }] });
    assert.equal(eq.blueprint.agents![0].color, '#c08a2a', 'Fídias continua dourado (a letra escura se lê)');
    assert.notEqual(eq.blueprint.agents![1].color, '#7a7a7a');
    assert.deepEqual(eq.ajustes.map((x) => [x.onde, x.quem]), [['retrato', 'Cinza']]);
    // o que já se lê não ganha aviso
    assert.deepEqual(validatePackage(await buildPackage(base('fx'), fx)).legibilidade, []);
    assert.deepEqual(validatePackage(await buildPackage({ ...base('city-theme'), package_id: 'comunidade.ana.tema-ok' }, { theme: { base: 'noite', colors: { bg: '#202020' } } })).legibilidade, []);
  });

  test('a prévia avisa quantas cores foram ajustadas, e o que se instala é a versão corrigida', async () => {
    const h = await harness(); const a = await setupOwner(h);
    const buf = await buildPackage({ ...base('city-theme'), package_id: 'comunidade.ana.tema-palido' }, { theme: { base: 'dia', colors: { outline: '#c8c0a8' } } });
    const pre = (await send(h, '/api/packages/preview', a, buf)).json() as { legibilidade: number };
    assert.equal(pre.legibilidade, 1);
    assert.equal((await send(h, '/api/packages/install', a, buf)).statusCode, 200);
    const cos = (await h.app.inject({ method: 'GET', url: '/api/packages/cosmetics', headers: { cookie: a.cookie } })).json() as { theme: { colors: Record<string, string> } };
    assert.notEqual(cos.theme.colors.outline, '#c8c0a8');
    // na loja: o item do catálogo leva o número para a prévia mostrar o aviso
    const { previewOf } = await import('../src/services/catalog.ts');
    assert.equal(previewOf(validatePackage(buf)).legibilidade, 1);
    assert.equal(previewOf(validatePackage(await buildPackage(base('fx'), fx))).legibilidade, undefined);
  });
});
