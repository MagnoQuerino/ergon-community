/**
 * Relatório de atividade em Markdown: período, o que entra, o que nunca entra (segredos, conversa de outra pessoa),
 * os problemas no topo, as ferramentas de cada execução e o corte dito em voz alta.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { activityReport, reportPeriod, semSegredos } from '../src/services/activity-report.ts';
import { localParts } from '../src/services/routine-time.ts';
import { addPerson, harness, req, setupOwner } from './helpers.ts';

type H = Awaited<ReturnType<typeof harness>>;
const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
const ymd = (n: number) => day(n).slice(0, 10);

function plantRun(h: H, ws: string, o: { id: string; at: string; status?: string; error?: string | null; conv?: string | null; model?: string; input?: string }) {
  const agent = h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? LIMIT 1', ws)!.id;
  h.db.run(`INSERT INTO runs (id, workspace_id, agent_id, conversation_id, kind, status, mode, input, error, model, idempotency_key, max_attempts, created_at, started_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, 'real', ?, ?, ?, ?, 2, ?, ?, ?)`, o.id, ws, agent, o.conv ?? null, o.conv ? 'chat' : 'subtask', o.status ?? 'succeeded', h.db.seal(ws, o.input ?? 'pedido'), o.error ?? null, o.model ?? 'nous/teste', `k-${o.id}`, o.at, o.at, o.at);
  return agent;
}
function plantConversation(h: H, ws: string, user: string, agent: string, id: string, title: string) {
  h.db.run('INSERT INTO conversations (id, workspace_id, agent_id, owner_user_id, title, hermes_session_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, ws, agent, user, title, `s-${id}`, day(0));
}
function plantMessage(h: H, ws: string, conv: string, role: string, content: string, at: string, run: string | null = null) {
  h.db.run("INSERT INTO messages (id, workspace_id, conversation_id, role, content, mode, run_id, created_at) VALUES (?, ?, ?, ?, ?, 'real', ?, ?)", `msg_${Math.random().toString(16).slice(2)}`, ws, conv, role, h.db.seal(ws, content), run, at);
}
function plantAudit(h: H, ws: string, action: string, target: [string, string], evidence: unknown, result: string) {
  h.db.run("INSERT INTO audit_events (id, workspace_id, actor_type, action, target_type, target_id, evidence, result, created_at) VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?)",
    `aud_${Math.random().toString(16).slice(2)}`, ws, action, target[0], target[1], h.db.seal(ws, JSON.stringify(evidence)), h.db.seal(ws, result), day(1));
}
function plantAcaoFalha(h: H, ws: string, erro: string, conv: string | null = null) {
  h.db.run(`INSERT INTO conexao_acoes (id, workspace_id, conversation_id, conexao, acao, risco, origem, decisao, status, resumo, erro, created_at)
    VALUES (?, ?, ?, 'asana', 'tarefa.criar', 'organizar', 'pessoa', 'direto', 'falhou', 'Criar tarefa', ?, ?)`, `cxa_${Math.random().toString(16).slice(2)}`, ws, conv, erro, day(1));
}

describe('relatório de atividade', () => {
  test('limpa o que parece credencial e mantém o que ajuda a investigar', () => {
    const out = semSegredos([
      'Authorization: Bearer abc.def.ghi', 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJh', 'ghp_' + '0123456789abcdefghijABCDEFGHIJ012345',
      'ntn_12345678901234567890', 'https://x.test/cb?code=abc&access_token=SEGREDO123456', 'lin_api_abcdefghijklmnop1234', 'refresh_token: "MEUSEGREDO123"',
      'fale com ana@empresa.com sobre https://exemplo.com/pagina', 'run_0123456789abcdef0123456789abcdef',
    ].join('\n'));
    for (const s of ['abc.def.ghi', 'eyJhbGci', 'ghp_', 'ntn_', 'SEGREDO123456', 'lin_api_', 'MEUSEGREDO123']) assert.ok(!out.includes(s), `vazou ${s}`);
    assert.match(out, /ana@empresa\.com/); assert.match(out, /https:\/\/exemplo\.com\/pagina/); assert.match(out, /run_0123456789abcdef/);
  });

  test('período: padrão de 7 dias; datas inválidas e invertidas são recusadas', () => {
    const p = reportPeriod('America/Sao_Paulo', undefined, undefined);
    assert.ok(p.de < p.ate); assert.ok(p.from < p.to);
    assert.throws(() => reportPeriod('UTC', '2026-13-99', '2026-11-01'), /período inválido/);
    assert.throws(() => reportPeriod('UTC', '2026-11-05', '2026-11-01'), /data inicial/);
    const fuso = reportPeriod('America/Sao_Paulo', '2026-11-01', '2026-11-01');
    assert.equal(fuso.from, '2026-11-01T03:00:00.000Z'); assert.equal(fuso.to, '2026-11-02T03:00:00.000Z');
  });

  test('traz problemas, ferramentas, conversas e conexões do período, e só dele', async () => {
    const h = await harness(); const s = await setupOwner(h); const ws = s.workspaceId;
    const agent = plantRun(h, ws, { id: 'run_a', at: day(1), status: 'failed', error: 'o motor recusou por falta de crédito' });
    plantRun(h, ws, { id: 'run_b', at: day(1), status: 'failed', error: 'o motor recusou por falta de crédito' });
    plantRun(h, ws, { id: 'run_antigo', at: day(40), status: 'failed', error: 'erro de quarenta dias atrás' });
    plantConversation(h, ws, s.userId, agent, 'conv_a', 'E-mail para o Asana');
    plantRun(h, ws, { id: 'run_c', at: day(1), conv: 'conv_a', model: 'nous/modelo-x' });
    plantMessage(h, ws, 'conv_a', 'user', 'joga isso no Asana', day(1));
    plantMessage(h, ws, 'conv_a', 'agent', 'Não tenho acesso ao Asana por aqui.\n## título dentro da resposta', day(1), 'run_c');
    plantMessage(h, ws, 'conv_a', 'user', 'mensagem de quarenta dias', day(40));
    h.db.run("INSERT INTO run_tools (workspace_id, run_id, seq, tool, preview, started_at, ok) VALUES (?, 'run_c', 0, 'web_search', ?, ?, 1), (?, 'run_c', 1, 'asana_create', ?, ?, 0)",
      ws, h.db.seal(ws, 'previa boa'), day(1), ws, h.db.seal(ws, 'previa do erro'), day(1));
    h.db.run("INSERT INTO integrations (id, workspace_id, kind, state, settings, last_error, created_at) VALUES ('int_x', ?, 'asana', 'error', '{}', 'token recusado', ?)", ws, day(1));
    h.db.run("INSERT INTO audit_events (id, workspace_id, actor_type, action, evidence, result, created_at) VALUES ('aud_x', ?, 'system', 'agent.context.mensagens', ?, 'lidas', ?)",
      ws, h.db.seal(ws, JSON.stringify({ reads: ['microsoft/email/sem_permissao/0'] })), day(1));

    const r = await req(h, 'GET', `/api/activity/report?de=${ymd(7)}&ate=${ymd(0)}&conteudo=1`, s);
    assert.equal(r.status, 200);
    assert.match(String(r.res.headers['content-type']), /text\/markdown/);
    assert.match(String(r.res.headers['content-disposition']), /ergon-atividade-.*\.md/);
    const md = r.res.body;
    assert.match(md, /Para quem for ler, pessoa ou IA/);
    assert.match(md, /Cortes:\*\* nenhum/);
    assert.match(md, /\| 2 \| .* \| o motor recusou por falta de crédito \|/, 'erros iguais agrupados com a contagem');
    assert.ok(!md.includes('quarenta dias'), 'fora do período não entra');
    assert.match(md, /microsoft\/email\/sem_permissao/);
    assert.match(md, /Respostas em que o agente diz que não conseguiu/);
    assert.match(md, /Ferramentas que falharam/); assert.match(md, /asana_create/); assert.match(md, /previa do erro/);
    assert.match(md, /web_search, asana_create \(erro\)/);
    assert.match(md, /\| asana \| error \|.*token recusado/);
    assert.match(md, /> joga isso no Asana/);
    assert.match(md, /> ## título dentro da resposta/, 'a resposta do agente não vira título do relatório');
    assert.match(md, /### E-mail para o Asana/);
    assert.match(md, /nous\/modelo-x/);
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'activity.export' AND workspace_id = ?", ws), 'a exportação fica registrada');
    await h.close();
  });

  test('sem o conteúdo: fica o que aconteceu, sai o texto', async () => {
    const h = await harness(); const s = await setupOwner(h); const ws = s.workspaceId;
    const agent = plantRun(h, ws, { id: 'run_a', at: day(1), input: 'texto sigiloso do pedido' });
    plantConversation(h, ws, s.userId, agent, 'conv_a', 'Assunto reservado');
    plantRun(h, ws, { id: 'run_c', at: day(1), conv: 'conv_a' });
    plantMessage(h, ws, 'conv_a', 'user', 'conteúdo sigiloso da conversa', day(1));
    plantMessage(h, ws, 'conv_a', 'agent', 'não tenho acesso ao texto sigiloso', day(1), 'run_c');
    const md = (await req(h, 'GET', `/api/activity/report?de=${ymd(7)}&ate=${ymd(0)}&conteudo=0`, s)).res.body;
    assert.match(md, /sem o texto das conversas/); assert.match(md, /## Execuções/);
    assert.ok(!/sigilos|Assunto reservado/.test(md), 'nenhum texto das conversas');
    await h.close();
  });

  test('conversa de outra pessoa nunca entra; só quem administra vê o estado da instalação', async () => {
    const h = await harness(); const s = await setupOwner(h); const ws = s.workspaceId;
    const agent = plantRun(h, ws, { id: 'run_a', at: day(1) });
    const outra = await addPerson(h, 'outra', 'senha-comprida-da-outra-1');
    plantConversation(h, ws, outra.userId, agent, 'conv_outra', 'Conversa da outra pessoa');
    plantRun(h, ws, { id: 'run_d', at: day(1), conv: 'conv_outra', input: 'pedido da outra pessoa' });
    plantMessage(h, ws, 'conv_outra', 'user', 'segredo da outra pessoa', day(1));
    const dono = (await req(h, 'GET', `/api/activity/report?de=${ymd(7)}&ate=${ymd(0)}&conteudo=1`, s)).res.body;
    assert.ok(!/outra pessoa/.test(dono.replace('conversas de outras pessoas', '')), 'a conversa dela fica de fora');
    assert.match(dono, /\*\*Instalação:\*\*/);
    await h.close();
  });

  test('passou do teto: corta e avisa no começo', async () => {
    const h = await harness(); const s = await setupOwner(h); const ws = s.workspaceId;
    const agent = plantRun(h, ws, { id: 'run_a', at: day(1) });
    plantConversation(h, ws, s.userId, agent, 'conv_a', 'Longa');
    for (let i = 0; i < 40; i++) plantMessage(h, ws, 'conv_a', 'user', `linha ${i} ${'palavra '.repeat(300)}`, day(1));
    const r = activityReport(h.db, { workspaceId: ws, userId: s.userId, tz: 'UTC', de: ymd(7), ate: ymd(0), conteudo: true, maxBytes: 20_000 });
    assert.ok(r.stats.bytes < 25_000);
    assert.ok(r.stats.cortes.length > 0);
    assert.match(r.markdown, /Cortes:\*\* Conversas: cortado no limite/);
    assert.match(r.markdown, /## Execuções/, 'o que ajuda a investigar vem antes das conversas');
    await h.close();
  });

  test('texto muito longo é cortado dizendo quanto ficou de fora', async () => {
    const h = await harness(); const s = await setupOwner(h); const ws = s.workspaceId;
    const agent = plantRun(h, ws, { id: 'run_a', at: day(1) });
    plantConversation(h, ws, s.userId, agent, 'conv_a', 'Longa');
    plantMessage(h, ws, 'conv_a', 'user', 'y '.repeat(5000), day(1));
    const r = activityReport(h.db, { workspaceId: ws, userId: s.userId, tz: 'UTC', de: ymd(7), ate: ymd(0), conteudo: true });
    assert.match(r.markdown, /cortado aqui: mais 4\.000 caracteres/);
    await h.close();
  });
});

