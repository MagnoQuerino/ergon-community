/**
 * Gerente de motores: o único contêiner com acesso ao Docker. Cria, liga, desliga e remove o
 * contêiner do motor de IA de cada pessoa — sempre a mesma imagem e a mesma configuração do motor do Ergon (cofre
 * gocryptfs, nenhum privilégio além do de montar o cofre, que o próprio cofre solta depois de montar), cada um com o
 * cofre e os tokens dele, derivados do token da instalação (que nenhum motor recebe).
 *
 * Só o Ergon fala com ele (rede interna própria + token da instalação). O pedido só escolhe a pessoa: imagem,
 * comando, pastas, variáveis e limites vêm daqui. A primeira conta pode herdar o cofre do motor de antes (o mesmo
 * volume), uma vez e só se nenhum outro contêiner o usa.
 */
import crypto from 'node:crypto';
import http from 'node:http';

export interface DockerResponse { status: number; json: any }
export type DockerCall = (method: string, path: string, body?: unknown) => Promise<DockerResponse>;

export interface ManagerConfig {
  master: string;
  image: string;
  network: string;
  legacyVolume: string;
  volumePrefix: string;
  bridgeUrl: string;
  memBytes: number;
  nanoCpus: number;
}

const UID = /^usr_[a-f0-9]{32}$/;
export const motorName = (uid: string) => `ergon-motor-${uid.slice(4)}`;
const secret = (master: string, purpose: string, uid: string) => crypto.createHmac('sha256', master).update(`ergon/motor-${purpose}/${uid}`).digest('hex');

/** O contêiner do motor de uma pessoa: o mesmo do docker-compose.yml (serviço do motor), com o cofre e os tokens dela. */
export function motorSpec(c: ManagerConfig, uid: string, volume: string): Record<string, unknown> {
  return {
    Image: c.image,
    Cmd: ['gateway', 'run'],
    Env: [
      'API_SERVER_ENABLED=true', 'API_SERVER_HOST=0.0.0.0', 'API_SERVER_PORT=8642', `API_SERVER_KEY=${secret(c.master, 'api', uid)}`,
      // painel interno do motor: só dentro do contêiner; o Ergon chega pela ponte de controle
      'HERMES_DASHBOARD=1', 'HERMES_DASHBOARD_HOST=127.0.0.1', 'HERMES_DASHBOARD_PORT=9119', `HERMES_DASHBOARD_SESSION_TOKEN=${secret(c.master, 'dashboard', uid)}`,
      'ERGON_CONTROL_PORT=8643', `ERGON_BRIDGE_URL=${c.bridgeUrl}`, `ERGON_BRIDGE_TOKEN=${secret(c.master, 'bridge', uid)}`,
      'ERGON_VAULT=1', // espera a chave do Ergon (porta 8644, só rede interna)
    ],
    Labels: { 'ergon.motor': uid, 'ergon.motor.volume': volume },
    HostConfig: {
      Mounts: [{ Type: 'volume', Source: volume, Target: '/vault' }], // só o lado cifrado vai para o disco
      // a vista decifrada fica só na memória; o cofre do motor entrega a pasta ao usuário dele (uid/gid aqui o Podman recusa)
      Tmpfs: { '/opt/data': 'mode=0700' },
      Devices: [{ PathOnHost: '/dev/fuse', PathInContainer: '/dev/fuse', CgroupPermissions: 'rwm' }],
      CapAdd: ['SYS_ADMIN'], CapDrop: ['NET_RAW', 'MKNOD', 'AUDIT_WRITE', 'SETFCAP'],
      SecurityOpt: ['apparmor:unconfined', 'no-new-privileges:true'],
      Memory: c.memBytes, NanoCpus: c.nanoCpus,
      RestartPolicy: { Name: 'unless-stopped' },
      LogConfig: { Type: 'json-file', Config: { 'max-size': '10m' } }, // só o que o Docker e o Podman aceitam
      NetworkMode: c.network,
      // sem portas publicadas, sem pastas do computador, sem o socket do Docker
    },
  };
}

class ManagerError extends Error { readonly status: number; constructor(status: number, msg: string) { super(msg); this.status = status; } }

