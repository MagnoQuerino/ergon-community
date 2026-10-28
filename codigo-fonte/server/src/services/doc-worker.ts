// Leitura de um documento fora do processo principal (doc-isolated.ts): recebe o arquivo, devolve o texto.
import { parentPort } from 'node:worker_threads';
import { extractDoc } from './doc-text.ts';

parentPort!.once('message', (m: { name: string; mime: string; data: Uint8Array }) => {
  parentPort!.postMessage(extractDoc(m.name, m.mime, Buffer.from(m.data.buffer, m.data.byteOffset, m.data.byteLength)));
});
