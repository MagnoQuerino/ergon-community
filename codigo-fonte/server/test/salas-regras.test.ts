// As regras puras das Salas (services/salas/marcas.ts): marcas formadas pela tela, permissão efetiva por pedido, prazo da
// cessão e o limite de agente chamando agente.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cessaoVale, chamadaDoAgente, conferirMarcas, expiraEm, MAX_AGENTES, permissaoEfetiva, podeChamarAgente, semControle, type Membro } from '../src/services/salas/marcas.ts';

const membros: Membro[] = [
  { tipo: 'pessoa', chave: 'acc:rogerio', nome: 'Rogério' }, { tipo: 'pessoa', chave: 'acc:ana', nome: 'Ana' },
  { tipo: 'agente', chave: 'Aristóteles', nome: 'Aristóteles' }, { tipo: 'agente', chave: 'Hipátia', nome: 'Hipátia' },
];
const pos = (t: string, trecho: string) => { const i = t.indexOf(trecho); return { inicio: i, fim: i + trecho.length }; };

test('marcas: só valem as que a tela formou, com o trecho igual ao marcador + nome de quem está na sala', () => {
  const t = '@Aristóteles, preciso de um resumo da semana. #Ana';
  const m = conferirMarcas(t, [{ tipo: 'agente', chave: 'Aristóteles', ...pos(t, '@Aristóteles') }, { tipo: 'cessao', chave: 'acc:ana', ...pos(t, '#Ana') }], membros, 'acc:rogerio');
  assert.deepEqual(m.agentes, ['Aristóteles']);
  assert.deepEqual(m.cessoes, ['acc:ana']);
  assert.deepEqual(m.pessoas, []);
  // o mesmo texto SEM marcas: nada (o servidor nunca varre o texto)
  assert.deepEqual(conferirMarcas(t, undefined, membros, 'acc:rogerio'), { pessoas: [], agentes: [], cessoes: [], marcas: [] });
  assert.deepEqual(conferirMarcas(t, [], membros, 'acc:rogerio').agentes, []);
});

test('marcas: fora do texto, trecho diferente, quem não está na sala, a si mesmo, sobreposta ou repetida caem caladas', () => {
  const t = '@Ana e @Hipátia, olhem isto @Ana';
  const fora = { tipo: 'pessoa', chave: 'acc:ana', inicio: 40, fim: 44 };
  const errado = { tipo: 'pessoa', chave: 'acc:ana', inicio: 8, fim: 16 }; // aponta para "@Hipátia"
  const estranho = { tipo: 'pessoa', chave: 'acc:zoe', ...pos(t, '@Ana') };
  const eu = { tipo: 'pessoa', chave: 'acc:rogerio', ...pos(t, '@Ana') };
  const ok = { tipo: 'pessoa', chave: 'acc:ana', ...pos(t, '@Ana') };
  const repetida = { tipo: 'pessoa', chave: 'acc:ana', inicio: t.lastIndexOf('@Ana'), fim: t.lastIndexOf('@Ana') + 4 };
  const agenteComoPessoa = { tipo: 'pessoa', chave: 'Hipátia', ...pos(t, '@Hipátia') };
  const lixo = [null, 3, 'x', { tipo: 'outro', chave: 'acc:ana', inicio: 0, fim: 4 }, { tipo: 'pessoa', chave: 'acc:ana', inicio: 0.5, fim: 4 }];
  const m = conferirMarcas(t, [fora, errado, estranho, eu, ok, repetida, agenteComoPessoa, ...lixo], membros, 'acc:rogerio');
  assert.deepEqual(m.pessoas, ['acc:ana']);
  assert.equal(m.marcas.length, 1);
  // cessão é só para pessoa; agente não cede conexões
  const c = '#Hipátia';
  assert.deepEqual(conferirMarcas(c, [{ tipo: 'cessao', chave: 'Hipátia', inicio: 0, fim: c.length }], membros, 'acc:rogerio').cessoes, []);
});

test('marcas: no máximo MAX_AGENTES agentes por mensagem, na ordem do texto', () => {
  const nomes = Array.from({ length: 8 }, (_, i) => `Ag${i}`);
  const ms: Membro[] = nomes.map((n) => ({ tipo: 'agente', chave: n, nome: n }));
  const t = nomes.map((n) => `@${n}`).join(' ');
  const marcas = nomes.map((n) => ({ tipo: 'agente', chave: n, ...pos(t, `@${n}`) })).reverse();
  const m = conferirMarcas(t, marcas, ms, 'acc:x');
  assert.equal(m.agentes.length, MAX_AGENTES);
  assert.deepEqual(m.marcas.map((x) => x.chave), [...m.marcas.map((x) => x.chave)].sort((a, b) => t.indexOf(a) - t.indexOf(b)));
});

