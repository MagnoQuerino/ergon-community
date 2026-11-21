/**
 * Rotas dos blocos visuais (rc.42, shared/visuais): a validação para a ferramenta `visual` do motor, a pré-visualização
 * de link (com a busca protegida de services/visuais/rede.ts) e a imagem dela, a prévia de arquivo, o PNG do bloco, o
 * voto numa enquete da conversa e o relatório em Documentos (.md com as cercas ```ergon-<tipo>: o documento dos
 * Entregáveis abre, revisa e exporta em PDF).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.ts';
import { S, idParams } from '../lib/schemas.ts';
import { HttpError, clip, notFound } from '../lib/util.ts';
import type { AuthContext } from '../services/auth.ts';
import type { Bus } from '../services/bus.ts';
import { registrarRespostaDigitada, getConversation } from '../services/chat.ts';
import { openArtifact, saveArtifact } from '../services/artifacts.ts';
import { preview } from '../services/documents.ts';
import { validarBloco, type BlocoDe } from '../../../shared/visuais/esquema.ts';
import { conferenciaDo } from '../services/visuais/conferencia.ts';
import { blocosDe, cercaVisual, cercaVoto } from '../../../shared/visuais/cercas.ts';
import { CATALOGO_VISUAIS } from '../../../shared/visuais/prompt.ts';
import { relatorioComoMarkdown } from '../../../shared/visuais/texto.ts';
import { Recusado, buscarSeguro, metadadosDe, type Metadados, type OpcoesBusca } from '../services/visuais/rede.ts';
import { visualParaPng } from '../services/visuais/png.ts';

export interface VisuaisDeps {
  db: Db; bus: Bus;
  cfg: { filesDir: string; maxUploadBytes: number };
  auth: (req: FastifyRequest) => AuthContext;
  bridgeMotor: (req: FastifyRequest) => string;
  /** o workspace da execução do motor que chamou a ferramenta (null: não é do Ergon, ou o motor não pode) */
  workspaceDaSessao: (motor: string, sessionId: string, taskId: string) => Promise<string | null>;
  /** testes: a busca de link sem rede de verdade */
  busca?: OpcoesBusca;
}

