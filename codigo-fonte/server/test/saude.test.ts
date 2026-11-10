/**
 * Saúde e diagnóstico: os quatro estados, o que cada componente olha, quem pode
 * ver, e o pacote de diagnóstico sem conteúdo do usuário (conteúdo plantado não aparece).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { scrub } from '../src/lib/log.ts';
import { diagnostics, healthPanel } from '../src/services/health.ts';
import type { HermesClient } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { addPerson, harness, req, setupOwner } from './helpers.ts';

const state = (p: { componentes: Array<{ id: string; estado: string }> }, id: string) => p.componentes.find((c) => c.id === id)?.estado;
/** o que a Saúde nunca mostra: as peças por dentro do Ergon e o erro cru de rede */
const JARGAO = /\bmotor(es)?\b|\bgerente\b|ponte de controle|cont[eê]iner|\bimagem\b|\bpodman\b|\bdocker\b|respondeu \d{3}|ECONNREFUSED|\bdele\b/i;

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
    // nome_t/detalhe_t: o mesmo texto com código (lib/textos.ts), para a tela traduzir
    const { nome_t, detalhe_t, ...noAr } = await motor();
    assert.deepEqual(noAr, { id: 'motor', nome: 'Equipe de IA', estado: 'operacional', detalhe: 'no ar · cofre aberto' });
    assert.deepEqual([nome_t, detalhe_t], [{ codigo: 'saude.nome.motor' }, { codigo: 'junto', valores: { itens: [{ codigo: 'saude.noAr' }, { codigo: 'saude.cofreAberto' }], sep: ' · ' } }]);
    ok = false; mv = { state: 'aguardando', lastError: null };
    assert.equal((await motor()).estado, 'indisponivel'); assert.match((await motor()).detalhe, /^abrindo o cofre da equipe \(a primeira vez pode levar minutos\)$/);
    mv = { state: 'erro', lastError: 'chave recusada' };
    assert.equal((await motor()).detalhe, 'o cofre da equipe não abriu: chave recusada');
    // o erro técnico do cofre (rede, gerente) não vai para a tela
    mv = { state: 'erro', lastError: 'gerente de motores respondeu 502' };
    assert.equal((await motor()).detalhe, 'o cofre da equipe não abriu');
    mv = { state: 'desligado', lastError: null };
    // o erro de rede cru (inglês, código do sistema) fica no registro: a tela diz só que está fora do ar
    assert.equal((await motor()).detalhe, 'fora do ar agora');
    for (const m of [mv, { state: 'aguardando', lastError: null }, { state: 'erro', lastError: 'connect ECONNREFUSED 10.89.0.3:8644' }]) {
      mv = m;
      const c = await motor();
      assert.doesNotMatch(`${c.nome} ${c.detalhe}`, JARGAO, c.detalhe);
    }
    await h.close();
  });

  test('disco: dentro do ambiente do Ergon diz que a medida é a dele (pode dizer mais do que o computador tem), com vírgula decimal', async () => {
    const h = await harness(); await setupOwner(h);
    const deps = { db: h.db, cfg: h.cfg, vault: h.vault, hermes: null, executorMode: () => 'simulated' as const, motorVault: () => ({ state: 'desligado', lastError: null }) };
    const painel = async (inContainer: boolean) => (await healthPanel({ ...deps, inContainer: () => inContainer })).componentes;
    const disco = async (inContainer: boolean) => (await painel(inContainer)).find((c) => c.id === 'disco')!.detalhe;
    assert.match(await disco(true), /^\d+,\d GB livres no ambiente do Ergon; o disco do computador pode ter menos \(confira no Windows\)$/);
    assert.match(await disco(false), /^\d+,\d GB livres$/);
    assert.doesNotMatch(await disco(true), JARGAO);
    // o tamanho do banco também com vírgula (0,9 MB, não 0.9 MB)
    assert.match((await painel(false)).find((c) => c.id === 'banco')!.detalhe, /^íntegro · \d+,\d MB$/);
    await h.close();
  });

  test('motor renovando, sem as Conexões ou com a renovação que voltou atrás: a tela diz a verdade', async () => {
    const h = await harness(); await setupOwner(h);
    const hermes = { health: async () => ({ ok: true, detail: 'ok' }) } as unknown as HermesClient;
    const base = { db: h.db, cfg: h.cfg, vault: h.vault, hermes, executorMode: () => 'real' as const, motorVault: () => ({ state: 'aberto', lastError: null }), inContainer: () => false };
    const ms = { estado: 'aberto' as const, erro: null, semConexoes: false, falha: null as string | null, adiada: null as string | null, versao: '9.9.9-rc.1' };
    const motor = async (x: Partial<typeof ms>, semConexoes = false) => (await healthPanel({ ...base, motor: () => ({ ...ms, ...x }), semConexoes: () => semConexoes })).componentes.find((c) => c.id === 'motor')!;
    // nome_t/detalhe_t: o mesmo texto com código (lib/textos.ts); aqui conta o português
    const { nome_t: _n, detalhe_t: _d, ...renovando } = await motor({ estado: 'renovando' as never });
    assert.deepEqual(renovando, { id: 'motor', nome: 'Equipe de IA', estado: 'limitado', detalhe: 'Atualizando a equipe para a versão 9.9.9-rc.1: os pedidos novos esperam (até 30 minutos) e seguem sozinhos quando terminar' });
    const sem = await motor({ semConexoes: true });
    const SEM_CONEXOES = 'no ar · as Conexões não estão nesta versão da equipe: os agentes ainda não conseguem usar as contas conectadas';
    assert.equal(sem.estado, 'limitado'); assert.equal(sem.detalhe, SEM_CONEXOES);
    assert.equal((await motor({}, true)).detalhe, SEM_CONEXOES, 'um motor só: pelo cache das ferramentas');
    assert.equal((await motor({})).estado, 'operacional');
    const f = await motor({ falha: 'a versão nova da equipe veio sem as Conexões' });
    assert.equal(f.estado, 'atencao'); assert.match(f.detalhe, /para a versão 9\.9\.9-rc\.1 não deu certo \(a versão nova da equipe veio sem as Conexões\); a equipe segue na versão anterior/);
    // depois de voltar atrás, nada tenta de novo nesta versão: a tela não promete "a próxima tentativa"
    assert.match(f.detalhe, /até a próxima versão do Ergon/); assert.doesNotMatch(f.detalhe, /próxima tentativa/);
    // um motivo gravado com peça interna (registro de antes) não vai cru para a tela
    const cru = await motor({ falha: 'a ponte de controle do motor não respondeu' });
    assert.match(cru.detalhe, /não deu certo \(a versão nova não passou na conferência\)/);
    // a versão nova ainda não chegou: o de antes funciona, e o sistema tenta de novo sozinho ao abrir o Ergon (ou um dia)
    const a = await motor({ adiada: 'a versão nova da equipe ainda não chegou a este computador (sem internet, ou o download não terminou)' });
    assert.equal(a.estado, 'limitado'); assert.match(a.detalhe, /atualização da equipe para a versão 9\.9\.9-rc\.1 pendente: a versão nova da equipe ainda não chegou.*o sistema tenta de novo sozinho quando o Ergon for aberto \(ou uma vez por dia/);
    assert.doesNotMatch(a.detalhe, /minutos/, 'nada de "a cada poucos minutos"');
    for (const c of [sem, f, cru, a]) assert.doesNotMatch(`${c.nome} ${c.detalhe}`, JARGAO, c.detalhe);
    await h.close();
  });

  test('cofre de conta removida: aviso com o nome que dá para mostrar; no diagnóstico, só a contagem', async () => {
    const h = await harness(); await setupOwner(h);
    const nome = `ergon_motor-${'f'.repeat(32)}`;
    const espaco = { liberavel: null, ultima: { at: new Date().toISOString(), liberado: 5e8, removidas: 2 }, volumes: [{ nome, conta: 'conta removida em 07/11/2026' }] };
    const deps = { db: h.db, cfg: h.cfg, vault: h.vault, hermes: null, executorMode: () => 'simulated' as const, motorVault: () => ({ state: 'desligado', lastError: null }), inContainer: () => false, espaco: () => espaco };
    const p = await healthPanel(deps);
    const c = p.componentes.find((x) => x.id === 'cofres')!;
    assert.equal(c.estado, 'limitado'); assert.match(c.detalhe, /1 cofre guardado \(conta removida em 07\/11\/2026\): ocupam espaço neste computador; dá para apagar, sem volta/);
    assert.equal(p.espaco?.volumes[0].nome, nome, 'a tela recebe o nome para pedir a confirmação');
    const d = JSON.stringify(await diagnostics(deps));
    assert.ok(!d.includes('f'.repeat(32)), 'o identificador da conta não vai no diagnóstico');
    assert.match(d, /"cofresSemDono":1/);
    // sem gerente (um motor só): nada de espaço na tela
    assert.equal((await healthPanel({ ...deps, espaco: () => null })).espaco, null);
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
