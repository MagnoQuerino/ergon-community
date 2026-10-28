// Worker de teste: cresce aos poucos até passar do teto de memória (o worker morre, o servidor segue).
import { parentPort } from 'node:worker_threads';
parentPort!.once('message', () => {
  const keep: unknown[] = [];
  for (let i = 0; ; i++) keep.push(Array.from({ length: 2000 }, (_, k) => ({ i, k, s: `v${i}-${k}` })));
});
