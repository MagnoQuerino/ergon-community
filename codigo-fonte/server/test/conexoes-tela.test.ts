/**
 * A tela de Conexões fala com a pessoa, não com o agente: rótulo curto em vez do texto de uso, permissão que falta dita
 * sem o nome técnico e apontando o botão, desconectar dizendo o que de fato acontece, a ajuda sem JSON nem endereço no
 * meio dos passos, e o que a tela precisa vindo junto (abre pronta). Os textos de tela que prometiam o que o sistema não
 * faz ("só leitura", "nunca sozinhos", espelho de uma mão só) ficam guardados aqui.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { addPerson, harness, req, setupOwner, type Harness, type Session } from './helpers.ts';
import { INTEGRATIONS, setIntegration } from '../src/services/integrations.ts';
import { acoesDe } from '../src/services/conexoes/catalogo.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { risksAccepted, WA_RISKS_VERSION } from '../src/services/whatsapp.ts';
import { CATALOG } from '../src/services/routine-catalog.ts';
import { CHARACTERS, grantConnectionsTool } from '../src/services/characters.ts';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
/**
 * Na cópia Community (COMMUNITY.json na raiz do código) o código fica em codigo-fonte/, e os guias e o README público (o de
 * community/publico/) ficam uma pasta acima: lê o mesmo texto de lá.
 */
const EXPORTADA = fs.existsSync(path.join(RAIZ, 'COMMUNITY.json'));
const ler = (rel: string) => {
  if (!EXPORTADA) return fs.readFileSync(path.join(RAIZ, rel), 'utf8');
  if (rel.startsWith('community/publico/')) return fs.readFileSync(path.join(RAIZ, '..', rel.slice('community/publico/'.length)), 'utf8');
  return fs.readFileSync(fs.existsSync(path.join(RAIZ, rel)) ? path.join(RAIZ, rel) : path.join(RAIZ, '..', rel), 'utf8');
};
/** os guias (docs/ e o README público) não vão para a imagem de teste do Docker: lá os testes de texto pulam */
const COM_GUIAS = (() => { try { ler('docs/CONEXOES.md'); ler('community/publico/README.md'); return true; } catch { return false; } })();
/** o que é para o agente: parâmetro, id, nome de outra ação, prefixo de token, linguagem de consulta */
const JARGAO = /\b(ids?|jid|token|xoxp|xoxb|cql|jql|oauth|cursor)\b|\b[a-z]+\.[a-z_]+\b|=|_|https?:/i;

/** um token de app do Slack de teste (montado em partes: a varredura de segredos procura o formato inteiro) */
const SLACK = ['xoxb', '1', '2', 'abcdefghijklmnop'].join('-');
const realFetch = globalThis.fetch;
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
before(() => {
  setHttpClock({ sleep: async () => undefined, jitter: () => 1 });
  // nada sai daqui: Slack e Microsoft recusam por falta de permissão; o resto nem tem rota
  globalThis.fetch = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    if (u.host === 'slack.com') return json({ ok: false, error: 'missing_scope', needed: 'channels:history' });
    if (u.host === 'graph.microsoft.com') return json({ error: { code: 'Forbidden', message: 'Missing scope permissions on the request. API requires one of Mail.Read' } }, 403);
    if (u.host === 'app.asana.com') return json({ data: { name: 'Ana Empresa' } });
    throw new TypeError(`rota não simulada: ${String(input)}`);
  }) as typeof fetch;
});
after(() => { globalThis.fetch = realFetch; setHttpClock(null); });

let h: Harness; let s: Session;
beforeEach(async () => { h = await harness({ msClientId: 'app-de-teste' }); s = await setupOwner(h); });
afterEach(() => h.close());
const ligar = (ws: string, kind: string, creds: Record<string, unknown>, conta: string) => {
  h.integrations.secrets.writeOwn(ws, kind as never, creds);
  setIntegration(h.db, ws, kind as never, { state: 'connected', account_label: conta, connected_at: new Date().toISOString() });
};
const item = async (kind: string, sess = s) => (await req(h, 'GET', '/api/integrations', sess)).json.find((i: { kind: string }) => i.kind === kind);

