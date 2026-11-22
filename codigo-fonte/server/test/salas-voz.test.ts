// Voz nas salas (rc.49): o nome chamado na fala (sem IA, para qualquer nome) decide quem responde; vários chamados
// respondem um de cada vez, dividindo a resposta; o canal de voz em "Todos" segue com quem respondeu por último.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chamaTodos, chaveFonetica, mencionados } from '../../shared/nomes-falados.ts';
import { juntosNota } from '../src/services/salas/servico.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

test('nomes falados: variações da transcrição casam, palavras comuns e pedaços curtos não', () => {
  const nomes = ['Sócrates', 'Aristóteles', 'Hipátia', 'Arquimedes', 'Hesíodo', 'Ana Clara', 'Ana Paula', 'Eva', 'Kleber'];
  const quem = (t: string) => mencionados(t, nomes).map((x) => x.nome);
  for (const t of ['Sócrates, me ajuda', 'socratis você viu?', 'ocrates, oi', 'Sócrate tá aí?', 'SOCRATES']) assert.deepEqual(quem(t), ['Sócrates'], t);
  assert.deepEqual(quem('Arqui medes calcula aí'), ['Arquimedes']);
  assert.deepEqual(quem('esiodo apaga o card'), ['Hesíodo']);
  assert.deepEqual(quem('hipacia e aristotele, vejam isso'), ['Hipátia', 'Aristóteles']);
  assert.deepEqual(quem('Ana Clara e Ana Paula'), ['Ana Clara', 'Ana Paula']);
  assert.deepEqual(quem('cleber, manda'), ['Kleber'], 'k/c e grafias trocadas');
  assert.deepEqual(quem('so isso mesmo, pode fazer'), []);
  assert.deepEqual(quem('ana disse que vai'), [], 'primeiro nome de dois agentes não basta');
  // nome novo ou renomeado vale na hora: o índice sai dos nomes de agora
  assert.deepEqual(mencionados('Joaquina, me ajuda', ['Joaquina', 'Platão']).map((x) => x.nome), ['Joaquina']);
  assert.equal(chaveFonetica('Sócrates'), chaveFonetica('Socratis'));
  assert.ok(chamaTodos('Pessoal, bom dia'));
  assert.ok(chamaTodos('bom dia equipe, vamos lá'));
  assert.ok(!chamaTodos('quero todos os relatórios'));
});

test('juntos: cada agente sabe a ordem e fala só a sua parte', () => {
  const j = JSON.stringify(['Sócrates', 'Hipátia']);
  assert.match(juntosNota(j, 'Sócrates'), /Você abre/);
  assert.match(juntosNota(j, 'Hipátia'), /Sócrates já respondeu/);
  assert.equal(juntosNota(null, 'Sócrates'), '');
});

let h: Harness; let s: Session;
before(async () => { h = await harness(); s = await setupOwner(h, 'rogerio', 'senha-do-rogerio-1'); });
after(async () => { await h?.close(); });

let rid = 0; const crid = () => `salas-voz-${String(++rid).padStart(4, '0')}`;
const agentes = () => h.db.all<{ id: string; name: string }>("SELECT id, name FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator DESC, name", s.workspaceId);
const esperar = async (f: () => boolean) => { for (let i = 0; i < 100 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };
/** um áudio na sala, já transcrito com `fala` */
async function audioDito(sala: string, fala: string): Promise<string> {
  const up = await req(h, 'POST', '/api/artifacts', s, Buffer.from('OggS-falso-para-teste'), { 'content-type': 'application/octet-stream', 'x-filename': 'audio.ogg', 'x-file-type': 'audio/ogg', 'x-conversation-id': sala });
  assert.equal(up.status, 201, JSON.stringify(up.json));
  const art = up.json.id as string;
  await esperar(() => !!h.db.get("SELECT 1 AS x FROM audio_transcricoes WHERE artifact_id = ? AND estado NOT IN ('transcrevendo','preparando')", art));
  h.db.run("INSERT INTO audio_transcricoes (artifact_id, workspace_id, estado, inicio, updated_at) VALUES (?, ?, 'pronta', ?, ?) ON CONFLICT(artifact_id) DO UPDATE SET estado = 'pronta', texto = ?",
    art, s.workspaceId, new Date().toISOString(), new Date().toISOString(), h.db.seal(s.workspaceId, fala));
  h.db.run('UPDATE audio_transcricoes SET texto = ? WHERE artifact_id = ?', h.db.seal(s.workspaceId, fala), art);
  return art;
}
const fila = (sala: string) => h.db.all<{ name: string; voz: number; juntos: string | null }>('SELECT a.name, f.voz, f.juntos FROM salas_fila f JOIN agents a ON a.id = f.agent_id WHERE f.conversation_id = ? ORDER BY f.created_at, f.rowid', sala);

test('áudio na sala: responde quem a fala chama pelo nome; dois chamados dividem a resposta; sem nome, ninguém', async () => {
  const [a1, a2, a3] = agentes();
  const sala = (await req(h, 'POST', '/api/salas', s, { nome: 'Voz', agentes: [a1.name, a2.name, a3.name] })).json.id as string;
  const art = await audioDito(sala, `${a2.name.toLowerCase()}, você pode ver isso?`);
  const r = await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: '', clientRequestId: crid(), attachments: [art] });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(fila(sala).map((x) => x.name), [a2.name]);
  assert.equal(fila(sala)[0].voz, 1, 'fala responde falado');

  const art2 = await audioDito(sala, `${a3.name} e ${a1.name}, dividam isso`);
  await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: '', clientRequestId: crid(), attachments: [art2] });
  const f2 = fila(sala).slice(1);
  assert.deepEqual(f2.map((x) => x.name), [a3.name, a1.name]);
  assert.deepEqual(JSON.parse(f2[0].juntos!), [a3.name, a1.name]);

  const art3 = await audioDito(sala, 'alguém aí sabe o horário?');
  await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: '', clientRequestId: crid(), attachments: [art3] });
  assert.equal(fila(sala).length, 3, 'sem nome, ninguém responde');
  assert.equal(h.db.get<{ n: number }>('SELECT COUNT(*) AS n FROM salas_rota_voz')!.n, 0);
});

test('canal de voz em "Todos": sem nome na fala, segue com quem respondeu por último', async () => {
  const [a1, a2] = agentes();
  const sala = (await req(h, 'POST', '/api/salas', s, { nome: 'Todos', agentes: [a1.name, a2.name] })).json.id as string;
  const art = await audioDito(sala, `${a2.name}, bom dia`);
  await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: '', clientRequestId: crid(), attachments: [art], vozAgente: '*' });
  const art2 = await audioDito(sala, 'e o que mais?');
  await req(h, 'POST', `/api/salas/${sala}/mensagens`, s, { texto: '', clientRequestId: crid(), attachments: [art2], vozAgente: '*' });
  assert.deepEqual(fila(sala).map((x) => x.name), [a2.name, a2.name]);
});
