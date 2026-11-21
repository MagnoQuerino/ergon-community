/**
 * Rotas dos entregáveis (rc.42): o documento formatado, o PDF com o modelo, a identidade e os modelos do workspace, e
 * a revisão com o coordenador (balão, versões, desfazer). Ver e pedir revisão: quem vê o arquivo (o workspace dele).
 * Mudar a identidade e os modelos: o dono do workspace.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.ts';
import { S, idParams } from '../lib/schemas.ts';
import { HttpError, notFound } from '../lib/util.ts';
import { openArtifact } from '../services/artifacts.ts';
import type { AuthContext } from '../services/auth.ts';
import type { Bus } from '../services/bus.ts';
import {
  apagarModelo, criarModelo, editarModelo, ehMarkdown, escolherModelo, identidade, LOGO_MAX_BYTES, logoDe, modeloDoArquivo, modelos, pdfDoArquivo, pdfDeTexto,
  acharModelo, salvarIdentidade, salvarLogo,
} from '../services/entregaveis.ts';
import { PEDIDO_MAX, type RevisaoDocumento } from '../services/revisao-documento.ts';
import { normalizarModelo } from '../../../shared/entregaveis.ts';

interface Deps {
  db: Db; bus: Bus; revisao: RevisaoDocumento;
  cfg: { filesDir: string };
  auth: (req: FastifyRequest) => AuthContext;
  owner: (req: FastifyRequest) => AuthContext;
}

/** texto inteiro de um .md (a prévia comum corta em 40 mil caracteres) */
const DOC_MAX = 1_000_000;
const MODELO_ID = { type: 'string', pattern: '^(ergon|abnt|mod_[a-f0-9]{32})$' };
const modeloParams = { type: 'object', required: ['id'], properties: { id: MODELO_ID } };
const QUALQUER = { type: 'object', additionalProperties: true, maxProperties: 40 };

