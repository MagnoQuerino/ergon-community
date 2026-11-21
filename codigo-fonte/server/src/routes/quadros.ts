/**
 * Rotas dos quadros da pessoa (rc.41, services/quadros.ts): criar, renomear e apagar quadros; criar, renomear,
 * reordenar e apagar colunas. Qualquer membro do workspace (os quadros da pessoa são do workspace, como os cards).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.ts';
import { idParams, S } from '../lib/schemas.ts';
import type { AuthContext } from '../services/auth.ts';
import type { Bus } from '../services/bus.ts';
import { apagarColuna, apagarQuadro, COLUNAS_MAX, criarColuna, criarQuadro, mudarColuna, NOME_COLUNA_MAX, NOME_QUADRO_MAX, renomearQuadro } from '../services/quadros.ts';

interface QuadrosDeps { db: Db; bus: Bus; auth: (req: FastifyRequest) => AuthContext }

export function registerQuadrosRoutes(app: FastifyInstance, d: QuadrosDeps): void {
  const { db, bus, auth } = d;
  const quem = (req: FastifyRequest) => { const a = auth(req); return { userId: a.userId, workspaceId: a.workspaceId }; };
  const pid = (req: FastifyRequest) => (req.params as { id: string }).id;

  app.post('/api/boards', { schema: { body: { type: 'object', additionalProperties: false, required: ['name'], properties: {
    name: S.str(NOME_QUADRO_MAX * 2, 1), columns: { type: 'array', minItems: 1, maxItems: COLUNAS_MAX, items: S.str(NOME_COLUNA_MAX * 2, 1) } } } } },
  async (req, reply) => { const b = req.body as { name: string; columns?: string[] }; reply.status(201); return criarQuadro(db, bus, quem(req), b.name, b.columns); });

  app.patch('/api/boards/:id', { schema: { params: idParams('brd'), body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: S.str(NOME_QUADRO_MAX * 2, 1) } } } },
    async (req) => renomearQuadro(db, bus, quem(req), pid(req), (req.body as { name: string }).name));

  app.delete('/api/boards/:id', { schema: { params: idParams('brd'), body: { type: ['object', 'null'], additionalProperties: false, properties: { destino: S.id('brd') } } } },
    async (req) => apagarQuadro(db, bus, quem(req), pid(req), (req.body as { destino?: string } | null)?.destino ?? null));

  app.post('/api/boards/:id/columns', { schema: { params: idParams('brd'), body: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: S.str(NOME_COLUNA_MAX * 2, 1), position: { type: 'integer', minimum: 0, maximum: 100 } } } } },
    async (req, reply) => { const b = req.body as { name: string; position?: number }; reply.status(201); return criarColuna(db, bus, quem(req), pid(req), b.name, b.position); });

  app.patch('/api/columns/:id', { schema: { params: idParams('col'), body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { name: S.str(NOME_COLUNA_MAX * 2, 1), position: { type: 'integer', minimum: 0, maximum: 100 } } } } },
    async (req) => mudarColuna(db, bus, quem(req), pid(req), req.body as { name?: string; position?: number }));

  app.delete('/api/columns/:id', { schema: { params: idParams('col'), body: { type: ['object', 'null'], additionalProperties: false, properties: { destino: S.id('col') } } } },
    async (req) => apagarColuna(db, bus, quem(req), pid(req), (req.body as { destino?: string } | null)?.destino ?? null));
}
