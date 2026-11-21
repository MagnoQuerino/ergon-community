/**
 * Modelos de entrega (rc.42, services/modelos-entrega.ts): o cartão da pessoa mostra o tipo e os itens curtos; o
 * relatório fica em "Ver detalhes". A entrega vem pela ferramenta entregar (ponte /internal/bridge/v1/entrega), validada
 * aqui: fora do modelo volta ao agente com os erros; sem ela, o card volta ao agente numa continuação curta; esgotado, o
 * formato mínimo seguro (o card #48: a frase "Para você decidir" vira itens curtos). O coordenador ajusta as partes
 * livres e restaura os originais; o essencial é travado. Motor falso, como em entrega-honesta.test.ts.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { MAX_DEVOLUCOES, PADRAO, TITULO_MAX, ajustarModelo, avisoCurto, dividirPontos, instrucaoEntregar, lerAjustes, minimoSeguro, restaurarModelos, validarEntrega, type Entrega } from '../src/services/modelos-entrega.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-0123456789';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_modelo${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'ergon_cartoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

/** O card #48, como o dono mostrou: a frase que virou parágrafo no painel. */
export const FRASE_48 = 'hoje, mandar as orientações de reemissão da NF 27 para a Acelen (é o único item que trava pagamento), liberar o acesso ao suporte@leadia.app para o Ian, fazer a sessão compartilhada da migração com o Sérgio e dizer quem assume as três pendências dele (leadcoins, advogada, nota pelo Asaas) e a cotação da Fieb que fecha segunda às 10:00.';
/** O mesmo card no modelo (o que o agente manda pela ferramenta entregar). */
export const ENTREGA_48 = {
  tipo: 'decisao',
  itens: [
    { titulo: 'NF27 da Acelen: mandar orientações de reemissão', acao: 'aprovar',
      contexto: 'E-mail de Carla (financeiro da Acelen) de 19/11, 16:42, “NF 27 recusada”: a nota saiu com o CNPJ da matriz e eles só pagam com o da filial.',
      objeto: 'NF 27, R$ 18.600,00, serviço de outubro. Rascunho pronto: cancelar a NF 27 e reemitir com o CNPJ da filial, mesmo valor e descrição.',
      riscos: { prazo: 'hoje', inacao: 'o pagamento de novembro não entra no lote de sexta da Acelen', em_jogo: 'R$ 18.600 a receber; é o único item que trava pagamento' } },
    { titulo: 'Liberar acesso ao suporte@leadia.app para Ian', acao: 'liberar',
      contexto: 'Mensagem do Ian no Teams (20/11, 09:10): começa no atendimento na segunda e precisa ler e responder a caixa compartilhada.',
      objeto: 'Acesso de leitura e envio à caixa suporte@leadia.app (Microsoft 365), sem permissão de administrador.',
      riscos: { prazo: 'segunda', inacao: 'Ian começa sem ver os 23 chamados abertos', em_jogo: 'o tempo de resposta do suporte' } },
    { titulo: 'Sessão compartilhada da migração com Sérgio', acao: 'agendar',
      contexto: 'Reunião de 18/11 (ata em Documentos › Migração): Sérgio sai de férias dia 28 e é o único que conhece o roteiro.',
      objeto: 'Uma sessão de 1 h com tela compartilhada para passar o roteiro da migração; sugeridos quarta 14:00 ou quinta 10:00.',
      riscos: { prazo: 'antes de 28/11', inacao: 'a migração fica sem ninguém que saiba o passo a passo', em_jogo: 'a migração marcada para 02/12' } },
    { titulo: '3 pendências do Sérgio: leadcoins, advogada, Asaas', acao: 'escolher',
      contexto: 'Lista que o Sérgio mandou por e-mail (20/11, 18:05) com o que fica aberto nas férias dele.',
      objeto: 'Quem assume: o ajuste dos leadcoins de outubro; o retorno à advogada sobre o contrato da Delta; a nota pelo Asaas do cliente Prisma.',
      riscos: { prazo: 'antes de 28/11', inacao: 'as três param durante as férias', em_jogo: 'o contrato da Delta e a cobrança do Prisma' } },
    { titulo: 'Cotação da FIEB: confirmar envio', acao: 'aprovar',
      contexto: 'Edital da FIEB recebido em 14/11 (Documentos › Propostas › FIEB.pdf); a cotação está pronta e espera o seu ok.',
      objeto: 'Cotação de R$ 42.300,00 para 12 meses de suporte, conforme o item 4 do edital.',
      riscos: { prazo: 'segunda, 10:00', inacao: 'a FIEB fecha a cotação sem a nossa proposta', em_jogo: 'contrato de R$ 42.300 em 12 meses' } },
  ],
};

