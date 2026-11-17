import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ehAudio } from './recursos.ts';

test('áudio: pelo tipo ou pela extensão (o player e a transcrição na conversa)', () => {
  assert.ok(ehAudio({ filename: 'nota.m4a', mime: 'application/octet-stream' }));
  assert.ok(ehAudio({ filename: 'audio-2026-11-17-1432.webm', mime: 'audio/webm' }));
  assert.ok(!ehAudio({ filename: 'a.pdf', mime: 'application/pdf' }));
});