test('permissão efetiva: as conexões daqui são de quem pediu; de outra pessoa, só cedidas e com a governança ligada', () => {
  const base = { dono: 'acc:ana', papelPedinte: 'editor' as const, risco: 'enviar', cessaoAtiva: false, governancaCessao: true };
  assert.equal(permissaoEfetiva({ ...base, pedinte: 'acc:ana' }), 'propria');
  assert.equal(permissaoEfetiva({ ...base, pedinte: 'acc:rogerio' }), 'sem_acesso');
  assert.equal(permissaoEfetiva({ ...base, pedinte: 'acc:rogerio', cessaoAtiva: true }), 'cedida');
  assert.equal(permissaoEfetiva({ ...base, pedinte: 'acc:rogerio', cessaoAtiva: true, governancaCessao: false }), 'sem_acesso', 'governança desligada: só a permissão de quem pediu');
  // leitura (viewer) não pede ação com efeito, nem com as próprias conexões; consultar pode
  assert.equal(permissaoEfetiva({ ...base, pedinte: 'acc:ana', papelPedinte: 'viewer' }), 'so_leitura');
  assert.equal(permissaoEfetiva({ ...base, pedinte: 'acc:ana', papelPedinte: 'viewer', risco: 'ler' }), 'propria');
  assert.equal(permissaoEfetiva({ ...base, pedinte: 'acc:rogerio', papelPedinte: null, cessaoAtiva: true }), 'sem_acesso', 'saiu do workspace');
  // a nuvem do workspace: as conexões são da conta dona; outra pessoa só com cessão da dona
  const nuvem = { ...base, dono: 'acc:dona' };
  assert.equal(permissaoEfetiva({ ...nuvem, pedinte: 'acc:dona' }), 'propria');
  assert.equal(permissaoEfetiva({ ...nuvem, pedinte: 'acc:ana' }), 'sem_acesso');
});

test('cessão: prazos, expiração, só desta vez e revogada', () => {
  const t0 = Date.parse('2026-11-21T12:00:00.000Z');
  const ped = { pedinte: 'acc:rogerio', origem: 'msg_a' };
  const c = (prazo: '24h' | '7d' | '30d' | 'sempre' | 'vez', extra: Partial<{ message_id: string | null; revogada_em: string | null; pedinte_chave: string }> = {}) =>
    ({ prazo, pedinte_chave: 'acc:rogerio', message_id: 'msg_a', expira_em: expiraEm(prazo, t0), revogada_em: null, ...extra });
  assert.equal(expiraEm('24h', t0), '2026-11-22T12:00:00.000Z');
  assert.equal(expiraEm('7d', t0), '2026-11-28T12:00:00.000Z');
  assert.equal(expiraEm('30d', t0), '2026-12-21T12:00:00.000Z');
  assert.equal(expiraEm('sempre', t0), null);
  assert.equal(cessaoVale(c('24h'), ped, t0 + 3_600_000), true);
  assert.equal(cessaoVale(c('24h'), ped, t0 + 86_400_001), false, 'venceu');
  assert.equal(cessaoVale(c('7d'), { ...ped, origem: 'msg_b' }, t0 + 6 * 86_400_000), true, 'outro pedido da mesma pessoa na mesma sala, dentro do prazo');
  assert.equal(cessaoVale(c('sempre'), ped, t0 + 900 * 86_400_000), true);
  assert.equal(cessaoVale(c('vez'), ped, t0 + 900 * 86_400_000), true);
  assert.equal(cessaoVale(c('vez'), { ...ped, origem: 'msg_b' }, t0), false, 'só desta vez: outro pedido não usa');
  assert.equal(cessaoVale(c('sempre', { revogada_em: '2026-11-21T13:00:00.000Z' }), ped, t0), false);
  assert.equal(cessaoVale(c('sempre'), { ...ped, pedinte: 'acc:caio' }, t0), false, 'cedida a quem pediu, não a qualquer um');
});

test('agente chamando agente: uma vez por mensagem humana, profundidade 1, pela linha de controle (não por @)', () => {
  assert.equal(podeChamarAgente(0, 0), true);
  assert.equal(podeChamarAgente(0, 1), false, 'a mensagem humana já gastou a chamada');
  assert.equal(podeChamarAgente(1, 0), false, 'quem foi chamado não chama');
  assert.deepEqual(chamadaDoAgente('Vou pedir ajuda.\n[[chamar agente="Hipátia" pedido="confira os números"]]'), { agente: 'Hipátia', pedido: 'confira os números' });
  assert.equal(chamadaDoAgente('@Hipátia, confira os números'), null, 'texto com @ não chama ninguém');
  assert.equal(semControle('Feito.\n[[chamar agente="Hipátia"]]'), 'Feito.');
});