describe('modelos de entrega: validação', () => {
  test('aceita o card #48 no modelo, com os riscos aninhados ou soltos', () => {
    const v = validarEntrega(ENTREGA_48);
    assert.equal(v.ok, true);
    const e = (v as { entrega: Extract<Entrega, { tipo: 'decisao' }> }).entrega;
    assert.equal(e.itens.length, 5);
    assert.ok(e.itens.every((x) => x.titulo.length <= TITULO_MAX));
    assert.equal(e.itens[4].riscos.prazo, 'segunda, 10:00');
    const solto = validarEntrega({ tipo: 'decisao', itens: [{ ...ENTREGA_48.itens[0], riscos: undefined, prazo: 'hoje', em_jogo: 'R$ 18.600' }] });
    assert.equal(solto.ok, true);
  });

  test('recusa o que não cabe de relance, com o erro que o agente entende', () => {
    const longo = validarEntrega({ tipo: 'decisao', itens: [{ ...ENTREGA_48.itens[0], titulo: `Ficou para você decidir: ${FRASE_48}` }] });
    assert.equal(longo.ok, false);
    assert.match((longo as { erros: string[] }).erros.join(' '), /itens\[0\]\.titulo: \d+ caracteres; o máximo é 60\. Encurte/);
    const semContexto = validarEntrega({ tipo: 'decisao', itens: [{ titulo: 'Aprovar a cotação', objeto: 'Cotação de R$ 42.300 para a FIEB', riscos: { em_jogo: 'contrato' } }] });
    assert.match((semContexto as { erros: string[] }).erros.join(' '), /itens\[0\]\.contexto: falta/);
    assert.match((validarEntrega({ tipo: 'decisao', itens: [] }) as { erros: string[] }).erros[0], /pelo menos 1/);
    assert.match((validarEntrega({ tipo: 'parágrafo' }) as { erros: string[] }).erros[0], /tipo: use um destes/);
    assert.equal(validarEntrega('Ficou para você decidir: …').ok, false, 'texto cru não é entrega');
    // os outros quatro: núcleo exigido
    assert.equal(validarEntrega({ tipo: 'relatorio', resumo: 'Caixa de novembro positivo', detalhes: 'x'.repeat(30) }).ok, false, 'relatório sem pontos');
    assert.equal(validarEntrega({ tipo: 'relatorio', resumo: 'Caixa de novembro positivo', pontos: ['Entradas R$ 61.900'], detalhes: 'x'.repeat(30) }).ok, true);
    assert.equal(validarEntrega({ tipo: 'entrega', resumo: 'Proposta da FIEB pronta', arquivos: ['Proposta.docx'], detalhes: 'x'.repeat(30) }).ok, true);
    assert.equal(validarEntrega({ tipo: 'entrega', resumo: 'x'.repeat(130), detalhes: 'x'.repeat(30) }).ok, false, 'resumo de uma linha');
    assert.equal(validarEntrega({ tipo: 'pergunta', pergunta: 'Qual CNPJ vai na NF 27?', opcoes: ['Filial', 'Matriz'], porque: 'A Acelen recusou a nota.' }).ok, true);
    assert.equal(validarEntrega({ tipo: 'pergunta', pergunta: 'Qual CNPJ vai na NF 27?', opcoes: ['a', 'b', 'c', 'd', 'e'], porque: 'A Acelen recusou a nota.' }).ok, false, 'no máximo 4 opções');
    assert.equal(validarEntrega({ tipo: 'bloqueio', motivo: 'O Asaas recusou a nota', precisa: 'Cadastrar a inscrição municipal' }).ok, true);
    assert.equal(validarEntrega({ tipo: 'bloqueio', motivo: 'O Asaas recusou a nota' }).ok, false, 'sem o que destrava');
  });

  test('o formato mínimo seguro do card #48: itens curtos, o prazo e o texto inteiro no detalhe — nunca o parágrafo', () => {
    const pontos = dividirPontos(FRASE_48);
    assert.deepEqual(pontos.map((p) => p.texto.split(' ')[0]), ['mandar', 'liberar', 'fazer', 'dizer', 'a']);
    assert.equal(pontos[4].prazo, 'segunda às 10:00');
    assert.equal(pontos[0].prazo, 'hoje', '"hoje" solto vira o prazo do ponto seguinte');
    const m = minimoSeguro({ agente: 'Hipátia', card: 48, titulo: 'Pendências da semana', corpo: '# Pendências\nTexto da entrega.', linha: { tipo: 'decidir', texto: FRASE_48 }, aprovar: true });
    assert.equal(m.tipo, 'decisao');
    const itens = (m as Extract<Entrega, { tipo: 'decisao' }>).itens;
    assert.equal(itens.length, 5);
    assert.ok(itens.every((x) => x.titulo.length <= TITULO_MAX && !x.titulo.includes('(')), itens.map((x) => x.titulo).join(' | '));
    assert.equal(itens[0].titulo, 'Mandar as orientações de reemissão da NF 27 para a Acelen');
    assert.equal(itens[0].riscos.em_jogo, 'é o único item que trava pagamento');
    assert.match(itens[4].titulo, /^A cotação da Fieb que fecha segunda às 10:00$/);
    assert.equal(itens[3].riscos.em_jogo, 'leadcoins, advogada, nota pelo Asaas');
    assert.equal(validarEntrega(m).ok, true, 'o mínimo passa no próprio modelo');
    const sem = minimoSeguro({ agente: 'Hipátia', card: 3, titulo: 'Relatório', corpo: '# Caixa de novembro\n- Entradas: R$ 61.900\n- Saídas: R$ 53.660', linha: null, aprovar: false });
    assert.equal(sem.tipo, 'relatorio');
    assert.equal(validarEntrega(sem).ok, true);
  });

  test('referências: link só do aplicativo da conexão (https), id interno que existe; citar é obrigatório quando o trabalho leu as contas', () => {
    const item = (referencias: unknown) => ({ tipo: 'decisao', itens: [{ ...ENTREGA_48.itens[0], referencias }] });
    const erro = (v: ReturnType<typeof validarEntrega>) => (v as { erros: string[] }).erros?.join(' ') ?? '';
    const ok = validarEntrega(item([{ tipo: 'email', titulo: 'NF 27 recusada', url: 'https://outlook.office.com/owa/?ItemID=AAMk1' }, { tipo: 'documento', titulo: 'FIEB.pdf', url: 'https://empresa.sharepoint.com/sites/x/FIEB.pdf' }]));
    assert.equal(ok.ok, true, erro(ok));
    assert.equal((ok as { entrega: Extract<Entrega, { tipo: 'decisao' }> }).entrega.itens[0].referencias.length, 2);
    assert.match(erro(validarEntrega(item([{ tipo: 'email', titulo: 'x1', url: 'javascript:alert(1)' }]))), /url: só o link do próprio aplicativo/);
    assert.match(erro(validarEntrega(item([{ tipo: 'email', titulo: 'x1', url: 'https://outlook.office.com.golpe.example/x' }]))), /url: só o link/);
    assert.match(erro(validarEntrega(item([{ tipo: 'email', titulo: 'x1', url: 'https://user:pw@github.com/x' }]))), /url: só o link/);
    assert.match(erro(validarEntrega(item([{ tipo: 'site', titulo: 'x1', url: 'https://github.com/x' }]))), /tipo: use/);
    assert.match(erro(validarEntrega(item([{ tipo: 'arquivo', titulo: 'Ata da migração' }]))), /falta url .* ou id/);
    const ids = new Set(['art_ata00000001']);
    assert.equal(validarEntrega(item([{ tipo: 'arquivo', titulo: 'Ata da migração', id: 'art_ata00000001' }]), {}, { idValido: (x) => ids.has(x) }).ok, true);
    assert.match(erro(validarEntrega(item([{ tipo: 'arquivo', titulo: 'Ata', id: 'art_deoutro00001' }]), {}, { idValido: (x) => ids.has(x) })), /id: não existe neste workspace/);
    assert.match(erro(validarEntrega(item(undefined), {}, { exigirReferencias: true })), /itens\[0\]\.referencias: cite o e-mail/);
    assert.match(erro(validarEntrega({ tipo: 'relatorio', resumo: 'Caixa positivo', pontos: ['Entradas'], detalhes: 'x'.repeat(30) }, {}, { exigirReferencias: true })), /^referencias: cite/);
    assert.equal(validarEntrega({ tipo: 'pergunta', pergunta: 'Qual CNPJ vai na NF 27?', porque: 'A Acelen recusou a nota.' }, {}, { exigirReferencias: true }).ok, true, 'pergunta não exige');
  });

  test('o aviso dos canais: o tipo, os itens curtos e o link dos detalhes', () => {
    const v = validarEntrega(ENTREGA_48) as { entrega: Entrega };
    const a = avisoCurto(v.entrega, { number: 48 }, 'https://ergon.test/#equipe?card=tsk_1');
    assert.match(a, /^Card #48 — Aguardando sua decisão:\n• NF27 da Acelen: mandar orientações de reemissão\n/);
    assert.match(a, /Ver detalhes: https:\/\/ergon\.test\/#equipe\?card=tsk_1$/);
    assert.ok(!a.includes('Ficou para você decidir'));
  });
});

let h: Harness; let s: Session; let motor: Motor; let agente: string; let coord: string;
const tick = async (n = 3) => { for (let i = 0; i < n; i++) await h.executor.tick(); };
const ponte = async (corpo: Record<string, unknown>) => (await req(h, 'POST', '/internal/bridge/v1/entrega', null, corpo, { 'x-ergon-bridge-token': TOKEN })).json;
async function card(titulo: string): Promise<{ task: string; sessao: string; run: string }> {
  const t = (await req(h, 'POST', '/api/tasks', s, { title: titulo, agentId: agente })).json;
  await req(h, 'PUT', `/api/tasks/${t.id}/approval`, s, { required: true });
  await req(h, 'POST', `/api/tasks/${t.id}/work`, s);
  await tick();
  const r = h.db.get<{ id: string; hermes_session_id: string }>("SELECT id, hermes_session_id FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1", t.id)!;
  return { task: t.id, sessao: r.hermes_session_id, run: r.id };
}
async function terminar(runId: string, output: string): Promise<void> {
  const remoto = h.db.get<{ hermes_run_id: string }>('SELECT hermes_run_id FROM runs WHERE id = ?', runId)!.hermes_run_id;
  motor.runs.set(remoto, { status: 'completed', output, error: null, sessionId: `sessao-${remoto}`, usage: null, model: 'nous/teste-1' });
  await tick();
}
const detalhe = async (taskId: string) => (await req(h, 'GET', `/api/tasks/${taskId}`, s)).json;
const ultimaExecucao = (taskId: string) => h.db.get<{ id: string; idempotency_key: string; hermes_session_id: string; input: string }>('SELECT id, idempotency_key, hermes_session_id, input FROM runs WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', taskId)!;
/** A continuação que pede a entrega (sem task_id: o card não fica ocupado; a chave diz de qual execução). */
const continuacao = (runId: string, n: number) => h.db.get<{ id: string; input: string; task_id: string | null }>('SELECT id, input, task_id FROM runs WHERE idempotency_key = ?', `pede-entrega-${n}-${runId}`)!;
const SAIDA = `# Pendências da semana\n\nLevantei os e-mails e as mensagens da semana. ${'Detalhe do levantamento. '.repeat(8)}\n\nPara você decidir: ${FRASE_48}`;

describe('modelos de entrega: o agente é obrigado a entregar no modelo', () => {
  beforeEach(async () => {
    motor = new Motor();
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor });
    s = await setupOwner(h);
    agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' AND coordinator = 0 ORDER BY created_at LIMIT 1", s.workspaceId)!.id;
    coord = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' AND coordinator = 1", s.workspaceId)!.id;
    h.db.run("INSERT OR REPLACE INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, 'team.persist', '0', ?)", s.workspaceId, new Date().toISOString());
  });
  afterEach(() => h.close());

  test('a instrução do card leva a ferramenta e os modelos; fora do modelo volta com os erros; no modelo, o cartão mostra os itens', async () => {
    const c = await card('Pendências da semana');
    assert.match(ultimaExecucao(c.task).input, /registre a entrega para a pessoa com a ferramenta entregar/);
    const ruim = await ponte({ session_id: c.sessao, entrega: { tipo: 'decisao', itens: [{ titulo: `Ficou para você decidir: ${FRASE_48}` }] } });
    assert.equal(ruim.ok, false); assert.equal(ruim.status, 'recusada'); assert.equal(ruim.restam, 2);
    assert.match(ruim.texto, /Corrija e chame entregar de novo/);
    assert.ok(ruim.erros.some((e: string) => /titulo: \d+ caracteres/.test(e)));
    const bom = await ponte({ session_id: c.sessao, entrega: ENTREGA_48 });
    assert.equal(bom.ok, true); assert.equal(bom.status, 'registrada');
    await terminar(c.run, SAIDA);
    const d = await detalhe(c.task);
    assert.equal(d.modelo.tipo, 'decisao'); assert.equal(d.modelo.minimo, false);
    assert.deepEqual(d.modelo.itens.map((x: { titulo: string }) => x.titulo), ENTREGA_48.itens.map((x) => x.titulo));
    assert.equal(d.modelo.entrega.itens[0].riscos.em_jogo, ENTREGA_48.itens[0].riscos.em_jogo);
    assert.ok(!h.db.get("SELECT 1 AS x FROM runs WHERE idempotency_key LIKE 'pede-entrega-%'"), 'entregou: nada a pedir de novo');
    // a sessão de outro motor (token errado) não registra nada
    assert.equal((await req(h, 'POST', '/internal/bridge/v1/entrega', null, { session_id: c.sessao, entrega: ENTREGA_48 }, { 'x-ergon-bridge-token': 'outro-token-0123456789-abcdef' })).status, 401);
  });

  test('leu as contas: a entrega sem referências volta pedindo o link; com o link do e-mail, passa', async () => {
    const c = await card('Pendências da semana');
    h.db.run(`INSERT INTO conexao_acoes (id, workspace_id, run_id, task_id, conexao, acao, risco, origem, decisao, status, created_at)
      VALUES ('cac_teste0001', ?, ?, ?, 'microsoft', 'email.buscar', 'ler', 'agente', 'direto', 'feita', ?)`, s.workspaceId, c.run, c.task, new Date().toISOString());
    const sem = await ponte({ session_id: c.sessao, entrega: ENTREGA_48 });
    assert.equal(sem.status, 'recusada');
    assert.ok(sem.erros.some((e: string) => /itens\[0\]\.referencias: cite/.test(e)));
    const com = { ...ENTREGA_48, itens: ENTREGA_48.itens.map((x, i) => ({ ...x, referencias: [{ tipo: 'email', titulo: `E-mail ${i + 1}`, url: `https://outlook.office.com/owa/?ItemID=AAMk${i}` }] })) };
    assert.equal((await ponte({ session_id: c.sessao, entrega: com })).status, 'registrada');
    await terminar(c.run, SAIDA);
    assert.equal((await detalhe(c.task)).modelo.entrega.itens[0].referencias[0].url, 'https://outlook.office.com/owa/?ItemID=AAMk0');
  });

  test('terminou sem entregar: o card volta ao agente com a instrução; ele registra na continuação e o card segue', async () => {
    const c = await card('Pendências da semana');
    await terminar(c.run, SAIDA);
    const cont = continuacao(c.run, 1);
    assert.match(cont.input, /não registrou a entrega/); assert.match(cont.input, /Acelen/, 'leva o texto que ele entregou');
    // o card não espera a continuação: já está com você, com o formato mínimo no topo
    const antes = await detalhe(c.task);
    assert.equal(antes.task.work_state, 'aguardando_aprovacao'); assert.equal(antes.modelo.minimo, true);
    assert.ok((await req(h, 'GET', '/api/decisions', s)).json.cards.some((x: { id: string }) => x.id === c.task), 'continua em "Aguardando você"');
    await tick();
    const sessao = h.db.get<{ hermes_session_id: string }>('SELECT hermes_session_id FROM runs WHERE id = ?', cont.id)!.hermes_session_id;
    assert.equal((await ponte({ session_id: sessao, entrega: ENTREGA_48 })).status, 'registrada');
    await terminar(cont.id, 'ok');
    const d = await detalhe(c.task);
    assert.equal(d.task.work_state, 'aguardando_aprovacao');
    assert.equal(d.modelo.tipo, 'decisao'); assert.equal(d.modelo.minimo, false); assert.equal(d.modelo.itens.length, 5);
  });

  test(`sem entregar em ${MAX_DEVOLUCOES} devoluções: o formato mínimo seguro (itens curtos da frase), nunca o parágrafo`, async () => {
    const c = await card('Pendências da semana');
    await terminar(c.run, SAIDA);
    for (let i = 1; i <= MAX_DEVOLUCOES; i++) {
      const cont = continuacao(c.run, i);
      await tick();
      await terminar(cont.id, 'pronto');
    }
    assert.equal(Number(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM runs WHERE idempotency_key LIKE 'pede-entrega-%'")!.n), MAX_DEVOLUCOES);
    const d = await detalhe(c.task);
    assert.equal(d.modelo.tipo, 'decisao'); assert.equal(d.modelo.minimo, true);
    assert.equal(d.modelo.itens.length, 5);
    assert.ok(d.modelo.itens.every((x: { titulo: string }) => x.titulo.length <= TITULO_MAX));
    assert.ok(d.modelo.itens.every((x: { titulo: string }) => !/Ficou para você decidir|Para você decidir/.test(x.titulo)));
  });

  test('três recusas no turno: a ferramenta para de insistir e o card segue com o mínimo, sem devolução', async () => {
    const c = await card('Pendências da semana');
    for (let i = 0; i < 2; i++) assert.equal((await ponte({ session_id: c.sessao, entrega: { tipo: 'decisao' } })).status, 'recusada');
    const terceira = await ponte({ session_id: c.sessao, entrega: { tipo: 'decisao' } });
    assert.equal(terceira.ok, true); assert.equal(terceira.status, 'minimo');
    await terminar(c.run, SAIDA);
    assert.ok(!h.db.get("SELECT 1 AS x FROM runs WHERE idempotency_key LIKE 'pede-entrega-%'"));
    assert.equal((await detalhe(c.task)).modelo.minimo, true);
  });

  test('item a item no diálogo: aprovar marca; todos aprovados aprovam o card; devolver leva a instrução ao agente', async () => {
    const c = await card('Pendências da semana');
    await ponte({ session_id: c.sessao, entrega: ENTREGA_48 });
    await terminar(c.run, SAIDA);
    const m = (await detalhe(c.task)).modelo;
    const r = await req(h, 'POST', `/api/tasks/${c.task}/entrega/decidir`, s, { entregaId: m.id, indice: 0, decisao: 'aprovado' });
    assert.equal(r.status, 200); assert.equal(r.json.decisoes['0'], 'aprovado');
    assert.equal((await detalhe(c.task)).modelo.itens[0].decisao, 'aprovado');
    assert.equal((await req(h, 'POST', `/api/tasks/${c.task}/entrega/decidir`, s, { entregaId: m.id, indice: 1, decisao: 'devolvido' })).status, 400, 'devolver pede a instrução');
    const dev = await req(h, 'POST', `/api/tasks/${c.task}/entrega/decidir`, s, { entregaId: m.id, indice: 1, decisao: 'devolvido', instrucao: 'Só leitura, sem envio.' });
    assert.equal(dev.status, 200);
    await tick();
    const nova = ultimaExecucao(c.task);
    assert.notEqual(nova.id, c.run);
    assert.match(nova.input, /Sobre o item “Liberar acesso ao suporte@leadia\.app para Ian”: Só leitura, sem envio\./);
    assert.match(nova.input, /Já aprovado pela pessoa \(mantenha\): “NF27 da Acelen/);
    // outra entrega (antiga): recusa sem decidir nada
    assert.equal((await req(h, 'POST', `/api/tasks/${c.task}/entrega/decidir`, s, { entregaId: 'ent_naoexiste000', indice: 0, decisao: 'aprovado' })).status, 409);
  });

  test('todos os itens aprovados: o card é aprovado', async () => {
    const c = await card('Pendências da semana');
    await ponte({ session_id: c.sessao, entrega: { tipo: 'decisao', itens: ENTREGA_48.itens.slice(0, 2) } });
    await terminar(c.run, SAIDA);
    const m = (await detalhe(c.task)).modelo;
    await req(h, 'POST', `/api/tasks/${c.task}/entrega/decidir`, s, { entregaId: m.id, indice: 0, decisao: 'aprovado' });
    const fim = await req(h, 'POST', `/api/tasks/${c.task}/entrega/decidir`, s, { entregaId: m.id, indice: 1, decisao: 'aprovado' });
    assert.ok(fim.json.result);
    assert.equal(Number((await detalhe(c.task)).task.completed), 1);
  });

  test('personalização pelo coordenador: ajustar pede o cartão; o essencial é travado; "volta os originais" restaura direto', async () => {
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: coord })).json;
    await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: 'Ari, nos resumos quero também o valor em R$', clientRequestId: `m-${crypto.randomUUID()}` });
    await tick();
    const sessao = h.db.get<{ hermes_session_id: string }>('SELECT hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!.hermes_session_id;
    const gestao = async (acao: string, parametros: Record<string, unknown>) => (await req(h, 'POST', '/internal/bridge/v1/gestao', null, { op: 'executar', session_id: sessao, acao, parametros }, { 'x-ergon-bridge-token': TOKEN })).json;
    const lista = (await req(h, 'POST', '/internal/bridge/v1/gestao', null, { op: 'listar', session_id: sessao, area: 'ajustes' }, { 'x-ergon-bridge-token': TOKEN })).json.texto as string;
    assert.match(lista, /modelos-entrega\.ajustar .*\(pede aprovação\)/); assert.match(lista, /modelos-entrega\.restaurar .*\(direto\)/);
    const r = await gestao('modelos-entrega.ajustar', { tipo: 'relatorio', campos: [{ chave: 'valor_rs', rotulo: 'Valor em R$', obrigatorio: true }], tom: 'direto' });
    assert.equal(r.status, 'aguardando_confirmacao');
    const p = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'gestao' AND status = 'proposed'")!;
    const ap = await req(h, 'POST', `/api/proposals/${p.id}`, s, { decision: 'apply' });
    assert.equal(ap.json.status, 'applied', JSON.stringify(ap.json));
    const aj = lerAjustes(h.db, s.workspaceId);
    assert.deepEqual(aj.relatorio?.campos, [{ chave: 'valor_rs', rotulo: 'Valor em R$', obrigatorio: true }]);
    // o campo pedido passa a ser exigido, e entra na instrução do agente
    assert.match(instrucaoEntregar(aj), /valor_rs\* = Valor em R\$/);
    const sem = validarEntrega({ tipo: 'relatorio', resumo: 'Caixa positivo', pontos: ['Entradas'], detalhes: 'x'.repeat(30) }, aj);
    assert.match((sem as { erros: string[] }).erros[0], /extras\.valor_rs: falta/);
    assert.equal(validarEntrega({ tipo: 'relatorio', resumo: 'Caixa positivo', pontos: ['Entradas'], detalhes: 'x'.repeat(30), extras: { valor_rs: 'R$ 8.240' } }, aj).ok, true);
    // o essencial: a rota recusa tirar ou trocar, pela tela ou pelo coordenador
    const tirar = await req(h, 'PUT', '/api/modelos-entrega', s, { tipo: 'decisao', remover: ['contexto'] });
    assert.equal(tirar.status, 422); assert.equal(tirar.json.code ?? tirar.json.error, 'essencial_travado');
    assert.equal((await req(h, 'PUT', '/api/modelos-entrega', s, { tipo: 'decisao', campos: [{ chave: 'riscos', rotulo: 'sem riscos' }] })).status, 422);
    assert.equal((await req(h, 'PUT', '/api/modelos-entrega', s, { tipo: 'decisao', remover: ['ver_detalhes'] })).status, 422);
    assert.throws(() => ajustarModelo(h.db, s.workspaceId, { tipo: 'pergunta', remover: ['pergunta'] }), /essencial/);
    // "Ari, volta os modelos originais"
    const volta = await gestao('modelos-entrega.restaurar', {});
    assert.equal(volta.status, 'feita', JSON.stringify(volta));
    assert.deepEqual(lerAjustes(h.db, s.workspaceId), {});
    const ativos = (await req(h, 'GET', '/api/modelos-entrega', s)).json;
    assert.equal(ativos.personalizado, false);
    assert.deepEqual(ativos.modelos.find((m: { tipo: string }) => m.tipo === 'decisao').essencial, PADRAO.decisao.porItem!.map((c) => c.chave));
    restaurarModelos(h.db, s.workspaceId);
  });
});
