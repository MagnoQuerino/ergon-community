/**
 * Saúde e diagnóstico: os quatro estados, o que cada componente olha, quem pode
 * ver, e o pacote de diagnóstico sem conteúdo do usuário (conteúdo plantado não aparece).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { scrub } from '../src/lib/log.ts';
import { healthPanel } from '../src/services/health.ts';
import type { HermesClient } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { addPerson, harness, req, setupOwner } from './helpers.ts';

const state = (p: { componentes: Array<{ id: string; estado: string }> }, id: string) => p.componentes.find((c) => c.id === id)?.estado;

describe('painel de saúde', () => {
  test('instalação nova: banco e proteção em dia; sem backup "necessita atenção"; depois do backup, só a simulação limita', async () => {
    const h = await harness(); const s = await setupOwner(h);
    const p = (await req(h, 'GET', '/api/saude', s)).json;
    assert.equal(state(p, 'banco'), 'operacional');
    assert.equal(state(p, 'cofre'), 'operacional');
    assert.equal(state(p, 'motor'), 'limitado', 'modo de simulação é dito');
    assert.equal(state(p, 'backup'), 'atencao');
    assert.equal(p.estado, 'atencao'); assert.equal(p.rotulo, 'Necessita atenção');
    assert.match(p.resumo, /nenhum backup ainda/);
    await req(h, 'POST', '/api/admin/backup', s);
    const q = (await req(h, 'GET', '/api/saude', s)).json;
    assert.equal(state(q, 'backup'), 'operacional');
    assert.equal(q.estado, 'limitado'); assert.equal(q.rotulo, 'Operacional com limitações');
    await h.close();
  });

  test('conta com erro e execução parada pedem atenção, dizendo o quê', async () => {
    const h = await harness(); const s = await setupOwner(h);
    setIntegration(h.db, s.workspaceId, 'google', { state: 'error', last_error: 'venceu', connected_at: new Date().toISOString() });
    const agent = h.db.get<{ id: string }>('SELECT id FROM agents LIMIT 1')!.id;
    h.db.run("INSERT INTO runs (id, workspace_id, agent_id, kind, status, mode, input, idempotency_key, max_attempts, created_at, started_at, lease_owner, lease_expires_at) VALUES ('run_00000000000000000000000000000001', ?, ?, 'chat', 'running', 'simulated', 'x', 'teste-parada', 2, ?, ?, 'outro', ?)",
      s.workspaceId, agent, new Date().toISOString(), new Date().toISOString(), new Date(Date.now() - 3600_000).toISOString());
    const p = (await req(h, 'GET', '/api/saude', s)).json;
    assert.equal(state(p, 'contas'), 'atencao'); assert.match(p.componentes.find((c: { id: string }) => c.id === 'contas').detalhe, /com erro: google/);
    assert.equal(state(p, 'execucoes'), 'atencao'); assert.match(p.resumo, /parada há mais de 10 min/);
    await h.close();
  });

  test('motor com cofre: no ar é operacional mesmo com o guardião em "desligado"; fora do ar, o cofre explica (achado na instalação real)', async () => {
    const h = await harness({ hermesVaultUrl: 'http://cofre.invalid:8644' }); await setupOwner(h);
    let ok = true; let mv = { state: 'desligado', lastError: null as string | null };
    const hermes = { health: async () => ({ ok, detail: ok ? 'ok' : 'connect ECONNREFUSED' }) } as unknown as HermesClient;
    const deps = { db: h.db, cfg: h.cfg, vault: h.vault, hermes, executorMode: () => 'real' as const, motorVault: () => mv, inContainer: () => false };
    const motor = async () => (await healthPanel(deps)).componentes.find((c) => c.id === 'motor')!;
    // depois de reiniciar só o Ergon: o receptor do cofre já não responde, o guardião fica "desligado", o motor responde
    assert.deepEqual(await motor(), { id: 'motor', nome: 'Motor de IA', estado: 'operacional', detalhe: 'no ar · cofre dele aberto' });
    ok = false; mv = { state: 'aguardando', lastError: null };
    assert.equal((await motor()).estado, 'indisponivel'); assert.match((await motor()).detalhe, /abrindo o cofre dele/);
    mv = { state: 'erro', lastError: 'chave recusada' };
    assert.match((await motor()).detalhe, /o cofre dele não abriu: chave recusada/);
    mv = { state: 'desligado', lastError: null };
    assert.match((await motor()).detalhe, /não responde \(connect ECONNREFUSED\)/);
    await h.close();
  });

  test('disco: dentro do Docker diz que a medida é a do disco virtual (pode dizer mais do que o computador tem)', async () => {
    const h = await harness(); await setupOwner(h);
    const deps = { db: h.db, cfg: h.cfg, vault: h.vault, hermes: null, executorMode: () => 'simulated' as const, motorVault: () => ({ state: 'desligado', lastError: null }) };
    const disco = async (inContainer: boolean) => (await healthPanel({ ...deps, inContainer: () => inContainer })).componentes.find((c) => c.id === 'disco')!.detalhe;
    assert.match(await disco(true), /^\d+\.\d GB livres no disco virtual do Docker; o disco do computador pode ter menos/);
    assert.match(await disco(false), /^\d+\.\d GB livres$/);
    await h.close();
  });

  test('só quem administra o computador vê a saúde e baixa o diagnóstico', async () => {
    const h = await harness(); const s = await setupOwner(h);
    assert.equal((await req(h, 'GET', '/api/saude', s)).status, 200);
    const outra = await addPerson(h, 'bruna', 'senha-bruna-123'); // dona do workspace dela, mas não administra
    assert.equal((await req(h, 'GET', '/api/saude', outra)).status, 403);
    assert.equal((await req(h, 'GET', '/api/saude/diagnostico', outra)).status, 403);
    await h.close();
  });
});

describe('pacote de diagnóstico', () => {
  test('leva versões, contagens, tempos e estados — e nada do conteúdo do usuário (conteúdo plantado não aparece)', async () => {
    const h = await harness(); const s = await setupOwner(h);
    await req(h, 'POST', '/api/tasks', s, { title: 'TITULO-PLANTADO-NO-QUADRO' });
    await req(h, 'POST', '/api/artifacts', s, Buffer.from('a;b\n1;2\n'), { 'content-type': 'application/octet-stream', 'x-filename': 'ARQUIVO-PLANTADO.csv', 'x-file-type': 'text/csv' });
    setIntegration(h.db, s.workspaceId, 'microsoft', { state: 'connected', account_label: 'pessoa.plantada@empresa.com', connected_at: new Date().toISOString(),
      last_error: 'falhou para pessoa.plantada@empresa.com em https://graph.microsoft.com/v1.0/me/messages?$search=PLANTADO token eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9abcdef' });
    const agent = h.db.get<{ id: string }>('SELECT id FROM agents LIMIT 1')!.id;
    h.db.run("INSERT INTO runs (id, workspace_id, agent_id, kind, status, mode, input, idempotency_key, max_attempts, created_at, started_at, finished_at, error) VALUES ('run_00000000000000000000000000000002', ?, ?, 'chat', 'failed', 'simulated', 'ENTRADA-PLANTADA', 'teste-falhou', 2, ?, ?, ?, 'o motor respondeu sobre fulano@cliente.com.br e o 11987654321')",
      s.workspaceId, agent, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    const r = await req(h, 'GET', '/api/saude/diagnostico', s);
    assert.equal(r.status, 200);
    assert.match(String(r.res.headers['content-disposition']), /attachment; filename="ergon-diagnostico-\d{4}-\d{2}-\d{2}\.json"/);
    const d = r.json; const text = JSON.stringify(d);
    for (const planted of ['TITULO-PLANTADO', 'ARQUIVO-PLANTADO', 'pessoa.plantada', 'fulano@cliente', 'ENTRADA-PLANTADA', '$search', '/me/messages', 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9', '11987654321', 'Alexandre', 'alexandre'])
      assert.ok(!text.includes(planted), `"${planted}" não pode estar no diagnóstico`);
    assert.equal(d.contagens.tarefasAbertas >= 1, true); assert.equal(d.contagens.arquivos, 1);
    assert.ok(d.banco.migracoes.length >= 18); assert.equal(d.banco.cifrado, true);
    assert.ok(d.saude.componentes.length >= 7);
    assert.match(JSON.stringify(d.integracoes), /<e-mail>.*<endereço graph\.microsoft\.com>.*<token>/);
    assert.match(JSON.stringify(d.errosRecentes), /<e-mail>.*<número>/);
    assert.ok(h.db.get("SELECT 1 FROM audit_events WHERE action = 'admin.diagnostico'"), 'baixar o diagnóstico fica na auditoria');
    await h.close();
  });

  test('limpeza dos textos: e-mail, endereço (fica só o domínio), token e número longo', () => {
    assert.equal(scrub('erro para ana@x.com.br em https://api.exemplo.com/v1/a?b=c com Bearer abcdefghijklmnopqrstuvwxyz0123 e 5511999998888'),
      'erro para <e-mail> em <endereço api.exemplo.com> com <token> e <número>');
    assert.equal(scrub('o serviço respondeu 503'), 'o serviço respondeu 503', 'mensagem comum fica como está');
  });
});
