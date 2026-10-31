/**
 * Cidade por região e /api/state enxuto (docs/CIDADE_REGIOES.md): a vaga e a casa de cada morador iguais às do
 * cálculo de antes (feito no navegador sobre a equipe inteira) em todos os modos, as contagens da cidade pelo status
 * de trabalho de cada agente, o /api/state sem a equipe, Coordenador e revisor escolhidos no banco com a regra do
 * serviço, quem tem cada ferramenta, a busca rápida na ordem de antes e o agente leve dentro das respostas.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { fitAt, freeCells } from '../../shared/city.ts';
import { rank } from '../../web/src/lib/search.ts';
import { foldText } from '../src/db/db.ts';
import { id, now } from '../src/lib/util.ts';
import { activeTeam, coordinatorOf, reviewerOf } from '../src/services/team.ts';
import { coordinatorFor, reviewerFor } from '../src/services/team-query.ts';
import { allAgents, cityStructures, drain, harness, oldPlaces, req, setupOwner, type Harness, type Session } from './helpers.ts';

type CityAgent = { id: string; name: string; role: string; color: string; char_key: string | null; look_seed: number | null; sector_name: string;
  building_id: string; floor_id: string; level: number; slot: number; house: number; run_status: string | null; last_outcome: string | null };

const chunks = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

describe('cidade por região: vaga e casa iguais às de antes', () => {
  let h: Harness; let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  const sameAsBefore = async (label: string) => {
    const full = await allAgents(h, s, 7); // páginas pequenas: o cursor também é conferido
    // a ordem de GET /api/agents é a do /api/state de antes
    const sql = h.db.all<{ id: string }>(`SELECT a.id FROM agents a JOIN floors f ON f.id = a.floor_id JOIN profiles p ON p.id = a.profile_id
      WHERE a.workspace_id = ? ORDER BY a.status, f.building_id, f.level, a.created_at, a.rowid`, s.workspaceId).map((x) => x.id);
    assert.deepEqual(full.map((a) => a.id), sql, `${label}: ordem de antes`);
    const want = oldPlaces(full);
    const check = (got: CityAgent[], mode: string) => {
      for (const a of got) {
        const w = want.get(a.id);
        assert.ok(w, `${label}/${mode}: ${a.name} é ativo`);
        assert.deepEqual([a.building_id, a.level, a.slot, a.house], [w!.building, w!.level, w!.slot, w!.house], `${label}/${mode}: ${a.name}`);
      }
      // a ordem da resposta: construção (binária), nível, vaga
      const keys = got.map((a) => [a.building_id, a.level, a.slot] as const);
      for (let i = 1; i < keys.length; i++) assert.ok(keys[i - 1][0] < keys[i][0] || (keys[i - 1][0] === keys[i][0] && (keys[i - 1][1] < keys[i][1] || (keys[i - 1][1] === keys[i][1] && keys[i - 1][2] < keys[i][2]))), `${label}/${mode}: ordem`);
    };
    // todos
    const all = (await req(h, 'GET', '/api/city/agents?all=1', s)).json as { total: number; agents: CityAgent[]; next: string | null };
    assert.equal(all.total, want.size); assert.equal(all.agents.length, want.size); assert.equal(all.next, null);
    check(all.agents, 'all');
    // a ordem de entrada no motor é a mesma de antes (mesma vida na cidade pequena)
    assert.deepEqual(all.agents.map((a) => a.id), [...want.values()].sort((a, b) => a.building.localeCompare(b.building) || a.level - b.level || a.slot - b.slot).map((a) => a.id), `${label}: ordem de entrada`);
    // por andar (alguns de cada vez: a vaga sai da partição inteira, não só do que foi pedido)
    const floors = [...new Set(all.agents.map((a) => a.floor_id))];
    const seenF = new Set<string>();
    for (const part of chunks(floors, 2)) {
      const r = (await req(h, 'GET', `/api/city/agents?f=${part.join(',')}`, s)).json as { total: number; agents: CityAgent[] };
      assert.ok(r.agents.every((a) => part.includes(a.floor_id)));
      assert.equal(r.total, r.agents.length);
      check(r.agents, 'f'); for (const a of r.agents) seenF.add(a.id);
    }
    assert.equal(seenF.size, want.size, `${label}: os andares cobrem todos`);
    // por construção, inteira e só as primeiras vagas
    const buildings = [...new Set(all.agents.map((a) => a.building_id))];
    for (const b of buildings) {
      const r = (await req(h, 'GET', `/api/city/agents?b=${b}`, s)).json as { total: number; agents: CityAgent[] };
      check(r.agents, 'b');
      assert.equal(r.total, [...want.values()].filter((x) => x.building === b).length);
      assert.equal(r.agents.length, r.total);
      const p = (await req(h, 'GET', `/api/city/agents?b=${b}&per=2`, s)).json as { total: number; agents: CityAgent[] };
      check(p.agents, 'b+per');
      assert.equal(p.total, r.total, 'o total não corta em per');
      assert.deepEqual(p.agents.map((a) => a.id), r.agents.filter((a) => a.slot < 2).map((a) => a.id));
    }
    const rb = (await req(h, 'GET', `/api/city/agents?b=${buildings.join(',')}`, s)).json as { total: number; agents: CityAgent[] };
    assert.deepEqual(rb.agents.map((a) => a.id), all.agents.map((a) => a.id), `${label}: várias construções de uma vez`);
    // pelo id (um desativado não volta)
    const archived = full.filter((a) => a.status === 'archived').map((a) => a.id);
    for (const part of chunks([...want.keys()], 3)) {
      const r = (await req(h, 'GET', `/api/city/agents?ids=${[...part, ...archived.slice(0, 1)].join(',')}`, s)).json as { total: number; agents: CityAgent[] };
      assert.deepEqual(new Set(r.agents.map((a) => a.id)), new Set(part));
      check(r.agents, 'ids');
    }
    return { full, all: all.agents };
  };

  test('equipe de partida (12): a mesma vaga e a mesma casa; seis por andar, dois por casa', async () => {
    const { all } = await sameAsBefore('partida');
    assert.equal(all.length, 12);
    assert.deepEqual(all.map((a) => a.slot), [0, 1, 2, 3, 4, 5, 0, 1, 2, 3, 4, 5]);
    assert.deepEqual(all.map((a) => a.house), [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });

  test('criar, desativar, reativar, mudar de construção e empate de chegada: continua igual ao cálculo de antes', async () => {
    // outras construções em lotes livres (ids aleatórios: a ordem binária mistura com a Stoa)
    const place = async (kind: string) => {
      const cur = await cityStructures(h, s); let at: [number, number] | null = null;
      for (const [ci, cj] of freeCells(cur)) { at = fitAt(cur, kind, ci, cj); if (at) break; }
      const r = await req(h, 'POST', '/api/structures', s, { kind, i: at![0], j: at![1] });
      assert.equal(r.status, 201, JSON.stringify(r.json)); return r.json.id as string;
    };
    const emporio = await place('emporion'); const escola = await place('didaskaleion');
    const made: string[] = [];
    for (let i = 0; i < 9; i++) {
      const r = await req(h, 'POST', '/api/agents', s, { name: `Morador ${i}`, role: 'Pesquisa', sectorKey: 'auto', structureId: i % 2 ? emporio : escola });
      assert.equal(r.status, 201, JSON.stringify(r.json)); made.push(r.json.id);
    }
    await sameAsBefore('criados');
    // desativar no meio de um andar: quem vem depois anda uma vaga (como antes)
    const full = await allAgents(h, s);
    const middle = full.filter((a) => a.status === 'active' && !a.coordinator && a.building_id === full[0].building_id)[2];
    assert.equal((await req(h, 'POST', `/api/agents/${middle.id}/deactivate`, s)).status, 200);
    assert.equal((await req(h, 'POST', `/api/agents/${made[3]}/deactivate`, s)).status, 200);
    await sameAsBefore('desativados');
    // mudar de construção
    assert.equal((await req(h, 'POST', `/api/agents/${made[0]}/move`, s, { structureId: emporio })).status, 200);
    const oneOfStoa = (await allAgents(h, s)).find((a) => a.status === 'active' && !a.coordinator && a.building_id === full[0].building_id)!;
    const mv = await req(h, 'POST', `/api/agents/${oneOfStoa.id}/move`, s, { structureId: escola });
    assert.ok(mv.status === 200 || mv.json.error === 'structure_full', JSON.stringify(mv.json));
    await sameAsBefore('movidos');
    // reativar: volta ao andar dele (ou ao primeiro com vaga)
    assert.equal((await req(h, 'POST', `/api/agents/${middle.id}/reactivate`, s)).status, 200);
    assert.equal((await req(h, 'POST', `/api/agents/${made[3]}/reactivate`, s)).status, 200);
    await sameAsBefore('reativados');
    // chegada no mesmo instante: desempata pela ordem de inserção (rowid), como antes
    const fl = h.db.get<{ id: string }>('SELECT f.id FROM floors f WHERE f.building_id = ? AND f.removed_at IS NULL ORDER BY f.level DESC LIMIT 1', emporio)!.id;
    const prof = h.db.get<{ id: string }>("SELECT id FROM profiles WHERE workspace_id = ? AND key = 'producao'", s.workspaceId)!.id;
    const t0 = '2020-01-01T00:00:00.000Z';
    h.db.run('UPDATE floors SET slots = 50 WHERE id = ?', fl);
    for (let i = 0; i < 3; i++) h.db.run("INSERT INTO agents (id, workspace_id, floor_id, profile_id, name, role, color, status, created_at) VALUES (?, ?, ?, ?, ?, 'x', '#2f6f8f', 'active', ?)", id('agt'), s.workspaceId, fl, prof, `Empate ${i}`, t0);
    const { all } = await sameAsBefore('empate');
    assert.deepEqual(all.filter((a) => a.name.startsWith('Empate')).map((a) => a.name), ['Empate 0', 'Empate 1', 'Empate 2']);
    assert.deepEqual(all.filter((a) => a.name.startsWith('Empate')).map((a) => a.slot), [0, 1, 2], 'os mais antigos do andar');
  });

  test('pedidos inválidos: um modo por vez, limites e cursores conferidos', async () => {
    const bad = async (q: string) => (await req(h, 'GET', `/api/city/agents${q}`, s)).status;
    assert.equal(await bad(''), 400, 'sem modo');
    const b = (await cityStructures(h, s))[0].id;
    assert.equal(await bad(`?all=1&b=${b}`), 400, 'dois modos');
    assert.equal(await bad(`?per=3&all=1`), 400, 'per só com b');
    assert.equal(await bad(`?cursor=abc&b=${b}`), 400, 'cursor só com all');
    assert.equal(await bad('?all=1&cursor=lixo!'), 400);
    assert.equal(await bad(`?all=1&cursor=${Buffer.from('["x",1]').toString('base64url')}`), 400);
    assert.equal(await bad(`?b=${b}&per=51`), 400);
    assert.equal(await bad('?f=flr_1'), 400, 'id fora do formato');
    assert.equal(await bad(`?f=${Array.from({ length: 101 }, () => id('flr')).join(',')}`), 400, 'até 100 andares');
    assert.equal(await bad(`?b=${Array.from({ length: 65 }, () => id('bld')).join(',')}`), 400, 'até 64 construções');
    assert.equal(await bad(`?ids=${Array.from({ length: 201 }, () => id('agt')).join(',')}`), 400, 'até 200 agentes');
    const none = (await req(h, 'GET', `/api/city/agents?ids=${id('agt')}`, s)).json;
    assert.deepEqual(none, { total: 0, agents: [], next: null }, 'id de fora: nada, sem erro');
    assert.equal((await req(h, 'GET', '/api/agents?cursor=lixo!', s)).status, 400);
    const p = (await req(h, 'GET', '/api/agents?limit=999', s)).json;
    assert.ok(p.items.length <= 100 && p.total >= p.items.length, 'páginas de até 100, total do banco');
  });
});

describe('contagens da cidade e /api/state enxuto', () => {
  let h: Harness; let s: Session;
  before(async () => { h = await harness(); s = await setupOwner(h); });
  after(async () => { await h.close(); });

  test('janelas pelo status de cada AGENTE (a execução ativa mais antiga), não pelo número de execuções', async () => {
    const full = await allAgents(h, s);
    const run = (agentId: string, status: string, at: string) => h.db.run("INSERT INTO runs (id, workspace_id, agent_id, kind, status, mode, input, idempotency_key, created_at) VALUES (?, ?, ?, 'subtask', ?, 'simulated', 'x', ?, ?)",
      id('run'), s.workspaceId, agentId, status, id('idem'), at);
    // um trabalhando, um esperando você, um na fila, e um com duas: a mais antiga (na fila) é o status dele
    run(full[1].id, 'running', '2026-10-31T10:00:00.000Z');
    run(full[2].id, 'waiting_user', '2026-10-31T10:00:00.000Z');
    run(full[3].id, 'queued', '2026-10-31T10:00:00.000Z');
    run(full[7].id, 'queued', '2026-10-31T09:00:00.000Z'); run(full[7].id, 'running', '2026-10-31T09:30:00.000Z'); run(full[7].id, 'running', '2026-10-31T09:40:00.000Z');
    // empate de horário: desempata pela ordem de inserção
    run(full[8].id, 'waiting_user', '2026-10-31T11:00:00.000Z'); run(full[8].id, 'running', '2026-10-31T11:00:00.000Z');
    const prof = await allAgents(h, s);
    assert.equal(prof.find((a) => a.id === full[7].id).run_status, 'queued');
    assert.equal(prof.find((a) => a.id === full[8].id).run_status, 'waiting_user');
    const ov = (await req(h, 'GET', '/api/city/overview', s)).json as { total: number; structures: Array<{ id: string; floors: Array<{ id: string; active: number; working: number; waiting: number; queued: number }> }> };
    assert.equal(ov.total, prof.filter((a) => a.status === 'active').length);
    for (const st of ov.structures) for (const f of st.floors) {
      const on = prof.filter((a) => a.status === 'active' && a.floor_id === f.id);
      assert.deepEqual([f.active, f.working, f.waiting, f.queued], [on.length, on.filter((a) => a.run_status === 'running').length,
        on.filter((a) => a.run_status === 'waiting_user').length, on.filter((a) => a.run_status === 'queued').length], f.id);
    }
    const sum = (k: 'working' | 'waiting' | 'queued') => ov.structures.flatMap((x) => x.floors).reduce((n, f) => n + f[k], 0);
    assert.deepEqual([sum('working'), sum('waiting'), sum('queued')], [1, 2, 2], 'contam agentes: 6 execuções ativas, 5 agentes');
    // a cena recebe o mesmo status (Equipe por partes também)
    const city = (await req(h, 'GET', '/api/city/agents?all=1', s)).json.agents as CityAgent[];
    for (const a of city) assert.equal(a.run_status, prof.find((x) => x.id === a.id).run_status, a.name);
    assert.equal((await req(h, 'GET', `/api/team/agents/${full[7].id}`, s)).json.run_status, 'queued');
    h.db.run("UPDATE runs SET status = 'cancelled', finished_at = ? WHERE workspace_id = ? AND status IN ('queued', 'running', 'waiting_user')", now(), s.workspaceId);
  });

  test('/api/state sem a equipe: totais, Coordenador, quem revisa e os primeiros nomes; pequeno', async () => {
    const r = await req(h, 'GET', '/api/state', s);
    const st = r.json;
    assert.equal(st.agents, undefined); assert.equal(st.structures, undefined); assert.equal(st.capacity.floors, undefined);
    const cap = (await req(h, 'GET', '/api/capacity', s)).json;
    assert.deepEqual(st.capacity, { slots: cap.slots, active: cap.active, free: cap.free, maxFloors: cap.maxFloors, note: cap.note });
    assert.ok(Array.isArray(cap.floors) && cap.floors.length > 0, 'os andares continuam em /api/capacity');
    const full = await allAgents(h, s);
    const coord = full.find((a) => a.coordinator);
    assert.equal(st.team.coordinator.id, coord.id); assert.equal(st.team.coordinator.name, 'Aristóteles');
    assert.equal(st.team.coordinator.floor_level, coord.floor_level); assert.equal(st.team.coordinator.floor_id, coord.floor_id);
    assert.deepEqual(st.team.reviewer, { id: full.find((a) => a.char_key === 'socrates').id, name: 'Sócrates' });
    assert.equal(st.team.active, full.filter((a) => a.status === 'active').length);
    assert.equal(st.team.archived, full.filter((a) => a.status === 'archived').length);
    // os três primeiros ativos que não coordenam, na ordem de antes (a da lista inteira)
    assert.deepEqual(st.team.others, full.filter((a) => a.status === 'active' && a.id !== coord.id).slice(0, 3).map((a) => ({ id: a.id, name: a.name })));
    assert.ok(Buffer.byteLength(r.res.body) < 10 * 1024, `pequeno: ${r.res.body.length} bytes`);
    for (const k of ['workspace', 'runs', 'decisionsPending', 'executor', 'sectors', 'teamAutorun', 'teamInitiative', 'themed', 'serverTime']) assert.ok(k in st, k);
  });

  test('Coordenador e revisor no banco: a mesma escolha de services/team.ts, inclusive em dados antigos', async () => {
    const ws = s.workspaceId;
    const same = (label: string) => {
      const team = activeTeam(h.db, ws);
      assert.equal(coordinatorFor(h.db, ws), coordinatorOf(team)?.id ?? null, `${label}: coordenador`);
      for (const except of [null, ...team.map((a) => a.id)]) assert.equal(reviewerFor(h.db, ws, except)?.id ?? null, reviewerOf(team, except)?.id ?? null, `${label}: revisor sem ${except}`);
    };
    same('partida');
    // mais quem revisa, em outro setor e numa construção que vem antes na ordem da cidade (antes, a tela podia mostrar outro nome)
    const full = await allAgents(h, s);
    const give = (key: string) => { const a = full.find((x) => x.char_key === key); h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify([...a.tools.map((t: { id: string }) => t.id), 'revisao']), a.id); return a; };
    give('hipatia'); give('euclides'); give('platao');
    same('vários revisores');
    h.db.run("UPDATE agents SET tools = 'isto não é JSON' WHERE id = ?", full.find((x) => x.char_key === 'diogenes').id);
    same('ferramentas ilegíveis');
    // dado antigo: ninguém marcado como Coordenador
    const coord = full.find((a) => a.coordinator);
    h.db.run('UPDATE agents SET coordinator = 0 WHERE id = ?', coord.id);
    same('sem a marca');
    h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro']), coord.id);
    same('sem a marca e sem encaminhar');
    h.db.run('UPDATE agents SET coordinator = 1, tools = ? WHERE id = ?', JSON.stringify(coord.tools.map((t: { id: string }) => t.id)), coord.id);
    // Sócrates fora: o próximo da qualidade, por chegada
    const soc = full.find((a) => a.char_key === 'socrates');
    assert.equal((await req(h, 'POST', `/api/agents/${soc.id}/deactivate`, s)).status, 200);
    same('sem o Sócrates');
    assert.equal((await req(h, 'GET', '/api/state', s)).json.team.reviewer.name, 'Euclides');
    assert.equal((await req(h, 'POST', `/api/agents/${soc.id}/reactivate`, s)).status, 200);
    same('de volta');
    // escrever um agente novo com a coordenação: quem redige é o Coordenador (escolhido no banco)
    const d = await req(h, 'POST', '/api/agents/draft', s, { name: 'Tales', role: 'Astronomia e previsões', requestId: 'rascunho-0001' });
    assert.equal(d.status, 202, JSON.stringify(d.json));
    assert.equal(h.db.get<{ agent_id: string }>('SELECT agent_id FROM runs WHERE id = ?', d.json.runId)!.agent_id, coord.id);
  });

  test('a revisão começa com quem o card mostra (reviewerFor também no review.ts)', async () => {
    const full = await allAgents(h, s);
    // um revisor da qualidade que chegou depois, numa construção que vem antes de todas na ordem binária
    const ws = s.workspaceId; const t0 = now();
    h.db.run("INSERT INTO buildings (id, workspace_id, name, kind, origin, created_at, lot_x, lot_z) VALUES ('bld_00000000000000000000000000000000', ?, 'Primeira', 'stoa', 'simulated', ?, 900, 900)", ws, t0);
    h.db.run("INSERT INTO floors (id, workspace_id, building_id, level, name, slots, origin, created_at) VALUES ('flr_00000000000000000000000000000000', ?, 'bld_00000000000000000000000000000000', 0, 'Térreo', 6, 'simulated', ?)", ws, t0);
    const prof = h.db.get<{ id: string }>("SELECT id FROM profiles WHERE workspace_id = ? AND key = 'qualidade'", ws)!.id;
    h.db.run("INSERT INTO agents (id, workspace_id, floor_id, profile_id, name, role, color, status, created_at, tools) VALUES ('agt_00000000000000000000000000000001', ?, 'flr_00000000000000000000000000000000', ?, 'Crítico', 'Revisão', '#123456', 'active', ?, ?)",
      ws, prof, t0, JSON.stringify(['revisao']));
    const her = full.find((a) => a.char_key === 'herodoto');
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Relatório anual', description: 'Rascunho do relatório anual com os números do ano.', agentId: her.id })).json;
    const card = (await req(h, 'GET', `/api/tasks/${t.id}`, s)).json;
    const want = reviewerOf(activeTeam(h.db, ws), her.id)!;
    assert.deepEqual(card.reviewer, { id: want.id, name: want.name });
    assert.notEqual(card.reviewer.name, 'Crítico', 'a regra do serviço (chegada), não a ordem da cidade');
    const r = await req(h, 'POST', `/api/tasks/${t.id}/review`, s, {});
    assert.equal(r.status, 202, JSON.stringify(r.json));
    assert.equal(h.db.get<{ reviewer_id: string }>('SELECT reviewer_id FROM reviews WHERE id = ?', r.json.reviewId)!.reviewer_id, card.reviewer.id);
    await drain(h, 12);
  });
});

describe('o agente leve dentro das respostas que as telas já pedem', () => {
  let h: Harness; let s: Session; let full: any[];
  const lite = (a: any) => ({ id: a.id, name: a.name, role: a.role, color: a.color, char_key: a.char_key, look_seed: a.look_seed, sector_name: a.sector_name });
  before(async () => { h = await harness(); s = await setupOwner(h); full = await allAgents(h, s); });
  after(async () => { await h.close(); });
  const by = (key: string) => full.find((a) => a.char_key === key);

  test('conversas recentes e a busca das conversas (contatos e arquivos)', async () => {
    const hip = by('hipatia');
    const c = (await req(h, 'POST', '/api/conversations', s, { agentId: hip.id })).json.id;
    const doc = await req(h, 'POST', '/api/artifacts', s, Buffer.from('anotações'), { 'content-type': 'application/octet-stream', 'x-filename': 'relatorio-hipatia.txt', 'x-file-type': 'text/plain', 'x-conversation-id': c });
    assert.equal((await req(h, 'POST', `/api/conversations/${c}/messages`, s, { text: 'segue o arquivo', clientRequestId: 'leve-0001', attachments: [doc.json.id] })).status, 201);
    await drain(h, 3);
    const recent = (await req(h, 'GET', '/api/conversations/recent', s)).json as Array<{ id: string; agent_id: string; agent: unknown }>;
    const row = recent.find((x) => x.id === c)!;
    assert.deepEqual(row.agent, lite(hip));
    const found = (await req(h, 'GET', '/api/search/conversations?q=hipatia', s)).json;
    assert.deepEqual(found.contatos, [lite(hip)], 'sem acento, com o retrato');
    // no banco: nome ou papel (sem acento, sem caixa), o Coordenador primeiro e depois pelo nome — o mesmo critério de antes
    for (const q of ['QUALIDADE', 'revis', 'ção', 'ar', 'arq']) {
      const t = foldText(q);
      const want = full.filter((a) => a.status === 'active' && (foldText(a.name).includes(t) || foldText(a.role).includes(t)))
        .sort((a, b) => Number(b.coordinator) - Number(a.coordinator) || foldText(a.name).localeCompare(foldText(b.name)) || (a.id < b.id ? -1 : 1)).slice(0, 20).map(lite);
      assert.deepEqual((await req(h, 'GET', `/api/search/conversations?q=${encodeURIComponent(q)}&kind=contatos`, s)).json.contatos, want, q);
    }
    const file = found.arquivos.find((f: { id: string }) => f.id === doc.json.id);
    assert.deepEqual(file.agent, lite(hip), 'o arquivo diz com quem foi a conversa');
    // desativado some dos contatos e das recentes, mas o arquivo continua com o nome
    const dio = by('diogenes');
    assert.equal((await req(h, 'POST', `/api/agents/${dio.id}/deactivate`, s)).status, 200);
    assert.deepEqual((await req(h, 'GET', '/api/search/conversations?q=diogenes&kind=contatos', s)).json.contatos, []);
    assert.equal((await req(h, 'POST', `/api/agents/${dio.id}/reactivate`, s)).status, 200);
  });

  test('cards do quadro, o card aberto (nomes citados e quem revisa) e os itens da Central', async () => {
    const her = by('herodoto'); const fid = by('fidias');
    const boards = (await req(h, 'GET', '/api/boards', s)).json as Array<{ id: string; audience: string }>;
    const team = boards.find((b) => b.audience === 'team')!; const mine = boards.find((b) => b.audience === 'user')!;
    const t = (await req(h, 'POST', '/api/tasks', s, { title: 'Texto do folheto', agentId: her.id })).json;
    const view = (await req(h, 'GET', `/api/boards/${team.id}`, s)).json;
    const card = view.tasks.find((x: { id: string }) => x.id === t.id);
    assert.deepEqual([card.agent_name, card.agent_color], [her.name, her.color]);
    // enviada à equipe: a etiqueta mostra quem recebeu
    const own = (await req(h, 'POST', '/api/tasks', s, { title: 'Arte do folheto', boardId: mine.id })).json;
    const sent = (await req(h, 'POST', `/api/tasks/${own.id}/send-to-team`, s)).json;
    const child = h.db.get<{ id: string; agent_id: string }>('SELECT id, agent_id FROM tasks WHERE workspace_id = ? AND number = ?', s.workspaceId, sent.number)!;
    const who = full.find((a) => a.id === child.agent_id);
    const myCard = (await req(h, 'GET', `/api/boards/${mine.id}`, s)).json.tasks.find((x: { id: string }) => x.id === own.id);
    assert.equal(myCard.team_agent_id, child.agent_id);
    assert.deepEqual([myCard.team_agent_name, myCard.team_agent_color], [who?.name ?? null, who?.color ?? null]);
    // card aberto: todos os citados, desativados também (card concluído não é redistribuído: fica com o nome de quem fez)
    h.db.run("INSERT INTO runs (id, workspace_id, agent_id, task_id, kind, status, mode, input, idempotency_key, created_at, finished_at) VALUES (?, ?, ?, ?, 'subtask', 'succeeded', 'simulated', 'x', ?, ?, ?)",
      id('run'), s.workspaceId, fid.id, t.id, id('idem'), now(), now());
    h.db.run('UPDATE tasks SET completed = 1 WHERE id = ?', t.id);
    assert.equal((await req(h, 'POST', `/api/agents/${her.id}/deactivate`, s)).status, 200);
    try {
      const open = (await req(h, 'GET', `/api/tasks/${t.id}`, s)).json;
      assert.equal(open.task.agent_id, her.id);
      assert.deepEqual(open.agents[her.id], { name: her.name, color: her.color }, 'o responsável (desativado) continua com nome');
      assert.deepEqual(open.agents[fid.id], { name: fid.name, color: fid.color }, 'quem rodou no card');
      for (const e of open.log.filter((x: { actor_type: string }) => x.actor_type === 'agent')) assert.ok(open.agents[e.actor_id], `autor ${e.actor_id}`);
      const rv = reviewerOf(activeTeam(h.db, s.workspaceId), open.task.agent_id);
      assert.deepEqual(open.reviewer, rv ? { id: rv.id, name: rv.name } : null);
      const boardAfter = (await req(h, 'GET', `/api/boards/${team.id}`, s)).json.tasks.find((x: { id: string }) => x.id === t.id);
      assert.deepEqual([boardAfter.agent_name, boardAfter.agent_color], [her.name, her.color], 'desativado: o card não perde o nome');
    } finally { assert.equal((await req(h, 'POST', `/api/agents/${her.id}/reactivate`, s)).status, 200); }
    // Central de Trabalho: o retrato de cada item
    const ops = (await req(h, 'GET', '/api/ambient/operations', s)).json;
    const items = Object.values(ops.items).flat() as Array<{ agentId: string | null; agent: unknown }>;
    assert.ok(items.length > 0);
    for (const it of items) assert.deepEqual(it.agent, it.agentId ? lite(full.find((a) => a.id === it.agentId)) : null);
  });

  test('preparo de rotina: quem conduz (leve) e quem entra nas frases de espera', async () => {
    const r = await req(h, 'POST', '/api/routines', s, { template: 'briefing-diario', tz: 'America/Sao_Paulo', adapt: true });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const st = (await req(h, 'GET', `/api/routines/${r.json.id}/setup`, s)).json;
    const agentId = st.setup.agentId as string;
    assert.ok(agentId);
    assert.deepEqual(st.setup.agent, (await req(h, 'GET', `/api/team/agents/${agentId}`, s)).json);
    assert.deepEqual(st.cast, ['aristoteles', 'hipatia', 'socrates', 'arquimedes', 'diogenes', 'euclides', 'herodoto']);
    // com outro nome (um tema), a piada daquele personagem sai; desativado também
    await req(h, 'PATCH', `/api/agents/${by('hipatia').id}`, s, { name: 'Hipátia de Alexandria' });
    assert.equal((await req(h, 'POST', `/api/agents/${by('euclides').id}/deactivate`, s)).status, 200);
    const st2 = (await req(h, 'GET', `/api/routines/${r.json.id}/setup`, s)).json;
    assert.deepEqual(st2.cast, ['aristoteles', 'socrates', 'arquimedes', 'diogenes', 'herodoto']);
    await req(h, 'PATCH', `/api/agents/${by('hipatia').id}`, s, { name: 'Hipátia' });
    assert.equal((await req(h, 'POST', `/api/agents/${by('euclides').id}/reactivate`, s)).status, 200);
  });

  test('quem tem cada ferramenta: quantos e até 3 nomes, o Coordenador primeiro', async () => {
    const now2 = await allAgents(h, s);
    const tools = (await req(h, 'GET', '/api/ai/tools', s)).json as Array<{ id: string; holders: { count: number; sample: string[] } }>;
    const coord = now2.find((a) => a.coordinator);
    for (const t of tools) {
      const who = now2.filter((a) => a.status === 'active' && a.tools.some((x: { id: string }) => x.id === t.id));
      const order = [...who].sort((a, b) => (a.id === coord.id ? -1 : b.id === coord.id ? 1 : 0) || foldText(a.name).localeCompare(foldText(b.name)) || (a.id < b.id ? -1 : 1));
      assert.equal(t.holders.count, who.length, t.id);
      assert.deepEqual(t.holders.sample, order.slice(0, 3).map((a) => a.name), t.id);
    }
    assert.ok(tools.some((t) => t.holders.count > 3), 'alguma com mais de 3 ("e mais X" na tela)');
  });

  test('busca rápida (Ctrl+K): os agentes na ordem do rank() de antes, até 6', async () => {
    for (const [name, role, sectorKey] of [['Ana Dados', 'Planilhas', 'qualidade'], ['Mariana', 'Atendimento de dados', 'central'], ['Damião', 'Produção de vídeo', 'producao'], ['Anaximandro', 'Mapas', 'brainstorm']]) {
      assert.equal((await req(h, 'POST', '/api/agents', s, { name, role, sectorKey })).status, 201);
    }
    const list = (await allAgents(h, s)).filter((a) => a.status === 'active');
    const old = (q: string) => list.map((a) => ({ a, r: rank(q, `${a.name} ${a.role} ${a.sector_name}`) })).filter((x) => x.r >= 0).sort((x, y) => y.r - x.r).slice(0, 6).map((x) => lite(x.a));
    for (const q of ['a', 'ana', 'ANA dados', 'dados', 'qualidade', 'hipatia', 'sócrates revis', 'ão', 'pro', 'zzz', 'mapas brain']) {
      const r = (await req(h, 'GET', `/api/search?q=${encodeURIComponent(q)}`, s)).json;
      assert.deepEqual(r.agents, old(q), q);
    }
    assert.equal((await req(h, 'GET', '/api/search?q=a', s)).json.agents.length, 6, 'corta em 6 depois de ordenar');
  });
});

describe('nuvem sem 2º fator: a Cidade abre por trás da matrícula, como o /api/state', () => {
  test('/api/city/* responde; o resto pede o cadastro do autenticador', async () => {
    const h = await harness({ mode: 'cloud' });
    const s = await setupOwner(h);
    assert.equal((await req(h, 'GET', '/api/boards', s)).json.error, 'enroll_2fa');
    assert.equal((await req(h, 'GET', '/api/state', s)).status, 200);
    assert.equal((await req(h, 'GET', '/api/city/overview', s)).status, 200);
    assert.equal((await req(h, 'GET', '/api/city/agents?all=1', s)).status, 200);
    assert.equal((await req(h, 'GET', '/api/agents', s)).json.error, 'enroll_2fa', 'o perfil completo, não');
    await h.close();
  });
});
