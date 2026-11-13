/**
 * Rotas das capacidades da equipe (rc.27): Configurações › Capacidades da equipe, Treinar (competências prontas e
 * loja), Conexões › Mais aplicativos (conectores prontos), a Revisão em conselho e a voz nas conversas.
 * Mudar o que a equipe pode fazer é do dono do workspace; ver, ouvir e transcrever, de quem está na conversa.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.ts';
import { S, idParams } from '../lib/schemas.ts';
import { HttpError, notFound } from '../lib/util.ts';
import { updateAgent } from '../services/capacity.ts';
import { NOME_COMPETENCIA, pacoteDoPedido } from '../services/competencias.ts';
import { openArtifact } from '../services/artifacts.ts';
import type { AuthContext } from '../services/auth.ts';
import type { Bus } from '../services/bus.ts';
import { getConversation, sendMessage } from '../services/chat.ts';
import { PEDIDO_CONSELHO, ehAudio, type Recursos } from '../services/recursos.ts';
import type { RunExecutor } from '../services/runs.ts';

export interface RecursosRoutesDeps {
  db: Db; bus: Bus; recursos: Recursos; executor: RunExecutor;
  cfg: { filesDir: string; maxConversationMessages: number; maxInputChars: number; publicUrl?: string | null };
  auth: (req: FastifyRequest) => AuthContext;
  owner: (req: FastifyRequest) => AuthContext;
}

const NOME = { type: 'string', pattern: '^[a-z0-9][a-z0-9_.-]{0,60}$' };
const ID_COMPETENCIA = { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{1,200}$' };
const VAGA = { type: 'object', additionalProperties: false, required: ['provider', 'model'], properties: { provider: S.str(41, 1), model: S.str(160, 1) } };
const nomeParams = { type: 'object', required: ['nome'], properties: { nome: NOME } };

/** A página que fecha a volta da entrada de um conector (a pessoa vê no navegador e volta ao Ergon). */
const paginaRetorno = (ok: boolean) => `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Ergon</title>
<body style="font-family:system-ui;padding:2rem;max-width:32rem;margin:auto">
<h1 style="font-size:1.2rem">${ok ? 'Pronto: aplicativo conectado. / Done: app connected.' : 'A entrada não foi concluída. / Sign-in was not completed.'}</h1>
<p>${ok ? 'Pode fechar esta aba e voltar ao Ergon. / You can close this tab and go back to Ergon.' : 'Volte ao Ergon e tente de novo em Conexões › Mais aplicativos. / Go back to Ergon and try again.'}</p>
<script>try{window.opener&&window.opener.postMessage({ergonConector:${ok ? 'true' : 'false'}},location.origin)}catch(e){}</script></body></html>`;

