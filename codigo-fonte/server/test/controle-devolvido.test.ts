/** O aviso de "controle devolvido" (rc.43): o navegador voltou sozinho ao agente; a pessoa vê uma vez, na próxima abertura. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { audit } from '../src/services/bus.ts';
import { harness, req, setupOwner } from './helpers.ts';

test('só os automáticos, só de quem estava no controle, até ela ver', async () => {
  const h = await harness(); const s = await setupOwner(h);
  try {
    const ag = h.db.get<{ id: string; name: string }>("SELECT id, name FROM agents WHERE workspace_id = ? AND status = 'active' LIMIT 1", s.workspaceId)!;
    const userId = h.db.get<{ user_id: string }>('SELECT user_id FROM memberships WHERE workspace_id = ? LIMIT 1', s.workspaceId)!.user_id;
    const devolveu = (motivo: string, quem = userId, tipo: 'system' | 'user' = 'system') => audit(h.db, null, { workspaceId: s.workspaceId, actorType: tipo, actorId: quem, action: 'navegador.devolveu', targetType: 'run', targetId: 'run_x', evidence: { agentId: ag.id, motivo }, result: 'voltou' });
    devolveu('pessoa', userId, 'user');
    devolveu('fim');
    devolveu('queda', 'usr_outra');
    let r = await req(h, 'GET', '/api/controle/devolvido', s);
    assert.deepEqual((r.json as { avisos: unknown[] }).avisos, [], 'nem o que a pessoa fez, nem o fim do trabalho, nem o de outra pessoa');
    devolveu('queda');
    r = await req(h, 'GET', '/api/controle/devolvido', s);
    const avisos = (r.json as { avisos: Array<{ recurso: string; motivo: string; agente: string }> }).avisos;
    assert.equal(avisos.length, 1);
    assert.deepEqual([avisos[0].recurso, avisos[0].motivo, avisos[0].agente], ['navegador', 'queda', ag.name]);
    assert.equal((await req(h, 'POST', '/api/controle/devolvido/visto', s)).status, 200);
    r = await req(h, 'GET', '/api/controle/devolvido', s);
    assert.deepEqual((r.json as { avisos: unknown[] }).avisos, [], 'visto: some');
  } finally { await h.close(); }
});
