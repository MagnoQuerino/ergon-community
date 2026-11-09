import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROBLEMA_TEAMS, linhaDoEstado, previaDaConta } from './teams-app.ts';

test('prévia: só a conta conferida como a sua dispensa a escolha consciente; outra organização tem o aviso forte', () => {
  const sua = previaDaConta('sua', 'Maria Souza', 'empresa.com.br');
  assert.equal(sua.exigeEscolha, false); assert.equal(sua.aviso, null); assert.match(sua.pergunta, /a sua conta do Teams \(Maria Souza\)/);
  for (const c of ['outra_pessoa', 'organizacao', 'outra_organizacao', 'sem_conferir', undefined] as const) {
    const p = previaDaConta(c, 'Maria Souza', null);
    assert.equal(p.exigeEscolha, true, String(c)); assert.ok(p.aviso && /Só continue se foi você que pediu o código no seu próprio Teams\./.test(p.aviso), String(c));
  }
  assert.equal(previaDaConta('outra_organizacao', 'Maria Souza', null).forte, true);
  assert.match(previaDaConta('outra_organizacao', 'Maria Souza', null).aviso!, /OUTRA ORGANIZAÇÃO/);
  assert.match(previaDaConta('outra_pessoa', 'Maria Souza', 'empresa.com.br').aviso!, /OUTRA PESSOA da sua organização \(empresa\.com\.br\)/);
  assert.match(previaDaConta('sem_conferir', 'X', null).aviso!, /a sua conta Microsoft não está ligada/);
});

test('problemas da conexão têm texto leigo; com problema, a linha "os pedidos chegam" não promete o que não vai acontecer', () => {
  for (const k of ['assinatura', 'registro', 'revogada', 'versao', 'substituida', 'religar']) assert.ok(PROBLEMA_TEAMS[k], k);
  assert.doesNotMatch(Object.values(PROBLEMA_TEAMS).join(' '), /Hermes|4401|4403|token|assinatura Ed25519|relé/i);
  assert.equal(linhaDoEstado('offline', 'registro'), null);
  assert.match(linhaDoEstado('offline', undefined)!, /guardados por até 7 dias/);
  assert.equal(linhaDoEstado('connected', undefined), 'Conectado.');
});
