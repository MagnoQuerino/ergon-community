/**
 * Rotas de Conexões › "Conversar com a equipe pelo Telegram / pelo Discord" (da própria pessoa) e as da ponte interna
 * (o plugin do motor: entrada de mensagens e cliques, saída com espera longa). Ligar a conversa equivale a cadastrar um
 * aparelho novo que manda na equipe: confirmar o código pede a mesma verificação de identidade das autorizações.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { S } from '../../lib/schemas.ts';
import type { AuthContext } from '../auth.ts';
import type { NomeCanal } from '../hermes.ts';
import type { Canais } from './servico.ts';

export interface CanaisRoutesDeps {
  canais: Canais;
  owner: (req: FastifyRequest) => AuthContext;
  verify: (req: FastifyRequest, ctx: AuthContext, body: { password?: string; code?: string; key?: string; response?: Record<string, unknown> }) => Promise<void>;
  /** o motor que chama a ponte (token dele), ou 401 */
  bridgeMotor: (req: FastifyRequest) => string;
}

const canalParams = { type: 'object', required: ['canal'], properties: { canal: { enum: ['telegram', 'discord'] } } };

export function registerCanaisRoutes(app: FastifyInstance, d: CanaisRoutesDeps): void {
  const { canais: c, owner, verify, bridgeMotor } = d;
  const canalDe = (req: FastifyRequest) => (req.params as { canal: NomeCanal }).canal;
  app.get('/api/canais', async (req) => { const a = owner(req); return c.estado(a.userId, a.workspaceId); });
  app.put('/api/canais/:canal/bot', {
    schema: { params: canalParams, body: { type: 'object', additionalProperties: false, required: ['token'], properties: { token: S.str(200, 10) } } },
  }, async (req) => {
    const a = owner(req);
    await c.guardarBot(a.userId, a.workspaceId, canalDe(req), (req.body as { token: string }).token);
    return c.estado(a.userId, a.workspaceId);
  });
  app.post('/api/canais/:canal/parear', {
    schema: { params: canalParams, body: { type: 'object', additionalProperties: false, required: ['codigo'], properties: {
      codigo: S.str(20, 6), password: S.str(200, 1), code: S.str(10, 6), key: S.str(80, 6), response: { type: 'object' } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { codigo: string; password?: string; code?: string; key?: string; response?: Record<string, unknown> };
    await verify(req, a, { password: b.password, code: b.code, key: b.key, response: b.response });
    await c.parear(a.userId, a.workspaceId, canalDe(req), b.codigo);
    return c.estado(a.userId, a.workspaceId);
  });
  app.patch('/api/canais/:canal', {
    schema: { params: canalParams, body: { type: 'object', additionalProperties: false, required: ['avisos'], properties: { avisos: { type: 'boolean' } } } },
  }, async (req) => {
    const a = owner(req);
    c.setAvisos(a.userId, canalDe(req), (req.body as { avisos: boolean }).avisos);
    return c.estado(a.userId, a.workspaceId);
  });
  app.delete('/api/canais/:canal', { schema: { params: canalParams } }, async (req) => {
    const a = owner(req);
    await c.desligar(a.userId, a.workspaceId, canalDe(req));
    return c.estado(a.userId, a.workspaceId);
  });

  // ponte interna (o plugin do motor da pessoa)
  app.post('/internal/bridge/v1/canais/entrada', {
    bodyLimit: 64 * 1024,
    schema: { body: { type: 'object', required: ['schema', 'tipo', 'canal', 'user_id'], properties: {
      schema: { const: 'ergon.canais.v1' }, tipo: { enum: ['mensagem', 'clique'] }, canal: { enum: ['telegram', 'discord'] },
      user_id: S.str(40, 1), chat_id: S.str(64), user_name: S.str(200), message_id: S.str(200), text: S.str(8000), sent_at: S.str(60),
      anexos: { type: 'integer', minimum: 0, maximum: 100 }, dado: S.str(80), evento: S.str(200) } } },
  }, async (req) => c.entrada(bridgeMotor(req), req.body as Parameters<Canais['entrada']>[1]));
  app.post('/internal/bridge/v1/canais/saida', {
    bodyLimit: 64 * 1024,
    schema: { body: { type: 'object', required: ['schema'], properties: {
      schema: { const: 'ergon.canais.v1' }, canais: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 20 } },
      espera: { type: 'integer', minimum: 0, maximum: 30 },
      acks: { type: 'array', maxItems: 50, items: { type: 'object', properties: { id: S.str(80), ok: { type: 'boolean' }, message_id: S.str(64), erro: S.str(200), passageiro: { type: 'boolean' } } } } } } },
  }, async (req) => {
    const motor = bridgeMotor(req);
    const b = req.body as { canais?: string[]; acks?: Array<Record<string, unknown>>; espera?: number };
    return c.saida(motor, (b.canais ?? []) as NomeCanal[], (b.acks ?? []) as never, Number(b.espera ?? 0));
  });
}