const IMAGEM_OK = /^image\/(png|jpeg|gif|webp|avif)\b/i;
/** os primeiros bytes de cada formato aceito (o tipo declarado pelo site não basta) */
const ehImagem = (b: Buffer) => (b[0] === 0x89 && b[1] === 0x50) || (b[0] === 0xff && b[1] === 0xd8) || b.subarray(0, 4).toString('latin1') === 'GIF8'
  || (b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') || b.subarray(4, 12).toString('latin1').startsWith('ftypavi');

export function registerVisuaisRoutes(app: FastifyInstance, d: VisuaisDeps): void {
  const { db, bus, cfg, auth } = d;

  // ---- a ferramenta `visual` do motor: valida e devolve a cerca pronta para colar, ou os erros para o agente corrigir
  app.post('/internal/bridge/v1/visual', {
    bodyLimit: 128 * 1024,
    schema: { body: { type: 'object', properties: { session_id: S.str(200), task_id: S.str(200), bloco: {}, catalogo: { type: 'boolean' } } } },
  }, async (req) => {
    const motor = d.bridgeMotor(req);
    const b = req.body as { session_id?: string; task_id?: string; bloco?: unknown; catalogo?: boolean };
    if (b.catalogo || b.bloco === undefined) return { ok: true, catalogo: CATALOGO_VISUAIS };
    const ws = await d.workspaceDaSessao(motor, String(b.session_id ?? ''), String(b.task_id ?? ''));
    const r = validarBloco(b.bloco, ws ? conferenciaDo(db, ws) : {});
    if (!r.ok) return { ok: false, erros: r.erros, dica: 'Corrija e chame de novo; peça catalogo=true para ver os campos.' };
    return { ok: true, cerca: cercaVisual(r.bloco), instrucao: 'Cole a cerca exatamente assim na sua resposta, onde o visual deve aparecer.' };
  });

  // ---- pré-visualização de link: título, descrição e imagem, buscados aqui (nunca pelo navegador da pessoa)
  const cache = new Map<string, { em: number; m: Metadados | null }>();
  app.get('/api/visuais/link', { schema: { querystring: { type: 'object', required: ['url'], properties: { url: S.str(2000, 8) } } } }, async (req) => {
    auth(req);
    const url = (req.query as { url: string }).url;
    const c = cache.get(url);
    if (c && Date.now() - c.em < 6 * 3600_000) return c.m ?? { erro: 'sem_previa' };
    let m: Metadados | null = null;
    try {
      const r = await buscarSeguro(url, { tempoMs: 5000, maxBytes: 512 * 1024, aceitar: /text\/html|application\/xhtml/i, ...d.busca });
      if (r.status >= 200 && r.status < 300) m = metadadosDe(r.corpo.toString('utf8'), r.url);
    } catch (e) {
      if (!(e instanceof Recusado)) throw e;
      if (/interno|porta|usuário|http/.test(e.motivo)) throw new HttpError(400, 'link_recusado', 'Esse endereço não pode ser aberto daqui.');
    }
    if (cache.size > 500) cache.delete(cache.keys().next().value as string);
    cache.set(url, { em: Date.now(), m });
    return m ?? { erro: 'sem_previa' };
  });

  // ---- imagem de fora (a do link, a da galeria, a foto da pessoa): passa por aqui, conferida e sem cookies
  app.get('/api/visuais/imagem', { schema: { querystring: { type: 'object', required: ['url'], properties: { url: S.str(2000, 8) } } } }, async (req, reply: FastifyReply) => {
    auth(req);
    let r;
    try { r = await buscarSeguro((req.query as { url: string }).url, { tempoMs: 6000, maxBytes: 3 * 1024 * 1024, aceitar: IMAGEM_OK, ...d.busca }); } catch (e) {
      if (e instanceof Recusado) throw new HttpError(404, 'sem_imagem', 'Imagem indisponível.');
      throw e;
    }
    if (r.status < 200 || r.status >= 300 || r.corpo.length >= 3 * 1024 * 1024 || !ehImagem(r.corpo)) throw new HttpError(404, 'sem_imagem', 'Imagem indisponível.');
    return reply.header('content-type', r.tipo.split(';')[0]).header('cache-control', 'private, max-age=86400').header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox").send(r.corpo);
  });

  // ---- prévia de arquivo: a primeira página do PDF (o texto dela), as primeiras linhas da planilha, o começo do documento ou do código
  app.get('/api/visuais/arquivo/:id', { schema: { params: idParams('art') } }, async (req) => {
    const a = auth(req);
    const id = (req.params as { id: string }).id;
    const f = openArtifact(db, cfg.filesDir, a.workspaceId, id);
    const base = { id, nome: f.filename, mime: f.mime, tamanho: f.data.length };
    const ext = f.filename.toLowerCase().match(/\.([a-z0-9]{1,6})$/)?.[1] ?? '';
    const CODIGO: Record<string, string> = { ts: 'ts', tsx: 'ts', js: 'js', jsx: 'js', mjs: 'js', py: 'py', json: 'json', sql: 'sql', sh: 'sh', bash: 'sh', css: 'css', html: 'html', yml: 'yaml', yaml: 'yaml', go: 'go', rs: 'rs', java: 'java', rb: 'rb', php: 'php', c: 'c', cpp: 'c', cs: 'cs' };
    if (f.mime.startsWith('image/')) return { ...base, tipo: 'imagem' };
    if (CODIGO[ext]) return { ...base, tipo: 'codigo', linguagem: CODIGO[ext], texto: f.data.subarray(0, 6000).toString('utf8').split('\n').slice(0, 40).join('\n') };
    const p = await preview(db, cfg, a.workspaceId, id) as { kind: string; text?: string; pages?: number | null; sheets?: Array<{ name: string; rows: string[][] }> };
    if (f.mime === 'application/pdf') {
      const { readDocument } = await import('../services/doc-isolated.ts');
      const t = await readDocument(f.filename, f.mime, f.data).catch(() => null);
      const pag1 = t?.status === 'ok' ? (t.text.split(/\[Página 2\]/)[0] ?? '').replace(/^\[Página 1\]\s*/, '') : '';
      return { ...base, tipo: 'pdf', paginas: t?.pages ?? null, texto: clip(pag1, 1800) };
    }
    if (p.kind === 'sheet') return { ...base, tipo: 'planilha', abas: (p.sheets ?? []).length, nomeAba: p.sheets?.[0]?.name ?? '', linhas: (p.sheets?.[0]?.rows ?? []).slice(0, 9).map((r) => r.slice(0, 8)) };
    if (p.kind === 'text') return { ...base, tipo: /markdown|\.md$/.test(`${f.mime} ${f.filename}`) ? 'markdown' : 'documento', paginas: p.pages ?? null, texto: clip(p.text ?? '', 1800) };
    return { ...base, tipo: 'outro' };
  });

  // ---- o PNG do bloco (o mesmo cartão que o Telegram e o Discord recebem)
  app.post('/api/visuais/png', { bodyLimit: 128 * 1024, schema: { body: { type: 'object', required: ['bloco'], properties: { bloco: {}, tema: { enum: ['claro', 'escuro'] } } } } }, async (req, reply: FastifyReply) => {
    const a = auth(req);
    const b = req.body as { bloco: unknown; tema?: 'claro' | 'escuro' };
    const r = validarBloco(b.bloco, conferenciaDo(db, a.workspaceId));
    if (!r.ok) throw new HttpError(422, 'visual_invalido', r.erros[0]);
    const png = await visualParaPng(r.bloco, { tema: b.tema });
    if (!png) throw new HttpError(503, 'sem_png', 'A imagem não pôde ser gerada neste computador.');
    return reply.header('content-type', 'image/png').header('cache-control', 'no-store').send(png.png);
  });

  // ---- voto numa enquete da conversa: vira uma mensagem da pessoa (só a cerca do voto), sem chamar o agente; anda
  // pela mesma sincronia das mensagens. Nas salas, a mensagem vai pela rota de mensagem da sala (sem menção).
  app.post('/api/conversations/:id/votos', {
    schema: { params: idParams('cnv'), body: { type: 'object', additionalProperties: false, required: ['enquete', 'opcao', 'pedido'], properties: {
      enquete: { type: 'string', pattern: '^[A-Za-z0-9_-]{3,40}$' }, opcao: { type: 'integer', minimum: 0, maximum: 5 }, pedido: { type: 'string', pattern: '^[A-Za-z0-9-]{8,64}$' } } } },
  }, async (req) => {
    const a = auth(req);
    const conv = (req.params as { id: string }).id;
    const b = req.body as { enquete: string; opcao: number; pedido: string };
    getConversation(db, a.workspaceId, a.userId, conv);
    // o conteúdo é cifrado no banco: a busca pela cerca é aqui, já aberto
    const msgs = db.all<{ content: string }>("SELECT content FROM messages WHERE conversation_id = ? AND workspace_id = ? AND role = 'agent' ORDER BY created_at DESC LIMIT 300", conv, a.workspaceId);
    const enq = msgs.filter((m) => m.content.includes(b.enquete)).flatMap((m) => blocosDe(m.content)).find((x): x is BlocoDe<'enquete'> => x.tipo === 'enquete' && x.id === b.enquete);
    if (!enq) throw notFound('enquete');
    if (enq.encerrada || enq.decisao !== undefined) throw new HttpError(409, 'enquete_encerrada', 'A enquete já foi encerrada.');
    if (b.opcao >= enq.opcoes.length) throw new HttpError(400, 'opcao', 'Opção inválida.');
    return registrarRespostaDigitada(db, bus, a.workspaceId, a.userId, conv, cercaVoto({ enquete: b.enquete, opcao: b.opcao }), b.pedido);
  });

  // ---- o relatório vira um documento .md em Documentos (as cercas ficam: o documento dos Entregáveis desenha e revisa)
  const relatorioDo = (req: FastifyRequest): BlocoDe<'relatorio'> => {
    const a = auth(req);
    const r = validarBloco((req.body as { relatorio: unknown }).relatorio, conferenciaDo(db, a.workspaceId));
    if (!r.ok || r.bloco.tipo !== 'relatorio') throw new HttpError(422, 'relatorio_invalido', r.ok ? 'Não é um relatório.' : r.erros[0]);
    return r.bloco;
  };
  const corpoRel = { type: 'object', required: ['relatorio'], properties: { relatorio: { type: 'object' }, pasta: { type: 'string' } } };
  app.post('/api/visuais/relatorio/documento', { bodyLimit: 256 * 1024, schema: { body: corpoRel } }, async (req) => {
    const a = auth(req);
    const rel = relatorioDo(req);
    const nome = `${(rel.titulo ?? 'Relatório').replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 80) || 'Relatório'} v${rel.versao}.md`;
    const data = Buffer.from(relatorioComoMarkdown(rel), 'utf8');
    // abrir de novo o mesmo relatório (a mesma versão) reabre o mesmo arquivo: nada de cópias em Documentos
    const ja = db.all<{ id: string }>('SELECT id FROM artifacts WHERE workspace_id = ? AND filename = ? AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 5', a.workspaceId, nome)
      .find((x) => { try { return openArtifact(db, cfg.filesDir, a.workspaceId, x.id).data.equals(data); } catch { return false; } });
    if (ja) return { id: ja.id, nome, tamanho: data.length };
    const art = saveArtifact(db, bus, cfg.filesDir, cfg.maxUploadBytes, a.workspaceId, a.userId, { filename: nome, mime: 'text/markdown', data });
    return { id: art.id, nome, tamanho: data.length };
  });
}

