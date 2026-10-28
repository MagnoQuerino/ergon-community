import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createManager, memBytes, motorName as managerName, type DockerCall, type ManagerConfig } from '../src/services/motor-manager.ts';
import { motorName, motorSecret } from '../src/services/motors.ts';

const MASTER = 'token-da-instalacao-'.padEnd(40, 'y');
const A = `usr_${'a'.repeat(32)}`; const B = `usr_${'b'.repeat(32)}`;
const cfg: ManagerConfig = { master: MASTER, image: 'ergon-hermes:dev', network: 'ergon-net', legacyVolume: 'ergon_hermes-vault', volumePrefix: 'ergon_motor-',
  bridgeUrl: 'http://ergon:8787/internal/bridge/v1/events', memBytes: memBytes('2g'), nanoCpus: 2e9 };

/** Docker falso: contêineres e volumes em memória; registra cada chamada. */
function fakeDocker(opts: { legacy?: boolean; legacyUsedBy?: string } = {}) {
  const containers = new Map<string, { spec: any; running: boolean }>();
  const volumes = new Set<string>(opts.legacy ? ['ergon_hermes-vault'] : []);
  const calls: string[] = [];
  const docker: DockerCall = async (method, path, body) => {
    calls.push(`${method} ${path}`);
    let m;
    if ((m = /^\/containers\/([\w-]+)\/json$/.exec(path))) {
      const c = containers.get(m[1]);
      return c ? { status: 200, json: { State: { Running: c.running }, Config: { Labels: c.spec.Labels } } } : { status: 404, json: { message: 'no such container' } };
    }
    if ((m = /^\/containers\/create\?name=([\w-]+)$/.exec(path))) { containers.set(m[1], { spec: body, running: false }); volumes.add((body as any).HostConfig.Mounts[0].Source); return { status: 201, json: {} }; }
    if ((m = /^\/containers\/([\w-]+)\/start$/.exec(path))) { containers.get(m[1])!.running = true; return { status: 204, json: null }; }
    if ((m = /^\/containers\/([\w-]+)\/stop/.exec(path))) { const c = containers.get(m[1]); if (!c) return { status: 404, json: null }; c.running = false; return { status: 204, json: null }; }
    if ((m = /^\/containers\/([\w-]+)\?force=true$/.exec(path)) && method === 'DELETE') { containers.delete(m[1]); return { status: 204, json: null }; }
    if ((m = /^\/volumes\/([\w-]+)$/.exec(path))) {
      if (method === 'DELETE') return volumes.delete(m[1]) ? { status: 204, json: null } : { status: 404, json: null };
      return volumes.has(m[1]) ? { status: 200, json: {} } : { status: 404, json: null };
    }
    if (path.startsWith('/containers/json')) {
      const f = JSON.parse(decodeURIComponent(path.split('filters=')[1]));
      const all = [...containers.values()].map((c) => ({ Labels: c.spec.Labels, State: c.running ? 'running' : 'exited', vol: c.spec.HostConfig.Mounts[0].Source }));
      if (opts.legacyUsedBy) all.push({ Labels: { 'com.docker.compose.service': opts.legacyUsedBy }, State: 'running', vol: 'ergon_hermes-vault' });
      return { status: 200, json: f.volume ? all.filter((x) => x.vol === f.volume[0]) : all.filter((x) => x.Labels['ergon.motor']) };
    }
    return { status: 599, json: { message: `rota de teste ausente: ${method} ${path}` } };
  };
  return { docker, containers, volumes, calls };
}

