/**
 * Rotas do que vai dentro do cartão (rc.41, services/cartao.ts e campos.ts): valores dos campos próprios, subtarefas,
 * links, pessoas, comentários e anexos de Documentos. Toda rota confere a sessão e o workspace da tarefa; a entrada é
 * conferida por esquema e, de novo, no serviço (tipos de campo, http/https, 240 caracteres).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.ts';
import { idParams, S } from '../lib/schemas.ts';
import type { AuthContext } from '../services/auth.ts';
import type { Bus } from '../services/bus.ts';
import { definirValor, TEXTO_CAMPO_MAX } from '../services/campos.ts';
import {
  anexar, apagarComentario, apagarLink, apagarSubtarefa, cartao, comentar, COMENTARIO_MAX, criarLink, criarSubtarefa, definirPessoas, desanexar, mudarSubtarefa,
  PESSOAS_MAX, SUBTAREFA_MAX, TITULO_LINK_MAX, URL_MAX,
} from '../services/cartao.ts';

interface CartaoDeps { db: Db; bus: Bus; auth: (req: FastifyRequest) => AuthContext }

export function registerCartaoRoutes(app: FastifyInstance, d: CartaoDeps): void {
  const { db, bus, auth } = d;
  const quem = (req: FastifyRequest) => { const a = auth(req); return { userId: a.userId, workspaceId: a.workspaceId, role: a.role }; };
  const pid = (req: FastifyRequest) => (req.params as { id: string }).id;
  const doisIds = (segundo: string, prefixo: string) => ({ type: 'object', required: ['id', segundo], properties: { id: S.id('tsk'), [segundo]: S.id(prefixo) } });
  const corpo = (required: string[], properties: Record<string, unknown>) => ({ type: 'object', additionalProperties: false, required, properties });

  app.get('/api/tasks/:id/card', { schema: { params: idParams('tsk') } }, async (req) => cartao(db, quem(req), pid(req)));

  // valor de um campo: texto, número, data, id da opção, ids das etiquetas ou id da pessoa; null tira
  app.put('/api/tasks/:id/fields/:fieldId', { schema: { params: doisIds('fieldId', 'cmp'), body: corpo(['value'], {
    value: { anyOf: [{ type: 'null' }, S.str(TEXTO_CAMPO_MAX * 2), { type: 'number' }, { type: 'array', maxItems: 50, items: S.id('opt') }] } }) } },
  async (req) => definirValor(db, bus, quem(req), pid(req), (req.params as { fieldId: string }).fieldId, (req.body as { value: unknown }).value));

  app.post('/api/tasks/:id/subtasks', { schema: { params: idParams('tsk'), body: corpo(['title'], { title: S.str(SUBTAREFA_MAX * 2, 1) }) } },
    async (req, reply) => { reply.status(201); return criarSubtarefa(db, bus, quem(req), pid(req), (req.body as { title: string }).title); });
  app.patch('/api/subtasks/:id', { schema: { params: idParams('sub'), body: { ...corpo([], { title: S.str(SUBTAREFA_MAX * 2, 1), done: { type: 'boolean' }, position: { type: 'integer', minimum: 0, maximum: 1000 } }), minProperties: 1 } } },
    async (req) => mudarSubtarefa(db, bus, quem(req), pid(req), req.body as { title?: string; done?: boolean; position?: number }));
  app.delete('/api/subtasks/:id', { schema: { params: idParams('sub') } }, async (req) => apagarSubtarefa(db, bus, quem(req), pid(req)));

  app.post('/api/tasks/:id/links', { schema: { params: idParams('tsk'), body: corpo(['url'], { url: S.str(URL_MAX, 1), title: S.str(TITULO_LINK_MAX * 2) }) } },
    async (req, reply) => { reply.status(201); return criarLink(db, bus, quem(req), pid(req), req.body as { url: string; title?: string }); });
  app.delete('/api/tasks/:id/links/:linkId', { schema: { params: doisIds('linkId', 'url') } },
    async (req) => apagarLink(db, bus, quem(req), pid(req), (req.params as { linkId: string }).linkId));

  app.put('/api/tasks/:id/people', { schema: { params: idParams('tsk'), body: corpo(['userIds'], { userIds: { type: 'array', maxItems: PESSOAS_MAX, items: S.id('usr') } }) } },
    async (req) => definirPessoas(db, bus, quem(req), pid(req), (req.body as { userIds: string[] }).userIds));

  // comentar: a pessoa da sessão; pela gestão do coordenador (bilhete de uso único, gestao.ts), o agente que pediu
  app.post('/api/tasks/:id/comments', { schema: { params: idParams('tsk'), body: corpo(['body'], { body: S.str(COMENTARIO_MAX * 4, 1) }) } },
    async (req, reply) => {
      const a = auth(req);
      reply.status(201);
      return comentar(db, bus, a.workspaceId, a.agenteId ? { type: 'agent', id: a.agenteId } : { type: 'user', id: a.userId }, pid(req), (req.body as { body: string }).body);
    });
  app.delete('/api/tasks/:id/comments/:commentId', { schema: { params: doisIds('commentId', 'cmt') } },
    async (req) => apagarComentario(db, bus, quem(req), pid(req), (req.params as { commentId: string }).commentId));

  app.post('/api/tasks/:id/attachments', { schema: { params: idParams('tsk'), body: corpo(['artifactId'], { artifactId: S.id('art') }) } },
    async (req, reply) => { reply.status(201); return anexar(db, bus, quem(req), pid(req), (req.body as { artifactId: string }).artifactId); });
  app.delete('/api/tasks/:id/attachments/:anexoId', { schema: { params: doisIds('anexoId', 'anx') } },
    async (req) => desanexar(db, bus, quem(req), pid(req), (req.params as { anexoId: string }).anexoId));
}
