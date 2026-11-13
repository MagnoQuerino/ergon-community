/**
 * Rotas dos aplicativos conectados pela pessoa (rc.29, Conexões › Conectar outro aplicativo): um servidor MCP que o
 * catálogo não traz. Ver é de quem está no workspace; conectar, testar, classificar, trocar chave e remover, do dono.
 * Ligar, desligar e liberar a escrita usam as rotas dos aplicativos prontos (/api/recursos/conectores/:nome...).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { S } from '../lib/schemas.ts';
import type { AuthContext } from '../services/auth.ts';
import type { McpProprios, PedidoApp, TipoFerramenta } from '../services/mcp-proprio.ts';

export interface McpProprioRoutesDeps {
  apps: McpProprios;
  auth: (req: FastifyRequest) => AuthContext;
  owner: (req: FastifyRequest) => AuthContext;
}

const NOME = { type: 'string', pattern: '^[a-z][a-z0-9]{0,30}(_[a-z0-9]{1,30}){0,4}$' };
const nomeParams = { type: 'object', required: ['nome'], properties: { nome: NOME } };
const chaves = (max: number, padrao: string) => ({ type: 'object', maxProperties: max, additionalProperties: S.str(4000), propertyNames: { pattern: padrao } });
const CABECALHOS = chaves(10, '^[A-Za-z0-9][A-Za-z0-9-]{0,79}$');
const VARIAVEIS = chaves(20, '^[A-Za-z_][A-Za-z0-9_]{0,79}$');

export function registerMcpProprioRoutes(app: FastifyInstance, d: McpProprioRoutesDeps): void {
  const { apps, auth, owner } = d;

  app.get('/api/recursos/apps-proprios', async (req) => ({ apps: apps.listar(auth(req).workspaceId) }));
  app.post('/api/recursos/apps-proprios', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['app', 'transporte'], properties: {
      app: S.str(60, 1), apelido: S.str(40), icone: { type: 'string', pattern: '^[a-z0-9-]{1,40}$' }, transporte: { enum: ['http', 'sse', 'stdio'] },
      endereco: S.str(2000), comando: S.str(200), argumentos: { type: 'array', maxItems: 40, items: S.str(1000, 1) },
      cabecalhos: CABECALHOS, variaveis: VARIAVEIS } } },
  }, async (req) => {
    const a = owner(req);
    return apps.conectar(a.workspaceId, a.userId, req.body as PedidoApp);
  });
  app.post('/api/recursos/apps-proprios/:nome/testar', { schema: { params: nomeParams } }, async (req) => {
    const a = owner(req);
    const nome = (req.params as { nome: string }).nome;
    const teste = await apps.testar(a.workspaceId, a.userId, nome);
    return { app: apps.um(a.workspaceId, nome), teste };
  });
  app.put('/api/recursos/apps-proprios/:nome/ferramentas', {
    schema: { params: nomeParams, body: { type: 'object', additionalProperties: false, required: ['ferramenta', 'tipo'], properties: { ferramenta: S.str(200, 1), tipo: { enum: ['leitura', 'escrita', 'envio'] } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { ferramenta: string; tipo: TipoFerramenta };
    return { app: apps.classificar(a.workspaceId, a.userId, (req.params as { nome: string }).nome, b.ferramenta, b.tipo) };
  });
  app.put('/api/recursos/apps-proprios/:nome/chaves', {
    schema: { params: nomeParams, body: { type: 'object', additionalProperties: false, required: ['valores'], properties: { valores: { type: 'object', minProperties: 1, maxProperties: 30, additionalProperties: S.str(4000, 1) } } } },
  }, async (req) => {
    const a = owner(req);
    await apps.trocarChaves(a.workspaceId, a.userId, (req.params as { nome: string }).nome, (req.body as { valores: Record<string, string> }).valores);
    return { ok: true };
  });
  // a conta do aplicativo, como PATCH /api/integrations/:kind/contas/:conta: o apelido e tornar principal
  app.patch('/api/recursos/apps-proprios/:nome', {
    schema: { params: nomeParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { apelido: S.str(40), principal: { const: true } } } },
  }, async (req) => {
    const a = owner(req);
    const nome = (req.params as { nome: string }).nome;
    const b = req.body as { apelido?: string; principal?: true };
    if (b.apelido !== undefined) apps.renomear(a.workspaceId, a.userId, nome, b.apelido);
    if (b.principal) apps.tornarPrincipal(a.workspaceId, a.userId, nome);
    return { app: apps.um(a.workspaceId, nome) };
  });
  app.delete('/api/recursos/apps-proprios/:nome', { schema: { params: nomeParams } }, async (req) => {
    const a = owner(req);
    await apps.remover(a.workspaceId, a.userId, (req.params as { nome: string }).nome);
    return { ok: true };
  });
}
