/**
 * rc.27, ganhos rápidos (services/ajustes-motor.ts, routes/equipe-ajustes.ts):
 *  1) modelos reserva: automático com as outras contas de IA conectadas, lista escolhida pela pessoa (só de contas
 *     conectadas), desligado; quando o motor informa que o reserva atendeu, fica no histórico;
 *  2) "não treinar com os meus dados" ligado por padrão; 7) busca privada desligada por padrão e, num motor sem a busca
 *     direta, guardada sem deixar a equipe sem busca; 5) arrumar competências sem uso desligado por padrão (é economia, não benefício);
 *     regra do dono (12/11): anotar na memória depois da conversa ligado e a profundidade do raciocínio alta por padrão;
 *  3) orientar um trabalho em andamento sem interromper (POST /v1/runs/{id}/steer no motor);
 *  4) limites e saldo da conta de IA, lidos do provedor pelo motor, no consumo;
 *  6) pausar a equipe: nenhum trabalho novo começa (a fila segura), a parada geral do motor liga, retomar solta;
 *  8) o idioma das mensagens do motor segue o da pessoa.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, test } from 'node:test';
import { throttle } from '../src/security/factors.ts';
import { AJUSTES_MOTOR, SEM_AJUSTES, ajustesDaEquipe, escolhasDaEquipe, patchDosAjustes, pausaDaEquipe, reservaAutomatica, reservaLimpa, reservaUsada, reservaValida, sincronizarAjustes } from '../src/services/ajustes-motor.ts';
import type { AjustesMotor, AjustesPatch, HermesClient, HermesControlClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { HermesError, HttpHermesClient, HttpHermesControl, parseAjustes, parseCota, parseServed } from '../src/services/hermes.ts';
import { EQUIPE_EM_PAUSA } from '../src/services/runs.ts';
import { getSetting } from '../src/services/sectors.ts';
import { contasDeIa } from '../src/services/usage.ts';
import { TEXTOS, reconhecer } from '../src/lib/textos.ts';
import { allAgents, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const OPCOES: ModelOptions = { model: 'anthropic/claude-sonnet-4.5', provider: 'nous', providers: [
  { slug: 'nous', name: 'Nous Portal', current: true, authenticated: true, models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5-mini'], pricing: {} },
  { slug: 'openrouter', name: 'OpenRouter', current: false, authenticated: true, models: ['openai/gpt-5-mini', 'anthropic/claude-sonnet-4.5'], pricing: {} },
  { slug: 'openai-codex', name: 'ChatGPT', current: false, authenticated: true, models: ['gpt-5.2-codex'], pricing: {} },
  { slug: 'anthropic', name: 'Anthropic', current: false, authenticated: false, models: ['claude-opus-4.5'], pricing: {} },
] };
const MOTOR_PADRAO: AjustesMotor = { reserva: [], naoTreinar: false, buscaPrivada: false, buscaPrivadaDisponivel: false, arrumarCompetencias: true, idioma: 'en' };

describe('as contas puras', () => {
  test('reserva automática: as OUTRAS contas conectadas, com o mesmo modelo do principal se a conta o tem', () => {
    assert.deepEqual(reservaAutomatica(OPCOES), [{ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' }, { provider: 'openai-codex', model: 'gpt-5.2-codex' }]);
    assert.deepEqual(reservaAutomatica({ ...OPCOES, providers: OPCOES.providers.slice(0, 1) }), [], 'só uma conta: sem reserva');
    assert.deepEqual(reservaAutomatica(null), []);
  });
  test('lista escolhida: entra só o que é válido, sem repetir, até 5; conta desconectada sai sozinha', () => {
    assert.deepEqual(reservaLimpa([{ provider: 'OpenRouter', model: 'a/b' }, { provider: 'openrouter', model: 'a/b' }, { provider: 'x y', model: 'z' }, { provider: 'nous', model: 'tem espaço' }, 'lixo']),
      [{ provider: 'openrouter', model: 'a/b' }]);
    assert.equal(reservaLimpa(Array.from({ length: 9 }, (_, i) => ({ provider: `p${i}`, model: 'm' }))).length, 5);
    assert.deepEqual(reservaValida([{ provider: 'anthropic', model: 'claude-opus-4.5' }, { provider: 'openrouter', model: 'openai/gpt-5-mini' }, { provider: 'openrouter', model: 'sumiu/modelo' }], OPCOES),
      [{ provider: 'openrouter', model: 'openai/gpt-5-mini' }]);
  });
  test('o que falta mandar ao motor: os padrões do Ergon sobre os padrões do motor', () => {
    const padroes = { reserva: { modo: 'auto' as const, lista: [] }, naoTreinar: true, buscaPrivada: false, arrumarCompetencias: false, anotarMemoria: true, raciocinio: 'high' as const };
    assert.deepEqual(patchDosAjustes(padroes, MOTOR_PADRAO, { opcoes: OPCOES, idioma: 'pt' }),
      { reserva: reservaAutomatica(OPCOES), naoTreinar: true, arrumarCompetencias: false, idioma: 'pt' });
    const igual: AjustesMotor = { ...MOTOR_PADRAO, reserva: reservaAutomatica(OPCOES), naoTreinar: true, arrumarCompetencias: false, idioma: 'pt' };
    assert.deepEqual(patchDosAjustes(padroes, igual, { opcoes: OPCOES, idioma: 'pt' }), {}, 'já está: nada a mandar');
    assert.deepEqual(patchDosAjustes(padroes, igual, { opcoes: OPCOES }), {}, 'sem idioma escolhido: o motor fica como está');
    assert.deepEqual(patchDosAjustes(padroes, { ...igual, reserva: [] }, { opcoes: null, idioma: 'pt' }), {}, 'sem o catálogo de modelos: a reserva não é mexida');
    assert.deepEqual(patchDosAjustes({ ...padroes, reserva: { modo: 'desligado', lista: [] } }, igual, { opcoes: null }), { reserva: [] }, 'desligar não depende do catálogo');
  });
  test('regra do dono (12/11): anotar na memória ligado e raciocínio alto por padrão; a escolha de reduzir vale; motor de antes não recebe', () => {
    const padroes = escolhasDaEquipe({ get: () => undefined } as never, []);
    assert.deepEqual([padroes.anotarMemoria, padroes.raciocinio, padroes.arrumarCompetencias, padroes.buscaPrivada, padroes.naoTreinar], [true, 'high', false, false, true]);
    const motor: AjustesMotor = { ...MOTOR_PADRAO, naoTreinar: true, arrumarCompetencias: false, anotarMemoria: false, raciocinio: 'low' };
    assert.deepEqual(patchDosAjustes(padroes, motor, { opcoes: null }), { anotarMemoria: true, raciocinio: 'high' }, 'o "low" da configuração de antes vira o alto; a anotação liga');
    assert.deepEqual(patchDosAjustes({ ...padroes, anotarMemoria: false, raciocinio: 'modelo' }, { ...motor, raciocinio: '' }, { opcoes: null }), {}, 'a do modelo é "" no motor');
    assert.deepEqual(patchDosAjustes({ ...padroes, raciocinio: 'medium' }, { ...motor, anotarMemoria: true, raciocinio: 'high' }, { opcoes: null }), { raciocinio: 'medium' });
    assert.deepEqual(patchDosAjustes(padroes, MOTOR_PADRAO, { opcoes: null }), { naoTreinar: true, arrumarCompetencias: false }, 'motor que não diz esses dois (de antes): não manda');
  });
  test('busca privada: num motor sem a busca direta não é mandada (a equipe não fica sem busca); desligar sempre vai', () => {
    const quer = { reserva: { modo: 'desligado' as const, lista: [] }, naoTreinar: false, buscaPrivada: true, arrumarCompetencias: true, anotarMemoria: true, raciocinio: 'high' as const };
    assert.deepEqual(patchDosAjustes(quer, MOTOR_PADRAO, { opcoes: null }), {});
    assert.deepEqual(patchDosAjustes(quer, { ...MOTOR_PADRAO, buscaPrivadaDisponivel: true }, { opcoes: null }), { buscaPrivada: true });
    assert.deepEqual(patchDosAjustes({ ...quer, buscaPrivada: false }, { ...MOTOR_PADRAO, buscaPrivada: true }, { opcoes: null }), { buscaPrivada: false });
  });
  test('o reserva foi usado? só quando quem atendeu está na cadeia e não é o que foi pedido', () => {
    const cadeia = [{ provider: 'openrouter', model: 'openai/gpt-5-mini' }, { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' }];
    const pedido = { provider: 'nous', model: 'anthropic/claude-sonnet-4.5' };
    assert.deepEqual(reservaUsada({ provider: 'openrouter', model: 'openai/gpt-5-mini' }, pedido, cadeia), cadeia[0]);
    assert.deepEqual(reservaUsada({ provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' }, pedido, cadeia), cadeia[1], 'o mesmo modelo por outra conta também é reserva');
    assert.equal(reservaUsada({ provider: 'nous', model: 'anthropic/claude-sonnet-4.5' }, pedido, cadeia), null, 'o principal atendeu');
    assert.equal(reservaUsada({ provider: null, model: 'anthropic/claude-sonnet-4.5' }, pedido, cadeia), null, 'sem a conta informada e com o modelo pedido: não afirma');
    assert.equal(reservaUsada({ provider: 'x', model: 'outro' }, pedido, cadeia), null);
    assert.equal(reservaUsada(null, pedido, cadeia), null);
    assert.equal(reservaUsada({ provider: 'openrouter', model: 'openai/gpt-5-mini' }, pedido, []), null);
  });
  test('o que vem do motor é lido com cuidado', () => {
    assert.deepEqual(parseServed({ provider: 'openrouter', model: 'a/b', route_source: 'global' }), { provider: 'openrouter', model: 'a/b' });
    assert.equal(parseServed(null), null); assert.equal(parseServed({ provider: '', model: '' }), null);
    assert.equal(parseAjustes({ ok: true }), null, 'resposta de outro formato: não se sabe');
    assert.deepEqual(parseAjustes({ reserva: [{ provider: 'nous', model: 'a/b' }, 'x', { provider: '', model: 'c' }], nao_treinar: true, busca_privada: false, busca_privada_disponivel: true, arrumar_competencias: false, idioma: 'pt', fixadas: 2 }),
      { reserva: [{ provider: 'nous', model: 'a/b' }], naoTreinar: true, buscaPrivada: false, buscaPrivadaDisponivel: true, arrumarCompetencias: false, idioma: 'pt' });
    const cota = parseCota({ contas: [{ provedor: 'openai-codex', plano: 'Plus', janelas: [{ tipo: 'semana', rotulo: 'Weekly', usado: 61.4, renova_em: '2026-11-14T10:00:00+00:00', escopo: 'conta' },
      { tipo: 'coisa-nova', rotulo: 'X', usado: 250 }, { tipo: 'sessao', usado: 'muito' }], saldo_usd: 7.5, saldo_ilimitado: false, renova_em: null, lido_em: '2026-11-10T10:00:00+00:00' }, 'lixo'] });
    assert.equal(cota.length, 1);
    assert.deepEqual(cota[0].janelas.map((j) => [j.tipo, j.usado]), [['semana', 61.4], ['outro', 100]]);
    const tela = contasDeIa(cota);
    assert.deepEqual(tela[0].windows.map((w) => [w.kind, w.usedPercent, w.leftPercent]), [['semana', 61, 39], ['outro', 100, 0]]);
    assert.equal(tela[0].windows[0].resetsAt, '2026-11-14T10:00:00.000Z');
    assert.equal(tela[0].balanceUsd, 7.5);
    assert.deepEqual(contasDeIa(null), []);
    assert.deepEqual(contasDeIa([{ provedor: 'x', plano: null, janelas: [], saldoUsd: null, saldoIlimitado: false, renovaEm: null, lidoEm: null }]), [], 'conta sem nada a mostrar não aparece');
  });
  test('os textos novos do histórico e dos erros têm código (a tela em inglês traduz)', () => {
    assert.equal(reconhecer('o modelo principal não respondeu: o trabalho foi feito pelo modelo reserva openai/gpt-5-mini', 'historico.')?.codigo, 'historico.reservaUsada');
    assert.equal(reconhecer('orientação enviada ao trabalho em andamento', 'historico.')?.codigo, 'historico.orientou');
    assert.equal(reconhecer('equipe em pausa: o trabalho novo espera você retomar', 'historico.')?.codigo, 'historico.equipePausada');
    assert.equal(reconhecer('equipe retomada: o trabalho que esperava volta a andar', 'historico.')?.codigo, 'historico.equipeRetomada');
    assert.ok(TEXTOS['erro.orientarNaoAndando'] && TEXTOS['erro.orientarNaoAceitou'] && TEXTOS['erro.reservaForaDaConta']);
  });
});

// ---------------------------------------------------------------- motor falso (API) + ponte de controle falsa
class Motor implements HermesClient {
  started: StartRun[] = [];
  runs = new Map<string, RemoteRun>();
  steers: Array<{ runId: string; text: string }> = [];
  /** como as execuções novas ficam */
  estado: RemoteRun = { status: 'completed', output: 'pronto', error: null, sessionId: 'sess-rapidos', usage: null };
  aceitaOrientacao = true;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(p: StartRun) {
    this.started.push(p);
    const runId = `run_${Buffer.from(p.idempotencyKey).toString('hex').slice(0, 30)}`;
    this.runs.set(runId, { ...this.estado });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async steer(runId: string, text: string) { if (!this.aceitaOrientacao) return false; this.steers.push({ runId, text }); return true; }
  async toolsets() { return [{ name: 'todo', label: 'todo', enabled: true, configured: true, tools: [] }]; }
  async modelOptions(): Promise<ModelOptions> { return OPCOES; }
}