describe('o que a pessoa lê sobre cada ação', () => {
  test('toda ação tem um texto para a pessoa sem jargão; o texto de uso continua indo ao agente', () => {
    const achados: string[] = [];
    for (const d of INTEGRATIONS.filter((x) => x.auth !== 'soon')) {
      for (const a of acoesDe(d.kind)) if (JARGAO.test(a.rotulo ?? a.descricao)) achados.push(`${d.kind} ${a.id}: ${a.rotulo ?? a.descricao}`);
    }
    assert.deepEqual(achados, []);
    const lerCanal = acoesDe('slack').find((a) => a.id === 'slack.ler')!;
    assert.match(lerCanal.descricao, /slack\.pessoas/, 'o agente ainda sabe onde achar os nomes');
    assert.doesNotMatch(lerCanal.rotulo!, /\bid\b|slack\./);
  });

  test('Conexões mostra o rótulo; a lista do agente, o texto de uso', async () => {
    ligar(s.workspaceId, 'slack', { token: SLACK }, 'App no Slack de Time');
    const eu = (await req(h, 'GET', '/api/conexoes', s)).json.ligadas.find((x: { kind: string }) => x.kind === 'slack');
    const pessoas = eu.acoes.find((a: { id: string }) => a.id === 'slack.pessoas');
    assert.equal(pessoas.rotulo, 'lista as pessoas do espaço de trabalho');
    assert.equal(pessoas.descricao, undefined, 'o texto do agente não vai para a tela');
    assert.match(h.conexoes.listar(s.workspaceId, 'slack'), /slack\.pessoas: lista as pessoas do espaço de trabalho, com nome e id/);
  });
});