const pdfReply = (reply: FastifyReply, data: Buffer, filename: string, inline: boolean) => {
  reply.header('Content-Type', 'application/pdf');
  reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(filename)}`);
  reply.header('Cache-Control', 'private, no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  return reply.send(data);
};

export function registerEntregaveisRoutes(app: FastifyInstance, d: Deps): void {
  const { db, bus, revisao, cfg, auth, owner } = d;
  const artId = (req: FastifyRequest) => (req.params as { id: string }).id;

  // o documento inteiro, com o modelo dele, a identidade e a versão (o visualizador)
  app.get('/api/artifacts/:id/documento', { schema: { params: idParams('art') } }, async (req) => {
    const a = auth(req);
    const f = openArtifact(db, cfg.filesDir, a.workspaceId, artId(req));
    if (!ehMarkdown(f.filename, f.mime)) throw new HttpError(415, 'nao_markdown', 'Não é um documento .md.');
    if (f.data.length > DOC_MAX) throw new HttpError(413, 'grande', 'Documento grande demais para abrir aqui: baixe o arquivo.');
    const m = modeloDoArquivo(db, a.workspaceId, f.id);
    const escolhido = db.get<{ m: string | null }>('SELECT modelo_id AS m FROM artifacts WHERE id = ?', f.id)?.m ?? null;
    return { texto: f.data.toString('utf8'), filename: f.filename, modelo: m, modeloEscolhido: escolhido, identidade: identidade(db, a.workspaceId), versao: revisao.versaoAtual(a.workspaceId, f.id) };
  });

  app.put('/api/artifacts/:id/modelo', {
    schema: { params: idParams('art'), body: { type: 'object', additionalProperties: false, required: ['modelo'], properties: { modelo: { anyOf: [MODELO_ID, { type: 'null' }] } } } },
  }, async (req) => {
    const a = auth(req);
    const m = escolherModelo(db, bus, a.workspaceId, { type: 'user', id: a.userId }, artId(req), (req.body as { modelo: string | null }).modelo);
    return { modelo: m?.id ?? null };
  });

  // PDF com o modelo do documento (ou ?modelo= para a prévia de outro); ?inline=1 abre no navegador
  app.get('/api/artifacts/:id/pdf', {
    schema: { params: idParams('art'), querystring: { type: 'object', properties: { modelo: MODELO_ID, inline: { type: 'string', enum: ['1'] } } } },
  }, async (req, reply) => {
    const a = auth(req);
    const q = req.query as { modelo?: string; inline?: string };
    const out = pdfDoArquivo(db, cfg.filesDir, a.workspaceId, artId(req), q.modelo ?? null);
    return pdfReply(reply, out.data, out.filename, q.inline === '1');
  });

  // prévia do modelo em Configurações: um texto de amostra com a identidade e o modelo (sem salvar nada)
  app.post('/api/entregaveis/previa.pdf', { bodyLimit: 64 * 1024, schema: { body: { type: 'object', required: ['modelo'], properties: { modelo: QUALQUER, texto: S.str(20_000) } } } }, async (req, reply) => {
    const a = auth(req);
    const b = req.body as { modelo: Record<string, unknown>; texto?: string };
    const m = typeof b.modelo.id === 'string' && !Object.keys(b.modelo).some((k) => k !== 'id') ? acharModelo(db, a.workspaceId, b.modelo.id) : normalizarModelo(b.modelo, 'previa');
    return pdfReply(reply, pdfDeTexto(db, a.workspaceId, b.texto ?? AMOSTRA, 'Amostra', m, cfg.filesDir), 'amostra.pdf', true);
  });

  // ------------------------------------------------------------------------------------------- identidade
  app.get('/api/entregaveis/identidade', async (req) => identidade(db, auth(req).workspaceId));
  app.put('/api/entregaveis/identidade', {
    schema: { body: { type: 'object', additionalProperties: false, properties: { nome: S.str(80), corPrimaria: S.str(7), corDestaque: S.str(7), mostrarErgon: { type: 'boolean' } } } },
  }, async (req) => { const a = owner(req); return salvarIdentidade(db, bus, a.workspaceId, a.userId, req.body as Record<string, unknown>); });
  // o logo: PNG ou JPEG em bytes (a tela converte SVG e WebP em PNG antes)
  app.put('/api/entregaveis/identidade/logo', { bodyLimit: LOGO_MAX_BYTES + 1024 }, async (req) => {
    const a = owner(req);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'logo_tipo', 'Envie a imagem como arquivo.');
    return salvarLogo(db, bus, a.workspaceId, a.userId, req.body);
  });
  app.delete('/api/entregaveis/identidade/logo', async (req) => { const a = owner(req); return salvarLogo(db, bus, a.workspaceId, a.userId, null); });
  app.get('/api/entregaveis/identidade/logo', async (req, reply) => {
    const l = logoDe(db, auth(req).workspaceId);
    if (!l) throw notFound('logo');
    reply.header('Content-Type', l.mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.send(l.data);
  });

  // ------------------------------------------------------------------------------------------- modelos
  app.get('/api/entregaveis/modelos', async (req) => modelos(db, auth(req).workspaceId));
  app.post('/api/entregaveis/modelos', { bodyLimit: 16 * 1024, schema: { body: QUALQUER } }, async (req) => {
    const a = owner(req); return criarModelo(db, bus, a.workspaceId, a.userId, req.body as Record<string, unknown>);
  });
  app.put('/api/entregaveis/modelos/:id', { bodyLimit: 16 * 1024, schema: { params: modeloParams, body: QUALQUER } }, async (req) => {
    const a = owner(req); return editarModelo(db, bus, a.workspaceId, a.userId, (req.params as { id: string }).id, req.body as Record<string, unknown>);
  });
  app.delete('/api/entregaveis/modelos/:id', { schema: { params: modeloParams } }, async (req) => {
    const a = owner(req); apagarModelo(db, bus, a.workspaceId, a.userId, (req.params as { id: string }).id); return { ok: true };
  });

  // ------------------------------------------------------------------------------------------- revisão com o coordenador
  const revParams = { type: 'object', required: ['id', 'rev'], properties: { id: S.id('art'), rev: S.id('rev') } };
  app.get('/api/artifacts/:id/revisao', { schema: { params: idParams('art') } }, async (req) => revisao.estado(auth(req).workspaceId, artId(req)));
  app.post('/api/artifacts/:id/revisao', {
    bodyLimit: 16 * 1024,
    schema: { params: idParams('art'), body: { type: 'object', additionalProperties: false, required: ['pedido'], properties: { pedido: S.str(PEDIDO_MAX, 1), trecho: { anyOf: [S.str(4000), { type: 'null' }] } } } },
  }, async (req) => {
    const a = auth(req);
    const b = req.body as { pedido: string; trecho?: string | null };
    return revisao.pedir(a.workspaceId, a.userId, artId(req), b);
  });
  app.delete('/api/artifacts/:id/revisao/:rev', { schema: { params: revParams } }, async (req) => {
    const a = auth(req); const p = req.params as { id: string; rev: string };
    revisao.cancelar(a.workspaceId, a.userId, p.id, p.rev); return { ok: true };
  });
  app.get('/api/artifacts/:id/versoes', { schema: { params: idParams('art') } }, async (req) => revisao.versoes(auth(req).workspaceId, artId(req)));
  app.get('/api/artifacts/:id/versoes/:n', { schema: { params: { type: 'object', required: ['id', 'n'], properties: { id: S.id('art'), n: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' } } } } }, async (req) => {
    const p = req.params as { id: string; n: string };
    return { texto: revisao.textoDaVersao(auth(req).workspaceId, p.id, Number(p.n)) };
  });
  app.post('/api/artifacts/:id/versoes/:n/restaurar', { schema: { params: { type: 'object', required: ['id', 'n'], properties: { id: S.id('art'), n: { type: 'string', pattern: '^[1-9][0-9]{0,5}$' } } } } }, async (req) => {
    const a = auth(req); const p = req.params as { id: string; n: string };
    return revisao.restaurar(a.workspaceId, a.userId, p.id, Number(p.n));
  });
  app.post('/api/artifacts/:id/desfazer', { schema: { params: idParams('art') } }, async (req) => {
    const a = auth(req); return revisao.desfazer(a.workspaceId, a.userId, artId(req));
  });
}

const AMOSTRA = `# Relatório de exemplo

Este é um parágrafo de exemplo, com **negrito**, *itálico* e um [link](https://example.com). Ele mostra a fonte, a entrelinha e as margens do modelo.

## Resultados

| Item | Quantidade | Valor |
|:--|--:|--:|
| Consultoria | 12 | R$ 4.800,00 |
| Treinamento | 3 | R$ 1.950,00 |

1. Primeiro ponto.
2. Segundo ponto, com uma lista dentro:
   - detalhe a;
   - detalhe b.

> Citação longa: segundo a norma, citações com mais de três linhas são destacadas com recuo de 4 cm da margem esquerda, letra menor e espaçamento simples, sem aspas.

## Referências

ASSOCIAÇÃO BRASILEIRA DE NORMAS TÉCNICAS. **NBR 14724**: informação e documentação: trabalhos acadêmicos: apresentação. Rio de Janeiro: ABNT, 2011.
`;
