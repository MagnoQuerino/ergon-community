// Worker de teste: morre de repente, sem responder.
import { parentPort } from 'node:worker_threads';
parentPort!.once('message', () => { process.exit(7); });