function ponte(o: { antiga?: boolean; buscaDireta?: boolean } = {}) {
  const st = { ajustes: { ...MOTOR_PADRAO, buscaPrivadaDisponivel: !!o.buscaDireta } as AjustesMotor, gravados: [] as AjustesPatch[], pausada: false, pausas: [] as boolean[], fora: false, cotas: 0,
    antiga: !!o.antiga };
  const control = {
    health: async () => true,
    info: async () => ({ ok: true, pluginVersion: st.antiga ? '0.4.0' : '0.5.0', vaultConfig: 3, capacidades: ['conexoes', 'medicao', 'passos', 'compactacao', ...(st.antiga ? [] : ['ajustes', 'cota', 'pausa', 'nao_treinar'])] }),
    apiToolsets: async () => ({ enabled: ['todo'], safe: ['todo'] }), setApiToolsets: async (e: string[]) => e,
    modelInfo: async () => ({ model: OPCOES.model, provider: OPCOES.provider }),
    accounts: async () => [],
    ajustes: async () => { if (st.fora) throw new Error('fora'); return st.antiga ? null : st.ajustes; },
    setAjustes: async (p: AjustesPatch) => {
      if (st.fora) throw new Error('fora');
      if (st.antiga) return null;
      if (p.buscaPrivada && !st.ajustes.buscaPrivadaDisponivel) throw new HermesError(409, 'este motor ainda não tem a busca direta');
      st.gravados.push(p); st.ajustes = { ...st.ajustes, ...p } as AjustesMotor; return st.ajustes;
    },
    pausa: async () => { if (st.fora) throw new Error('fora'); return st.antiga ? null : st.pausada; },
    setPausa: async (v: boolean) => { if (st.fora) throw new Error('fora'); if (st.antiga) return null; st.pausas.push(v); st.pausada = v; return v; },
    cota: async () => { st.cotas++; return st.antiga ? null : parseCota({ contas: [{ provedor: 'openai-codex', plano: 'Plus', janelas: [{ tipo: 'sessao', rotulo: 'Session', usado: 12, renova_em: '2026-11-10T15:00:00+00:00', escopo: 'conta' },
      { tipo: 'semana', rotulo: 'Weekly', usado: 61, renova_em: '2026-11-14T10:00:00+00:00', escopo: 'conta' }], saldo_usd: null, saldo_ilimitado: false, renova_em: null, lido_em: '2026-11-10T10:00:00+00:00' }] }); },
  } as unknown as HermesControlClient;
  return { st, control };
}