describe('Testar conexão', () => {
  test('credencial sem permissão: o teste aponta o botão, sem o nome técnico, e o problema fica à vista na tela', async () => {
    ligar(s.workspaceId, 'slack', { token: SLACK }, 'App no Slack de Time');
    const todos = (await req(h, 'POST', '/api/conexoes/slack/testar', s, {})).json.itens as Array<{ nome: string; ok: boolean; detalhe: string }>;
    // a última linha não é uma ação: diz se a equipe consegue usar a conexão (o teste roda no servidor, a equipe usa pelo motor)
    const equipe = todos.at(-1)!;
    assert.equal(equipe.nome, 'a equipe usar esta conexão');
    assert.equal(equipe.ok, false); assert.match(equipe.detalhe, /a equipe ainda não consegue usar: a ferramenta Conexões está desligada/);
    const itens = todos.slice(0, -1);
    assert.ok(itens.length > 0);
    for (const x of itens) {
      assert.equal(x.ok, false);
      assert.equal(x.detalhe, 'falta autorizar de novo: use o botão "Autorizar de novo", acima', x.nome);
      assert.doesNotMatch(x.nome, JARGAO, 'o nome é o rótulo');
    }
    // conectada e com problema: a tela mostra o erro (e, por token, o "Autorizar de novo" que cola outra credencial)
    const i = await item('slack');
    assert.equal(i.state, 'connected');
    assert.ok(i.error, 'o último problema vem junto da conexão conectada');
  });

  test('uma leitura sem permissão e a seguinte ok: o problema continua à vista até a mesma ação dar certo', async () => {
    const antes = globalThis.fetch;
    let canais = false;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = new URL(String(input));
      if (u.pathname.endsWith('/conversations.list') && !canais) return json({ ok: false, error: 'missing_scope', needed: 'channels:read' });
      return json({ ok: true, members: [], channels: [], messages: { matches: [] }, response_metadata: {} });
    }) as typeof fetch;
    try {
      ligar(s.workspaceId, 'slack', { token: SLACK }, 'App no Slack de Time');
      const itens = (await req(h, 'POST', '/api/conexoes/slack/testar', s, {})).json.itens as Array<{ nome: string; ok: boolean; detalhe: string }>;
      assert.ok(itens.some((x) => !x.ok && x.detalhe.startsWith('falta autorizar de novo')), 'o teste aponta o botão');
      assert.ok(itens.some((x) => x.ok), 'a leitura seguinte deu certo');
      assert.ok((await item('slack')).error, 'o sucesso de outra ação não apaga a permissão recusada');
      canais = true;
      await req(h, 'POST', '/api/conexoes/slack/testar', s, {});
      assert.equal((await item('slack')).error, null, 'a mesma ação deu certo: o problema sai');
    } finally { globalThis.fetch = antes; }
  });

  test('permissão recusada ao preparar a ação de um agente: o sucesso de outra ação não apaga o problema', async () => {
    const PONTE = 'token-da-ponte-de-teste-0123456789';
    const motor: HermesClient & { runs: Map<string, RemoteRun> } = {
      runs: new Map(),
      async health() { return { ok: true, detail: 'teste' }; },
      async startRun(_p: StartRun) { const runId = `run_teste${String(this.runs.size + 1).padStart(6, '0')}`; this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null }); return { runId, replayed: false }; },
      async getRun(id: string) { return this.runs.get(id)!; },
      async stop() { return { accepted: true, detail: 'ok' }; },
      async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; },
      async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; },
    };
    const h2 = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: PONTE }, { hermes: motor });
    const antes = globalThis.fetch;
    // o app do Slack lê os canais, mas não a lista de pessoas (users:read)
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith('/users.list')) return json({ ok: false, error: 'missing_scope', needed: 'users:read' });
      return json({ ok: true, members: [], channels: [{ id: 'C1', name: 'geral', is_member: true }], response_metadata: {} });
    }) as typeof fetch;
    try {
      const s2 = await setupOwner(h2);
      const agente = h2.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s2.workspaceId)!.id;
      h2.integrations.secrets.writeOwn(s2.workspaceId, 'slack', { token: SLACK });
      setIntegration(h2.db, s2.workspaceId, 'slack', { state: 'connected', account_label: 'App no Slack de Time', connected_at: new Date().toISOString() });
      const conv = (await req(h2, 'POST', '/api/conversations', s2, { agentId: agente })).json;
      await req(h2, 'POST', `/api/conversations/${conv.id}/messages`, s2, { text: 'mande oi para a Ana no Slack', clientRequestId: `m-${crypto.randomUUID()}` });
      for (let i = 0; i < 3; i++) await h2.executor.tick();
      const sessao = h2.db.get<{ hermes_session_id: string }>('SELECT hermes_session_id FROM runs WHERE conversation_id = ?', conv.id)!.hermes_session_id;
      const ex = async (acao: string, parametros: Record<string, unknown>) =>
        (await req(h2, 'POST', '/internal/bridge/v1/conexoes', null, { op: 'executar', session_id: sessao, conexao: 'slack', acao, parametros }, { 'x-ergon-bridge-token': PONTE })).json;
      const slack = async () => (await req(h2, 'GET', '/api/integrations', s2)).json.find((i: { kind: string }) => i.kind === 'slack');
      const d = await ex('slack.direta', { pessoa: 'Ana Souza', texto: 'oi' }); // o nome vira id no preparar, que lê a lista de pessoas
      assert.equal(d.autorizar, true, JSON.stringify(d));
      const problema = (await slack()).error;
      assert.match(problema ?? '', /users:read/);
      assert.equal((await ex('slack.canais', {})).ok, true);
      assert.equal((await slack()).error, problema, 'o "Autorizar de novo" continua na tela');
    } finally { globalThis.fetch = antes; await h2.close(); }
  });

  test('a tela mostra "Autorizar de novo" quando o teste aponta falta de permissão', () => {
    const tela = ler('web/src/views/ConexoesView.tsx');
    assert.match(tela, /faltouNoTeste/);
    assert.match(tela, /\(i\.error \|\| autorizar\)/, 'por token');
    assert.match(tela, /faltam\.length > 0 \|\| !!i\.error \|\| autorizar/, 'no login com a conta');
  });

  test('conta Microsoft sem as permissões novas: nenhuma permissão crua; sem lista, a escrita testa só o rascunho', async () => {
    ligar(s.workspaceId, 'microsoft', { access_token: 'acesso', refresh_token: 'renova', expires_at: Date.now() + 3_600_000, granted: 'User.Read Tasks.ReadWrite', account: 'ana@empresa.com' }, 'ana@empresa.com');
    const itens = (await req(h, 'POST', '/api/conexoes/microsoft/testar', s, { escrita: true })).json.itens as Array<{ nome: string; ok: boolean; detalhe: string }>;
    const crus = itens.filter((x) => /https?:|Mail\.|Calendars\.|Files\.|Chat\.|Channel|scope/i.test(x.detalhe));
    assert.deepEqual(crus, []);
    assert.ok(itens.some((x) => x.detalhe.startsWith('falta autorizar de novo')));
    assert.ok(itens.some((x) => x.nome === 'deixar um rascunho de teste na sua caixa'), 'sem lista, roda o rascunho assim mesmo');
    assert.ok(!itens.some((x) => x.nome === 'criar uma tarefa de teste'), 'sem lista, a Microsoft não cria tarefa');
    assert.ok(!itens.some((x) => /o id muda|email\.apagar/.test(x.nome)), 'o nome é o rótulo');
  });
});

