/**
 * Código de verdade (rc.42, conexoes/codigo.ts): o agente clona com um acesso de curta duração, envia um ramo e abre o pull
 * request, sem nunca ver o token da conexão. Ponta a ponta pela ponte do motor, com o git de verdade (CLI e http-backend)
 * contra um GitHub/GitLab falso: o .git/config fica limpo, só o token guardado chega ao serviço, o ramo principal é
 * protegido, a concessão não serve para outro repositório nem depois do trabalho, e as sempre-protegidas pedem o cartão
 * mesmo com "Liberar tudo".
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { comandosDoEnvio, ramo, recusaDoEnvio, repoGitHub, repoGitLab } from '../src/services/conexoes/codigo.ts';
import { decidir } from '../src/services/conexoes/regra.ts';
import type { HermesClient, ModelOptions, RemoteRun, StartRun } from '../src/services/hermes.ts';
import { setIntegration } from '../src/services/integrations.ts';
import { setHttpClock } from '../src/lib/http.ts';
import { gitFalso, redirecionar, type GitFalso } from './fake-git.ts';
import { harness, req, setupOwner, tmpDir, type Harness, type Session } from './helpers.ts';

const TOKEN_PONTE = 'token-da-ponte-de-teste-0123456789';
const PAT = 'ghp_tokenDeVerdadeQueNuncaSaiDoErgon0123';
class Motor implements HermesClient {
  runs = new Map<string, RemoteRun>(); n = 0;
  async health() { return { ok: true, detail: 'teste' }; }
  async startRun(_p: StartRun) { const runId = `run_teste${String(++this.n).padStart(6, '0')}`; this.runs.set(runId, { status: 'running', output: null, error: null, sessionId: `sessao-${runId}`, usage: null, model: null }); return { runId, replayed: false }; }
  async getRun(id: string) { return this.runs.get(id)!; }
  async stop() { return { accepted: true, detail: 'ok' }; }
  async toolsets() { return [{ name: 'ergon_conexoes', enabled: true }] as never; }
  async modelOptions(): Promise<ModelOptions> { return { model: 'nous/teste-1', provider: 'nous', providers: [] }; }
}

describe('código: as regras do envio e dos nomes', () => {
  test('os comandos do receive-pack e a recusa que o git mostra', () => {
    const z = '0'.repeat(40); const a = 'a'.repeat(40);
    const linha = (s: string) => `${(s.length + 4).toString(16).padStart(4, '0')}${s}`;
    const corpo = Buffer.from(`${linha(`${z} ${a} refs/heads/ergon/x\0report-status side-band-64k agent=git/2\n`)}${linha(`${a} ${z} refs/heads/velho\n`)}0000PACK...`);
    const c = comandosDoEnvio(corpo);
    assert.deepEqual(c.comandos.map((x) => x.ref), ['refs/heads/ergon/x', 'refs/heads/velho']);
    assert.ok(c.caps.includes('report-status'));
    const r = recusaDoEnvio(c.comandos, c.caps, 'motivo da recusa');
    assert.equal(r.status, 200); assert.equal(r.tipo, 'application/x-git-receive-pack-result');
    assert.match(r.corpo.toString('latin1'), /ng refs\/heads\/ergon\/x motivo da recusa/);
    assert.equal(recusaDoEnvio(c.comandos, [], 'x').status, 403, 'sem report-status, o git só entende o erro HTTP');
  });
  test('nomes de repositório e de ramo que não saem do lugar', () => {
    assert.equal(repoGitHub('https://github.com/acme/app.git'), 'acme/app');
    for (const ruim of ['acme', 'acme/../x', 'a/b/c', '../x/y']) assert.throws(() => repoGitHub(ruim), /inválido/);
    assert.equal(repoGitLab('grupo/sub/proj'), 'grupo/sub/proj');
    assert.throws(() => repoGitLab('grupo/../proj'), /inválido/);
    assert.equal(ramo('refs/heads/ergon/ajuste'), 'ergon/ajuste');
    for (const ruim of ['a b', 'a..b', '-x', 'x.lock', 'a~1', '']) assert.throws(() => ramo(ruim), /inválido/);
  });
  test('sempre-protegida: pede o cartão até com "Liberar tudo" e com regra aprovada; só o "desligado" vale acima', () => {
    const base = { risco: 'apagar' as const, origem: 'pessoa' as const, leuDeFora: false, liberarTudo: true };
    assert.equal(decidir(base), 'direto');
    assert.equal(decidir({ ...base, protegida: true }), 'confirmar');
    assert.equal(decidir({ ...base, protegida: true, regra: true }), 'confirmar');
    assert.equal(decidir({ ...base, protegida: true, ajuste: 'desligado' }), 'recusar');
  });
});

describe('código: clonar, enviar ramo e abrir pull request pela ponte, sem ver o token', () => {
  let h: Harness; let s: Session; let agente: string; let porta: number; let fake: GitFalso; let trabalho: string;
  const antes = globalThis.fetch;
  const ponte = async (corpo: Record<string, unknown>) => (await req(h, 'POST', '/internal/bridge/v1/conexoes', null, corpo, { 'x-ergon-bridge-token': TOKEN_PONTE })).json;
  async function conversar(texto: string): Promise<string> {
    const conv = (await req(h, 'POST', '/api/conversations', s, { agentId: agente })).json;
    await req(h, 'POST', `/api/conversations/${conv.id}/messages`, s, { text: texto, clientRequestId: `m-${crypto.randomUUID()}` });
    for (let i = 0; i < 3; i++) await h.executor.tick();
    return h.db.get<{ hermes_session_id: string }>('SELECT hermes_session_id FROM runs WHERE conversation_id = ? ORDER BY created_at DESC LIMIT 1', conv.id)!.hermes_session_id;
  }
  const executar = (sessao: string, acao: string, parametros: Record<string, unknown>, conexao = 'github') => ponte({ op: 'executar', session_id: sessao, conexao, acao, parametros });
  /** o git de verdade, com a senha só pelo credential helper (-c na linha de comando não fica no .git/config) */
  // assíncrono: o servidor do Ergon roda neste mesmo processo e precisa responder ao git enquanto ele espera
  const git = (cwd: string, senha: string, ...args: string[]) => new Promise<{ status: number | null; stderr: string; stdout: string }>((ok) => {
    const p = spawn('git', ['-c', 'credential.helper=', '-c', `credential.helper=!f() { echo username=ergon; echo "password=$ERGON_SENHA_TESTE"; }; f`, ...args],
      { cwd, env: { ...process.env, ERGON_SENHA_TESTE: senha, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 'Agente', GIT_AUTHOR_EMAIL: 'a@x', GIT_COMMITTER_NAME: 'Agente', GIT_COMMITTER_EMAIL: 'a@x' } });
    let stderr = ''; let stdout = '';
    p.stderr.on('data', (c) => { stderr += c; }); p.stdout.on('data', (c) => { stdout += c; });
    p.on('close', (status) => ok({ status, stderr, stdout }));
  });

  before(async () => {
    setHttpClock({ sleep: async () => undefined, jitter: () => 0 });
    fake = await gitFalso(path.join(tmpDir(), 'servidor'), PAT);
    fake.criarRepo('acme/app', { 'soma.js': 'export const soma = (a, b) => a - b;\n', 'teste.js': "import { soma } from './soma.js';\nif (soma(2, 3) !== 5) { console.error('falhou'); process.exit(1); }\nconsole.log('ok');\n", 'package.json': '{"type":"module"}\n' });
    fake.criarRepo('acme/outro', { 'x.txt': 'x\n' });
    globalThis.fetch = redirecionar(fake, antes);
    h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123', bridgeToken: TOKEN_PONTE }, { hermes: new Motor() });
    s = await setupOwner(h);
    agente = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active' ORDER BY coordinator LIMIT 1", s.workspaceId)!.id;
    h.integrations.secrets.write(s.workspaceId, 'github', { token: PAT });
    setIntegration(h.db, s.workspaceId, 'github', { state: 'connected', account_label: 'ana', connected_at: new Date().toISOString() });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    porta = (h.app.server.address() as AddressInfo).port;
    trabalho = tmpDir();
  });
  after(async () => { globalThis.fetch = antes; setHttpClock(null); await h.close(); await fake.fechar(); });

  test('o fluxo inteiro: preparar → clonar → ramo → testar → commit → push → pull request → encerrar', async () => {
    const sessao = await conversar('corrija a soma no acme/app e abra um pull request');
    const r = await executar(sessao, 'codigo.preparar', { repositorio: 'acme/app' });
    assert.equal(r.status, 'feita', JSON.stringify(r));
    assert.ok(r.git?.senha?.startsWith('ergit_'), 'a senha de uso curto vai ao plugin (que a tira antes do modelo)');
    assert.equal(r.git.caminho, '/internal/git/v1/github/acme/app.git');
    assert.ok(!r.texto.includes(r.git.senha) && !r.texto.includes(PAT), 'o texto que vai ao modelo não tem senha nem token');
    assert.match(r.texto, /Ramo principal: main/);
    const url = `http://127.0.0.1:${porta}${r.git.caminho}`;
    const pasta = path.join(trabalho, 'app');
    let g = await git(trabalho, r.git.senha, 'clone', '-q', url, pasta);
    assert.equal(g.status, 0, g.stderr);
    const config = fs.readFileSync(path.join(pasta, '.git', 'config'), 'utf8');
    assert.ok(!config.includes(r.git.senha) && !config.includes(PAT) && !config.includes('ergon@'), '.git/config limpo');
    // edita, roda o teste de verdade, commit e envia num ramo novo
    assert.notEqual(spawnSync(process.execPath, ['teste.js'], { cwd: pasta }).status, 0, 'o teste falha antes da correção');
    fs.writeFileSync(path.join(pasta, 'soma.js'), 'export const soma = (a, b) => a + b;\n');
    assert.equal(spawnSync(process.execPath, ['teste.js'], { cwd: pasta }).status, 0, 'o teste passa depois');
    await git(pasta, r.git.senha, 'switch', '-q', '-c', 'ergon/corrige-soma');
    await git(pasta, r.git.senha, 'commit', '-qam', 'Corrige a soma');
    g = await git(pasta, r.git.senha, 'push', '-q', '-u', 'origin', 'ergon/corrige-soma');
    assert.equal(g.status, 0, g.stderr);
    assert.match(fake.mostrar('acme/app', 'ergon/corrige-soma', 'soma.js') ?? '', /a \+ b/);
    // só o token guardado chegou ao serviço; nada da senha de uso curto
    const auths = fake.git.map((x) => x.auth ?? '');
    assert.ok(auths.every((a) => Buffer.from(a.replace(/^Basic /, ''), 'base64').toString() === `x-access-token:${PAT}`), 'o serviço só vê o token');
    // enviar ao principal: recusado, com o motivo que o git mostra
    g = await git(pasta, r.git.senha, 'push', 'origin', 'ergon/corrige-soma:main');
    assert.notEqual(g.status, 0);
    assert.match(g.stderr, /ramo principal \(main\) pede a aprova/);
    assert.match(fake.mostrar('acme/app', 'main', 'soma.js') ?? '', /a - b/, 'o principal ficou como estava');
    // apagar ramo pelo envio: recusado
    g = await git(pasta, r.git.senha, 'push', 'origin', '--delete', 'ergon/corrige-soma');
    assert.notEqual(g.status, 0); assert.match(g.stderr, /apagar um ramo pede a aprova/);
    // o pull request, com o link para a pessoa
    const pr = await executar(sessao, 'codigo.abrir_pr', { repositorio: 'acme/app', ramo: 'ergon/corrige-soma', titulo: 'Corrige a soma', texto: 'Teste: node teste.js passa. @time' });
    assert.equal(pr.status, 'feita', JSON.stringify(pr));
    assert.equal(pr.url, 'https://github.com/acme/app/pull/1');
    assert.deepEqual([fake.pulls[0].head, fake.pulls[0].base], ['ergon/corrige-soma', 'main']);
    assert.ok(fake.pulls[0].body.includes('@​time'), 'o @ não marca ninguém');
    // a concessão não serve para outro repositório
    g = await git(trabalho, r.git.senha, 'clone', '-q', `http://127.0.0.1:${porta}/internal/git/v1/github/acme/outro.git`, path.join(trabalho, 'outro'));
    assert.notEqual(g.status, 0);
    // encerrar: o git deste trabalho não alcança mais nada
    const fim = await executar(sessao, 'codigo.encerrar', {});
    assert.equal(fim.gitFim, true);
    g = await git(pasta, r.git.senha, 'fetch', 'origin');
    assert.notEqual(g.status, 0);
    // a auditoria registra cada passo, sem segredo
    const aud = h.db.all<{ action: string; result: string; evidence: string }>("SELECT action, result, evidence FROM audit_events WHERE workspace_id = ? AND action LIKE 'codigo.%' OR action = 'conexao.acao'", s.workspaceId);
    assert.ok(aud.some((x) => x.action === 'codigo.concessao') && aud.some((x) => x.action === 'codigo.envio') && aud.some((x) => x.action === 'codigo.envio.recusado'));
    const tudo = JSON.stringify(h.db.all('SELECT * FROM audit_events')) + JSON.stringify(h.db.all('SELECT * FROM conexao_acoes')) + JSON.stringify(h.db.all('SELECT * FROM git_concessoes'));
    assert.ok(!tudo.includes(r.git.senha) && !tudo.includes(PAT), 'nem a senha nem o token no banco');
  });

  test('a concessão morre com o trabalho; outra pessoa/workspace não usa senha que não é dela', async () => {
    const sessao = await conversar('clone o acme/app');
    const r = await executar(sessao, 'codigo.preparar', { repositorio: 'acme/app' });
    assert.equal(r.status, 'feita');
    const runId = h.db.get<{ id: string }>('SELECT id FROM runs WHERE hermes_session_id = ?', sessao)!.id;
    h.db.run("UPDATE runs SET status = 'succeeded' WHERE id = ?", runId);
    const g = await git(trabalho, r.git.senha, 'ls-remote', `http://127.0.0.1:${porta}${r.git.caminho}`);
    assert.notEqual(g.status, 0, 'trabalho terminado: a senha não abre mais nada');
    const inventada = await git(trabalho, `ergit_${'0'.repeat(64)}`, 'ls-remote', `http://127.0.0.1:${porta}${r.git.caminho}`);
    assert.notEqual(inventada.status, 0);
  });

  test('"Liberar tudo" de quem pediu libera o principal e o merge; apagar repositório continua pedindo o cartão', async () => {
    await req(h, 'PUT', '/api/conexoes/liberar-tudo/meu', s, { on: true, semAviso: true });
    try {
      const sessao = await conversar('pode mandar direto no main do acme/app');
      const r = await executar(sessao, 'codigo.preparar', { repositorio: 'acme/app' });
      const pasta = path.join(trabalho, 'livre');
      assert.equal((await git(trabalho, r.git.senha, 'clone', '-q', `http://127.0.0.1:${porta}${r.git.caminho}`, pasta)).status, 0);
      fs.writeFileSync(path.join(pasta, 'LEIAME.md'), '# app\n');
      await git(pasta, r.git.senha, 'add', '-A'); await git(pasta, r.git.senha, 'commit', '-qm', 'Leia-me');
      const g = await git(pasta, r.git.senha, 'push', '-q', 'origin', 'main');
      assert.equal(g.status, 0, g.stderr);
      assert.equal(fake.mostrar('acme/app', 'main', 'LEIAME.md'), '# app\n');
      const m = await executar(sessao, 'codigo.incorporar', { repositorio: 'acme/app', numero: 1 });
      assert.equal(m.status, 'feita', JSON.stringify(m));
      const apagar = await executar(sessao, 'codigo.apagar_repositorio', { repositorio: 'acme/app' });
      assert.equal(apagar.status, 'aguardando_confirmacao');
      assert.deepEqual(fake.apagados, [], 'nada apagado sem o clique');
      const cartao = h.db.get<{ payload: string }>("SELECT payload FROM agent_proposals WHERE workspace_id = ? AND kind = 'conexao' AND status = 'proposed' ORDER BY created_at DESC LIMIT 1", s.workspaceId)!;
      assert.match(JSON.parse(cartao.payload).porque, /mesmo com "Liberar tudo"/);
    } finally { await req(h, 'PUT', '/api/conexoes/liberar-tudo/meu', s, { on: false }); }
  });

  test('sem "Liberar tudo", merge e liberar o principal esperam o cartão; o cartão aprovado libera o envio ao principal', async () => {
    const sessao = await conversar('incorpore o pull request 1 do acme/app');
    assert.equal((await executar(sessao, 'codigo.incorporar', { repositorio: 'acme/app', numero: 1 })).status, 'aguardando_confirmacao');
    const r = await executar(sessao, 'codigo.preparar', { repositorio: 'acme/app' });
    const lib = await executar(sessao, 'codigo.liberar_principal', { repositorio: 'acme/app', motivo: 'correção urgente' });
    assert.equal(lib.status, 'aguardando_confirmacao');
    const pid = h.db.get<{ id: string }>("SELECT id FROM agent_proposals WHERE workspace_id = ? AND kind = 'conexao' AND status = 'proposed' ORDER BY created_at DESC LIMIT 1", s.workspaceId)!.id;
    assert.equal((await req(h, 'POST', `/api/proposals/${pid}`, s, { decision: 'apply' })).status, 200);
    const pasta = path.join(trabalho, 'aprovado');
    assert.equal((await git(trabalho, r.git.senha, 'clone', '-q', `http://127.0.0.1:${porta}${r.git.caminho}`, pasta)).status, 0);
    fs.writeFileSync(path.join(pasta, 'urgente.txt'), 'ok\n');
    await git(pasta, r.git.senha, 'add', '-A'); await git(pasta, r.git.senha, 'commit', '-qm', 'Urgente');
    const g = await git(pasta, r.git.senha, 'push', '-q', 'origin', 'main');
    assert.equal(g.status, 0, g.stderr);
  });

  test('GitLab: o mesmo caminho, com o projeto em grupo/sub e o merge request', async () => {
    const lab = await gitFalso(path.join(tmpDir(), 'lab'), 'glpat-tokenDoGitLab0123456789', { tipo: 'gitlab' });
    lab.criarRepo('grupo/sub/proj', { 'a.txt': 'a\n' });
    const antesLab = globalThis.fetch;
    globalThis.fetch = redirecionar(lab, antesLab, { gitHost: 'gitlab.com', apiHost: 'gitlab.com' });
    try {
      h.integrations.secrets.write(s.workspaceId, 'gitlab', { token: 'glpat-tokenDoGitLab0123456789' });
      setIntegration(h.db, s.workspaceId, 'gitlab', { state: 'connected', account_label: 'ana', connected_at: new Date().toISOString() });
      const sessao = await conversar('mude o a.txt no gitlab');
      const r = await executar(sessao, 'codigo.preparar', { repositorio: 'grupo/sub/proj' }, 'gitlab');
      assert.equal(r.status, 'feita', JSON.stringify(r));
      const pasta = path.join(trabalho, 'lab');
      let g = await git(trabalho, r.git.senha, 'clone', '-q', `http://127.0.0.1:${porta}${r.git.caminho}`, pasta);
      assert.equal(g.status, 0, g.stderr);
      fs.writeFileSync(path.join(pasta, 'a.txt'), 'b\n');
      await git(pasta, r.git.senha, 'switch', '-qc', 'ergon/b'); await git(pasta, r.git.senha, 'commit', '-qam', 'b');
      g = await git(pasta, r.git.senha, 'push', '-q', 'origin', 'ergon/b');
      assert.equal(g.status, 0, g.stderr);
      const mr = await executar(sessao, 'codigo.abrir_pr', { repositorio: 'grupo/sub/proj', ramo: 'ergon/b', titulo: 'B', texto: '/merge\nfeito' }, 'gitlab');
      assert.equal(mr.status, 'feita', JSON.stringify(mr));
      assert.match(mr.url, /merge_requests\/1$/);
      assert.match(lab.pulls[0].body, /^`\/merge`/, 'comando do GitLab vira código, não executa');
    } finally { globalThis.fetch = antesLab; await lab.fechar(); }
  });
});

// o git do laboratório está instalado (o teste usa o de verdade)
execFileSync('git', ['--version']);
