import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contactsOf, unreadTotal } from './conversations.ts';
import type { RecentConversation } from './types.ts';

const c = (id: string, agent: string, at: string, title = `Conversa ${id}`, more: Partial<RecentConversation> = {}): RecentConversation =>
  ({ id, agent_id: agent, title, created_at: at, last_user_at: at, last_at: at, ...more });

test('uma linha por contato, pela última atividade; as outras conversas contam, não repetem', () => {
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

test('Fixadas › Precisa de você (urgente primeiro) › Recentes; não lidas somadas por contato', () => {
  const list = [
    c('r1', 'ari', '2026-10-30T12:00:00Z', 'x', { unread: 2 }),
    c('p1', 'hip', '2026-10-30T08:00:00Z', 'x', { priority: 'alta', priority_reason: 'precisa de você no card #3' }),
    c('u1', 'asp', '2026-10-30T07:00:00Z', 'x', { priority: 'urgente', priority_reason: 'prazo hoje', unread: 1 }),
    c('f1', 'dio', '2026-10-29T08:00:00Z', 'x', { pinned_at: '2026-10-29T09:00:00Z' }),
    c('w1', 'arq', '2026-10-28T08:00:00Z', 'x', { waiting: 1 }),
    c('r2', 'ari', '2026-10-30T11:00:00Z', 'x', { unread: 1 }),
  ];
  const out = contactsOf(list);
  assert.deepEqual(out.map((x) => [x.agentId, x.section]), [['dio', 'fixadas'], ['asp', 'precisa'], ['hip', 'precisa'], ['arq', 'precisa'], ['ari', 'recentes']]);
  assert.equal(out.find((x) => x.agentId === 'ari')!.unread, 3);
  assert.equal(out.find((x) => x.agentId === 'hip')!.priorityReason, 'precisa de você no card #3');
  assert.equal(unreadTotal(list), 4);
});

test('a conversa fixada vem primeiro entre os assuntos do mesmo colega, mas o contato abre na mais recente', () => {
  const out = contactsOf([c('a', 'ari', '2026-10-30T10:00:00Z'), c('b', 'ari', '2026-10-29T10:00:00Z', 'fixa', { pinned_at: '2026-10-29T11:00:00Z' })]);
  assert.deepEqual(out[0].convs.map((x) => x.id), ['b', 'a']);
  assert.equal(out[0].latest.id, 'a');
});