export function registerRecursosRoutes(app: FastifyInstance, d: RecursosRoutesDeps): void {
  const { db, bus, recursos, executor, cfg, auth, owner } = d;

  app.get('/api/recursos', async (req) => recursos.estado(auth(req).workspaceId));
  app.put('/api/recursos', {
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { checkpoints: { type: 'boolean' }, codigoInseguro: { type: 'boolean' }, limpeza: { type: 'boolean' } } } },
  }, async (req) => {
    const a = owner(req);
    const r = await recursos.protecoes(a.workspaceId, a.userId, req.body as { checkpoints?: boolean; codigoInseguro?: boolean; limpeza?: boolean });
    return { ...(await recursos.estado(a.workspaceId)), reiniciar: r.reiniciar };
  });

  // ---- conselho de modelos
  app.get('/api/recursos/conselho', async (req) => recursos.conselho(auth(req).workspaceId));
  app.put('/api/recursos/conselho', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['opinam', 'agrega'], properties: { opinam: { type: 'array', minItems: 2, maxItems: 6, items: VAGA }, agrega: VAGA } } },
  }, async (req) => {
    const a = owner(req);
    return recursos.setConselho(a.workspaceId, a.userId, req.body as { opinam: Array<{ provider: string; model: string }>; agrega: { provider: string; model: string } });
  });
  // Revisão em conselho numa conversa: uma mensagem da pessoa que vai ao conselho em vez do modelo do agente
  app.post('/api/conversations/:id/conselho', {
    schema: { params: idParams('cnv'), body: { type: 'object', additionalProperties: false, required: ['clientRequestId'], properties: { clientRequestId: S.str(64, 8), texto: S.str(4000) } } },
  }, async (req, reply) => {
    const a = auth(req);
    const b = req.body as { clientRequestId: string; texto?: string };
    const convId = (req.params as { id: string }).id;
    getConversation(db, a.workspaceId, a.userId, convId);
    // sem conselho que sirva, a equipe monta um com as contas conectadas (pronto para usar; a pessoa troca depois)
    await recursos.conselhoAutomatico(a.workspaceId, a.userId).catch(() => false);
    const r = sendMessage(db, bus, executor, a.workspaceId, a.userId, convId, b.texto?.trim() || PEDIDO_CONSELHO, b.clientRequestId,
      cfg.maxConversationMessages, cfg.maxInputChars, { conselho: true, plain: true });
    return reply.status(r.replayed ? 200 : 201).send(r);
  });

  // ---- loja de competências (Treinar)
  app.get('/api/recursos/loja', { schema: { querystring: { type: 'object', properties: { q: S.str(80) } } } },
    async (req) => recursos.loja(auth(req).workspaceId, String((req.query as { q?: string }).q ?? '').trim()));
  app.get('/api/recursos/loja/previa', { schema: { querystring: { type: 'object', required: ['id'], properties: { id: ID_COMPETENCIA } } } },
    async (req) => recursos.previa(auth(req).workspaceId, (req.query as { id: string }).id));
  app.get('/api/recursos/loja/varredura', { schema: { querystring: { type: 'object', required: ['id'], properties: { id: ID_COMPETENCIA } } } },
    async (req) => recursos.varredura(auth(req).workspaceId, (req.query as { id: string }).id));
  app.post('/api/recursos/loja/instalar', { schema: { body: { type: 'object', additionalProperties: false, required: ['id', 'vi'], properties: { id: ID_COMPETENCIA, vi: { const: true } } } } },
    async (req) => { const a = owner(req); return recursos.instalar(a.workspaceId, a.userId, (req.body as { id: string }).id); });

  // ---- adicionar uma competência pronta (rc.29): SKILL.md, pasta compactada ou texto colado, com a mesma varredura da loja
  const PACOTE = { texto: S.str(400_000), zip: { type: 'string', maxLength: 6_000_000 }, nomeArquivo: S.str(200) };
  const ENVIO = 8 * 1024 * 1024;
  type Pedido = { texto?: string; zip?: string; nomeArquivo?: string };
  const listaDe = (v: string | null): string[] => { try { const x = JSON.parse(v ?? '[]'); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };
  /** Liga (ou tira) a competência nos agentes, com a ferramenta das competências junto (sem ela o agente não consulta). */
  const nosAgentes = (ws: string, userId: string, ids: string[], nome: string, ligar: boolean) => {
    for (const agentId of ids) {
      const ag = db.get<{ tools: string | null; hermes_skills: string | null }>('SELECT tools, hermes_skills FROM agents WHERE id = ? AND workspace_id = ?', agentId, ws);
      if (!ag) continue;
      const tem = listaDe(ag.hermes_skills);
      const tools = listaDe(ag.tools);
      if (ligar && tem.includes(nome)) continue;
      if (!ligar && !tem.includes(nome)) continue;
      const novas = ligar ? [...tem, nome] : tem.filter((x) => x !== nome);
      updateAgent(db, bus, ws, userId, agentId, { hermesSkills: novas, ...(ligar && !tools.includes('habilidades') ? { tools: [...tools, 'habilidades'] } : {}) });
    }
  };
  app.post('/api/recursos/competencias/previa', { bodyLimit: ENVIO, schema: { body: { type: 'object', additionalProperties: false, properties: PACOTE } } }, async (req) => {
    const a = auth(req);
    const p = pacoteDoPedido(req.body as Pedido);
    const varredura = await recursos.varrerEnvio(a.workspaceId, p);
    return { nome: p.nome, titulo: p.titulo, descricao: p.descricao, arquivos: Object.keys(p.arquivos).sort(), ignorados: p.ignorados, texto: p.arquivos['SKILL.md'], varredura };
  });
  app.post('/api/recursos/competencias/instalar', {
    bodyLimit: ENVIO,
    schema: { body: { type: 'object', additionalProperties: false, required: ['destino'], properties: { ...PACOTE, destino: { enum: ['agente', 'equipe'] }, agente: S.id('agt'), riscoAceito: { type: 'boolean' } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as Pedido & { destino: 'agente' | 'equipe'; agente?: string; riscoAceito?: boolean };
    const ativos = db.all<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY created_at", a.workspaceId).map((x) => x.id);
    if (b.destino === 'agente' && (!b.agente || !ativos.includes(b.agente))) throw new HttpError(400, 'agente', 'escolha um agente ativo desta equipe');
    const p = pacoteDoPedido(b);
    const r = await recursos.enviar(a.workspaceId, a.userId, p, b.riscoAceito === true);
    const alvos = b.destino === 'equipe' ? ativos : [b.agente!];
    nosAgentes(a.workspaceId, a.userId, alvos, p.nome, true);
    return { ok: true, nome: p.nome, atualizada: r?.atualizada === true, agentes: alvos.length };
  });
  app.get('/api/recursos/competencias/conteudo', { schema: { querystring: { type: 'object', required: ['nome'], properties: { nome: { type: 'string', pattern: NOME_COMPETENCIA.source } } } } },
    async (req) => recursos.conteudo(auth(req).workspaceId, (req.query as { nome: string }).nome));
  app.delete('/api/recursos/competencias/:nome', { schema: { params: { type: 'object', required: ['nome'], properties: { nome: { type: 'string', pattern: NOME_COMPETENCIA.source } } } } }, async (req) => {
    const a = owner(req);
    const nome = (req.params as { nome: string }).nome;
    if (nome.startsWith('ergon-')) throw new HttpError(400, 'treinar', 'as competências do Treinar se removem no cartão delas');
    await recursos.removerCompetencia(a.workspaceId, a.userId, nome);
    nosAgentes(a.workspaceId, a.userId, db.all<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ?', a.workspaceId).map((x) => x.id), nome, false);
    return { ok: true };
  });
  // Ligar ou desligar uma competência da biblioteca num agente: a conta é feita aqui, sobre a lista gravada (dois cliques
  // seguidos na tela não apagam um ao outro, como aconteceria mandando a lista inteira que a tela tinha)
  app.post('/api/recursos/competencias/ligar', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['agente', 'nome', 'ligar'], properties: { agente: S.id('agt'), nome: { type: 'string', pattern: NOME_COMPETENCIA.source }, ligar: { type: 'boolean' } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { agente: string; nome: string; ligar: boolean };
    if (b.nome.startsWith('ergon-')) throw new HttpError(400, 'treinar', 'as competências do Treinar se ligam e desligam no cartão delas');
    if (!db.get('SELECT 1 FROM agents WHERE id = ? AND workspace_id = ?', b.agente, a.workspaceId)) throw new HttpError(404, 'not_found', 'agente não encontrado');
    nosAgentes(a.workspaceId, a.userId, [b.agente], b.nome, b.ligar);
    const ag = db.get<{ hermes_skills: string | null }>('SELECT hermes_skills FROM agents WHERE id = ? AND workspace_id = ?', b.agente, a.workspaceId);
    return { ok: true, competencias: listaDe(ag?.hermes_skills ?? null) };
  });

  // ---- conectores prontos (Conexões › Mais aplicativos)
  const retornoDe = (req: FastifyRequest, nome: string) => {
    const base = (cfg.publicUrl || `${req.protocol}://${req.headers.host ?? 'localhost'}`).replace(/\/+$/, '');
    return `${base}/api/recursos/conectores/${nome}/retorno`;
  };
  app.get('/api/recursos/conectores', async (req) => recursos.conectores(auth(req).workspaceId));
  app.post('/api/recursos/conectores/instalar', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['nome'], properties: { nome: NOME,
      campos: { type: 'object', maxProperties: 8, additionalProperties: S.str(2000, 1), propertyNames: { pattern: '^[A-Z][A-Z0-9_]{1,60}$' } } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { nome: string; campos?: Record<string, string> };
    return recursos.instalarConector(a.workspaceId, a.userId, b.nome, b.campos ?? {}, retornoDe(req, b.nome));
  });
  app.put('/api/recursos/conectores/:nome', { schema: { params: nomeParams, body: { type: 'object', additionalProperties: false, required: ['ligado'], properties: { ligado: { type: 'boolean' } } } } },
    async (req) => { const a = owner(req); return recursos.ligarConector(a.workspaceId, a.userId, (req.params as { nome: string }).nome, (req.body as { ligado: boolean }).ligado); });
  app.put('/api/recursos/conectores/:nome/escrita', { schema: { params: nomeParams, body: { type: 'object', additionalProperties: false, required: ['liberada'], properties: { liberada: { type: 'boolean' } } } } },
    async (req) => { const a = owner(req); return { escrita: recursos.setEscrita(a.workspaceId, a.userId, (req.params as { nome: string }).nome, (req.body as { liberada: boolean }).liberada) }; });
  app.delete('/api/recursos/conectores/:nome', { schema: { params: nomeParams } },
    async (req) => { const a = owner(req); await recursos.removerConector(a.workspaceId, a.userId, (req.params as { nome: string }).nome); return { ok: true }; });
  app.post('/api/recursos/conectores/:nome/entrar', { schema: { params: nomeParams } }, async (req) => {
    const a = owner(req);
    const r = await recursos.entrarConector(a.workspaceId, (req.params as { nome: string }).nome);
    // só endereço da internet, para abrir no navegador da pessoa
    if (r.endereco && !/^https:\/\//.test(String(r.endereco))) throw new HttpError(502, 'entrada', 'endereço de entrada inesperado');
    return r;
  });
  app.get('/api/recursos/conectores/entrada/:fluxo', { schema: { params: { type: 'object', required: ['fluxo'], properties: { fluxo: { type: 'string', pattern: '^[A-Za-z0-9_-]{8,80}$' } } } } },
    async (req) => recursos.fluxoConector(owner(req).workspaceId, (req.params as { fluxo: string }).fluxo));
  // a volta do provedor, no navegador da pessoa (com a sessão dela): o motor confere o "state" da entrada que ele abriu
  app.get('/api/recursos/conectores/:nome/retorno', {
    schema: { params: nomeParams, querystring: { type: 'object', properties: { code: S.str(4000), state: S.str(4000), error: S.str(400), iss: S.str(400) } } },
  }, async (req, reply) => {
    const a = owner(req);
    const q = req.query as Record<string, string | undefined>;
    const campos = Object.fromEntries(Object.entries(q).filter(([k, v]) => ['code', 'state', 'error', 'iss'].includes(k) && typeof v === 'string' && v)) as Record<string, string>;
    let ok = false;
    try { ok = (await recursos.retornoConector(a.workspaceId, (req.params as { nome: string }).nome, campos)).ok === true; } catch { ok = false; }
    reply.header('Content-Type', 'text/html; charset=utf-8').header('Cache-Control', 'no-store')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'");
    return reply.send(paginaRetorno(ok));
  });

  // ---- voltar atrás
  app.get('/api/recursos/checkpoints', async (req) => recursos.checkpoints(owner(req).workspaceId));
  app.post('/api/recursos/checkpoints/voltar', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['pasta', 'id'], properties: { pasta: S.str(300, 1), id: { type: 'string', pattern: '^[0-9a-f]{7,64}$' } } } },
  }, async (req) => { const a = owner(req); const b = req.body as { pasta: string; id: string }; return recursos.voltar(a.workspaceId, a.userId, b.pasta, b.id); });

  // ---- voz: o áudio anexado vira texto; a resposta vira áudio ("Ouvir")
  app.post('/api/recursos/voz/transcrever', { schema: { body: { type: 'object', additionalProperties: false, required: ['arquivo'], properties: { arquivo: S.id('art') } } } }, async (req) => {
    const a = auth(req);
    const f = openArtifact(db, cfg.filesDir, a.workspaceId, (req.body as { arquivo: string }).arquivo);
    if (!ehAudio(f.mime, f.filename)) throw new HttpError(400, 'nao_e_audio', 'este arquivo não é um áudio');
    const r = await recursos.transcrever(a.workspaceId, f.data, f.filename);
    if (r.ok !== true) {
      if (r.motivo === 'componente') throw new HttpError(409, 'voz_componente', 'transcrever áudios precisa de um componente adicional na equipe de IA (o transcritor local) ou de uma conta de voz ligada');
      if (r.motivo === 'formato') throw new HttpError(400, 'formato', 'formato de áudio não aceito');
      if (r.motivo === 'tamanho') throw new HttpError(400, 'tamanho', 'áudio grande demais para transcrever');
      throw new HttpError(502, 'voz_falhou', 'não consegui transcrever este áudio agora');
    }
    return { texto: String(r.texto ?? ''), arquivo: f.filename };
  });
  app.post('/api/recursos/voz/falar', { schema: { body: { type: 'object', additionalProperties: false, required: ['mensagem'], properties: { mensagem: S.id('msg') } } } }, async (req, reply) => {
    const a = auth(req);
    const m = db.get<{ conversation_id: string; content: string; role: string }>('SELECT conversation_id, content, role FROM messages WHERE id = ? AND workspace_id = ?', (req.body as { mensagem: string }).mensagem, a.workspaceId);
    if (!m) throw notFound('mensagem');
    getConversation(db, a.workspaceId, a.userId, m.conversation_id); // só quem vê a conversa ouve
    const texto = String(m.content ?? '').replace(/\[\[[^\]]*\]\]/g, '').trim().slice(0, 12000);
    if (!texto) throw new HttpError(400, 'vazio', 'nada para ouvir nesta mensagem');
    const r = await recursos.falar(a.workspaceId, texto);
    if (r.ok !== true) {
      if (r.motivo === 'componente') throw new HttpError(409, 'voz_componente', 'responder em áudio precisa de um componente adicional na equipe de IA (a voz) ou de uma conta de voz ligada');
      throw new HttpError(502, 'voz_falhou', 'não consegui gerar o áudio agora (a voz padrão precisa de internet)');
    }
    const tipo = /^audio\/(mpeg|ogg|wav)$/.test(String(r.tipo)) ? String(r.tipo) : 'audio/mpeg';
    reply.header('Content-Type', tipo).header('Cache-Control', 'private, no-store');
    return reply.send(Buffer.from(String(r.audio ?? ''), 'base64'));
  });
}
