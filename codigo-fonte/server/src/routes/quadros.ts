/**
 * Rotas dos quadros da pessoa (rc.41, services/quadros.ts): criar, renomear e apagar quadros; criar, renomear,
 * reordenar e apagar colunas; e os campos próprios de cada quadro (services/campos.ts). Qualquer membro do workspace
 * (os quadros da pessoa são do workspace, como os cards).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.ts';
import { idParams, S } from '../lib/schemas.ts';
import type { AuthContext } from '../services/auth.ts';
import type { Bus } from '../services/bus.ts';
import { apagarCampo, camposDoQuadro, criarCampo, mudarCampo, NOME_CAMPO_MAX, NOME_OPCAO_MAX, OPCOES_MAX, PALETA, TIPOS_CAMPO, type TipoCampo } from '../services/campos.ts';
import { boardAudience } from '../services/tasks.ts';
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

  // ---- campos próprios do quadro
  const opcoes = { type: 'array', maxItems: OPCOES_MAX, items: { type: 'object', additionalProperties: false, required: ['name'], properties: {
    id: S.id('opt'), name: S.str(NOME_OPCAO_MAX * 2, 1), color: { enum: [...PALETA] } } } };

  app.get('/api/boards/:id/fields', { schema: { params: idParams('brd') } }, async (req) => {
    const a = auth(req);
    // o quadro da equipe não tem campos (e a conferência do workspace é a mesma de sempre)
    return boardAudience(db, a.workspaceId, pid(req)) === 'user' ? camposDoQuadro(db, a.workspaceId, pid(req)) : [];
  });

  app.post('/api/boards/:id/fields', { schema: { params: idParams('brd'), body: { type: 'object', additionalProperties: false, required: ['name', 'type'], properties: {
    name: S.str(NOME_CAMPO_MAX * 2, 1), type: { enum: [...TIPOS_CAMPO] }, options: opcoes, showOnCard: { type: 'boolean' } } } } },
  async (req, reply) => { reply.status(201); return criarCampo(db, bus, quem(req), pid(req), req.body as { name: string; type: TipoCampo; options?: unknown; showOnCard?: boolean }); });

  app.patch('/api/fields/:id', { schema: { params: idParams('cmp'), body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
    name: S.str(NOME_CAMPO_MAX * 2, 1), options: opcoes, position: { type: 'integer', minimum: 0, maximum: 100 }, showOnCard: { type: 'boolean' } } } } },
  async (req) => mudarCampo(db, bus, quem(req), pid(req), req.body as { name?: string; options?: unknown; position?: number; showOnCard?: boolean }));

  app.delete('/api/fields/:id', { schema: { params: idParams('cmp') } }, async (req) => apagarCampo(db, bus, quem(req), pid(req)));
}