describe('o que vem junto da lista de conexões', () => {
  test('desconectar onde a credencial mora: a tela sabe quem continua usando', async () => {
    ligar(s.workspaceId, 'asana', { token: 'tok-da-empresa-123456' }, 'Ana Empresa');
    const a = s.workspaceId;
    const b = (await req(h, 'POST', '/api/workspaces', s, { name: 'Pessoal' })).json.workspaceId;
    // o workspace novo já traz a conta do outro, sem a tela pedir de novo
    const antes = await item('asana');
    assert.deepEqual(antes.reutilizaveis.map((c: { workspaceId: string; conta: string }) => [c.workspaceId, c.conta]), [[a, 'Ana Empresa']]);
    assert.equal((await req(h, 'POST', '/api/conexoes/asana/usar-de', s, { workspaceId: a })).status, 200);
    const emprestada = await item('asana');
    assert.ok(emprestada.sharedFrom);
    assert.deepEqual(emprestada.reutilizaveis, []);
    await req(h, 'POST', '/api/session/workspace', s, { workspaceId: a });
    assert.deepEqual((await item('asana')).usadaEm, ['Pessoal']);
    assert.ok(b);
    // quem também é do workspace, sem ser o dono, não vê os nomes dos outros workspaces do dono
    const membro = await addPerson(h, 'membro', 'senha-comprida-do-membro-1');
    h.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)", a, membro.userId, new Date().toISOString());
    assert.equal((await req(h, 'POST', '/api/session/workspace', membro, { workspaceId: a })).status, 200);
    const vista = await item('asana', membro);
    assert.equal(vista.state, 'connected');
    assert.deepEqual(vista.usadaEm, []);
  });

  test('a conta de outra pessoa nunca aparece para usar', async () => {
    ligar(s.workspaceId, 'asana', { token: 'tok-da-empresa-123456' }, 'Ana Empresa');
    const outra = await addPerson(h, 'outra', 'senha-comprida-da-outra-1');
    assert.deepEqual((await item('asana', outra)).reutilizaveis, []);
  });

  test('campo opcional em branco: a tela não manda, e a rota trata o vazio como não preenchido', async () => {
    const antes = globalThis.fetch;
    const vistos: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const u = new URL(String(input)); vistos.push(u.href);
      if (u.host === 'gitlab.com') return json({ username: 'ana', name: 'Ana Souza' });
      return antes(input);
    }) as typeof fetch;
    try {
      const r = await req(h, 'POST', '/api/integrations/gitlab/token', s, { credentials: { token: 'glpat-token-de-teste-123', site: '' } });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.account, 'Ana Souza');
      assert.deepEqual(vistos, ['https://gitlab.com/api/v4/user'], 'em branco vai a gitlab.com');
      // obrigatório em branco: o nome do campo, em português, não um erro de formato
      const falta = await req(h, 'POST', '/api/integrations/gitlab/token', s, { credentials: { token: '', site: 'git.empresa.com' } });
      assert.equal(falta.status, 400);
      assert.match(falta.json.message, /preencha: Token pessoal/);
    } finally { globalThis.fetch = antes; }
    assert.match(ler('web/src/views/ConexoesView.tsx'), /fields\.filter\(\(f\) => \(v\[f\.name\] \?\? ''\)\.trim\(\)\)/, 'a tela não manda o campo vazio');
  });

  test('a ajuda traz links e textos para copiar à parte', async () => {
    const extras = (await item('slack')).help.extras as Array<{ rotulo: string; url?: string; copiar?: string }>;
    assert.ok(extras.some((x) => x.url?.startsWith('https://api.slack.com/apps?')));
    assert.ok(extras.some((x) => x.copiar?.startsWith('{')));
  });
});