describe('gerente de motores (o único com o Docker)', () => {
  test('só o Ergon (token da instalação) e só uma pessoa válida', async () => {
    const d = fakeDocker(); const m = createManager(cfg, d.docker);
    assert.equal((await m.handle('POST', `/v1/motors/${A}/ensure`, 'errado', {})).status, 401);
    assert.equal((await m.handle('POST', '/v1/motors/../../containers/x/ensure', MASTER, {})).status, 404);
    assert.equal((await m.handle('POST', '/v1/motors/usr_123/ensure', MASTER, {})).status, 400);
    assert.equal((await m.handle('GET', '/health', undefined, null)).status, 200);
    assert.equal(d.calls.length, 0, 'nada chegou ao Docker');
  });

  test('o motor criado é o do Ergon: imagem e configuração fixas, tokens só dele, sem portas nem pastas do computador', async () => {
    const d = fakeDocker(); const m = createManager(cfg, d.docker);
    const r = await m.handle('POST', `/v1/motors/${A}/ensure`, MASTER, { adoptLegacy: false, image: 'outra:latest', env: ['X=1'], binds: ['/:/host'] });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const c = d.containers.get(motorName(A))!;
    assert.equal(managerName(A), motorName(A), 'o Ergon e o gerente chegam no mesmo nome');
    assert.equal(c.running, true);
    const spec = c.spec;
    assert.equal(spec.Image, 'ergon-hermes:dev', 'a imagem do pedido é ignorada');
    const env: string[] = spec.Env;
    assert.ok(!env.some((e) => e.includes(MASTER)), 'o token da instalação não vai para o motor');
    assert.ok(env.includes(`ERGON_BRIDGE_TOKEN=${motorSecret(MASTER, 'bridge', A)}`));
    assert.ok(env.includes(`API_SERVER_KEY=${motorSecret(MASTER, 'api', A)}`));
    assert.ok(env.includes('ERGON_VAULT=1'));
    assert.ok(!env.includes('X=1'));
    assert.deepEqual(spec.HostConfig.Mounts, [{ Type: 'volume', Source: `ergon_motor-${'a'.repeat(32)}`, Target: '/vault' }], 'só o cofre dela');
    assert.equal(spec.HostConfig.Binds, undefined); assert.equal(spec.HostConfig.PortBindings, undefined);
    assert.deepEqual(spec.HostConfig.CapAdd, ['SYS_ADMIN']);
    assert.ok(spec.HostConfig.SecurityOpt.includes('no-new-privileges:true'));
    assert.equal(spec.HostConfig.NetworkMode, 'ergon-net');
    assert.match(spec.HostConfig.Tmpfs['/opt/data'], /mode=0700/);
  });

  test('o cofre de antes vai para uma pessoa só, e só se ninguém o estiver usando', async () => {
    const busy = fakeDocker({ legacy: true, legacyUsedBy: 'hermes' });
    assert.equal((await createManager(cfg, busy.docker).handle('POST', `/v1/motors/${A}/ensure`, MASTER, { adoptLegacy: true })).json.adopted, false, 'o motor antigo ainda ligado: não herda');
    const d = fakeDocker({ legacy: true }); const m = createManager(cfg, d.docker);
    assert.equal((await m.handle('POST', `/v1/motors/${A}/ensure`, MASTER, { adoptLegacy: true })).json.adopted, true);
    assert.equal(d.containers.get(motorName(A))!.spec.HostConfig.Mounts[0].Source, 'ergon_hermes-vault');
    const rb = await m.handle('POST', `/v1/motors/${B}/ensure`, MASTER, { adoptLegacy: true });
    assert.equal(rb.json.adopted, false, 'a segunda pessoa não pega o cofre de outra');
    assert.equal(d.containers.get(motorName(B))!.spec.HostConfig.Mounts[0].Source, `ergon_motor-${'b'.repeat(32)}`);
  });

  test('desligar, religar e remover (contêiner e cofre)', async () => {
    const d = fakeDocker(); const m = createManager(cfg, d.docker);
    await m.handle('POST', `/v1/motors/${B}/ensure`, MASTER, {});
    assert.equal((await m.handle('POST', `/v1/motors/${B}/stop`, MASTER, null)).status, 200);
    assert.equal(d.containers.get(motorName(B))!.running, false);
    await m.handle('POST', `/v1/motors/${B}/ensure`, MASTER, {});
    assert.equal(d.containers.get(motorName(B))!.running, true, 'religa o mesmo contêiner (o cofre continua o dela)');
    assert.equal((await m.handle('DELETE', `/v1/motors/${B}`, MASTER, null)).status, 200);
    assert.equal(d.containers.has(motorName(B)), false);
    assert.equal(d.volumes.has(`ergon_motor-${'b'.repeat(32)}`), false, 'o cofre saiu junto');
    assert.equal((await m.handle('GET', '/v1/motors', MASTER, null)).json.motors.length, 0);
  });
});
