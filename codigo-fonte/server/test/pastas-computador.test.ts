/**
 * Pastas do computador (rc.42): o que pode ser concedido ao motor (e o que nunca), a montagem pelo gerente de motores
 * (só as concedidas, em /pastas/<nome>, com o mesmo cofre; revogar desmonta; o pedido mexido não monta nada fora da regra)
 * e as rotas: conceder, listar, revogar, na nuvem não existe; e o cartão "Ativar acesso total?" (senha uma vez, Terminal e
 * o resto para os agentes escolhidos, "Liberar tudo" junto).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { conferirPasta, nomeNoMotor, pastasParaMontar } from '../src/lib/pastas-seguras.ts';
import * as mm from '../src/services/motor-manager.ts';
import { B, B_REF, MASTER, U1, cfg, fakeDocker, nome, vol } from './docker-falso.ts';
import { harness, req, setupOwner } from './helpers.ts';

describe('pastas: o que pode ir para o motor', () => {
  test('pasta de projeto passa; raiz, sistema, casa inteira e pastas de credenciais não', () => {
    assert.equal(conferirPasta('/home/ana/projetos/site/'), '/home/ana/projetos/site');
    assert.equal(conferirPasta('C:\\Users\\Ana\\Projetos\\site'), 'C:/Users/Ana/Projetos/site');
    assert.equal(conferirPasta('/Users/ana/Code/app'), '/Users/ana/Code/app');
    for (const [p, m] of [['/', /raiz/], ['C:\\', /raiz/], ['/etc', /sistema/], ['/usr/local/bin', /sistema/], ['/var/run/docker.sock', /sistema/], ['/root/x', /sistema/],
      ['/home', /pessoal/], ['/home/ana', /pessoal/], ['/Users/ana', /pessoal/], ['C:\\Users\\Ana', /pessoal/], ['C:\\Windows\\System32', /sistema/],
      ['/home/ana/.ssh', /senhas e chaves/], ['/home/ana/projetos/.aws/x', /senhas e chaves/], ['/home/ana/.gnupg', /senhas e chaves/],
      ['projetos/site', /caminho completo/], ['/home/ana/../bob/x', /subir/], ['/home/ana/a:b', /caracteres/], ['/tmp', /dentro desta/]] as const) {
      assert.throws(() => conferirPasta(p), m, p);
    }
    assert.throws(() => conferirPasta('/srv/dados', ['/srv/dados/ana']), /pessoal/, 'o que fica acima de uma casa conhecida também não');
    assert.throws(() => conferirPasta('/srv/dados/ana', ['/srv/dados/ana']), /pessoal/);
    assert.equal(conferirPasta('/srv/dados/ana/proj', ['/srv/dados/ana']), '/srv/dados/ana/proj');
  });
  test('nome no motor e a lista conferida de novo', () => {
    assert.equal(nomeNoMotor('/home/ana/Projetos Ação', new Set()), 'projetos-acao');
    assert.equal(nomeNoMotor('/x/site', new Set(['site'])), 'site-2');
    const l = pastasParaMontar([{ origem: '/home/ana/site', modo: 'rw', nome: 'site' }, { origem: '/etc', modo: 'rw' }, { origem: '/home/ana/.ssh', modo: 'ro' },
      { origem: '/home/ana/doc', modo: 'xx' }, { origem: '/home/ana/site', modo: 'ro' }, { origem: '/home/ana/dados', modo: 'ro', nome: '../x' }]);
    assert.deepEqual(l, [{ origem: '/home/ana/dados', nome: 'dados', modo: 'ro' }, { origem: '/home/ana/site', nome: 'site', modo: 'rw' }]);
  });
});

describe('pastas: o gerente monta só as concedidas, com o mesmo cofre', () => {
  const ensure = (m: ReturnType<typeof mm.createManager>, body: unknown) => m.handle('POST', `/v1/motors/${U1}/ensure`, MASTER, body);
  test('conceder monta em /pastas/<nome>; ligado e ocupado, espera; livre, refaz; sem dizer, mantém; revogar desmonta', async () => {
    const d = fakeDocker(); d.addImage({ id: B, digests: [B_REF] }); const m = mm.createManager(cfg(B_REF), d.docker);
    assert.equal((await ensure(m, {})).status, 200);
    const montagens = () => d.containers.get(nome(U1))!.spec.HostConfig.Mounts;
    assert.deepEqual(montagens(), [{ Type: 'volume', Source: vol(U1), Target: '/vault' }]);
    // ligado e trabalhando: não mexe, avisa (a renovação espera o trabalho terminar)
    let r = await ensure(m, { pastas: [{ origem: '/home/ana/site', modo: 'rw' }, { origem: '/etc', modo: 'rw' }] });
    assert.equal(r.json.stale, true); assert.equal(r.json.motivo, 'ocupado');
    assert.equal(montagens().length, 1, 'nada montado com trabalho em andamento');
    r = await ensure(m, { idle: true, pastas: [{ origem: '/home/ana/site', modo: 'rw' }, { origem: '/home/ana/docs', modo: 'ro' }, { origem: '/etc', modo: 'rw' }] });
    assert.equal(r.status, 200, JSON.stringify(r.json)); assert.equal(r.json.recreated, true);
    assert.deepEqual(montagens(), [{ Type: 'volume', Source: vol(U1), Target: '/vault' },
      { Type: 'bind', Source: '/home/ana/docs', Target: '/pastas/docs', ReadOnly: true, BindOptions: { Propagation: 'rprivate' } },
      { Type: 'bind', Source: '/home/ana/site', Target: '/pastas/site', ReadOnly: false, BindOptions: { Propagation: 'rprivate' } }], 'o mesmo cofre, e /etc nunca');
    assert.deepEqual(r.json.pastas.map((p: { nome: string }) => p.nome), ['docs', 'site']);
    // um ensure sem pastas (a partida do gerente, um Ergon de antes) mantém o que está montado: nada é refeito
    r = await ensure(m, { idle: true });
    assert.equal(r.json.recreated, false); assert.equal(montagens().length, 3);
    // revogar tudo desmonta
    r = await ensure(m, { idle: true, pastas: [] });
    assert.equal(r.json.recreated, true);
    assert.deepEqual(montagens(), [{ Type: 'volume', Source: vol(U1), Target: '/vault' }]);
    assert.equal(d.count(/^DELETE \/volumes/), 0, 'o cofre nunca sai');
  });
  test('as casas desta máquina (ERGON_HOST_HOME) não montam, nem o que fica acima delas', async () => {
    const d = fakeDocker(); d.addImage({ id: B, digests: [B_REF] }); const m = mm.createManager(cfg(B_REF, { casas: ['/srv/gente/ana'] }), d.docker);
    await ensure(m, { pastas: [{ origem: '/srv/gente/ana', modo: 'rw' }, { origem: '/srv/gente', modo: 'rw' }, { origem: '/srv/gente/ana/proj', modo: 'rw' }] });
    assert.deepEqual(d.containers.get(nome(U1))!.spec.HostConfig.Mounts.map((x: { Target: string }) => x.Target), ['/vault', '/pastas/proj']);
  });
});

describe('pastas e acesso total pelas rotas', () => {
  test('conceder, listar, revogar; recusa com o motivo; o agente vê a pasta nas instruções', async () => {
    const h = await harness(); const s = await setupOwner(h);
    try {
      assert.equal((await req(h, 'POST', '/api/pastas', s, { caminho: '/home/ana/.ssh' })).status, 400);
      const r = await req(h, 'POST', '/api/pastas', s, { caminho: '/home/ana/projetos/site', modo: 'ro' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal(r.json.noMotor, '/pastas/site'); assert.equal(r.json.modo, 'ro');
      const l = (await req(h, 'GET', '/api/pastas', s)).json;
      assert.equal(l.disponivel, true); assert.deepEqual(l.pastas.map((p: { caminho: string }) => p.caminho), ['/home/ana/projetos/site']);
      const { promptConexoes } = await import('../src/services/conexoes/catalogo.ts');
      assert.match(promptConexoes(h.db, s.workspaceId), /\/pastas\/site \(só leitura\)/);
      assert.ok(!promptConexoes(h.db, s.workspaceId).includes('/home/ana'), 'o agente não recebe o caminho do computador');
      assert.equal((await req(h, 'DELETE', `/api/pastas/${r.json.id}`, s)).status, 200);
      assert.deepEqual((await req(h, 'GET', '/api/pastas', s)).json.pastas, []);
      assert.ok(h.db.all<{ action: string }>("SELECT action FROM audit_events WHERE action LIKE 'pastas.%'").length >= 2);
    } finally { await h.close(); }
  });
  test('na nuvem não existe', async () => {
    const h = await harness(); const s = await setupOwner(h);
    try {
      const { Pastas } = await import('../src/services/pastas.ts');
      const nuvem = new Pastas({ db: h.db, bus: h.bus, nuvem: true, aplicar: () => assert.fail('nada a aplicar na nuvem') });
      assert.throws(() => nuvem.conceder(s.userId, s.workspaceId, '/home/ana/site', 'rw'), /na nuvem/);
    } finally { await h.close(); }
  });
  test('"Ativar acesso total?": a senha uma vez libera as protegidas à equipe inteira (sem escolher agentes), com "Liberar tudo"', async () => {
    const h = await harness(); const s = await setupOwner(h);
    try {
      const { PROTEGIDAS, acessoTotalDaEquipe, ferramentasEfetivas } = await import('../src/services/characters.ts');
      const efetivas = (id: string) => ferramentasEfetivas(JSON.parse(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', id)!.tools) as string[], { acessoTotal: acessoTotalDaEquipe(h.db, s.workspaceId) });
      const ativos = () => h.db.all<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active'", s.workspaceId).map((x) => x.id);
      assert.equal((await req(h, 'GET', '/api/acesso-total', s)).json.ativo, false);
      for (const id of ativos()) assert.ok(!PROTEGIDAS.some((t) => efetivas(id).includes(t)), 'sem o acesso total, ninguém tem as protegidas');
      h.db.run("UPDATE sessions SET auth_at = '2000-01-01T00:00:00.000Z'");
      assert.equal((await req(h, 'POST', '/api/acesso-total', s, {})).status, 401, 'sem a senha agora, não');
      assert.equal((await req(h, 'POST', '/api/acesso-total', s, { agentes: [ativos()[0]] })).status, 400, 'não há mais escolha de agentes');
      assert.equal((await req(h, 'POST', '/api/session/unlock', s, { password: 'senha-local-123' })).status, 200);
      const r = await req(h, 'POST', '/api/acesso-total', s, { semAviso: true });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      for (const id of ativos()) assert.ok(PROTEGIDAS.every((t) => efetivas(id).includes(t)), `todo agente tem as protegidas: ${efetivas(id).join(',')}`);
      // quem chega depois também
      const novo = await req(h, 'POST', '/api/agents', s, { name: 'Tales', role: 'Pesquisa', sectorKey: 'brainstorm' });
      assert.equal(novo.status, 201, JSON.stringify(novo.json));
      assert.ok(PROTEGIDAS.every((t) => efetivas(novo.json.id).includes(t)));
      const e = (await req(h, 'GET', '/api/conexoes', s)).json;
      assert.equal(e.liberarTudoMeu, true); assert.equal(e.liberarTudoSemAviso, true);
      assert.equal((await req(h, 'GET', '/api/acesso-total', s)).json.ativo, true);
      assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'acesso_total'"));
      // quem administra proibiu: o acesso total cai e não ativa de novo
      await req(h, 'PUT', '/api/conexoes/liberar-tudo/proibir', s, { on: true });
      assert.equal((await req(h, 'GET', '/api/acesso-total', s)).json.ativo, false);
      for (const id of ativos()) assert.ok(!PROTEGIDAS.some((t) => efetivas(id).includes(t)), 'proibido: as protegidas saem de todos');
      assert.equal((await req(h, 'POST', '/api/acesso-total', s, {})).status, 409);
      // desligar pela tela (quem administra)
      await req(h, 'PUT', '/api/conexoes/liberar-tudo/proibir', s, { on: false });
      assert.equal((await req(h, 'POST', '/api/acesso-total', s, {})).status, 200);
      assert.equal((await req(h, 'DELETE', '/api/acesso-total', s)).status, 200);
      assert.equal((await req(h, 'GET', '/api/acesso-total', s)).json.ativo, false);
    } finally { await h.close(); }
  });
});
