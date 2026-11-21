// Salas num computador (sem o World): criar, membros, @menção ao agente (só o mencionado responde, em ordem), agente
// chamando agente sem laço, quem não está na sala não vê nada (IDOR entre salas e workspaces), as rotas de conversa não
// servem de atalho e os limites de tamanho e frequência.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { addPerson, drain, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

let h: Harness; let s: Session; let outra: Session;
const agentes = () => h.db.all<{ id: string; name: string }>("SELECT id, name FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator DESC, name", s.workspaceId);
const marca = (texto: string, trecho: string, tipo: 'pessoa' | 'agente' | 'cessao', chave: string) => { const i = texto.indexOf(trecho); return { tipo, chave, inicio: i, fim: i + trecho.length }; };
let rid = 0; const crid = () => `salas-teste-${String(++rid).padStart(4, '0')}`;

before(async () => {
  h = await harness();
  s = await setupOwner(h, 'rogerio', 'senha-do-rogerio-1');
  outra = await addPerson(h, 'bia', 'senha-da-bia-12345', 'Bia');
});
after(async () => { await h?.close(); });

test('criar sala com um agente; @menção: só o mencionado responde, com o autor; sem marca, ninguém responde', async () => {
  const [a1, a2] = agentes();
  const c = await req(h, 'POST', '/api/salas', s, { nome: 'Financeiro', agentes: [a1.name, a2.name] });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  const sala = c.json.id as string;
  const lista = await req(h, 'GET', '/api/salas', s);
  assert.equal(lista.json.salas.length, 1);
  assert.equal(lista.json.salas[0].nome, 'Financeiro');
  assert.equal(lista.json.podeCriar, true);
  // a sala não aparece nas conversas da pessoa com os agentes
  assert.ok(!(await req(h, 'GET', '/api/conversations', s)).json.some((x: { id: string }) => x.id === sala));

  // texto com "@Nome" sem a marca da tela: nenhum agente responde
  const cru = await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: `@${a1.name} oi`, clientRequestId: crid() });
  assert.equal(cru.status, 201);
  assert.deepEqual(cru.json.agentes, []);
  await drain(h);
  assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE conversation_id = ?", sala)!.n, 0);

  // com a marca: só ele responde, e a resposta tem o autor
  const t = `@${a2.name}, qual o saldo?`;
  const r = await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: t, clientRequestId: crid(), marcas: [marca(t, `@${a2.name}`, 'agente', a2.name)] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(r.json.agentes, [a2.name]);
  await drain(h);
  const m = (await req(h, 'GET', `/api/salas/${sala}/mensagens`, s)).json.mensagens as Array<{ role: string; autor: { nome: string; chave: string }; content: string; marcas: unknown }>;
  const resp = m.filter((x) => x.role === 'agent');
  assert.equal(resp.length, 1);
  assert.equal(resp[0].autor.nome, a2.name);
  assert.equal(resp[0].autor.chave, `agt:${a2.name}`);
  assert.ok(m.some((x) => x.role === 'user' && Array.isArray(x.marcas)));
  // o agente recebeu o histórico com os autores e o pedido de quem pediu
  const run = h.db.get<{ input: string; instructions: string }>('SELECT input, instructions FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', sala)!;
  assert.match(run.input, /\[Alexandre\]: @/);
  assert.match(run.input, /Alexandre pediu: @/);
  assert.match(run.instructions, /sala "Financeiro"/);
});

