import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROBLEMAS_DO_TEAMS, linhaDoEstado, previaDaConta, problemaDoTeams } from './teams-app.ts';
import { idiomaAtual, setIdioma } from '../i18n/index.ts';

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
  assert.match(previaDaConta('outra_pessoa', 'Maria Souza', null).aviso!, /OUTRA PESSOA da sua organização, não/, 'sem organização, nada de parênteses vazios');
  assert.match(previaDaConta('sem_conferir', 'X', null).aviso!, /a sua conta Microsoft não está ligada/);
});

test('problemas da conexão têm texto leigo; com problema, a linha "os pedidos chegam" não promete o que não vai acontecer', () => {
  for (const k of ['assinatura', 'registro', 'revogada', 'versao', 'substituida', 'religar']) assert.ok(problemaDoTeams(k), k);
  assert.equal(problemaDoTeams('desconhecido'), null);
  assert.equal(problemaDoTeams('toString'), null, 'só os códigos da lista');
  assert.doesNotMatch(PROBLEMAS_DO_TEAMS.map(problemaDoTeams).join(' '), /Hermes|4401|4403|token|assinatura Ed25519|relé/i);
  assert.equal(linhaDoEstado('offline', 'registro'), null);
  assert.match(linhaDoEstado('offline', undefined)!, /guardados por até 7 dias/);
  assert.equal(linhaDoEstado('connected', undefined), 'Conectado.');
});

test('em inglês: a prévia e os problemas trocam de língua, sem jargão', async () => {
  const antes = idiomaAtual();
  await setIdioma('en', { guardar: false });
  try {
    assert.match(previaDaConta('sua', 'Maria Souza', null).pergunta, /^Link your Teams account \(Maria Souza\)\?$/);
    assert.match(previaDaConta('outra_pessoa', 'Maria Souza', 'empresa.com.br').aviso!, /ANOTHER PERSON in your organization \(empresa\.com\.br\)/);
    const textos = [...PROBLEMAS_DO_TEAMS.map(problemaDoTeams), linhaDoEstado('offline', undefined)].join(' ');
    assert.doesNotMatch(textos, /token|engine|container|relay|Hermes/i);
    assert.equal(linhaDoEstado('connected', undefined), 'Connected.');
  } finally { await setIdioma(antes, { guardar: false }); }
});