async function umMotor(o: Parameters<typeof ponte>[0] = {}): Promise<{ h: Harness; s: Session; motor: Motor; p: ReturnType<typeof ponte> }> {
  throttle.reset();
  const motor = new Motor(); const p = ponte(o);
  const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', runTimeoutSeconds: 30 }, { hermes: motor, control: p.control });
  const s = await setupOwner(h);
  return { h, s, motor, p };
}
const ticks = async (h: Harness, n: number) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
async function pedido(h: Harness, s: Session, text: string, id: string): Promise<string> {
  const agents = await allAgents(h, s);
  const coord = agents.find((a) => a.coordinator) ?? agents[0];
  const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: coord.id })).json;
  const sent = await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text, clientRequestId: id });
  assert.equal(sent.status, 201, JSON.stringify(sent.json));
  return sent.json.runId as string;
}
const run = (h: Harness, id: string) => h.db.get<{ status: string; error: string | null; model: string | null; hermes_run_id: string | null }>('SELECT status, error, model, hermes_run_id FROM runs WHERE id = ?', id)!;
const auditoria = (h: Harness, action: string) => h.db.all<{ result: string; target_type: string | null }>('SELECT result, target_type FROM audit_events WHERE action = ? ORDER BY created_at, id', action);

describe('1, 2, 5, 7) ajustes da equipe no motor', () => {
  test('sem escolha nenhuma: os padrões do Ergon chegam ao motor (reserva automática, não treinar ligado, arrumar desligado)', async () => {
    const { h, s, p } = await umMotor();
    const e = (await req(h, 'GET', '/api/team/ajustes', s)).json;
    assert.deepEqual([e.reserva.modo, e.naoTreinar, e.buscaPrivada, e.arrumarCompetencias, e.pausa.pausada], ['auto', true, false, false, false]);
    assert.deepEqual(e.opcoes.contas.map((c: { id: string }) => c.id), ['nous', 'openrouter', 'openai-codex'], 'só as contas conectadas, para a pessoa escolher');
    assert.deepEqual(e.opcoes.principal, { provider: 'nous', model: 'anthropic/claude-sonnet-4.5' });
    const ids = [s.workspaceId];
    const ai = h.motors.ai(s.workspaceId);
    const ficou = await ai.sincronizarAjustes(h.db, ids, 'pt');
    assert.deepEqual(ficou?.reserva, reservaAutomatica(OPCOES));
    assert.equal(ficou?.naoTreinar, true); assert.equal(ficou?.arrumarCompetencias, false); assert.equal(ficou?.idioma, 'pt', 'o motor fala a língua da pessoa');
    assert.equal(p.st.gravados.length, 1);
    await ai.sincronizarAjustes(h.db, ids, 'pt');
    assert.equal(p.st.gravados.length, 1, 'segunda conferência: nada a mandar');
    const depois = (await req(h, 'GET', '/api/team/ajustes', s)).json;
    assert.deepEqual(depois.reserva.emUso, reservaAutomatica(OPCOES), 'a tela mostra quais modelos estão de reserva agora');
    assert.equal(depois.pendente, false);
    await h.close();
  });

  test('a pessoa escolhe: lista de modelos (só de contas conectadas), desligar, treino, arrumação; fica gravado e vai na hora', async () => {
    const { h, s, p } = await umMotor();
    const lista = [{ provider: 'openai-codex', model: 'gpt-5.2-codex' }, { provider: 'openrouter', model: 'openai/gpt-5-mini' }];
    let r = await req(h, 'PUT', '/api/team/ajustes', s, { reserva: { modo: 'lista', lista } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.applied, true);
    assert.deepEqual(p.st.ajustes.reserva, lista, 'na ordem que a pessoa pôs');
    assert.deepEqual(r.json.reserva, { modo: 'lista', lista, emUso: lista });
    r = await req(h, 'PUT', '/api/team/ajustes', s, { reserva: { modo: 'lista', lista: [{ provider: 'anthropic', model: 'claude-opus-4.5' }] } });
    assert.equal(r.status, 400, 'modelo de conta não conectada: recusado');
    assert.equal(r.json.message_t?.codigo, 'erro.reservaForaDaConta');
    assert.deepEqual(p.st.ajustes.reserva, lista);
    r = await req(h, 'PUT', '/api/team/ajustes', s, { reserva: { modo: 'desligado' }, naoTreinar: false, arrumarCompetencias: true });
    assert.equal(r.status, 200);
    assert.deepEqual([p.st.ajustes.reserva, p.st.ajustes.naoTreinar, p.st.ajustes.arrumarCompetencias], [[], false, true]);
    assert.deepEqual(escolhasDaEquipe(h.db, [s.workspaceId]), { reserva: { modo: 'desligado', lista: [] }, naoTreinar: false, buscaPrivada: false, arrumarCompetencias: true, anotarMemoria: true, raciocinio: 'high' });
    // reduzir para economizar: a anotação de memória desligada e o raciocínio do modelo
    p.st.ajustes = { ...p.st.ajustes, anotarMemoria: true, raciocinio: 'high' };
    r = await req(h, 'PUT', '/api/team/ajustes', s, { anotarMemoria: false, raciocinio: 'low' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.anotarMemoria, r.json.raciocinio, p.st.ajustes.anotarMemoria, p.st.ajustes.raciocinio], [false, 'low', false, 'low']);
    assert.equal((await req(h, 'PUT', '/api/team/ajustes', s, { raciocinio: 'ultra' })).status, 400, 'só os níveis que a tela oferece');
    assert.match(auditoria(h, 'team.ajustes').at(-1)?.result ?? '', /anotar na memória depois da conversa: desligado; profundidade do raciocínio: baixa/);
    r = await req(h, 'PUT', '/api/team/ajustes', s, { anotarMemoria: true, raciocinio: 'high' });
    r = await req(h, 'PUT', '/api/team/ajustes', s, { reserva: { modo: 'auto' } });
    assert.deepEqual(p.st.ajustes.reserva, reservaAutomatica(OPCOES));
    assert.equal((await req(h, 'PUT', '/api/team/ajustes', s, {})).status, 400);
    assert.equal((await req(h, 'PUT', '/api/team/ajustes', s, { reserva: { modo: 'qualquer' } })).status, 400);
    const a = auditoria(h, 'team.ajustes');
    assert.equal(a.length, 5);
    assert.match(a[1].result, /modelos reserva desligados; não treinar com os meus dados: desligado; arrumar competências sem uso: ligado/);
    await h.close();
  });

  test('motor fora do ar: a escolha fica guardada e chega quando ele volta', async () => {
    const { h, s, p } = await umMotor();
    await h.motors.ai(s.workspaceId).sincronizarAjustes(h.db, [s.workspaceId]);
    p.st.fora = true;
    const r = await req(h, 'PUT', '/api/team/ajustes', s, { naoTreinar: false });
    assert.equal(r.status, 200); assert.equal(r.json.applied, false); assert.equal(r.json.naoTreinar, false); assert.equal(r.json.pendente, true);
    assert.equal(p.st.ajustes.naoTreinar, true);
    p.st.fora = false;
    await h.motors.ai(s.workspaceId).sincronizarAjustes(h.db, [s.workspaceId]);
    assert.equal(p.st.ajustes.naoTreinar, false);
    assert.equal(ajustesDaEquipe(h.db, [s.workspaceId]).pendente, false);
    await h.close();
  });

  test('busca privada num motor sem a busca direta: guardada, a tela diz que chega com a atualização, e a busca de hoje fica', async () => {
    const { h, s, p } = await umMotor();
    const r = await req(h, 'PUT', '/api/team/ajustes', s, { buscaPrivada: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([r.json.buscaPrivada, r.json.buscaPrivadaAguarda, r.json.pendente], [true, true, false]);
    assert.equal(p.st.ajustes.buscaPrivada, false, 'o motor não foi mexido');
    assert.ok(!p.st.gravados.some((g) => g.buscaPrivada !== undefined));
    // a versão nova da equipe traz a busca direta: a escolha guardada entra sozinha
    p.st.ajustes = { ...p.st.ajustes, buscaPrivadaDisponivel: true };
    await h.motors.ai(s.workspaceId).sincronizarAjustes(h.db, [s.workspaceId]);
    assert.equal(p.st.ajustes.buscaPrivada, true);
    assert.equal(ajustesDaEquipe(h.db, [s.workspaceId]).buscaPrivadaAguarda, false);
    await h.close();
  });

  test('motor de antes dos ajustes: as escolhas ficam guardadas e a tela diz que chegam com a atualização da equipe', async () => {
    const { h, s, p } = await umMotor({ antiga: true });
    const r = await req(h, 'PUT', '/api/team/ajustes', s, { naoTreinar: false });
    assert.equal(r.status, 200); assert.deepEqual([r.json.applied, r.json.atualizacao, r.json.pendente], [false, true, false]);
    assert.equal(getSetting(h.db, s.workspaceId, AJUSTES_MOTOR), SEM_AJUSTES);
    assert.equal(p.st.gravados.length, 0);
    assert.equal(await sincronizarAjustes(h.db, null, [s.workspaceId], { opcoes: null }), null);
    const u = await req(h, 'GET', '/api/usage?tz=0', s);
    assert.deepEqual(u.json.accounts, [], 'motor de antes: sem os limites da conta, sem erro');
    await h.close();
  });
});

describe('6) pausar a equipe', () => {
  test('em pausa nenhum trabalho novo começa; o motor recebe a parada geral; retomar faz a fila andar', async () => {
    const { h, s, motor, p } = await umMotor();
    let r = await req(h, 'PUT', '/api/team/pausa', s, { pausada: true });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.pausada, true); assert.equal(r.json.applied, true); assert.match(r.json.desde, /^\d{4}-/);
    assert.deepEqual(p.st.pausas, [true]);
    const estado = (await req(h, 'GET', '/api/state', s)).json;
    assert.equal(estado.teamPausa.pausada, true, 'a barra de cima e a Cidade leem daqui');
    const runId = await pedido(h, s, 'resuma a semana', 'req-pausa-0001');
    await ticks(h, 4);
    assert.equal(run(h, runId).status, 'queued');
    assert.equal(run(h, runId).error, EQUIPE_EM_PAUSA, 'o pedido diz por que espera');
    assert.equal(motor.started.length, 0, 'nada foi ao motor');
    r = await req(h, 'PUT', '/api/team/pausa', s, { pausada: true });
    assert.deepEqual(p.st.pausas, [true], 'pausar de novo não repete');
    r = await req(h, 'PUT', '/api/team/pausa', s, { pausada: false });
    assert.equal(r.json.pausada, false); assert.equal(r.json.desde, null);
    assert.deepEqual(p.st.pausas, [true, false]);
    await ticks(h, 4);
    assert.equal(run(h, runId).status, 'succeeded', 'o pedido que esperava andou');
    assert.equal(motor.started.length, 1);
    assert.deepEqual(auditoria(h, 'team.pause').length + auditoria(h, 'team.resume').length, 2);
    assert.equal((await req(h, 'PUT', '/api/team/pausa', s, { pausada: 'sim' })).status, 400);
    await h.close();
  });

  test('o que já está em andamento termina; motor fora do ar: a fila do Ergon segura assim mesmo e o motor recebe depois', async () => {
    const { h, s, motor, p } = await umMotor();
    motor.estado = { ...motor.estado, status: 'running', output: null };
    const andando = await pedido(h, s, 'trabalho longo', 'req-pausa-0002');
    await ticks(h, 2);
    assert.equal(run(h, andando).status, 'running');
    p.st.fora = true;
    const r = await req(h, 'PUT', '/api/team/pausa', s, { pausada: true });
    assert.equal(r.status, 200); assert.equal(r.json.pausada, true); assert.equal(r.json.applied, false);
    assert.equal(pausaDaEquipe(h.db, [s.workspaceId]).pausada, true);
    motor.runs.set(run(h, andando).hermes_run_id!, { status: 'completed', output: 'terminei', error: null, sessionId: 'x', usage: null });
    await ticks(h, 2);
    assert.equal(run(h, andando).status, 'succeeded', 'a pausa não interrompe o que já andava');
    p.st.fora = false;
    assert.equal(await h.motors.ai(s.workspaceId).sincronizarPausa(h.db, [s.workspaceId]), true, 'o motor recebe a parada quando volta');
    await h.close();
  });
});

describe('3) orientar um trabalho em andamento', () => {
  test('o recado vai ao motor sem interromper; fora de andamento, a tela recebe o motivo', async () => {
    const { h, s, motor } = await umMotor();
    motor.estado = { ...motor.estado, status: 'running', output: null };
    const runId = await pedido(h, s, 'monte o relatório', 'req-steer-0001');
    let r = await req(h, 'POST', `/api/runs/${runId}/steer`, s, { text: 'use os dados de outubro' });
    assert.equal(r.status, 409, 'ainda na fila: não há o que orientar');
    assert.equal(r.json.message_t?.codigo, 'erro.orientarNaoAndando');
    await ticks(h, 2);
    r = await req(h, 'POST', `/api/runs/${runId}/steer`, s, { text: '  use os dados de outubro, não os de setembro  ' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, { accepted: true });
    assert.deepEqual(motor.steers, [{ runId: run(h, runId).hermes_run_id, text: 'use os dados de outubro, não os de setembro' }]);
    assert.equal(run(h, runId).status, 'running', 'continua andando');
    assert.equal(auditoria(h, 'run.steer').length, 1);
    assert.equal((await req(h, 'POST', `/api/runs/${runId}/steer`, s, { text: '' })).status, 400);
    assert.equal((await req(h, 'POST', `/api/runs/${runId}/steer`, s, { text: 'x'.repeat(4001) })).status, 400);
    motor.aceitaOrientacao = false;
    r = await req(h, 'POST', `/api/runs/${runId}/steer`, s, { text: 'mais uma' });
    assert.equal(r.status, 409, 'o motor não aceitou (terminando)');
    motor.aceitaOrientacao = true;
    motor.runs.set(run(h, runId).hermes_run_id!, { status: 'completed', output: 'pronto', error: null, sessionId: 'x', usage: null });
    await ticks(h, 2);
    r = await req(h, 'POST', `/api/runs/${runId}/steer`, s, { text: 'tarde demais' });
    assert.equal(r.status, 409);
    assert.equal(motor.steers.length, 1);
    assert.equal((await req(h, 'POST', '/api/tasks/tsk_naoexiste00000000000000/steer', s, { text: 'oi' })).status >= 400, true);
    await h.close();
  });

  test('o cliente do motor: POST /v1/runs/{id}/steer com o texto; 409 e 404 = não recebeu', async () => {
    const pedidos: Array<{ url: string; body: unknown; auth: string }> = [];
    let status = 200;
    const srv = http.createServer((q, res) => {
      let b = '';
      q.on('data', (c) => { b += c; });
      q.on('end', () => {
        pedidos.push({ url: q.url ?? '', body: JSON.parse(b || '{}'), auth: String(q.headers.authorization) });
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(status === 200 ? { object: 'hermes.run.steer', run_id: 'run_abc123', accepted: true } : { error: { message: 'Run is not currently accepting steer input', code: 'run_not_accepting_steer' } }));
      });
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const c = new HttpHermesClient(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 'chave-de-teste');
    assert.equal(await c.steer('run_abc123', 'mude o rumo'), true);
    assert.deepEqual(pedidos[0], { url: '/v1/runs/run_abc123/steer', body: { input: 'mude o rumo' }, auth: 'Bearer chave-de-teste' });
    status = 409; assert.equal(await c.steer('run_abc123', 'x'), false);
    status = 404; assert.equal(await c.steer('run_abc123', 'x'), false);
    status = 500; await assert.rejects(() => c.steer('run_abc123', 'x'), HermesError);
    await assert.rejects(() => c.steer('../etc', 'x'), HermesError);
    srv.close();
  });
});

describe('1) o reserva atendeu: fica no histórico', () => {
  test('o motor informa quem atendeu; se foi um modelo reserva, a atividade diz qual', async () => {
    const { h, s, motor } = await umMotor();
    await h.motors.ai(s.workspaceId).sincronizarAjustes(h.db, [s.workspaceId]);
    await h.motors.ai(s.workspaceId).defaultModel(true);
    motor.estado = { ...motor.estado, served: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' } };
    const runId = await pedido(h, s, 'resuma', 'req-reserva-0001');
    await ticks(h, 3);
    assert.equal(run(h, runId).status, 'succeeded');
    const a = auditoria(h, 'run.reserva');
    assert.equal(a.length, 1);
    assert.equal(a[0].result, 'o modelo principal não respondeu: o trabalho foi feito pelo modelo reserva anthropic/claude-sonnet-4.5');
    // o principal atendeu: nada a registrar
    motor.estado = { ...motor.estado, served: { provider: 'nous', model: 'anthropic/claude-sonnet-4.5' } };
    const outro = await pedido(h, s, 'resuma de novo', 'req-reserva-0002');
    await ticks(h, 3);
    assert.equal(run(h, outro).status, 'succeeded');
    assert.equal(auditoria(h, 'run.reserva').length, 1);
    await h.close();
  });
});

describe('4) limites e saldo da conta de IA no consumo', () => {
  test('o consumo traz o que o provedor informou (quanto resta e quando renova), guardado por alguns minutos', async () => {
    const { h, s, p } = await umMotor();
    let u = await req(h, 'GET', '/api/usage?tz=180', s);
    assert.equal(u.status, 200, JSON.stringify(u.json));
    assert.deepEqual(u.json.accounts, [{ provider: 'openai-codex', plan: 'Plus', windows: [
      { kind: 'sessao', label: 'Session', usedPercent: 12, leftPercent: 88, resetsAt: '2026-11-10T15:00:00.000Z', scope: 'conta' },
      { kind: 'semana', label: 'Weekly', usedPercent: 61, leftPercent: 39, resetsAt: '2026-11-14T10:00:00.000Z', scope: 'conta' }],
      balanceUsd: null, unlimited: false, renewsAt: null, readAt: '2026-11-10T10:00:00.000Z' }]);
    u = await req(h, 'GET', '/api/usage?tz=180', s);
    assert.equal(p.st.cotas, 1, 'a segunda tela não pergunta de novo ao provedor');
    u = await req(h, 'GET', '/api/usage?tz=180&atualizar=1', s);
    assert.equal(p.st.cotas, 2);
    assert.equal(u.json.accounts.length, 1);
    await h.close();
  });

  test('o cliente da ponte: as rotas novas, e 404 (motor de antes) vira "não se sabe"', async () => {
    const pedidos: Array<{ m: string; url: string; body: unknown }> = [];
    let antigo = false;
    const srv = http.createServer((q, res) => {
      let b = '';
      q.on('data', (c) => { b += c; });
      q.on('end', () => {
        pedidos.push({ m: q.method ?? '', url: q.url ?? '', body: b ? JSON.parse(b) : null });
        const ok = (o: unknown) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        if (antigo) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'rota não liberada pela ponte do Ergon' })); }
        if (q.url?.startsWith('/ergon/v1/ajustes')) return ok({ reserva: [], nao_treinar: true, busca_privada: false, busca_privada_disponivel: false, arrumar_competencias: false, idioma: 'pt' });
        if (q.url?.startsWith('/ergon/v1/pausa')) return ok({ pausada: q.method === 'PUT' });
        if (q.url?.startsWith('/ergon/v1/cota')) return ok({ contas: [] });
        res.writeHead(409, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: 'x' }));
      });
    });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    const c = new HttpHermesControl(`http://127.0.0.1:${(srv.address() as AddressInfo).port}`, 'token-da-ponte-de-teste-0123456789');
    assert.equal((await c.ajustes())?.naoTreinar, true);
    await c.setAjustes({ reserva: [{ provider: 'nous', model: 'a/b' }], naoTreinar: false, buscaPrivada: true, arrumarCompetencias: true, idioma: 'en' });
    assert.deepEqual(pedidos.at(-1), { m: 'PUT', url: '/ergon/v1/ajustes', body: { reserva: [{ provider: 'nous', model: 'a/b' }], nao_treinar: false, busca_privada: true, arrumar_competencias: true, idioma: 'en' } });
    await c.setAjustes({ anotarMemoria: false, raciocinio: 'modelo' });
    assert.deepEqual(pedidos.at(-1)?.body, { anotar_memoria: false, raciocinio: '' }, 'a do modelo vai como "" ao motor');
    await c.setAjustes({ naoTreinar: true });
    assert.deepEqual(pedidos.at(-1)?.body, { nao_treinar: true }, 'só o que mudou');
    assert.equal(await c.pausa(), false); assert.equal(await c.setPausa(true), true);
    assert.deepEqual(await c.cota(true), []); assert.equal(pedidos.at(-1)?.url, '/ergon/v1/cota?atualizar=1');
    antigo = true;
    assert.equal(await c.ajustes(), null); assert.equal(await c.setAjustes({ naoTreinar: true }), null);
    assert.equal(await c.pausa(), null); assert.equal(await c.setPausa(true), null); assert.equal(await c.cota(), null);
    srv.close();
  });
});
