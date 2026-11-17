// Mensagem de áudio (rc.33): a máquina de estados do gravador da conversa (o componente GravadorDeVoz.tsx só liga ao
// microfone): pedir o microfone, gravar com o relógio, cancelar, enviar, parar sozinho em 10:00 e a recusa do microfone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAVACAO_BITS, GRAVACAO_MAX_MS, PARADO, formatoDeGravacao, gravador, microfoneAberto, motivoDoErro, nomeDaGravacao, relogio, type EstadoGravador, type EventoGravador } from './gravador.ts';

const rodar = (evs: EventoGravador[], de: EstadoGravador = PARADO) => evs.reduce(gravador, de);

test('gravar e enviar: pede o microfone, grava com o relógio, fecha o arquivo e volta ao começo', () => {
  let e = gravador(PARADO, { tipo: 'iniciar' });
  assert.deepEqual(e, { fase: 'pedindo' });
  e = gravador(e, { tipo: 'permitido', agora: 1000 });
  assert.deepEqual(e, { fase: 'gravando', inicio: 1000, ms: 0 });
  assert.ok(microfoneAberto(e));
  e = gravador(e, { tipo: 'tique', agora: 8500 });
  assert.equal(e.fase === 'gravando' && relogio(e.ms), '0:07');
  e = gravador(e, { tipo: 'enviar', agora: 9000 });
  assert.deepEqual(e, { fase: 'fechando', ms: 8000, motivo: 'enviar' });
  assert.deepEqual(gravador(e, { tipo: 'enviar', agora: 9500 }), e, 'dois cliques em enviar: um arquivo só');
  assert.deepEqual(gravador(e, { tipo: 'fechado' }), PARADO);
});

test('para sozinho em 10:00 (o arquivo fica no campo, para conferir)', () => {
  const e = rodar([{ tipo: 'iniciar' }, { tipo: 'permitido', agora: 0 }, { tipo: 'tique', agora: GRAVACAO_MAX_MS - 1 }]);
  assert.equal(e.fase, 'gravando');
  const fim = gravador(e, { tipo: 'tique', agora: GRAVACAO_MAX_MS + 300 });
  assert.deepEqual(fim, { fase: 'fechando', ms: GRAVACAO_MAX_MS, motivo: 'limite' }, 'o relógio nunca passa de 10:00');
  assert.equal(relogio(GRAVACAO_MAX_MS), '10:00');
  assert.deepEqual(gravador(fim, { tipo: 'tique', agora: GRAVACAO_MAX_MS + 900 }), fim, 'tique atrasado não muda nada');
});

test('cancelar: em qualquer ponto antes de fechar, sem arquivo', () => {
  assert.deepEqual(rodar([{ tipo: 'iniciar' }, { tipo: 'cancelar' }]), PARADO, 'enquanto o navegador pergunta');
  assert.deepEqual(rodar([{ tipo: 'iniciar' }, { tipo: 'permitido', agora: 0 }, { tipo: 'tique', agora: 3000 }, { tipo: 'cancelar' }]), PARADO);
  assert.deepEqual(rodar([{ tipo: 'iniciar' }, { tipo: 'permitido', agora: 0 }, { tipo: 'cancelar' }, { tipo: 'tique', agora: 9000 }]), PARADO, 'tique depois de cancelar');
  const fechando = rodar([{ tipo: 'iniciar' }, { tipo: 'permitido', agora: 0 }, { tipo: 'enviar', agora: 2000 }]);
  assert.equal(gravador(fechando, { tipo: 'cancelar' }).fase, 'fechando', 'depois de enviar, o arquivo segue');
});

test('microfone negado: uma frase curta, e dá para tentar de novo', () => {
  const negado = rodar([{ tipo: 'iniciar' }, motivoDoErro(Object.assign(new Error('x'), { name: 'NotAllowedError' }))]);
  assert.deepEqual(negado, { fase: 'negado' });
  assert.ok(!microfoneAberto(negado));
  assert.deepEqual(gravador(negado, { tipo: 'iniciar' }), { fase: 'pedindo' });
  assert.deepEqual(gravador(negado, { tipo: 'cancelar' }), PARADO, 'fechar o aviso');
  assert.deepEqual(motivoDoErro({ name: 'NotFoundError' }), { tipo: 'erro', motivo: 'sem_microfone' });
  assert.deepEqual(motivoDoErro({ name: 'SecurityError' }), { tipo: 'negado' });
  assert.deepEqual(motivoDoErro(null), { tipo: 'erro', motivo: 'falhou' });
  assert.deepEqual(rodar([{ tipo: 'iniciar' }, { tipo: 'erro', motivo: 'sem_suporte' }]), { fase: 'erro', motivo: 'sem_suporte' });
  assert.deepEqual(gravador(PARADO, { tipo: 'permitido', agora: 0 }), PARADO, 'permissão sem pedido não grava');
});

test('formato: WebM/Opus onde dá, Ogg/Opus, MP4 no Safari; 32 kbit/s; nome com data e hora', () => {
  assert.deepEqual(formatoDeGravacao((x) => x.startsWith('audio/webm')), { mime: 'audio/webm;codecs=opus', ext: 'webm', tipo: 'audio/webm' });
  assert.equal(formatoDeGravacao((x) => x === 'audio/ogg;codecs=opus')?.ext, 'ogg');
  assert.equal(formatoDeGravacao((x) => x === 'audio/mp4')?.ext, 'm4a');
  assert.equal(formatoDeGravacao(() => false), null);
  assert.equal(formatoDeGravacao(() => { throw new Error('x'); }), null, 'navegador que lança: sem formato, sem travar');
  assert.ok(GRAVACAO_BITS >= 24_000 && GRAVACAO_BITS <= 32_000);
  assert.equal(nomeDaGravacao(new Date(2026, 10, 17, 14, 3), 'webm'), 'audio-2026-11-17-1403.webm');
  assert.equal(relogio(-5), '0:00');
  assert.equal(relogio(65_000), '1:05');
});
