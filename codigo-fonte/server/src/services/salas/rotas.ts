/**
 * Rotas das Salas. Toda rota confere a sessão e o workspace (auth) e, na sala, se a pessoa está nela AGORA (o serviço
 * responde 404 sem dizer se a sala existe). Entrada validada por esquema; texto e marcas com teto.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { S, idParams } from '../../lib/schemas.ts';
import { HttpError, clip } from '../../lib/util.ts';
import type { AuthContext } from '../auth.ts';
import type { Bus } from '../bus.ts';
import type { Db } from '../../db/db.ts';
import { titleFrom } from '../chat.ts';
import { createTask, userBoard } from '../tasks.ts';
import { MAX_MARCAS, PRAZOS } from './marcas.ts';
import type { Salas } from './servico.ts';

interface Deps { db: Db; bus: Bus; salas: Salas; auth: (req: FastifyRequest) => AuthContext; maxChars: number }

const CHAVE = { type: 'string', minLength: 3, maxLength: 200 };
const membroBody = { type: 'object', additionalProperties: false, required: ['tipo', 'chave'], properties: { tipo: { enum: ['pessoa', 'agente'] }, chave: CHAVE } };

export function registerSalasRoutes(app: FastifyInstance, d: Deps): void {
  const { salas, auth } = d;
  const sid = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.get('/api/salas', async (req) => {
    const a = auth(req);
    return { salas: salas.listar(a.workspaceId, a.userId), podeCriar: salas.podeCriar(a.workspaceId, a.userId), governanca: salas.governanca(a.workspaceId), avisos: salas.contarAvisos(a.workspaceId, a.userId) };
  });
  app.get('/api/salas/disponiveis', async (req) => { const a = auth(req); return salas.disponiveis(a.workspaceId, a.userId); });
  app.post('/api/salas', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['nome'], properties: { nome: S.str(80, 1), pessoas: { type: 'array', maxItems: 60, items: CHAVE }, agentes: { type: 'array', maxItems: 60, items: CHAVE } } } },
  }, async (req, reply) => {
    const a = auth(req);
    return reply.status(201).send(await salas.criar(a.workspaceId, a.userId, req.body as { nome: string; pessoas?: string[]; agentes?: string[] }));
  });

  // governança (quem administra o workspace): cessão de conexões nas salas e quem cria salas
  app.get('/api/salas/governanca', async (req) => { const a = auth(req); return salas.governanca(a.workspaceId); });
  app.put('/api/salas/governanca', {
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { cessao: { type: 'boolean' }, criar: { enum: ['admins', 'todos'] } } } },
  }, async (req) => { const a = auth(req); return salas.setGovernanca(a.workspaceId, a.userId, req.body as { cessao?: boolean; criar?: 'admins' | 'todos' }); });

  // avisos (menção e pedido de cessão) e as cessões que a pessoa deu
  app.get('/api/salas/avisos', async (req) => { const a = auth(req); return salas.avisos(a.workspaceId, a.userId); });
  app.post('/api/salas/avisos/:id', {
    schema: { params: idParams('sav'), body: { type: 'object', additionalProperties: false, required: ['decisao'], properties: { decisao: { enum: [...PRAZOS, 'recusar'] } } } },
  }, async (req) => { const a = auth(req); return salas.decidirCessao(a.workspaceId, a.userId, sid(req), (req.body as { decisao: never }).decisao); });
  app.get('/api/salas/cessoes', async (req) => { const a = auth(req); return salas.minhasCessoes(a.workspaceId, a.userId); });
  app.delete('/api/salas/cessoes/:id', { schema: { params: idParams('sce') } }, async (req) => { const a = auth(req); salas.revogar(a.workspaceId, a.userId, sid(req)); return { ok: true }; });

  app.get('/api/salas/:id', { schema: { params: idParams('cnv') } }, async (req) => { const a = auth(req); return salas.detalhe(a.workspaceId, a.userId, sid(req)); });
  app.patch('/api/salas/:id', {
    schema: { params: idParams('cnv'), body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { nome: S.str(80, 1), arquivada: { type: 'boolean' } } } },
  }, async (req) => { const a = auth(req); salas.atualizar(a.workspaceId, a.userId, sid(req), req.body as { nome?: string; arquivada?: boolean }); return { ok: true }; });
  app.post('/api/salas/:id/membros', { schema: { params: idParams('cnv'), body: membroBody } }, async (req) => {
    const a = auth(req); await salas.adicionar(a.workspaceId, a.userId, sid(req), req.body as { tipo: 'pessoa' | 'agente'; chave: string }); return { ok: true };
  });
  app.post('/api/salas/:id/membros/remover', { schema: { params: idParams('cnv'), body: membroBody } }, async (req) => {
    const a = auth(req); salas.remover(a.workspaceId, a.userId, sid(req), req.body as { tipo: 'pessoa' | 'agente'; chave: string }); return { ok: true };
  });
  app.post('/api/salas/:id/sair', { schema: { params: idParams('cnv') } }, async (req) => {
    const a = auth(req); salas.remover(a.workspaceId, a.userId, sid(req), { tipo: 'pessoa', chave: salas.detalhe(a.workspaceId, a.userId, sid(req)).eu }); return { ok: true };
  });
  app.get('/api/salas/:id/mensagens', {
    schema: { params: idParams('cnv'), querystring: { type: 'object', additionalProperties: false, properties: { antes: S.str(40) } } },
  }, async (req) => { const a = auth(req); return salas.mensagens(a.workspaceId, a.userId, sid(req), (req.query as { antes?: string }).antes ?? null); });
  app.post('/api/salas/:id/mensagens', {
    // o corpo inteiro tem teto (o texto, até 40 marcas e 20 anexos)
    bodyLimit: Math.max(64 * 1024, d.maxChars * 4 + 16 * 1024),
    schema: { params: idParams('cnv'), body: { type: 'object', additionalProperties: false, required: ['texto', 'clientRequestId'], properties: {
      texto: S.str(d.maxChars), clientRequestId: S.str(64, 8), replyTo: S.id('msg'), attachments: { type: 'array', maxItems: 20, items: S.id('art') }, vozAgente: { type: 'string', minLength: 1, maxLength: 200 },
      marcas: { type: 'array', maxItems: MAX_MARCAS, items: { type: 'object', additionalProperties: false, required: ['tipo', 'chave', 'inicio', 'fim'], properties: {
        tipo: { enum: ['pessoa', 'agente', 'cessao'] }, chave: CHAVE, inicio: { type: 'integer', minimum: 0, maximum: d.maxChars }, fim: { type: 'integer', minimum: 1, maximum: d.maxChars } } } } } } },
  }, async (req, reply) => {
    const a = auth(req);
    const r = salas.enviar(a.workspaceId, a.userId, sid(req), req.body as { texto: string; marcas?: unknown; clientRequestId: string; attachments?: string[]; replyTo?: string; vozAgente?: string });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });
  // tópicos: a lista (só os que a pessoa vê) e abrir um, do zero ou a partir de uma mensagem da sala
  app.get('/api/salas/:id/topicos', { schema: { params: idParams('cnv') } }, async (req) => { const a = auth(req); salas.detalhe(a.workspaceId, a.userId, sid(req)); return salas.topicosVisiveis(a.workspaceId, a.userId, sid(req)); });
  app.post('/api/salas/:id/topicos', {
    schema: { params: idParams('cnv'), body: { type: 'object', additionalProperties: false, required: ['visibilidade'], properties: {
      nome: S.str(80), visibilidade: { enum: ['privado', 'compartilhado'] }, origem: S.id('msg'),
      pessoas: { type: 'array', maxItems: 60, items: CHAVE }, agentes: { type: 'array', maxItems: 60, items: CHAVE } } } },
  }, async (req, reply) => { const a = auth(req); return reply.status(201).send(salas.criarTopico(a.workspaceId, a.userId, sid(req), req.body as { nome?: string; visibilidade: 'privado' | 'compartilhado'; origem?: string; pessoas?: string[]; agentes?: string[] })); });
  // baixar um anexo que nasceu em outro computador (vem cifrado pela sincronia, em partes, só para quem está na sala)
  app.post('/api/salas/:id/anexos/:ref/baixar', {
    schema: { params: { type: 'object', required: ['id', 'ref'], properties: { id: S.id('cnv'), ref: S.id('art') } } },
  }, async (req) => { const a = auth(req); salas.pedirAnexo(a.workspaceId, a.userId, sid(req), (req.params as { ref: string }).ref); return { ok: true }; });
  app.post('/api/salas/:id/lido', { schema: { params: idParams('cnv') } }, async (req) => { const a = auth(req); salas.lido(a.workspaceId, a.userId, sid(req)); return { ok: true }; });

  // cartão de tarefa a partir de uma mensagem da sala (vai para Suas tarefas, com o link da sala); leitura não cria
  app.post('/api/salas/:id/mensagens/:msg/tarefa', {
    schema: { params: { type: 'object', required: ['id', 'msg'], properties: { id: S.id('cnv'), msg: S.id('msg') } } },
  }, async (req, reply) => {
    const a = auth(req);
    const det = salas.detalhe(a.workspaceId, a.userId, sid(req));
    if (det.papel === 'viewer' || !det.papel) throw new HttpError(403, 'forbidden', 'O seu papel neste workspace é de leitura.');
    const m = d.db.get<{ content: string; autor_nome: string | null }>("SELECT content, autor_nome FROM messages WHERE id = ? AND conversation_id = ? AND workspace_id = ? AND role != 'system'", (req.params as { msg: string }).msg, sid(req), a.workspaceId);
    if (!m) throw new HttpError(404, 'not_found', 'mensagem não encontrada');
    const t = createTask(d.db, d.bus, a.workspaceId, { type: 'user', id: a.userId }, {
      title: titleFrom(m.content, 80) || det.nome, description: clip(`${m.autor_nome ?? ''} — sala ${det.nome}:\n\n${m.content}`, 8000), boardId: userBoard(d.db, a.workspaceId).id, origin: 'chat',
    });
    d.db.run('UPDATE tasks SET conversation_id = ? WHERE id = ?', sid(req), t.id);
    return reply.status(201).send({ id: t.id, number: t.number });
  });
}
