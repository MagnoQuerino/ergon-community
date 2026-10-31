import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { titleFrom } from '../src/services/chat.ts';
import { allAgents, drain, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

describe('título da conversa: a 1ª mensagem dá nome à conversa', () => {
  let h: Harness;
  let s: Session;
  let agent: { id: string; name: string };
  before(async () => {
    h = await harness();
    s = await setupOwner(h);
    agent = (await allAgents(h, s)).find((a: { name: string }) => a.name === 'Hipátia');
  });
  after(async () => { await h.close(); });

  const open = async (title?: string): Promise<string> =>
    (await req(h, 'POST', '/api/conversations', s, { agentId: agent.id, ...(title ? { title } : {}) })).json.id;
  const say = async (conv: string, text: string, rid: string) => {
    const r = await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text, clientRequestId: rid });
    assert.equal(r.status, 201);
    await drain(h, 3);
  };
  const titleOf = async (conv: string): Promise<string> =>
    (await req(h, 'GET', `/api/conversations?agentId=${agent.id}`, s)).json.find((c: { id: string }) => c.id === conv).title;
  const stored = (conv: string) => (h.db.raw.prepare('SELECT title FROM conversations WHERE id = ?').get(conv) as { title: string }).title;

  test('título padrão → trecho da 1ª mensagem, gravado cifrado', async () => {
    const c = await open();
    assert.equal(await titleOf(c), 'Conversa com Hipátia');
    await say(c, 'Preciso de ideias para o nome da nova linha de cosméticos naturais que vamos lançar em março', 'req-titulo-0001');
    assert.equal(await titleOf(c), 'Preciso de ideias para o nome da nova linha de cosméticos…');
    assert.match(stored(c), /^ev1\.ws_[a-f0-9]{32}\./, 'o trecho vem da mensagem (cifrada): o título também fica cifrado');
  });

  test('mensagem curta vira o título inteiro, sem "…"', async () => {
    const c = await open();
    await say(c, '  Orçamento da\nfesta  ', 'req-titulo-0002');
    assert.equal(await titleOf(c), 'Orçamento da festa');
  });

  test('título escolhido pela pessoa → intacto', async () => {
    const c = await open('Viagem a Atenas');
    await say(c, 'Quais museus valem a visita em três dias?', 'req-titulo-0003');
    assert.equal(await titleOf(c), 'Viagem a Atenas');
    assert.equal(stored(c), 'Viagem a Atenas', 'nada regravado');
  });

  test('segunda mensagem → o título não muda', async () => {
    const c = await open();
    await say(c, 'Rascunho do convite para o lançamento', 'req-titulo-0004');
    await say(c, 'Agora escreva uma versão mais curta, para o WhatsApp', 'req-titulo-0005');
    assert.equal(await titleOf(c), 'Rascunho do convite para o lançamento');
  });

  test('conversa antiga (já com mensagem sua, de antes) → mantém o título padrão', async () => {
    const c = await open();
    h.db.run(`INSERT INTO messages (id, workspace_id, conversation_id, role, author_user_id, content, mode, created_at)
              VALUES ('msg_antiga000000000000000000000001', ?, ?, 'user', ?, ?, 'local', '2026-10-01T12:00:00.000Z')`,
      s.workspaceId, c, s.userId, h.db.seal(s.workspaceId, 'mensagem de antes da mudança'));
    await say(c, 'Uma mensagem nova numa conversa antiga', 'req-titulo-0006');
    assert.equal(await titleOf(c), 'Conversa com Hipátia');
  });

  test('agente renomeado: o título padrão acompanha o nome; o trecho fica', async () => {
    const padrao = await open();
    const nomeada = await open();
    await say(nomeada, 'Plano de conteúdo para novembro', 'req-titulo-0007');
    assert.equal((await req(h, 'PATCH', `/api/agents/${agent.id}`, s, { name: 'Hipátia de Alexandria' })).status, 200);
    assert.equal(await titleOf(padrao), 'Conversa com Hipátia de Alexandria');
    assert.equal(await titleOf(nomeada), 'Plano de conteúdo para novembro');
    // e a próxima conversa nova, com o nome novo, também ganha o trecho
    const nova = await open();
    await say(nova, 'Revisar a apresentação', 'req-titulo-0008');
    assert.equal(await titleOf(nova), 'Revisar a apresentação');
  });

  test('corte: em palavra, sem pontuação sobrando, palavra longa demais corta no limite', () => {
    assert.equal(titleFrom('a'.repeat(30) + ' ' + 'b'.repeat(40)), `${'a'.repeat(30)}…`);
    assert.equal(titleFrom('Pode revisar o contrato, com atenção às cláusulas, multas, prazos e rescisão?'), 'Pode revisar o contrato, com atenção às cláusulas, multas…');
    assert.equal(titleFrom('x'.repeat(100)), `${'x'.repeat(60)}…`);
    assert.equal(titleFrom('veja [imagem: art_0123] e diga o que acha'), 'veja e diga o que acha');
    assert.equal(titleFrom('   '), '');
  });
});
