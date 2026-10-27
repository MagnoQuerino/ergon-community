import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contactsOf } from './conversations.ts';

const c = (id: string, agent: string, at: string, title = `Conversa ${id}`) => ({ id, agent_id: agent, title, created_at: at, last_user_at: at, last_at: at });

test('uma linha por contato, na ordem da última vez que você escreveu; as outras conversas contam, não repetem', () => {
  const list = [
    c('a1', 'ari', '2026-10-26T21:14:00Z'), c('h1', 'hip', '2026-10-26T14:50:00Z'), c('f1', 'fid', '2026-10-26T14:49:00Z'),
    c('h2', 'hip', '2026-10-26T09:44:00Z'), c('a2', 'ari', '2026-10-26T09:11:00Z', 'Validação 4'), c('h3', 'hip', '2026-10-26T08:27:00Z'),
  ];
  const out = contactsOf(list);
  assert.deepEqual(out.map((x) => x.agentId), ['ari', 'hip', 'fid']);
  assert.equal(out[0].latest.id, 'a1', 'abre na conversa mais recente com o contato');
  assert.equal(out[1].count, 3);
  assert.deepEqual(out[0].titles, ['Conversa a1', 'Validação 4'], 'os títulos servem para a busca');
  assert.deepEqual(contactsOf([...list].reverse()).map((x) => x.agentId), ['ari', 'hip', 'fid'], 'não depende da ordem de chegada');
});
