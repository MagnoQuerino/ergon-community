/**
 * Ponto de entrada do gerente de motores (serviço "motores" do docker-compose.yml): o único contêiner com o socket
 * do Docker. Ver services/motor-manager.ts.
 */
import { dockerOver, memBytes, selfContainerIds, serveManager } from './services/motor-manager.ts';

const env = process.env;
const master = env.ERGON_BRIDGE_TOKEN ?? '';
if (master.length < 24) { console.error('gerente de motores: ERGON_BRIDGE_TOKEN ausente (hermes.env)'); process.exit(1); }
const port = Number(env.ERGON_MANAGER_PORT ?? 8645);
const image = env.ERGON_MOTOR_IMAGE ?? 'ergon-hermes:dev';
serveManager({
  master,
  image,
  network: env.ERGON_MOTOR_NETWORK ?? 'ergon-net',
  legacyVolume: env.ERGON_MOTOR_LEGACY_VOLUME ?? 'ergon_hermes-vault',
  volumePrefix: env.ERGON_MOTOR_VOLUME_PREFIX ?? 'ergon_motor-',
  bridgeUrl: env.ERGON_BRIDGE_URL ?? 'http://ergon:8787/internal/bridge/v1/events',
  memBytes: memBytes(env.HERMES_MEM_LIMIT ?? '2g'),
  nanoCpus: Math.round(Number(env.HERMES_CPUS ?? 2) * 1e9),
  // o próprio contêiner (a imagem do núcleo): a limpeza protege a dele e só mexe nas do repositório dele e do motor
  selfIds: selfContainerIds(),
}, dockerOver(env.ERGON_DOCKER_URL ? null : (env.ERGON_DOCKER_SOCKET ?? '/var/run/docker.sock'), env.ERGON_DOCKER_URL ?? null), port, '0.0.0.0', (uids) => {
  if (uids.length) console.log(JSON.stringify({ level: 'info', msg: `motores parados renovados para a imagem configurada (sem ligar): ${uids.length}` }));
});
console.log(JSON.stringify({ level: 'info', msg: `gerente de motores ouvindo na porta ${port} (rede interna)`, image }));
