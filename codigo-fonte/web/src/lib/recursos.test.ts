import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audiosParaTranscrever, ehAudio } from './recursos.ts';

const audio = (id: string) => ({ id, filename: `${id}.ogg`, mime: 'audio/ogg', size: 1 });
const doc = { id: 'f-doc', filename: 'a.pdf', mime: 'application/pdf', size: 1 };

test('transcrição automática: só áudio novo da pessoa, cada um tentado uma vez', () => {
  const desde = Date.parse('2026-11-12T10:00:00Z');
  const list = [
    { role: 'user', created_at: '2026-11-12T09:00:00Z', attachments: [audio('velho')] },
    { role: 'agent', created_at: '2026-11-12T10:05:00Z', attachments: [audio('do-agente')] },
    { role: 'user', created_at: '2026-11-12T10:06:00Z', attachments: [audio('novo'), doc] },
  ];
  assert.deepEqual(audiosParaTranscrever(list, desde, new Set()).map((f) => f.id), ['novo'], 'nem o de antes, nem o do agente, nem o PDF');
  // já tentado (deu erro e saiu da lista de transcrições): não tenta de novo sozinho a cada mudança da conversa
  assert.deepEqual(audiosParaTranscrever(list, desde, new Set(['novo'])), []);
  assert.equal(audiosParaTranscrever([{ role: 'user', created_at: 'data ruim', attachments: [audio('x')] }], desde, new Set()).length, 0, 'data ilegível: não tenta');
  assert.ok(ehAudio({ filename: 'nota.m4a', mime: 'application/octet-stream' }) && !ehAudio(doc));
});
