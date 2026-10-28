// Backup consistente com o servidor em execução. Imprime só o nome do arquivo.
//   docker compose exec -T ergon node server/src/backup-cli.ts
// Com o Ergon protegido, o banco só abre no processo do servidor (a chave fica na memória dele): pede o backup
// a ele pela rota interna. O arquivo sai cifrado com a mesma chave (só abre com a senha ou a frase).
import { loadConfig } from './config.ts';

const cfg = loadConfig();
const res = await fetch(`http://127.0.0.1:${cfg.port}/internal/admin/backup`, { method: 'POST', headers: { 'X-Ergon-Bridge-Token': cfg.bridgeToken ?? '' } })
  .catch(() => null);
if (!res) { console.error('o servidor do Ergon não respondeu (está trancado ou parado?)'); process.exit(1); }
const j = await res.json().catch(() => ({})) as { file?: string; message?: string };
if (!res.ok || !j.file) { console.error(`backup recusado: ${j.message ?? res.status}`); process.exit(1); }
console.log(j.file);