test('vários agentes mencionados respondem em ordem, um por vez; agente chama agente uma vez só (sem laço)', async () => {
  const [a1, a2] = agentes();
  const sala = (await req(h, 'POST', '/api/salas', s, { nome: 'Ordem', agentes: [a1.name, a2.name] })).json.id as string;
  // o agente simulado sempre pede ajuda ao outro: só a primeira chamada vale
  const ex = h.executor as unknown as { simulatedOutput: (r: { agent_id: string }) => string };
  const antes = ex.simulatedOutput;
  ex.simulatedOutput = (r) => { const outro = r.agent_id === a1.id ? a2.name : a1.name; return `Feito por mim.\n[[chamar agente="${outro}" pedido="continue"]]`; };
  try {
    const t = `@${a1.name} e @${a2.name}, dividam isto`;
    const r = await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: t, clientRequestId: crid(), marcas: [marca(t, `@${a1.name}`, 'agente', a1.name), marca(t, `@${a2.name}`, 'agente', a2.name)] });
    assert.deepEqual(r.json.agentes, [a1.name, a2.name]);
    // um por vez: enquanto o primeiro roda, o segundo espera
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE conversation_id = ? AND status IN ('queued','running')", sala)!.n, 1);
    await drain(h, 30);
  } finally { ex.simulatedOutput = antes; }
  const msgs = (await req(h, 'GET', `/api/salas/${sala}/mensagens`, s)).json.mensagens as Array<{ role: string; autor: { nome: string }; content: string }>;
  const quem = msgs.filter((m) => m.role === 'agent').map((m) => m.autor.nome);
  // a1, a2 (as menções, em ordem) e UMA chamada de agente para agente — nunca mais que isso
  assert.deepEqual(quem, [a1.name, a2.name, a2.name]);
  assert.ok(msgs.every((m) => !m.content.includes('[[chamar')), 'a linha de controle não aparece na sala');
  assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM salas_fila WHERE conversation_id = ?', sala)!.n, 3);
});

test('quem não está na sala não vê nada: 404 em toda rota, também pelas rotas de conversa (IDOR entre workspaces)', async () => {
  const [a1] = agentes();
  const sala = (await req(h, 'POST', '/api/salas', s, { nome: 'Segredo', agentes: [a1.name] })).json.id as string;
  for (const [m, u, b] of [['GET', `/api/salas/${sala}`], ['GET', `/api/salas/${sala}/mensagens`], ['POST', `/api/salas/${sala}/mensagens`, { texto: 'oi', clientRequestId: crid() }],
    ['PATCH', `/api/salas/${sala}`, { nome: 'x' }], ['POST', `/api/salas/${sala}/membros`, { tipo: 'agente', chave: a1.name }], ['POST', `/api/salas/${sala}/sair`], ['POST', `/api/salas/${sala}/lido`],
    ['GET', `/api/conversations/${sala}/messages`], ['GET', `/api/conversations/${sala}/media`]] as Array<[string, string, unknown?]>) {
    const r = await req(h, m, u, outra, b);
    assert.equal(r.status, 404, `${m} ${u}: ${r.status}`);
  }
  assert.equal((await req(h, 'GET', '/api/salas', outra)).json.salas.length, 0);
  // a rota de conversa com o agente não serve de atalho para escrever na sala (nem a dona)
  const atalho = await req(h, 'POST', `/api/conversations/${sala}/messages`, s, { text: 'oi', clientRequestId: crid() });
  assert.equal(atalho.status, 409);
  // id de outro formato: o esquema recusa
  assert.equal((await req(h, 'GET', '/api/salas/cnv_nao-existe', s)).status, 400);
});

