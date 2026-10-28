/**
 * Ponto de entrada do gerente de motores (serviço "motores" do docker-compose.yml): o único contêiner com o socket
 * do Docker. Ver services/motor-manager.ts.
 */
import { dockerOver, memBytes, serveManager } from './services/motor-manager.ts';

const env = process.env;
const master = env.ERGON_BRIDGE_TOKEN ?? '';
if (master.length < 24) { console.error('gerente de motores: ERGON_BRIDGE_TOKEN ausente (hermes.env)'); process.exit(1); }
const port = Number(env.ERGON_MANAGER_PORT ?? 8645);
serveManager({
  master,
  image: env.ERGON_MOTOR_IMAGE ?? 'ergon-hermes:dev',
  network: env.ERGON_MOTOR_NETWORK ?? 'ergon-net',
  legacyVolume: env.ERGON_MOTOR_LEGACY_VOLUME ?? 'ergon_hermes-vault',
  volumePrefix: env.ERGON_MOTOR_VOLUME_PREFIX ?? 'ergon_motor-',
  bridgeUrl: env.ERGON_BRIDGE_URL ?? 'http://ergon:8787/internal/bridge/v1/events',
  memBytes: memBytes(env.HERMES_MEM_LIMIT ?? '2g'),
  nanoCpus: Math.round(Number(env.HERMES_CPUS ?? 2) * 1e9),
}, dockerOver(env.ERGON_DOCKER_URL ? null : (env.ERGON_DOCKER_SOCKET ?? '/var/run/docker.sock'), env.ERGON_DOCKER_URL ?? null), port);
console.log(JSON.stringify({ level: 'info', msg: `gerente de motores ouvindo na porta ${port} (rede interna)`, image: env.ERGON_MOTOR_IMAGE ?? 'ergon-hermes:dev' }));
