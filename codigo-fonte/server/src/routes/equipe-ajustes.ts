/**
 * Rotas dos ajustes da equipe que são configuração do motor de IA (rc.27, services/ajustes-motor.ts): modelos reserva,
 * "não treinar com os meus dados", busca privada, arrumar competências sem uso, anotar na memória depois da conversa, a
 * profundidade do raciocínio; pausar e retomar a equipe; e orientar um
 * trabalho em andamento sem interromper. As respostas levam dados (a tela tem os textos nos dicionários dela).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Db } from '../db/db.ts';
import { idParams } from '../lib/schemas.ts';
import { HttpError, now } from '../lib/util.ts';
import type { AiService } from '../services/ai.ts';
import type { AuthContext } from '../services/auth.ts';
import { ajustesDaEquipe, gravarEscolhas, gravarPausa, pausaDaEquipe, RACIOCINIOS, RESERVA_MAX, type ReservaModo } from '../services/ajustes-motor.ts';
import type { Raciocinio } from '../services/hermes.ts';
import { audit, type Bus } from '../services/bus.ts';
import { ORIENTAR_NAO_ANDANDO, STEER_MAX, type RunExecutor } from '../services/runs.ts';

export interface AjustesRoutesDeps {
  db: Db; bus: Bus; executor: RunExecutor;
  /** sessão válida (qualquer membro) */ auth: (req: FastifyRequest) => AuthContext;
  /** sessão do dono do workspace */ owner: (req: FastifyRequest) => AuthContext;
  /** a configuração de IA do motor do workspace */ aiOf: (workspaceId: string) => AiService;
  /** os workspaces que dividem o motor deste (os da pessoa; ou todos, com um motor só) */
  workspacesDoMotor: (workspaceId: string) => string[];
  /** o idioma das mensagens do motor do workspace (o da pessoa dona dele) */
  idiomaDoMotor: (workspaceId: string) => 'pt' | 'en' | undefined;
  /** a conversa é desta pessoa? (lança 404 se não for) */
  conversaDe: (workspaceId: string, userId: string, conversationId: string) => void;
}