test('renomear, arquivar, tirar o agente e sair; o membro que saiu não lê mais', async () => {
  const [a1, a2] = agentes();
  const sala = (await req(h, 'POST', '/api/salas', s, { nome: 'Projeto', agentes: [a1.name] })).json.id as string;
  assert.equal((await req(h, 'POST', `/api/salas/${sala}/membros`, s, { tipo: 'agente', chave: a2.name })).status, 200);
  assert.equal((await req(h, 'POST', `/api/salas/${sala}/membros`, s, { tipo: 'agente', chave: 'Ninguém Assim' })).status, 404);
  assert.equal((await req(h, 'POST', `/api/salas/${sala}/membros`, s, { tipo: 'pessoa', chave: `usr:${outra.userId}` })).status, 404, 'pessoa de outro workspace não entra');
  assert.equal((await req(h, 'PATCH', `/api/salas/${sala}`, s, { nome: 'Projeto Alfa' })).status, 200);
  let d = (await req(h, 'GET', `/api/salas/${sala}`, s)).json;
  assert.equal(d.nome, 'Projeto Alfa');
  assert.equal(d.membros.filter((m: { tipo: string }) => m.tipo === 'agente').length, 2);
  assert.equal((await req(h, 'POST', `/api/salas/${sala}/membros/remover`, s, { tipo: 'agente', chave: a2.name })).status, 200);
  // agente tirado não responde, mesmo com marca
  const t = `@${a2.name} oi`;
  const r = await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: t, clientRequestId: crid(), marcas: [marca(t, `@${a2.name}`, 'agente', a2.name)] });
  assert.deepEqual(r.json.agentes, []);
  assert.equal((await req(h, 'PATCH', `/api/salas/${sala}`, s, { arquivada: true })).status, 200);
  assert.equal((await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: 'oi', clientRequestId: crid() })).status, 409, 'arquivada: só leitura');
  d = (await req(h, 'GET', `/api/salas/${sala}`, s)).json;
  assert.equal(d.arquivada, true);
  assert.equal((await req(h, 'POST', `/api/salas/${sala}/sair`, s)).status, 200);
  assert.equal((await req(h, 'GET', `/api/salas/${sala}`, s)).status, 404);
  assert.equal((await req(h, 'GET', `/api/conversations/${sala}/messages`, s)).status, 404, 'quem saiu não lê pela rota de conversa');
});

test('limites: tamanho do texto, frequência por minuto e marcas a mais pelo esquema; cartão de tarefa a partir da mensagem', async () => {
  const [a1] = agentes();
  const sala = (await req(h, 'POST', '/api/salas', s, { nome: 'Limites', agentes: [a1.name] })).json.id as string;
  assert.equal((await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: 'x'.repeat(h.cfg.maxInputChars + 1), clientRequestId: crid() })).status, 400);
  const muitas = Array.from({ length: 41 }, (_, i) => ({ tipo: 'agente', chave: a1.name, inicio: i, fim: i + 1 }));
  assert.equal((await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: 'oi', clientRequestId: crid(), marcas: muitas })).status, 400);
  const primeira = await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: 'Fechar o balanço de novembro até sexta', clientRequestId: crid() });
  // o mesmo pedido de novo (resposta perdida) não duplica
  const again = await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: 'Fechar o balanço de novembro até sexta', clientRequestId: `salas-teste-${String(rid).padStart(4, '0')}` });
  assert.equal(again.json.messageId, primeira.json.messageId);
  let ultimo = 201;
  for (let i = 0; i < 40 && ultimo !== 429; i++) ultimo = (await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: `msg ${i}`, clientRequestId: crid() })).status;
  assert.equal(ultimo, 429, 'mensagens demais num minuto');
  const t = await req(h, 'POST', `/api/salas/${sala}/mensagens/${primeira.json.messageId}/tarefa`, s);
  assert.equal(t.status, 201, JSON.stringify(t.json));
  const task = h.db.get<{ title: string; conversation_id: string }>('SELECT title, conversation_id FROM tasks WHERE id = ?', t.json.id)!;
  assert.match(task.title, /balanço de novembro/);
  assert.equal(task.conversation_id, sala);
  assert.equal((await req(h, 'POST', `/api/salas/${sala}/mensagens/${primeira.json.messageId}/tarefa`, outra)).status, 404);
});

test('governança: só quem administra muda; desligada, ninguém além de quem administra cria sala', async () => {
  assert.deepEqual((await req(h, 'GET', '/api/salas/governanca', s)).json.cessao, true, 'cessão ligada por padrão');
  const g = await req(h, 'PUT', '/api/salas/governanca', s, { cessao: false, criar: 'admins' });
  assert.equal(g.status, 200);
  assert.equal(g.json.cessao, false);
  assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM audit_events WHERE workspace_id = ? AND action = 'salas.governanca'", s.workspaceId)!.n, 1);
  await req(h, 'PUT', '/api/salas/governanca', s, { cessao: true, criar: 'todos' });
});

