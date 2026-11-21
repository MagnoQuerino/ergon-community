// O estado da sincronia e da nuvem em linguagem de gente (sinc-estado.ts): a linha do quadro, o selo do cartão do
// workspace e a linha do cartão "Subir o WS para o World".
//   node --test src/views/world/sinc-estado.test.ts   (roda pelo npm test via lib/sinc-estado-world.test.ts)
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fraseDaPendencia, lerAppState, linhaDaNuvem, quadroDaSincronia, type SyncAuto, type SyncStatus } from './sinc-estado.ts';
import { tw } from './textos.ts';

const F = { hora: (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`, dia: (d: Date) => `${d.getDate()}/${d.getMonth() + 1}` };
const AGORA = new Date(2026, 10, 21, 15, 0, 0);
const hoje = new Date(2026, 10, 21, 14, 37, 0).toISOString(); const ontem = new Date(2026, 10, 20, 9, 5, 0).toISOString();
const auto = (x: Partial<SyncAuto> = {}): SyncAuto => ({ auto: true, ultimaOk: hoje, ultimaTentativa: hoje, pendencia: null, equipeRetida: false, nuvem: null, ...x });
const base: SyncStatus = { bound: true, enabled: true, conflicts: 0, auto: auto(), atividade: { ativo: false, fase: null, pausada: false } };
const q = (s: Partial<SyncStatus>) => quadroDaSincronia({ ...base, ...s }, tw, F, AGORA);
const pend = (codigo: string, vezes = 1, passo: NonNullable<SyncAuto['pendencia']>['passo'] = 'enviar') => ({ codigo, passo, desde: hoje, vezes });

test('em dia: a hora da última sincronia (e o dia, se não foi hoje); o selo diz o mesmo', () => {
  const r = q({});
  assert.deepEqual([r.situacao, r.tom, r.linha, r.selo, r.seloTom, r.pendente], ['em_dia', 'ok', 'Em dia · às 14:37', 'sincronia em dia', 'ok', null]);
  assert.equal(q({ auto: auto({ ultimaOk: ontem }) }).linha, 'Em dia · 20/11 às 09:05');
});
test('enviando e recebendo: enquanto há dados indo ou vindo', () => {
  assert.deepEqual([q({ atividade: { ativo: true, fase: 'enviando', pausada: false } }).linha, q({ atividade: { ativo: true, fase: 'recebendo', pausada: false } }).linha], ['Enviando…', 'Recebendo…']);
  assert.equal(q({ atividade: { ativo: true, fase: 'enviando', pausada: false } }).selo, 'sincronizando');
});
test('desligada, começando, em pausa e servidor sem a sincronia automática', () => {
  assert.deepEqual([q({ enabled: false }).situacao, q({ enabled: false }).selo], ['desligada', 'sincronia desligada']);
  assert.equal(q({ auto: auto({ ultimaOk: null }) }).situacao, 'comecando');
  assert.equal(q({ atividade: { ativo: false, fase: null, pausada: true } }).situacao, 'pausada');
  assert.deepEqual([q({ auto: null }).situacao, q({ auto: null, lastSyncAt: hoje }).linha], ['manual', 'Sincronia automática desligada · às 14:37']);
});
test('algo pendente: diz o quê; tropeço passageiro só vira aviso depois de se repetir', () => {
  assert.equal(q({ auto: auto({ pendencia: pend('world_offline', 1) }) }).situacao, 'em_dia');
  const r = q({ auto: auto({ pendencia: pend('world_offline', 2) }) });
  assert.deepEqual([r.situacao, r.tom, r.selo, r.seloTom], ['pendente', 'warn', 'sincronia pendente', 'warn']);
  assert.match(r.linha, /^Algo pendente · às 14:37$/);
  assert.match(r.pendente!, /Sem conexão com o Ergon World/);
  assert.equal(fraseDaPendencia(pend('version_conflict', 2), tw), null);
  assert.match(fraseDaPendencia(pend('version_conflict', 3), tw)!, /ao mesmo tempo/);
  assert.match(fraseDaPendencia(pend('key_pending'), tw)!, /chave nova/);
  assert.match(fraseDaPendencia(pend('rotation_required'), tw)!, /quem administra/);
  assert.match(fraseDaPendencia(pend('sync_forbidden', 1, 'enviar'), tw)!, /só acompanha/);
  assert.match(fraseDaPendencia(pend('sync_forbidden', 1, 'giro'), tw)!, /quem administra/);
  assert.match(fraseDaPendencia(pend('internal', 1, 'chave'), tw)!, /um dos aparelhos/);
  assert.match(fraseDaPendencia(pend('algo_novo'), tw)!, /\(algo_novo\)/);
});
test('o que pede decisão: equipe nova retida (antes de tudo), conflitos e a frase de recuperação', () => {
  const e = q({ conflicts: 2, recoveryOutdated: true, auto: auto({ equipeRetida: true, pendencia: pend('world_offline', 5) }) });
  assert.deepEqual([e.situacao, e.linha, e.decisoes, e.selo], ['decisao', 'Equipe nova de outro computador', ['conflitos', 'equipe', 'frase'], 'sincronia espera você']);
  assert.equal(q({ conflicts: 1 }).linha, '1 item mudou nos dois computadores');
  assert.equal(q({ conflicts: 3 }).linha, '3 itens mudaram nos dois computadores');
  // só a frase velha não tira o "em dia" (o aviso dela aparece ao lado)
  assert.deepEqual([q({ recoveryOutdated: true }).situacao, q({ recoveryOutdated: true }).decisoes], ['em_dia', ['frase']]);
});

test('o que o contêiner conta: estado e detalhe', () => {
  assert.deepEqual(lerAppState('preparando: ligando a equipe de IA (a primeira vez leva alguns minutos)'), { estado: 'preparando', detalhe: 'ligando a equipe de IA (a primeira vez leva alguns minutos)' });
  assert.deepEqual([lerAppState('pronto'), lerAppState(null), lerAppState('outra coisa')], [{ estado: 'pronto', detalhe: null }, { estado: null, detalhe: null }, { estado: null, detalhe: null }]);
});
const n = (d: Parameters<typeof linhaDaNuvem>[0], o?: Parameters<typeof linhaDaNuvem>[2]) => linhaDaNuvem(d, tw, o);
test('a nuvem esperando a chave; sem a sincronia aqui, diz o que fazer', () => {
  const r = n({ active: true, runtime: 'rodando', appState: 'aguardando_chave: Abra o Ergon no seu computador uma vez.', keyWanted: true }, { syncLigada: true })!;
  assert.deepEqual(r, { texto: 'Esperando a chave…', tom: 'info', preparando: true });
  // World antigo (sem keyWanted): pelo estado do contêiner
  assert.equal(n({ active: true, runtime: 'rodando', appState: 'aguardando_chave' })!.texto, r.texto);
  const sem = n({ active: true, runtime: 'rodando', appState: 'aguardando_chave', keyWanted: true }, { syncLigada: false })!;
  assert.deepEqual([sem.tom, /ligue a sincronia/.test(sem.texto)], ['warn', true]);
  // a chave já foi entregue (keyWanted falso) e o contêiner ainda não contou o passo seguinte: não fica dizendo "esperando a chave"
  assert.equal(n({ active: true, runtime: 'rodando', appState: 'aguardando_chave: x', keyWanted: false })!.texto, 'Preparando…');
});
test('a nuvem preparando (cada passo), pronta, dormindo, com erro, na fila, pausada, sem sinal', () => {
  assert.equal(n({ active: true, runtime: 'rodando', appState: 'preparando: recebendo a equipe e as conversas do computador', keyWanted: false })!.texto, 'Preparando: recebendo os dados…');
  assert.equal(n({ active: true, runtime: 'rodando', appState: 'preparando: ligando a equipe de IA (a primeira vez leva alguns minutos)' })!.texto, 'Preparando: ligando a equipe de IA…');
  assert.equal(n({ active: true, runtime: 'rodando', appState: 'preparando: ligando o modelo da equipe: falhou' })!.texto, 'Preparando: ligando o modelo…');
  assert.equal(n({ active: true, runtime: 'rodando', appState: 'preparando: ligando os canais (Telegram, Discord, Teams)' })!.texto, 'Preparando: ligando os canais…');
  assert.deepEqual(n({ active: true, runtime: 'rodando', appState: 'pronto', keyWanted: false }), { texto: 'Pronta', tom: 'ok', preparando: false });
  assert.deepEqual([n({ active: true, runtime: 'rodando', appState: null })!.texto, n({ active: true, runtime: 'rodando', appState: null })!.preparando], ['Ligando…', true]);
  const dorme = n({ active: true, runtime: 'dormindo', appState: 'pronto', keyWanted: false })!;
  assert.deepEqual([dorme.tom, /^Pronta · dormindo$/.test(dorme.texto), dorme.preparando], ['ok', true, false]);
  // o caso de produção: dormindo sem nunca ter recebido a chave não é "pronta · dormindo"
  assert.match(n({ active: true, runtime: 'dormindo', appState: 'aguardando_chave: x', keyWanted: true }, { syncLigada: true })!.texto, /sem a chave da sincronia/);
  assert.match(n({ active: true, runtime: 'dormindo', appState: 'preparando: ligando a equipe de IA' })!.texto, /^Dormindo$/);
  assert.equal(n({ active: true, runtime: 'rodando', appState: 'erro: conta local: 500' })!.texto, 'Com problema; tentando de novo: conta local: 500');
  assert.equal(n({ active: true, runtime: 'erro', runtimeError: null })!.tom, 'warn');
  assert.deepEqual([n({ active: true, runtime: 'fila' })!.texto, n({ active: true, runtime: 'pausado' })!.texto, n({ active: true, runtime: 'desconhecido' })!.tom], ['Na fila: já já', 'Pausada pela Equipe Ergon', 'warn']);
  assert.match(n({ active: true, runtime: 'parado' })!.texto, /^Desligada$/);
  assert.equal(n({ active: false }), null);
});