export function createManager(c: ManagerConfig, docker: DockerCall) {
  const inspect = async (name: string) => { const r = await docker('GET', `/containers/${name}/json`); return r.status === 404 ? null : r.json; };
  const ok = (r: DockerResponse, what: string) => { if (r.status >= 300 && r.status !== 304) throw new ManagerError(502, `${what}: Docker respondeu ${r.status} ${JSON.stringify(r.json?.message ?? '')}`); };

  /** O cofre de antes pode ir para esta pessoa? (existe, e nenhum outro contêiner o usa — nem o motor antigo ligado) */
  async function canAdopt(uid: string): Promise<boolean> {
    if ((await docker('GET', `/volumes/${c.legacyVolume}`)).status !== 200) return false;
    const users = await docker('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ volume: [c.legacyVolume] }))}`);
    return (users.json ?? []).every((x: { Labels?: Record<string, string> }) => x.Labels?.['ergon.motor'] === uid);
  }

  async function ensure(uid: string, adoptLegacy: boolean): Promise<{ adopted: boolean; created: boolean; state: string }> {
    const name = motorName(uid);
    let cur = await inspect(name);
    let created = false;
    if (!cur) {
      const adopt = adoptLegacy && (await canAdopt(uid));
      const volume = adopt ? c.legacyVolume : `${c.volumePrefix}${uid.slice(4)}`;
      let made = await docker('POST', `/containers/create?name=${name}`, motorSpec(c, uid, volume));
      if (made.status === 404) {
        // imagem ainda não está neste computador (pacote de versão): baixa a publicada e tenta de novo
        const at = c.image.lastIndexOf(':');
        const [from, tag] = at > c.image.lastIndexOf('/') ? [c.image.slice(0, at), c.image.slice(at + 1)] : [c.image, 'latest'];
        ok(await docker('POST', `/images/create?fromImage=${encodeURIComponent(from)}&tag=${encodeURIComponent(tag)}`), 'baixar a imagem do motor');
        made = await docker('POST', `/containers/create?name=${name}`, motorSpec(c, uid, volume));
      }
      ok(made, 'criar o motor');
      created = true;
      cur = await inspect(name);
    }
    if (!cur?.State?.Running) ok(await docker('POST', `/containers/${name}/start`), 'ligar o motor');
    return { adopted: cur?.Config?.Labels?.['ergon.motor.volume'] === c.legacyVolume, created, state: 'running' };
  }
  async function stop(uid: string) {
    const r = await docker('POST', `/containers/${motorName(uid)}/stop?t=20`);
    if (r.status !== 404) ok(r, 'desligar o motor');
  }
  /** Remove contêiner e cofre (conta removida). O cofre herdado também sai: era dela. */
  async function remove(uid: string) {
    const cur = await inspect(motorName(uid));
    const volume = cur?.Config?.Labels?.['ergon.motor.volume'] ?? `${c.volumePrefix}${uid.slice(4)}`;
    if (cur) ok(await docker('DELETE', `/containers/${motorName(uid)}?force=true`), 'remover o motor');
    const v = await docker('DELETE', `/volumes/${volume}`);
    if (v.status !== 404) ok(v, 'remover o cofre do motor');
  }
  async function list() {
    const r = await docker('GET', `/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({ label: ['ergon.motor'] }))}`);
    return (r.json ?? []).map((x: { Labels: Record<string, string>; State: string }) => ({ uid: x.Labels['ergon.motor'], state: x.State }));
  }

  /** Atende um pedido do Ergon (já com o corpo lido). */
  async function handle(method: string, url: string, token: string | undefined, body: unknown): Promise<{ status: number; json: any }> {
    try {
      if (url === '/health' && method === 'GET') return { status: 200, json: { ok: true } };
      const t = Buffer.from(token ?? ''); const m = Buffer.from(c.master);
      if (!c.master || t.length !== m.length || !crypto.timingSafeEqual(t, m)) throw new ManagerError(401, 'token inválido');
      if (url === '/v1/motors' && method === 'GET') return { status: 200, json: { motors: await list() } };
      const r = /^\/v1\/motors\/([^/]+)(?:\/(ensure|stop))?$/.exec(url);
      if (!r) throw new ManagerError(404, 'rota desconhecida');
      if (!UID.test(r[1])) throw new ManagerError(400, 'pessoa inválida');
      if (r[2] === 'ensure' && method === 'POST') return { status: 200, json: { ok: true, ...(await ensure(r[1], (body as { adoptLegacy?: unknown } | null)?.adoptLegacy === true)) } };
      if (r[2] === 'stop' && method === 'POST') { await stop(r[1]); return { status: 200, json: { ok: true } }; }
      if (!r[2] && method === 'DELETE') { await remove(r[1]); return { status: 200, json: { ok: true } }; }
      throw new ManagerError(405, 'método não permitido');
    } catch (e) {
      return { status: e instanceof ManagerError ? e.status : 500, json: { error: (e as Error).message.slice(0, 300) } };
    }
  }
  return { handle, ensure, stop, remove, list };
}

/** Docker Engine API pelo socket (ou por um endereço, nos testes). */
export function dockerOver(socketPath: string | null, baseUrl: string | null): DockerCall {
  return (method, path, body) => new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const target = baseUrl ? new URL(baseUrl) : null;
    const req = http.request({
      ...(target ? { hostname: target.hostname, port: target.port } : { socketPath: socketPath! }),
      method, path: `/v1.41${path}`, headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': data.length } : {}) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const raw = Buffer.concat(chunks).toString('utf8'); let json: unknown = null; try { json = raw ? JSON.parse(raw) : null; } catch { json = { message: raw.slice(0, 200) }; } resolve({ status: res.statusCode ?? 0, json }); });
    });
    req.on('error', reject);
    req.setTimeout(120_000, () => req.destroy(new Error('Docker não respondeu')));
    if (data) req.write(data);
    req.end();
  });
}

/** Servidor HTTP do gerente (rede interna do Ergon). */
export function serveManager(c: ManagerConfig, docker: DockerCall, port: number, host = '0.0.0.0'): http.Server {
  const m = createManager(c, docker);
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = []; let size = 0;
    req.on('data', (x: Buffer) => { size += x.length; if (size > 4096) req.destroy(); else chunks.push(x); });
    req.on('end', async () => {
      let body: unknown = null;
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null; } catch { body = null; }
      const out = await m.handle(req.method ?? 'GET', (req.url ?? '/').split('?')[0], req.headers['x-ergon-manager-token'] as string | undefined, body);
      res.writeHead(out.status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out.json));
    });
  });
  srv.listen(port, host);
  return srv;
}

/** "2g", "512m", "1536" (MB) → bytes */
export function memBytes(v: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*([gmk]?)b?$/i.exec(v.trim());
  if (!m) return 2 * 1024 ** 3;
  const n = Number(m[1]); const u = m[2].toLowerCase();
  return Math.round(n * (u === 'g' ? 1024 ** 3 : u === 'k' ? 1024 : 1024 ** 2));
}