test('tópicos: compartilhado de uma mensagem (todos da sala veem, a origem mostra nome e respostas); privado só para quem foi convidado', async () => {
  const [a1, a2] = agentes();
  const sala = (await req(h, 'POST', '/api/salas', s, { nome: 'Com tópicos', agentes: [a1.name, a2.name] })).json.id as string;
  const origem = (await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: 'Precisamos decidir o fornecedor de papel', clientRequestId: crid() })).json.messageId as string;
  const t = await req(h, 'POST', `/api/salas/${sala}/topicos`, s, { visibilidade: 'compartilhado', origem });
  assert.equal(t.status, 201, JSON.stringify(t.json));
  const topico = t.json.id as string;
  // agente da sala responde no tópico com @ (as regras valem igual), e o tópico não vira sala na lista
  const texto = `@${a1.name}, compare os três orçamentos`;
  const r = await req(h, 'POST', `/api/salas/${topico}/mensagens`, s, { texto, clientRequestId: crid(), marcas: [marca(texto, `@${a1.name}`, 'agente', a1.name)] });
  assert.deepEqual(r.json.agentes, [a1.name]);
  await drain(h);
  assert.ok(!(await req(h, 'GET', '/api/salas', s)).json.salas.some((x: { id: string }) => x.id === topico), 'o tópico fica dentro da sala');
  const lista = (await req(h, 'GET', `/api/salas/${sala}/topicos`, s)).json;
  assert.deepEqual(lista.map((x: { nome: string; respostas: number; privado: boolean }) => [x.nome, x.respostas, x.privado]), [['Precisamos decidir o fornecedor de papel', 2, false]]);
  const m = (await req(h, 'GET', `/api/salas/${sala}/mensagens`, s)).json.mensagens.find((x: { id: string }) => x.id === origem);
  assert.deepEqual([m.topico.id, m.topico.respostas], [topico, 2]);
  const det = (await req(h, 'GET', `/api/salas/${topico}`, s)).json;
  assert.deepEqual([det.topico.pai, det.topico.visibilidade, det.membros.length], [sala, 'compartilhado', 3], 'membros: os da sala');
  // compartilhado: não se põe nem tira gente (é de todos)
  assert.equal((await req(h, 'POST', `/api/salas/${topico}/membros`, s, { tipo: 'agente', chave: a2.name })).status, 409);
  // privado: só quem abriu e os convidados da sala; agente de fora da sala não entra
  const p = (await req(h, 'POST', `/api/salas/${sala}/topicos`, s, { nome: 'Só nós', visibilidade: 'privado', agentes: [a2.name, 'Ninguém'] })).json.id as string;
  const dp = (await req(h, 'GET', `/api/salas/${p}`, s)).json;
  assert.deepEqual(dp.membros.map((x: { nome: string }) => x.nome).sort(), [a2.name, 'Alexandre'].sort());
  // quem não está na sala não vê tópico nenhum
  assert.equal((await req(h, 'GET', `/api/salas/${topico}`, outra)).status, 404);
  assert.equal((await req(h, 'GET', `/api/salas/${sala}/topicos`, outra)).status, 404);
  assert.equal((await req(h, 'POST', `/api/salas/${topico}/topicos`, s, { visibilidade: 'compartilhado', nome: 'x' })).status, 400, 'sem tópico dentro de tópico');
  // arquivar e reabrir: continua consultável
  assert.equal((await req(h, 'PATCH', `/api/salas/${topico}`, s, { arquivada: true })).status, 200);
  assert.equal((await req(h, 'POST', `/api/salas/${topico}/mensagens`, s, { texto: 'oi', clientRequestId: crid() })).status, 409);
  assert.equal((await req(h, 'GET', `/api/salas/${topico}/mensagens`, s)).status, 200);
  assert.equal((await req(h, 'GET', `/api/salas/${sala}/topicos`, s)).json.find((x: { id: string }) => x.id === topico).arquivado, true);
  assert.equal((await req(h, 'PATCH', `/api/salas/${topico}`, s, { arquivada: false })).status, 200);
  assert.equal((await req(h, 'POST', `/api/salas/${topico}/mensagens`, s, { texto: 'voltei', clientRequestId: crid() })).status, 201);
  assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'sala.topico.criado'"));
});