describe('relatório de atividade: o que fica de fora e o período usado', () => {
  // formatos de credencial das conexões: um por conector (falsos, montados por partes para a proteção de push não barrar) (a pessoa cola no chat para perguntar algo e exporta com o conteúdo)
  const formatos: Array<[string, string, string]> = [
    ['bot do Telegram', '123456789:AAFabcdefghijklmnopqrstuvwxyz012345', 'AAFabcdefghij'],
    ['GitLab', 'glpat-abcdefghij0123456789', 'glpat-'],
    ['Asaas', '$aact_YTU5YTE0M2M2N2I4MTliNzk0YTI5N2U5MzdjNWZmNDQ6OjAwMDAw', '$aact_'],
    ['HubSpot', ['pat', 'na1', '12345678-90ab-cdef-1234-567890abcdef'].join('-'), 'pat-na1-'],
    ['Slack (app)', 'xapp-1-A0123456789-1234567890123-abcdef0123456789', 'xapp-'],
    ['Asana', ['2', '1204567890123456', '1209876543210987:0123456789abcdef0123456789abcdef'].join('/'), '1209876543210987'],
    ['Todoist e Pipedrive (40 hex)', '0123456789abcdef0123456789abcdef01234567', '0123456789abcdef0123'],
    ['Discord', ['MTIzNDU2Nzg5MDEyMzQ1Njc4', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('.'), 'MTIzNDU2Nzg5'],
    ['Trello (key=)', 'https://api.trello.com/1/cards?key=0123456789abcdef0123456789abcdef&idList=1', '0123456789abcdef'],
    ['Basic', 'Authorization: Basic dXNlcjpzZW5oYS1jb21wcmlkYQ==', 'dXNlcjpz'],
  ];
  for (const [nome, segredo, pedaco] of formatos) {
    test(`limpa credencial colada: ${nome}`, () => {
      const out = semSegredos(`a chave é ${segredo} e o horário 12:30 com ana@empresa.com`);
      assert.ok(!out.includes(pedaco), `vazou: ${out}`);
      assert.match(out, /<oculto>/);
      assert.match(out, /12:30 com ana@empresa\.com/, 'o resto do texto fica');
    });
  }
  test('o que ajuda a investigar continua: ids, horários, telefones e texto comum', () => {
    const s = 'run_0123456789abcdef0123456789abcdef às 2026-11-07T10:20:30.000Z para 5511999990000@s.whatsapp.net · Basic Training · key=curta';
    assert.equal(semSegredos(s), s);
  });

  test('período: dia que não existe é recusado; data final adiante vai até amanhã; mais de 90 dias fica nos 90 finais', () => {
    assert.throws(() => reportPeriod('America/Sao_Paulo', '2026-02-31', '2026-02-31'), /período inválido/);
    assert.throws(() => reportPeriod('America/Sao_Paulo', '2026-02-29', '2026-03-01'), /período inválido/);
    assert.equal(reportPeriod('UTC', '2024-02-29', '2024-02-29').from, '2024-02-29T00:00:00.000Z');
    const amanha = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const longe = reportPeriod('UTC', ymd(3), '9999-12-31');
    assert.equal(longe.ate, amanha); assert.ok(longe.to.startsWith('2'), 'fim do período em data comparável');
    assert.match(longe.ajustes.join(' '), /9999-12-31/);
    assert.throws(() => reportPeriod('UTC', '9999-01-01', '9999-12-31'), /ainda não começou/);
    const longo = reportPeriod('UTC', '2020-01-01', ymd(0));
    assert.equal(longo.de, ymd(89)); assert.match(longo.ajustes.join(' '), /no máximo 90 dias/);
    assert.deepEqual(reportPeriod('UTC', ymd(6), ymd(0)).ajustes, []);
  });

  test('período: o dia começa no primeiro instante da data local, mesmo com troca de horário à meia-noite', () => {
    const casos: Array<[string, string, string]> = [
      ['America/Havana', '2026-03-08', '2026-03-08T05:00:00.000Z'], // a meia-noite não existe: o dia começa à 01:00
      ['America/Santiago', '2026-09-06', '2026-09-06T04:00:00.000Z'],
      ['America/Havana', '2026-11-01', '2026-11-01T04:00:00.000Z'], // a meia-noite se repete: vale a primeira
      ['America/Sao_Paulo', '2026-11-01', '2026-11-01T03:00:00.000Z'],
    ];
    for (const [tz, dia, inicio] of casos) {
      const p = reportPeriod(tz, dia, dia);
      assert.equal(p.from, inicio, `${tz} ${dia}`);
      const [y, m, d] = dia.split('-').map(Number);
      const antes = localParts(tz, Date.parse(p.from) - 1); const ja = localParts(tz, Date.parse(p.from));
      assert.deepEqual([ja.y, ja.m, ja.d], [y, m, d]); assert.notDeepEqual([antes.y, antes.m, antes.d], [y, m, d]);
    }
    const longo = reportPeriod('America/Santiago', '2026-04-04', '2026-04-04');
    assert.equal((Date.parse(longo.to) - Date.parse(longo.from)) / 3_600_000, 25, 'o dia de 25 horas inteiro');
  });

  test('período ajustado: o relatório diz o que usou, no cabeçalho e no nome do arquivo', async () => {
    const h = await harness(); const s = await setupOwner(h); const ws = s.workspaceId;
    plantRun(h, ws, { id: 'run_a', at: day(1), status: 'failed', error: 'falha de ontem' });
    const r = await req(h, 'GET', `/api/activity/report?de=${ymd(3)}&ate=9999-12-31`, s);
    assert.equal(r.status, 200);
    assert.match(r.res.body, /falha de ontem/, 'os dados do período aparecem');
    assert.match(r.res.body, /\*\*Período:\*\* .*9999-12-31.*ainda não chegou/);
    assert.ok(!String(r.res.headers['content-disposition']).includes('9999'));
    await h.close();
  });

  test('sem o parâmetro, sem conteúdo: das ações nas contas e do envio dos quadros ficam conexão, ação e estado', async () => {
    const h = await harness(); const s = await setupOwner(h); const ws = s.workspaceId;
    const agent = plantRun(h, ws, { id: 'run_a', at: day(1) });
    plantConversation(h, ws, s.userId, agent, 'conv_a', 'Assunto reservado');
    plantMessage(h, ws, 'conv_a', 'user', 'conteúdo reservado da conversa', day(1));
    plantAudit(h, ws, 'conexao.acao', ['integration', 'microsoft'], { acao: 'agenda.criar', run: null }, 'Compromisso criado; convite enviado para medico@clinica.com');
    plantAudit(h, ws, 'conexao.acao.error', ['integration', 'asana'], { acao: 'tarefa.criar', erro: 'caixa medico@clinica.com recusou', run: null }, 'caixa medico@clinica.com recusou');
    plantAudit(h, ws, 'mirror.push.error', ['task', 'tsk_sem_quadro'], { op: 'criar', erro: 'anexo salario.pdf recusado' }, 'Não foi enviado ao aplicativo: anexo salario.pdf recusado');
    plantAcaoFalha(h, ws, 'caixa medico@clinica.com recusou');
    // a decisão num cartão pedido por um card (app.ts devolverAoCard): o resultado repete o resumo da ação
    plantAudit(h, ws, 'task.conexao', ['task', 'tsk_card_a'], { paraAgente: 'a pessoa confirmou' }, 'Você confirmou: Microsoft: Enviar e-mail para medico@clinica.com, assunto "Laudo de Ana". Resultado: E-mail enviado para medico@clinica.com.');
    plantAudit(h, ws, 'task.conexao', ['task', 'tsk_card_b'], { paraAgente: 'a pessoa recusou' }, 'Você recusou: Microsoft: Enviar e-mail para medico@clinica.com');
    plantAudit(h, ws, 'task.conexao', ['task', 'tsk_card_c'], { paraAgente: 'falhou' }, 'Você confirmou, mas não deu: Microsoft: Enviar e-mail para medico@clinica.com (caixa cheia)');
    // ação que ninguém pôs na lista: sem o conteúdo, o texto dela não sai
    plantAudit(h, ws, 'task.result', ['task', 'tsk_card_d'], {}, 'entrega aceita: o laudo de Ana foi para medico@clinica.com');
    // texto fixo: continua
    plantAudit(h, ws, 'integration.connect', ['integration', 'asana'], {}, 'conectado (conferido no serviço)');

    const sem = (await req(h, 'GET', `/api/activity/report?de=${ymd(7)}&ate=${ymd(0)}`, s)).res.body;
    assert.match(sem, /sem o texto das conversas/);
    assert.ok(!/medico@clinica|salario\.pdf|reservad|Laudo|laudo/.test(sem), 'nada do texto das ações nem das conversas');
    assert.match(sem, /microsoft · agenda\.criar · feita/); assert.match(sem, /asana · tarefa\.criar · falhou/); assert.match(sem, /aplicativo · criar · falhou/);
    assert.match(sem, /asana tarefa\.criar · .*: falhou/);
    assert.match(sem, /task\.conexao \| task \| card tsk_card_a · cartão de confirmação · confirmada \|/);
    assert.match(sem, /card tsk_card_b · cartão de confirmação · recusada/); assert.match(sem, /card tsk_card_c · cartão de confirmação · falhou/);
    assert.match(sem, /task\.result \| task \| tsk_card_d · sem o texto \|/);
    assert.match(sem, /integration\.connect \| integration \| conectado \(conferido no serviço\) \|/);
    assert.match(sem, /Credenciais:\*\* as guardadas nunca entram/);
    const ev = h.db.get<{ evidence: string }>("SELECT evidence FROM audit_events WHERE action = 'activity.export' AND workspace_id = ?", ws)!;
    assert.equal(JSON.parse(ev.evidence).conteudo, false);

    const com = (await req(h, 'GET', `/api/activity/report?de=${ymd(7)}&ate=${ymd(0)}&conteudo=1`, s)).res.body;
    assert.match(com, /convite enviado para medico@clinica\.com/); assert.match(com, /conteúdo reservado da conversa/);
    assert.match(com, /Você confirmou: Microsoft: Enviar e-mail para medico@clinica\.com/); assert.match(com, /entrega aceita: o laudo de Ana/);
    assert.match(com, /colado numa conversa.*revise/);
    await h.close();
  });

  test('conversa de outra pessoa: nem o erro, nem a prévia da ferramenta, nem o resultado da ação', async () => {
    const h = await harness(); const s = await setupOwner(h); const ws = s.workspaceId;
    const agent = plantRun(h, ws, { id: 'run_a', at: day(1) });
    const outra = await addPerson(h, 'outra', 'senha-comprida-da-outra-1');
    plantConversation(h, ws, outra.userId, agent, 'conv_outra', 'Conversa dela');
    plantRun(h, ws, { id: 'run_d', at: day(1), conv: 'conv_outra', status: 'failed', error: 'Falhou ao ler o anexo salario-da-Outra.pdf' });
    // execução dela que começou antes do período, com a ferramenta falhando já dentro dele
    plantRun(h, ws, { id: 'run_antes', at: day(9), conv: 'conv_outra' });
    h.db.run("INSERT INTO run_tools (workspace_id, run_id, seq, tool, preview, started_at, ok) VALUES (?, 'run_antes', 0, 'arquivo_ler', ?, ?, 0)", ws, h.db.seal(ws, 'PREVIA-SIGILOSA'), day(1));
    plantAcaoFalha(h, ws, 'caixa medico@clinica.com recusou', 'conv_outra');
    plantAudit(h, ws, 'conexao.acao', ['integration', 'microsoft'], { acao: 'agenda.criar', run: 'run_d' }, 'convite enviado para medico@clinica.com');
    plantAudit(h, ws, 'conexao.acao', ['integration', 'microsoft'], { acao: 'agenda.criar', run: 'run_antes' }, 'convite enviado para medico2@clinica.com');

    const md = (await req(h, 'GET', `/api/activity/report?de=${ymd(7)}&ate=${ymd(0)}&conteudo=1`, s)).res.body;
    assert.ok(!/salario-da-Outra|medico2?@clinica|PREVIA-SIGILOSA/.test(md), 'nada do que veio da conversa dela');
    assert.match(md, /erro em conversa de outra pessoa/);
    assert.match(md, /arquivo_ler/, 'a ferramenta que falhou continua contada');
    await h.close();
  });

  test('carrega só o que vai ao arquivo: pedido e resposta só dos cards, mensagens por páginas até o teto', async () => {
    const h = await harness(); const s = await setupOwner(h); const ws = s.workspaceId;
    const agent = plantRun(h, ws, { id: 'run_card', at: day(1), input: 'pedido do card' });
    plantConversation(h, ws, s.userId, agent, 'conv_a', 'Longa');
    for (let i = 0; i < 30; i++) plantRun(h, ws, { id: `run_chat_${i}`, at: day(1), conv: 'conv_a', input: 'pedido do chat que não vai ao arquivo' });
    for (let i = 0; i < 300; i++) plantMessage(h, ws, 'conv_a', 'user', `linha ${i} ${'palavra '.repeat(250)}`, day(1));
    const lidas: Array<{ sql: string; rows: Array<Record<string, unknown>> }> = [];
    const orig = h.db.all.bind(h.db);
    (h.db as unknown as { all: typeof orig }).all = ((sql: string, ...p: never[]) => { const r = orig(sql, ...p); lidas.push({ sql, rows: r as Array<Record<string, unknown>> }); return r; }) as typeof orig;
    const r = activityReport(h.db, { workspaceId: ws, userId: s.userId, tz: 'UTC', de: ymd(7), ate: ymd(0), conteudo: true, maxBytes: 20_000 });
    (h.db as unknown as { all: typeof orig }).all = orig;
    assert.match(r.markdown, /> pedido do card/);
    assert.match(r.markdown, /Cortes:\*\* .*Conversas: cortado no limite/);
    assert.equal(r.stats.mensagens, 300, 'o resumo conta todas');
    const mensagens = lidas.filter((x) => /FROM messages/.test(x.sql)).reduce((n, x) => n + x.rows.length, 0);
    assert.ok(mensagens < 300, `leu ${mensagens} mensagens para um arquivo de 20 KB`);
    assert.ok(!lidas.some((x) => x.rows.some((row) => typeof row.input === 'string' && row.input.includes('pedido do chat'))), 'pedido das conversas não é lido');
    await h.close();
  });

  test('a triagem de "não consegui" lê só as respostas mais recentes, e a descrição dos cards nem é lida', async () => {
    const h = await harness(); const s = await setupOwner(h); const ws = s.workspaceId;
    const agent = plantRun(h, ws, { id: 'run_a', at: day(1) });
    plantConversation(h, ws, s.userId, agent, 'conv_a', 'Muitas respostas');
    plantMessage(h, ws, 'conv_a', 'agent', 'Não tenho acesso ao Asana: RESPOSTA-ANTIGA', day(3));
    for (let i = 0; i < 2000; i++) plantMessage(h, ws, 'conv_a', 'agent', `resposta comum ${i}`, day(2));
    plantMessage(h, ws, 'conv_a', 'agent', 'Não tenho acesso ao Asana: RESPOSTA-RECENTE', day(1));
    assert.equal((await req(h, 'POST', '/api/tasks', s, { title: 'card do período', description: 'DESCRICAO-QUE-NAO-VAI' })).status, 201);
    const lidas: Array<{ sql: string; rows: Array<Record<string, unknown>> }> = [];
    const orig = h.db.all.bind(h.db);
    (h.db as unknown as { all: typeof orig }).all = ((sql: string, ...p: never[]) => { const r = orig(sql, ...p); lidas.push({ sql, rows: r as Array<Record<string, unknown>> }); return r; }) as typeof orig;
    const r = activityReport(h.db, { workspaceId: ws, userId: s.userId, tz: 'UTC', de: ymd(7), ate: ymd(0), conteudo: true });
    (h.db as unknown as { all: typeof orig }).all = orig;
    const triagem = r.markdown.slice(r.markdown.indexOf('**Respostas em que o agente diz que não conseguiu**'));
    const bloco = triagem.slice(0, triagem.indexOf('\n## '));
    assert.match(bloco, /RESPOSTA-RECENTE/);
    assert.ok(!bloco.includes('RESPOSTA-ANTIGA'), 'a resposta além do teto não entra na triagem');
    assert.match(r.markdown, /Cortes:\*\* .*procuradas nas 2\.000 respostas mais recentes do período/);
    const respostas = lidas.filter((x) => /m\.role = 'agent'/.test(x.sql)).reduce((n, x) => n + x.rows.length, 0);
    assert.ok(respostas <= 2001, `leu ${respostas} respostas na triagem`);
    assert.ok(!lidas.some((x) => x.rows.some((row) => Object.values(row).some((v) => typeof v === 'string' && v.includes('DESCRICAO-QUE-NAO-VAI')))), 'a descrição dos cards não é lida');
    assert.match(r.markdown, /card do período/, 'o card entra pelo título');
    await h.close();
  });
});