describe('textos de tela que prometiam o que o sistema não faz', { skip: !COM_GUIAS && 'os guias não vêm nesta cópia (imagem de teste)' }, () => {
  test('WhatsApp: "nunca sozinhos" saiu, e quem aceitou aquele texto aceita de novo', () => {
    assert.ok(WA_RISKS_VERSION >= 3);
    assert.equal(risksAccepted({ riscos: { versao: 2 } }), false);
    const tela = ler('web/src/views/ConexoesView.tsx');
    assert.doesNotMatch(tela, /nunca sozinhos|Nada é enviado sozinho/);
    assert.match(tela, /Liberar tudo" em Conexões, o que não partiu de você/);
    assert.doesNotMatch(ler('community/publico/docs/WHATSAPP.md'), /nunca sozinhos/);
  });

  test('Conexões: a escrita e o alcance como são', () => {
    const tela = ler('web/src/views/ConexoesView.tsx');
    assert.doesNotMatch(tela, /Gerar o token \(só leitura\)/, 'o link do Trello pede leitura e escrita');
    assert.doesNotMatch(tela, /canais que você liberar/, 'não há escolha de canais: o alcance é o da credencial');
    assert.doesNotMatch(tela, /disabled=\{busy \|\| !filled\}/, 'Conectar não fica apagado sem dizer o que falta');
    assert.match(tela, /Aqui o teste só lê; a escrita aparece no primeiro uso/);
    assert.match(ler('community/publico/README.md'), /CRM e atendimento; financeiro sem mover dinheiro/);
    assert.doesNotMatch(tela, /Só leitura: os agentes consultam cobranças/, 'o financeiro também escreve; só leitura é o atalho da conexão');
    assert.match(tela, /\/> Só leitura<\/label>/, 'o atalho é uma caixa de marcar, nunca um botão apagado');
    assert.match(tela, /Reconectar do novo jeito/);
    // o erro do atalho aparece junto da caixa, e não dentro da lista que vem fechada
    const caixa = tela.indexOf('/> Só leitura</label>'); const lista = tela.indexOf('<details className="conn-acoes">', caixa);
    const erroDoAtalho = tela.indexOf('{errSoLeitura && <p className="error"', caixa);
    assert.ok(erroDoAtalho > caixa && erroDoAtalho < lista, 'o erro do "Só leitura" fica fora da lista fechada');
    assert.match(tela, /api\.put\(`\/api\/conexoes\/\$\{i\.kind\}\/so-leitura`, \{ on \}\); estado\.reload\(\); \} catch \(e\) \{ setErrSoLeitura\(errMsg\(e\)\)/);
  });

  test('Microsoft: a conta e o "Teams como canal" separados; cada etapa com o próximo passo, sem botão apagado esperando', () => {
    const tela = ler('web/src/views/ConexoesView.tsx');
    assert.match(tela, /Microsoft 365: a equipe age na sua conta\./);
    // conversar pelo Teams deixou de ser "em breve" (rc.26: o app público, ligado por código), e segue separado da conta
    assert.match(tela, /Conversar com a equipe pelo Teams: é outra coisa\./);
    assert.doesNotMatch(tela, /pelo Teams: em breve/);
    assert.ok(tela.includes('function TeamsConversa') && tela.includes('Em breve: conversar com a equipe pelo Teams'));
    for (const t of ['Liberar leitura', 'Pedir ao administrador', 'Já aprovaram? Conectar de novo', 'Autorizar agora', 'é esperado']) assert.ok(tela.includes(t), t);
    const etapas = tela.slice(tela.indexOf('function EtapasMicrosoft'), tela.indexOf('interface WaState'));
    assert.ok(etapas.length > 1000);
    assert.doesNotMatch(etapas, /disabled/);
    assert.doesNotMatch(tela, /Hermes/);
    assert.doesNotMatch(etapas, /o Ergon (envia|manda|lê|sabe)/, 'o Ergon não é uma pessoa');
  });

  test('docs da Microsoft: etapas, pedido ao administrador e conexão × bot; nada de comando nem de "nenhuma exige administrador"', { skip: !COM_GUIAS }, () => {
    const ms = ler('docs/MICROSOFT.md');
    assert.doesNotMatch(ms, /docker compose/);
    assert.doesNotMatch(ms, /nenhuma exige administrador/i);
    for (const t of [/Pedir ao administrador/, /Já aprovaram\? Conectar de novo/, /etapa/i, /bot/i, /ChannelMessage\.Read\.All/]) assert.match(ms, t);
    // o login de uma vez e o passo a passo do portal para o administrador (incluir Teams e canais e aprovar pela organização)
    const portal = ms.slice(ms.indexOf('## O administrador da empresa'), ms.indexOf('## Registrar um aplicativo próprio'));
    assert.ok(portal.length > 500, 'a seção do administrador vem antes do registro próprio');
    for (const t of [/Chat\.ReadBasic/, /ChannelMessage\.Read\.All/, /Conceder consentimento do administrador para/, /Aplicativos empresariais/, /Permissões delegadas/]) assert.match(portal, t);
    // 09/11: Chat.Read também; "Funções de diretório" ligado no token; os canais só para quem se sabe administrador
    for (const t of [/`Chat\.Read`/, /Funções de diretório/, /só quem se sabe administrador/]) assert.match(portal, t);
    assert.ok(portal.indexOf('Funções de diretório') < portal.indexOf('volte a **Permissões de API**, clique em **Conceder consentimento'), 'na ordem: funções de diretório, depois o consentimento');
    assert.doesNotMatch(ms, /Opcional: em \*\*Configuração de token/, 'as funções de diretório deixaram de ser opcionais');
    assert.match(ms, /de uma vez/);
    assert.doesNotMatch(ms, /\*\*Não\*\* clique em "Conceder consentimento/, 'o administrador pode aprovar pela organização');
    // nomes privados montados por partes (o texto deles não pode aparecer no repositório público)
    assert.doesNotMatch(ms, new RegExp(['M' + 'G3', 'am' + 'agno', 'fun' + 'dador'].join('|'), 'i'));
    const cx = ler('docs/CONEXOES.md');
    assert.match(cx, /MICROSOFT\.md/); assert.doesNotMatch(cx, /docker compose/);
  });

  test('listas ligadas nos dois sentidos: sem "espelho" na tela', () => {
    // o nome do arquivo (conexoes/espelho.ts) pode aparecer nos comentários; a palavra, não
    for (const f of ['web/src/views/TarefasView.tsx', 'web/src/views/AjudaView.tsx', 'web/src/components/CommandPalette.tsx']) assert.doesNotMatch(ler(f), /espelh(?!o\.ts)/i, f);
    assert.doesNotMatch(ler('web/src/views/ConexoesView.tsx'), /espelho/);
    // (types.ts puxa código do navegador: lido como texto)
    assert.match(ler('web/src/lib/types.ts'), /mirror: 'ligada'/);
    // os rótulos do histórico do card ficam em lib/tarefa-tela.ts (as linhas curtas da tela de detalhes)
    const detalhe = ler('web/src/lib/tarefa-tela.ts');
    assert.match(detalhe, /'mirror\.push': 'Enviado ao aplicativo'/);
    assert.match(detalhe, /'mirror\.push\.error': 'Não foi ao aplicativo'/);
  });

  test('docs: nada de botão que não existe nem frase para o dono do projeto', () => {
    assert.doesNotMatch(ler('README.md'), /Reproduzir fixture/);
    assert.doesNotMatch(ler('docs/ROTINAS.md'), /decisão sua/);
  });

  test('rotinas e Aspásia: "pede a sua confirmação" diz que "Liberar tudo" tira a confirmação', () => {
    const semRessalva = CATALOG.filter((t) => /confirmação/.test(t.approvals) && !/a menos que você ligue "Liberar tudo"/.test(t.approvals)).map((t) => t.name);
    assert.deepEqual(semRessalva, []);
    // as rotinas que pedem confirmação dizem todas a ressalva (acima); o número cresce com a biblioteca (a do Teams + e-mail entrou na rc.24)
    assert.ok(CATALOG.filter((t) => /Liberar tudo/.test(t.approvals)).length >= 6);
    assert.match(ler('docs/ROTINAS.md'), /o que uma rotina propõe\s+enviar pede a sua confirmação, a menos que você ligue "Liberar tudo" em Conexões/);
    assert.match(ler('docs/ROTINAS.md'), /o que parte de uma rotina pede confirmação, a menos que você ligue "Liberar tudo" em Conexões/);
    // nenhum texto que chega à pessoa promete a confirmação sem dizer que "Liberar tudo" a tira
    const promessa = /(?:O|o) que não partiu de você pede a sua confirmação(?!, a menos que você ligue "Liberar tudo")/;
    for (const f of ['community/publico/README.md', 'web/src/views/AjudaView.tsx', 'web/src/views/ConexoesView.tsx']) assert.doesNotMatch(ler(f), promessa, f);
    assert.equal(ler('web/src/views/ConexoesView.tsx').match(/o que não partiu de você pede a sua confirmação, a menos que você ligue "Liberar tudo" em Conexões/g)?.length, 2, 'Microsoft e Google');
    // e "Liberar tudo" não desfaz o que a pessoa desligou
    assert.match(ler('docs/CONEXOES.md'), /"Liberar tudo, por minha conta": tira as confirmações da regra e a aprovação depois de ler conteúdo privado[\s\S]{0,140}o que você desligou continua desligado/);
    const aspasia = CHARACTERS.find((c) => c.key === 'aspasia')!.bio;
    assert.doesNotMatch(aspasia, /nenhuma mensagem sai sem/);
    assert.match(aspasia, /manda o que você pedir, e o resto passa pela sua confirmação, a menos que você ligue "Liberar tudo"/);
  });

  test('quadros ligados: a tela e o doc dizem que desligar também vale para o quadro, e confirmar só para os agentes', () => {
    const frase = /Desligar uma ação também impede que o que você faz nos quadros ligados chegue ao aplicativo\. "Sempre pedir confirmação" vale só para os agentes\./;
    assert.match(ler('web/src/views/ConexoesView.tsx'), frase);
    assert.match(ler('docs/CONEXOES.md'), /desligar uma ação também impede que o que você faz no quadro .* chegue\s+ao aplicativo\. "Sempre pedir confirmação" vale só para os agentes/);
  });

  test('sem "espelho" no que chega à pessoa: a biblioteca de rotinas e o aviso de quadro que não existe', () => {
    for (const t of CATALOG) for (const campo of [t.benefit, t.produces, t.examines, t.approvals, t.sample ?? '']) assert.doesNotMatch(campo, /espelh/i, t.name);
    assert.doesNotMatch(ler('server/src/routes/integracoes.ts'), /notFound\('[^']*espelh/);
  });

  test('cartão de ação numa conta: quem recusa lê "Recusando…", e o já decidido noutro lugar só relê', () => {
    // "Enviando…" só no cartão que envia a uma conta; ativar rotina, abrir cards e apagar de vez dizem o que fazem
    assert.match(ler('web/src/components/ChatPanel.tsx'), /deciding\[p\.id\] === 'reject' \? 'Recusando…' : p\.kind === 'conexao' \? 'Enviando…' : p\.kind === 'depois_de_ler' \? 'Aprovando…' : p\.kind === 'purge' \? 'Apagando…' : 'Aplicando…'/);
    assert.match(ler('web/src/components/DecisionsPanel.tsx'), /decisao === 'reject' \? 'Recusando…' : 'Recusar'/);
    const detalhe = ler('web/src/components/TaskDetail.tsx');
    assert.match(detalhe, /e instanceof ApiError && e\.status === 409 && e\.code === 'decided'\) return null/);
    // a faixa de decisão: "Aprovar" decide o que a frase diz (um cartão, ou todos de uma vez); cada botão diz o que está indo
    assert.match(detalhe, /'Aprovando…' : n > 1 \? `Aprovar \(\$\{n\}\)` : 'Aprovar'/);
    assert.match(detalhe, /'Recusando…' : 'Recusar'/);
    assert.match(detalhe, /indo\(`reject:\$\{c\.id\}`, 'Recusar este', 'Recusando…'\)/);
    // a aprovação depois de ler: os botões do prazo (1 h, 8 h, 72 h, sempre)
    assert.match(detalhe, /<BotoesPrazo /);
  });
});

describe('Aspásia: a bio antiga muda uma vez, junto das instruções', () => {
  const ANTIGA = 'Dizem que escrevia os discursos de Péricles; ela nunca confirmou nem negou. Cuida das conversas com clientes e fornecedores — e nenhuma mensagem sai sem a sua aprovação.';
  const bio = () => h.db.get<{ id: string; bio: string | null }>("SELECT id, bio FROM agents WHERE workspace_id = ? AND char_key = 'aspasia'", s.workspaceId)!;
  test('só onde o texto ainda é o original, e uma vez só', () => {
    const nova = CHARACTERS.find((c) => c.key === 'aspasia')!.bio;
    assert.equal(bio().bio, nova, 'equipe nova já nasce com a bio nova');
    h.db.run('UPDATE agents SET bio = ? WHERE id = ?', ANTIGA, bio().id);
    h.db.run("DELETE FROM workspace_settings WHERE workspace_id = ? AND key = 'charter.conexoes'", s.workspaceId);
    grantConnectionsTool(h.db, h.bus, s.workspaceId);
    assert.equal(bio().bio, nova, 'a original passa à nova');
    h.db.run('UPDATE agents SET bio = ? WHERE id = ?', ANTIGA, bio().id);
    grantConnectionsTool(h.db, h.bus, s.workspaceId);
    assert.equal(bio().bio, ANTIGA, 'uma vez só');
    // a que a pessoa (ou um tema) escreveu fica
    h.db.run('UPDATE agents SET bio = ? WHERE id = ?', 'Cuida do WhatsApp da loja.', bio().id);
    h.db.run("DELETE FROM workspace_settings WHERE workspace_id = ? AND key = 'charter.conexoes'", s.workspaceId);
    grantConnectionsTool(h.db, h.bus, s.workspaceId);
    assert.equal(bio().bio, 'Cuida do WhatsApp da loja.');
  });
});