export function registerAjustesRoutes(app: FastifyInstance, d: AjustesRoutesDeps): void {
  const { db, bus, executor, auth, owner, aiOf, workspacesDoMotor } = d;
  const estado = (ws: string) => {
    const ids = workspacesDoMotor(ws);
    return { ...ajustesDaEquipe(db, ids), pausa: pausaDaEquipe(db, ids), outros: ids.filter((w) => w !== ws).length };
  };

  // O que vale para a equipe e, para montar a lista de modelos reserva, as contas de IA conectadas com os modelos de cada uma
  app.get('/api/team/ajustes', async (req) => {
    const a = auth(req);
    return { ...estado(a.workspaceId), opcoes: await aiOf(a.workspaceId).opcoesDeReserva().catch(() => ({ principal: { provider: null, model: null }, contas: [] })) };
  });

  const modelo = { type: 'object', additionalProperties: false, required: ['provider', 'model'],
    properties: { provider: { type: 'string', minLength: 1, maxLength: 60 }, model: { type: 'string', minLength: 1, maxLength: 160 } } };
  app.put('/api/team/ajustes', {
    schema: { body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      reserva: { type: 'object', additionalProperties: false, required: ['modo'], properties: { modo: { enum: ['auto', 'lista', 'desligado'] }, lista: { type: 'array', maxItems: RESERVA_MAX, items: modelo } } },
      naoTreinar: { type: 'boolean' }, buscaPrivada: { type: 'boolean' }, arrumarCompetencias: { type: 'boolean' },
      anotarMemoria: { type: 'boolean' }, raciocinio: { enum: [...RACIOCINIOS] } } } },
  }, async (req) => {
    const a = owner(req);
    const b = req.body as { reserva?: { modo: ReservaModo; lista?: Array<{ provider: string; model: string }> }; naoTreinar?: boolean; buscaPrivada?: boolean; arrumarCompetencias?: boolean; anotarMemoria?: boolean; raciocinio?: Raciocinio };
    const ai = aiOf(a.workspaceId);
    if (b.reserva?.modo === 'lista') {
      // só modelos de contas que a pessoa conectou (a lista vem da tela, mas quem confere é o servidor)
      const { contas } = await ai.opcoesDeReserva();
      const fora = (b.reserva.lista ?? []).find((e) => !contas.some((c) => c.id === e.provider && c.models.some((m) => m.id === e.model)));
      if (fora) throw new HttpError(400, 'reserva_model', 'Esse modelo não está numa conta de IA conectada.');
    }
    gravarEscolhas(db, a.workspaceId, b);
    const ids = workspacesDoMotor(a.workspaceId);
    let applied = false;
    try { applied = (await ai.sincronizarAjustes(db, ids, d.idiomaDoMotor(a.workspaceId))) !== null; } catch { /* motor fora agora: o passo de 60 s e a abertura tentam de novo */ }
    const e = estado(a.workspaceId);
    const partes = [
      b.reserva ? (b.reserva.modo === 'desligado' ? 'modelos reserva desligados' : b.reserva.modo === 'auto' ? 'modelos reserva automáticos (as outras contas de IA conectadas)' : `modelos reserva escolhidos (${(b.reserva.lista ?? []).length})`) : '',
      b.naoTreinar === undefined ? '' : b.naoTreinar ? 'não treinar com os meus dados: ligado' : 'não treinar com os meus dados: desligado',
      b.buscaPrivada === undefined ? '' : b.buscaPrivada ? 'busca privada ligada' : 'busca privada desligada',
      b.arrumarCompetencias === undefined ? '' : b.arrumarCompetencias ? 'arrumar competências sem uso: ligado' : 'arrumar competências sem uso: desligado',
      b.anotarMemoria === undefined ? '' : b.anotarMemoria ? 'anotar na memória depois da conversa: ligado' : 'anotar na memória depois da conversa: desligado',
      b.raciocinio === undefined ? '' : `profundidade do raciocínio: ${({ high: 'alta', medium: 'média', low: 'baixa', modelo: 'a do modelo' } as const)[b.raciocinio]}`,
    ].filter(Boolean);
    audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: 'team.ajustes',
      evidence: { ...(b.reserva ? { reserva: b.reserva.modo, modelos: (b.reserva.lista ?? []).map((x) => `${x.provider}:${x.model}`) } : {}),
        ...(b.naoTreinar !== undefined ? { naoTreinar: b.naoTreinar } : {}), ...(b.buscaPrivada !== undefined ? { buscaPrivada: b.buscaPrivada } : {}),
        ...(b.arrumarCompetencias !== undefined ? { arrumarCompetencias: b.arrumarCompetencias } : {}),
        ...(b.anotarMemoria !== undefined ? { anotarMemoria: b.anotarMemoria } : {}), ...(b.raciocinio !== undefined ? { raciocinio: b.raciocinio } : {}), applied },
      result: `${partes.join('; ')}${applied ? '' : e.atualizacao ? ' (chega com a próxima atualização da equipe)' : ' (a equipe recebe quando estiver ligada)'}` });
    for (const ws of ids) bus.publish(ws, 'agents.changed', {});
    return { ...e, applied };
  });

  // Pausar a equipe: nenhum trabalho novo começa (pedidos e conversas esperam na fila); o que está em andamento termina.
  // Retomar: a fila volta a andar na hora. Vale para todos os workspaces do mesmo motor.
  app.put('/api/team/pausa', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['pausada'], properties: { pausada: { type: 'boolean' } } } },
  }, async (req) => {
    const a = owner(req);
    const pausada = (req.body as { pausada: boolean }).pausada;
    const ids = workspacesDoMotor(a.workspaceId);
    const antes = pausaDaEquipe(db, ids).pausada;
    if (antes !== pausada) gravarPausa(db, ids, pausada, now());
    let applied = false;
    try { applied = (await aiOf(a.workspaceId).sincronizarPausa(db, ids)) === pausada; } catch { /* motor fora agora: recebe ao abrir (a fila do Ergon já segura) */ }
    if (antes !== pausada) {
      audit(db, bus, { workspaceId: a.workspaceId, actorType: 'user', actorId: a.userId, action: pausada ? 'team.pause' : 'team.resume', evidence: { applied },
        result: pausada ? 'equipe em pausa: o trabalho novo espera você retomar' : 'equipe retomada: o trabalho que esperava volta a andar' });
      for (const ws of ids) { bus.publish(ws, 'agents.changed', {}); bus.publish(ws, 'runs.changed', {}); }
      if (!pausada) void executor.tick();
    }
    return { ...pausaDaEquipe(db, ids), applied };
  });

  // Orientar sem interromper: um recado para o trabalho em andamento (o agente lê na próxima volta e segue)
  const corpo = { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: STEER_MAX } } };
  app.post('/api/runs/:id/steer', { schema: { params: idParams('run'), body: corpo } }, async (req) => {
    const a = auth(req);
    const r = executor.get(a.workspaceId, (req.params as { id: string }).id);
    // conversa: só quem é dono dela; trabalho de card: quem é dono do workspace (como cancelar)
    if (r.conversation_id) d.conversaDe(a.workspaceId, a.userId, r.conversation_id); else owner(req);
    return executor.steer(a.workspaceId, r.id, a.userId, (req.body as { text: string }).text);
  });
  app.post('/api/tasks/:id/steer', { schema: { params: idParams('tsk'), body: corpo } }, async (req) => {
    const a = owner(req);
    const run = db.get<{ id: string }>(
      "SELECT id FROM runs WHERE workspace_id = ? AND task_id = ? AND status = 'running' AND mode = 'real' AND hermes_run_id IS NOT NULL AND cancel_requested = 0 ORDER BY started_at DESC LIMIT 1",
      a.workspaceId, (req.params as { id: string }).id);
    if (!run) throw new HttpError(409, 'steer_not_running', ORIENTAR_NAO_ANDANDO);
    return executor.steer(a.workspaceId, run.id, a.userId, (req.body as { text: string }).text);
  });
}
