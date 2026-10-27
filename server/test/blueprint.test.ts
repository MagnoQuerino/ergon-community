/**
 * F1 — fronteiras: esqueleto portável do workspace (sem segredos, permissões nem direitos).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { validateBlueprint } from '../../shared/blueprint.ts';
import { addPerson, harness, req, setupOwner } from './helpers.ts';

describe('esqueleto do workspace', () => {
  test('exporta a forma e nunca leva ferramentas, modelo, conta ou segredos', async () => {
    const h = await harness();
    const a = await setupOwner(h);
    await req(h, 'POST', '/api/routines', a, { template: 'supervisor-projetos', tz: 'America/Sao_Paulo' });
    h.db.run(`UPDATE agents SET tools = '["executar-codigo","terminal"]', model = 'vendor/modelo-secreto', provider = 'nous' WHERE workspace_id = ?`, a.workspaceId);
    const r = await req(h, 'GET', '/api/blueprint/export', a);
    assert.equal(r.status, 200);
    const bp = r.json;
    assert.equal(bp.format, 'ergon.blueprint');
    assert.ok(bp.agents.length >= 12 && bp.agents.filter((x: { coordinator: boolean }) => x.coordinator).length === 1);
    assert.ok(bp.sectors.length >= 5 && bp.structures.length >= 1);
    assert.deepEqual(bp.routines.map((x: { template: string }) => x.template), ['supervisor-projetos']);
    const txt = JSON.stringify(bp);
    for (const proibido of ['executar-codigo', 'terminal', 'modelo-secreto', '"tools"', '"model"', '"provider"', 'nous']) assert.ok(!txt.includes(proibido), proibido);
    assert.equal(validateBlueprint(bp).ok, true);
  });

  test('importar: prévia não muda nada; aplicar cria agentes sem ferramentas e rotinas pausadas', async () => {
    const h = await harness();
    const a = await setupOwner(h);
    await req(h, 'POST', '/api/routines', a, { template: 'supervisor-projetos', tz: 'America/Sao_Paulo' });
    const bp = (await req(h, 'GET', '/api/blueprint/export', a)).json;
    bp.agents = bp.agents.map((x: { name: string; coordinator: boolean }) => (x.coordinator ? { ...x, name: 'Gandalf' } : x));
    bp.agents.push({ ...bp.agents[1], name: 'Frodo', role: 'Pesquisa de campo', coordinator: false, charKey: null });

    const b = await addPerson(h, 'bruna', 'senha-da-bruna-123');
    const antes = h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND status = 'active'", b.workspaceId)!.n;
    const prev = await req(h, 'POST', '/api/blueprint/import', b, { blueprint: bp });
    assert.equal(prev.status, 200);
    assert.equal(prev.json.applied, false);
    assert.deepEqual(prev.json.coordinator, { from: 'Aristóteles', to: 'Gandalf' });
    assert.ok(prev.json.agents.some((x: { name: string }) => x.name === 'Frodo'));
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND status = 'active'", b.workspaceId)!.n, antes);

    const ap = await req(h, 'POST', '/api/blueprint/import', b, { blueprint: bp, apply: true });
    assert.equal(ap.status, 200);
    assert.equal(ap.json.applied, true);
    const frodo = h.db.get<{ tools: string | null; model: string | null; provider: string | null }>("SELECT tools, model, provider FROM agents WHERE workspace_id = ? AND name = 'Frodo'", b.workspaceId)!;
    assert.ok(frodo, 'Frodo criado');
    // só as ferramentas de qualquer agente novo daquele setor; nada do esqueleto, nada que execute código
    const manual = (await req(h, 'POST', '/api/agents', b, { name: 'Sam', role: 'Pesquisa de campo', sectorKey: ap.json.agents.find((x: { name: string }) => x.name === 'Frodo').sector })).json;
    const samTools = h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', manual.id)!.tools;
    assert.deepEqual(JSON.parse(frodo.tools ?? '[]').sort(), JSON.parse(samTools ?? '[]').sort());
    for (const t of ['executar-codigo', 'terminal']) assert.ok(!(frodo.tools ?? '').includes(t));
    assert.equal(frodo.model, null); assert.equal(frodo.provider, null);
    const coord = h.db.get<{ name: string; coordinator: number }>('SELECT name, coordinator FROM agents WHERE workspace_id = ? AND coordinator = 1', b.workspaceId)!;
    assert.equal(coord.name, 'Gandalf');
    const rot = h.db.all<{ status: string }>('SELECT status FROM routines WHERE workspace_id = ?', b.workspaceId);
    assert.ok(rot.length >= 1 && rot.every((x) => x.status === 'paused'));
    // o esqueleto de A não abriu nada de A para B
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND name = 'Gandalf'", a.workspaceId)!.n, 0);
  });

  test('validação recusa campos proibidos, desconhecidos, conteúdo ativo e excesso', () => {
    const base = { format: 'ergon.blueprint', version: 1, createdAt: '2026-10-27T00:00:00Z', ergonVersion: '0.2.0', workspace: { name: 'X' }, sectors: [], agents: [], structures: [], routines: [] };
    assert.equal(validateBlueprint(base).ok, true);
    const casos: Array<[string, unknown]> = [
      ['token aninhado', { ...base, workspace: { name: 'X', apiToken: 'abc' } }],
      ['campo desconhecido', { ...base, extra: 1 }],
      ['ferramentas', { ...base, agents: [{ name: 'A', role: 'r', sectorKey: 'x', charter: null, bio: null, skills: [], color: '#fff', lookSeed: null, coordinator: false, charKey: null, tools: ['terminal'] }] }],
      ['conteúdo ativo', { ...base, workspace: { name: '<script>alert(1)</script>' } }],
      ['carteira', { ...base, wallet: { dracmas: 100 } }],
      ['grande demais', { ...base, workspace: { name: 'x'.repeat(1_100_000) } }],
      ['duas coordenações', { ...base, agents: [1, 2].map((n) => ({ name: `C${n}`, role: 'r', sectorKey: 'x', charter: null, bio: null, skills: [], color: '#fff', lookSeed: null, coordinator: true, charKey: null })) }],
    ];
    for (const [nome, v] of casos) assert.equal(validateBlueprint(v).ok, false, nome);
  });
});
