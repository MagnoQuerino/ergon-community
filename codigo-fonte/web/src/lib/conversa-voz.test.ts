// Conversa por voz (rc.41): o detector de fala por energia, a máquina de estados do modo mãos livres e a leitura do turno
// na conversa (o componente ConversaPorVoz.tsx só liga ao microfone, ao gravador e ao alto-falante).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  VAD_ESCUTA, VAD_INTERRUPCAO, VAD_PARADO, conversaVoz, limiarDoVad, microfoneLigado, modoDoVad, nivelNoMedidor, nivelRms, textoFalado, turnoDaMensagem, vad, vezDoAgente, voz0,
  type EstadoVad, type EstadoVoz, type EventoVoz, type MensagemDoTurno, type SinalVad, type VadCfg,
} from './conversa-voz.ts';

/** Passa uma trilha de níveis pelo detector: [nível, duração em ms] em medidas de `passo` ms. Devolve os sinais com a hora. */
function trilha(partes: Array<[number, number]>, cfg: VadCfg = VAD_ESCUTA, passo = 50, de: EstadoVad = VAD_PARADO) {
  let e = de; let t = 0;
  const sinais: Array<SinalVad & { t: number }> = [];
  for (const [nivel, ms] of partes) {
    for (const fim = t + ms; t < fim; t += passo) {
      const r = vad(e, nivel, t, cfg);
      e = r.e;
      if (r.sinal) sinais.push({ ...r.sinal, t });
    }
  }
  return { e, sinais, t };
}
const SILENCIO = 0.004; const FALA = 0.12;

test('VAD: fala seguida de silêncio fecha o trecho depois de 1,4 s, não antes', () => {
  const { sinais } = trilha([[SILENCIO, 1000], [FALA, 2000], [SILENCIO, 3000]]);
  assert.deepEqual(sinais.map((s) => s.tipo), ['inicio', 'fim']);
  const [ini, fim] = sinais;
  assert.ok(ini.tipo === 'inicio' && ini.em === 1000, 'o começo é a 1ª medida acima do limiar (o ataque não come a fala)');
  assert.ok(ini.t - 1000 >= VAD_ESCUTA.ataqueMs && ini.t - 1000 < VAD_ESCUTA.ataqueMs + 100);
  assert.ok(fim.tipo === 'fim' && fim.motivo === 'silencio');
  assert.ok(fim.t >= 3000 + VAD_ESCUTA.silencioFimMs - 50 && fim.t <= 3000 + VAD_ESCUTA.silencioFimMs + 100, `fechou em ${fim.t}`);
  assert.ok(fim.tipo === 'fim' && Math.abs(fim.vozMs - 2000) <= 100, 'a voz do trecho não conta o silêncio do fim');
});

test('VAD: pausa curta no meio da frase (respirar, pensar) não corta', () => {
  const { sinais } = trilha([[SILENCIO, 500], [FALA, 1500], [SILENCIO, 900], [FALA, 1200], [SILENCIO, 1200], [FALA, 800], [SILENCIO, 2500]]);
  assert.deepEqual(sinais.map((s) => s.tipo), ['inicio', 'fim'], 'um trecho só');
  const fim = sinais[1];
  assert.ok(fim.tipo === 'fim' && Math.abs(fim.vozMs - 3500) <= 200);
});

test('VAD: estalo, tecla e ruído curto não viram mensagem', () => {
  // estalo mais curto que o ataque: nem começa
  assert.deepEqual(trilha([[SILENCIO, 500], [0.5, 100], [SILENCIO, 3000]]).sinais, []);
  // uma batida de 250 ms: começa, mas tem pouca voz e é descartada
  const batida = trilha([[SILENCIO, 500], [0.5, 250], [SILENCIO, 3000]]).sinais;
  assert.deepEqual(batida.map((s) => s.tipo), ['inicio', 'descartado']);
  // silêncio puro e chiado baixo: nada
  assert.deepEqual(trilha([[0, 5000]]).sinais, []);
  assert.deepEqual(trilha([[0.012, 8000]]).sinais, []);
});

test('VAD: o limiar acompanha o ruído da sala (ventilador não é fala; falar mais alto que ele é)', () => {
  const sala = trilha([[0.015, 20_000]]);
  assert.deepEqual(sala.sinais, []);
  assert.ok(limiarDoVad(sala.e, VAD_ESCUTA) > 0.04, 'o limiar subiu com o ruído');
  assert.deepEqual(trilha([[0.03, 3000]], VAD_ESCUTA, 50, { ...sala.e, ultimo: null }).sinais, [], 'pouco acima do ruído: não é fala');
  assert.equal(trilha([[0.12, 1000], [0.015, 2500]], VAD_ESCUTA, 50, { ...sala.e, ultimo: null }).sinais.at(-1)?.tipo, 'fim');
  // o ruído estimado tem teto: gritaria de fundo não desliga o detector
  assert.ok(limiarDoVad(trilha([[0.019, 600_000]]).e, VAD_ESCUTA) <= 0.04 * VAD_ESCUTA.fatorRuido);
});

test('VAD: trecho no teto fecha sozinho (bem antes dos 10 minutos do áudio)', () => {
  const { sinais } = trilha([[FALA, 10 * 60_000]], VAD_ESCUTA, 250);
  const fim = sinais.find((s) => s.tipo === 'fim');
  assert.ok(fim && fim.tipo === 'fim' && fim.motivo === 'limite');
  assert.ok(fim.ms >= VAD_ESCUTA.maxMs && fim.ms < 10 * 60_000 - 20_000);
});

test('VAD com o agente falando: o eco não interrompe; a fala firme por cima, sim', () => {
  // o eco da resposta no alto-falante (nível médio) e um "ahã" curto não contam
  assert.deepEqual(trilha([[0.05, 6000]], VAD_INTERRUPCAO).sinais, []);
  assert.deepEqual(trilha([[SILENCIO, 500], [0.2, 250], [SILENCIO, 1000]], VAD_INTERRUPCAO).sinais, []);
  // o mesmo nível, escutando, seria fala
  assert.equal(trilha([[0.05, 1000]], VAD_ESCUTA).sinais[0]?.tipo, 'inicio');
  const s = trilha([[0.05, 1000], [0.2, 800]], VAD_INTERRUPCAO).sinais;
  assert.equal(s[0]?.tipo, 'inicio');
  assert.ok(s[0].t - 1000 >= VAD_INTERRUPCAO.ataqueMs);
});

test('VAD: a fala oscila entre as sílabas e ainda conta como fala; dois estalos seguidos, não', () => {
  // sílabas de 120 ms com vales de 100 ms abaixo do limiar, por 2 s: abre nos dois modos
  const silabas: Array<[number, number]> = Array.from({ length: 9 }, () => [[0.2, 120], [0.01, 100]] as Array<[number, number]>).flat();
  assert.equal(trilha([[SILENCIO, 500], ...silabas, [SILENCIO, 2500]], VAD_ESCUTA, 20).sinais.map((s) => s.tipo).join(), 'inicio,fim');
  assert.equal(trilha([[SILENCIO, 500], ...silabas], VAD_INTERRUPCAO, 20).sinais[0]?.tipo, 'inicio', 'falar por cima com voz normal interrompe');
  // duas batidas (60 ms cada, 150 ms entre elas) com o agente falando: não interrompem
  assert.deepEqual(trilha([[SILENCIO, 500], [0.5, 60], [SILENCIO, 150], [0.5, 60], [SILENCIO, 150], [0.5, 60], [SILENCIO, 2000]], VAD_INTERRUPCAO, 20).sinais, []);
  // um vale longo (300 ms) recomeça o ataque
  assert.deepEqual(trilha([[SILENCIO, 500], [0.2, 100], [SILENCIO, 300], [0.2, 100], [SILENCIO, 2000]], VAD_ESCUTA, 20).sinais, []);
});

test('VAD com a aba em segundo plano (uma medida por segundo): ainda abre e fecha o trecho', () => {
  const { sinais } = trilha([[SILENCIO, 3000], [FALA, 4000], [SILENCIO, 4000]], VAD_ESCUTA, 1000);
  assert.deepEqual(sinais.map((s) => s.tipo), ['inicio', 'fim']);
  assert.ok(sinais[1].tipo === 'fim' && sinais[1].vozMs >= 2000);
});

test('nível: RMS das amostras e a escala do medidor', () => {
  assert.equal(nivelRms([]), 0);
  assert.equal(nivelRms(new Float32Array(512)), 0);
  assert.ok(Math.abs(nivelRms(Float32Array.from({ length: 480 }, (_, i) => Math.sin((i / 48) * 2 * Math.PI))) - Math.SQRT1_2) < 0.01);
  assert.equal(nivelNoMedidor(0), 0);
  assert.equal(nivelNoMedidor(NaN), 0);
  assert.equal(nivelNoMedidor(1), 1);
  assert.ok(nivelNoMedidor(0.003) < 0.05, 'silêncio quase não mexe');
  assert.ok(nivelNoMedidor(0.05) > 0.4 && nivelNoMedidor(0.05) < nivelNoMedidor(0.2), 'fala normal aparece bem');
});

const rodar = (evs: EventoVoz[], de: EstadoVoz = voz0(false)) => evs.reduce(conversaVoz, de);
const fases = (evs: EventoVoz[], de: EstadoVoz = voz0(false)) => { let e = de; return evs.map((ev) => (e = conversaVoz(e, ev)).fase); };
const TURNO: EventoVoz[] = [{ tipo: 'fala_inicio' }, { tipo: 'fala_fim' }, { tipo: 'enviado' }, { tipo: 'transcrito' }, { tipo: 'resposta', falar: true }, { tipo: 'tocando' }, { tipo: 'fala_agente_fim' }];

test('o ciclo: ouvir → enviar → transcrever → pensar → falar → ouvir de novo, sozinho', () => {
  assert.equal(voz0(false).fase, 'abrindo');
  assert.deepEqual(fases([{ tipo: 'microfone' }, ...TURNO, ...TURNO]),
    ['ouvindo', 'captando', 'enviando', 'transcrevendo', 'pensando', 'preparando', 'falando', 'ouvindo', 'captando', 'enviando', 'transcrevendo', 'pensando', 'preparando', 'falando', 'ouvindo']);
  assert.equal(rodar([{ tipo: 'microfone' }, ...TURNO, ...TURNO]).turnos, 2);
  // a resposta pode chegar antes de a tela ver "pensando" (transcrição rápida)
  assert.equal(rodar([{ tipo: 'microfone' }, { tipo: 'fala_inicio' }, { tipo: 'fala_fim' }, { tipo: 'enviado' }, { tipo: 'resposta', falar: true }]).fase, 'preparando');
});

test('o detector segue a fase: escuta a pessoa (também com o agente pensando), só vigia a interrupção com o agente falando, e cala no envio', () => {
  const em = (evs: EventoVoz[]) => modoDoVad(rodar([{ tipo: 'microfone' }, ...evs]));
  assert.equal(modoDoVad(voz0(false)), null, 'pedindo o microfone');
  assert.equal(em([]), 'escuta');
  assert.equal(em(TURNO.slice(0, 1)), 'escuta');
  for (const n of [2, 3]) assert.equal(em(TURNO.slice(0, n)), null, 'enviando e transcrevendo: nada é escutado nem gravado');
  assert.equal(em(TURNO.slice(0, 4)), 'escuta', 'pensando: a pessoa pode comentar o que mandou');
  assert.equal(em(TURNO.slice(0, 5)), 'interrupcao');
  assert.equal(em(TURNO.slice(0, 6)), 'interrupcao');
  assert.equal(em(TURNO), 'escuta');
  assert.ok(vezDoAgente(rodar([{ tipo: 'microfone' }, ...TURNO.slice(0, 4)])));
  assert.ok(!vezDoAgente(rodar([{ tipo: 'microfone' }])));
});

test('interromper: falar por cima (ou tocar no botão) para a fala do agente e volta a ouvir', () => {
  const falando = rodar([{ tipo: 'microfone' }, ...TURNO.slice(0, 6)]);
  assert.equal(falando.fase, 'falando');
  assert.equal(conversaVoz(falando, { tipo: 'fala_inicio' }).fase, 'captando', 'falar por cima já é o próximo trecho');
  assert.equal(conversaVoz(falando, { tipo: 'interromper' }).fase, 'ouvindo');
  const preparando = rodar([{ tipo: 'microfone' }, ...TURNO.slice(0, 5)]);
  assert.equal(conversaVoz(preparando, { tipo: 'interromper' }).fase, 'ouvindo', 'resposta longa: dá para não esperar a voz');
  // fora de hora não muda nada
  const ouvindo = rodar([{ tipo: 'microfone' }]);
  assert.deepEqual(conversaVoz(ouvindo, { tipo: 'interromper' }), ouvindo);
  assert.deepEqual(conversaVoz(ouvindo, { tipo: 'fala_agente_fim' }), ouvindo);
  assert.deepEqual(conversaVoz(rodar([{ tipo: 'microfone' }, ...TURNO.slice(0, 3)]), { tipo: 'fala_inicio' }).fase, 'transcrevendo', 'na vez do agente a fala não abre outro trecho');
});

test('ruído e falhas de envio voltam a ouvir, sem travar', () => {
  assert.equal(rodar([{ tipo: 'microfone' }, { tipo: 'fala_inicio' }, { tipo: 'fala_descartada' }]).fase, 'ouvindo');
  const falhou = rodar([{ tipo: 'microfone' }, { tipo: 'fala_inicio' }, { tipo: 'fala_fim' }, { tipo: 'envio_falhou' }]);
  assert.deepEqual([falhou.fase, falhou.aviso], ['ouvindo', 'envio_falhou']);
  assert.equal(conversaVoz(falhou, { tipo: 'fala_inicio' }).aviso, null, 'o aviso some quando a pessoa fala de novo');
  const esperando = rodar([{ tipo: 'microfone' }, ...TURNO.slice(0, 4)]);
  assert.deepEqual([conversaVoz(esperando, { tipo: 'sem_resposta', motivo: 'falhou' }).fase, conversaVoz(esperando, { tipo: 'sem_resposta', motivo: 'falhou' }).aviso], ['ouvindo', 'resposta_falhou']);
  assert.equal(conversaVoz(esperando, { tipo: 'sem_resposta', motivo: 'parada' }).aviso, 'resposta_parada');
  assert.equal(conversaVoz(esperando, { tipo: 'sem_resposta', motivo: 'vazia' }).fase, 'ouvindo');
  // o colega espera uma decisão na conversa escrita: a escuta segue, com o aviso (a barra de texto está ao lado)
  const espera = conversaVoz(esperando, { tipo: 'sem_resposta', motivo: 'espera' });
  assert.deepEqual([espera.fase, espera.mudo, espera.aviso, microfoneLigado(espera)], ['ouvindo', false, 'espera_voce', true]);
  // transcrição falhou: o pedido segue (o colega sabe do áudio), com o aviso
  const tr = rodar([{ tipo: 'microfone' }, ...TURNO.slice(0, 3), { tipo: 'transcricao_falhou' }]);
  assert.deepEqual([tr.fase, tr.aviso], ['pensando', 'transcricao_falhou']);
  const limite = rodar([{ tipo: 'microfone' }, { tipo: 'fala_inicio' }, { tipo: 'fala_fim', limite: true }]);
  assert.deepEqual([limite.fase, limite.aviso], ['enviando', 'limite']);
});

test('canal ao lado da barra: um texto mandado com a voz ligada vira a vez do agente; falar enquanto ele pensa abre outro trecho', () => {
  const ouvindo = rodar([{ tipo: 'microfone' }]);
  const texto = conversaVoz(ouvindo, { tipo: 'texto' });
  assert.deepEqual([texto.fase, modoDoVad(texto)], ['pensando', 'escuta']);
  assert.equal(rodar([{ tipo: 'resposta', falar: true }, { tipo: 'tocando' }], texto).fase, 'falando', 'a resposta ao texto é falada');
  assert.equal(conversaVoz(texto, { tipo: 'fala_inicio' }).fase, 'captando', 'comentar por voz o texto que mandou');
  // fora de hora (captando, falando): o texto não muda a fase
  const captando = conversaVoz(ouvindo, { tipo: 'fala_inicio' });
  assert.deepEqual(conversaVoz(captando, { tipo: 'texto' }), captando);
});

test('sem voz para falar: cai para só texto, avisando, e segue ouvindo', () => {
  const sem = voz0(true);
  assert.equal(sem.aviso, 'sem_voz');
  const e = rodar([{ tipo: 'microfone' }, ...TURNO.slice(0, 5)], sem);
  assert.deepEqual([e.fase, e.aviso, e.turnos], ['ouvindo', 'sem_voz', 1], 'a resposta fica escrita e a escuta volta na hora');
  // a voz existia e deixou de responder (componente ausente): daí em diante, só texto
  const caiu = rodar([{ tipo: 'microfone' }, ...TURNO.slice(0, 5), { tipo: 'voz_indisponivel' }]);
  assert.deepEqual([caiu.fase, caiu.semVoz, caiu.aviso], ['ouvindo', true, 'sem_voz']);
  assert.equal(rodar([...TURNO.slice(0, 5)], caiu).fase, 'ouvindo');
  // falha passageira: só esta resposta fica sem voz
  const passou = rodar([{ tipo: 'microfone' }, ...TURNO.slice(0, 5), { tipo: 'voz_falhou' }]);
  assert.deepEqual([passou.fase, passou.semVoz, passou.aviso], ['ouvindo', false, 'voz_falhou']);
});

test('pausar o microfone: solta na hora; no meio de uma resposta, ela termina e o modo fica pausado', () => {
  const ouvindo = rodar([{ tipo: 'microfone' }]);
  const p = conversaVoz(ouvindo, { tipo: 'pausar' });
  assert.deepEqual([p.fase, microfoneLigado(p), modoDoVad(p)], ['pausado', false, null]);
  assert.equal(conversaVoz(p, { tipo: 'fala_inicio' }).fase, 'pausado', 'pausado não capta');
  assert.equal(conversaVoz(rodar([{ tipo: 'microfone' }, { tipo: 'fala_inicio' }]), { tipo: 'pausar' }).fase, 'pausado', 'o trecho em curso é descartado');
  const volta = conversaVoz(p, { tipo: 'retomar' });
  assert.deepEqual([volta.fase, microfoneLigado(volta)], ['abrindo', true]);
  assert.equal(conversaVoz(volta, { tipo: 'microfone' }).fase, 'ouvindo');
  const falando = rodar([{ tipo: 'microfone' }, ...TURNO.slice(0, 6), { tipo: 'pausar' }]);
  assert.deepEqual([falando.fase, microfoneLigado(falando), modoDoVad(falando)], ['falando', false, null], 'a resposta segue; falar por cima não interrompe');
  assert.equal(conversaVoz(falando, { tipo: 'fala_agente_fim' }).fase, 'pausado');
  assert.equal(conversaVoz(conversaVoz(falando, { tipo: 'retomar' }), { tipo: 'fala_agente_fim' }).fase, 'ouvindo');
});

test('erros do microfone e sair: o microfone nunca fica aberto', () => {
  for (const motivo of ['negado', 'sem_microfone', 'sem_suporte', 'falhou', 'sem_transcricao', 'sem_motor'] as const) {
    const e = conversaVoz(voz0(false), { tipo: 'erro', motivo });
    assert.deepEqual([e.fase, e.erro, microfoneLigado(e), modoDoVad(e)], ['erro', motivo, false, null]);
    assert.deepEqual(conversaVoz(e, { tipo: 'microfone' }), e, 'o microfone que chega atrasado não reabre o modo');
    assert.equal(conversaVoz(e, { tipo: 'retomar' }).fase, 'abrindo', 'tentar de novo');
  }
  // o microfone some no meio (fone desconectado)
  assert.equal(rodar([{ tipo: 'microfone' }, ...TURNO.slice(0, 6), { tipo: 'erro', motivo: 'sem_microfone' }]).fase, 'erro');
  for (let n = 0; n <= TURNO.length; n++) {
    const f = rodar([{ tipo: 'microfone' }, ...TURNO.slice(0, n), { tipo: 'fechar' }]);
    assert.deepEqual([f.fase, microfoneLigado(f), modoDoVad(f)], ['fechado', false, null]);
    for (const ev of [...TURNO, { tipo: 'microfone' }, { tipo: 'retomar' }] as EventoVoz[]) assert.deepEqual(conversaVoz(f, ev), f, 'fechado é o fim');
  }
});

const msg = (p: Partial<MensagemDoTurno> & { id: string }): MensagemDoTurno => ({ role: 'user', content: '', run_id: null, run_status: null, ...p });
const audio = (estado: string, texto: string | null = null, motivo: string | null = null) => [{ transcricao: { estado, texto, motivo } }];

test('o turno na conversa: transcrevendo → pensando → pronta, pelas mensagens de sempre', () => {
  assert.equal(turnoDaMensagem([], 'msg_1').fase, 'enviando');
  assert.equal(turnoDaMensagem([msg({ id: 'msg_1', run_id: 'run_1', run_status: 'queued', attachments: [{}] })], 'msg_1').fase, 'transcrevendo', 'a transcrição ainda nem começou');
  assert.equal(turnoDaMensagem([msg({ id: 'msg_1', run_id: 'run_1', run_status: 'queued', attachments: audio('preparando') })], 'msg_1').fase, 'transcrevendo');
  const pensando = turnoDaMensagem([msg({ id: 'msg_1', run_id: 'run_1', run_status: 'running', attachments: audio('pronta', ' reunião às três ') })], 'msg_1');
  assert.deepEqual([pensando.fase, pensando.dito], ['pensando', 'reunião às três']);
  assert.equal(turnoDaMensagem([msg({ id: 'msg_1', queued: 1, attachments: audio('pronta', 'oi') })], 'msg_1').fase, 'pensando', 'na fila da conversa');
  const lista = [
    msg({ id: 'msg_0', run_id: 'run_0', run_status: 'succeeded' }), msg({ id: 'msg_0r', role: 'agent', content: 'antiga', run_id: 'run_0' }),
    msg({ id: 'msg_1', run_id: 'run_1', run_status: 'succeeded', attachments: audio('pronta', 'que horas é a reunião?') }),
    msg({ id: 'msg_s', role: 'system', content: 'Sistema — nota', run_id: null }),
    msg({ id: 'msg_1r', role: 'agent', content: 'Às **três**. [[card 12]]', run_id: 'run_1' }),
    msg({ id: 'msg_1v', role: 'agent', content: '[[silencio]]', run_id: 'run_1' }),
    msg({ id: 'msg_x', role: 'agent', content: 'de outra execução', run_id: 'run_9' }),
  ];
  const pronto = turnoDaMensagem(lista, 'msg_1');
  assert.deepEqual([pronto.fase, pronto.dito, pronto.respostas.map((m) => m.id)], ['pronta', 'que horas é a reunião?', ['msg_1r']], 'só as respostas deste pedido, com texto');
});

test('o turno na conversa: falha, parada, vazia, espera e transcrição que falhou', () => {
  const com = (run_status: string, resto: MensagemDoTurno[] = []) => turnoDaMensagem([msg({ id: 'msg_1', run_id: 'run_1', run_status, attachments: audio('pronta', 'oi') }), ...resto], 'msg_1');
  assert.equal(com('failed', [msg({ id: 'm2', role: 'system', content: 'Não deu certo desta vez: x', run_id: 'run_1' })]).fase, 'falhou');
  assert.equal(com('cancelled').fase, 'parada');
  assert.equal(com('succeeded').fase, 'vazia');
  assert.equal(com('waiting_user').fase, 'espera');
  const falhou = turnoDaMensagem([msg({ id: 'msg_1', run_id: 'run_1', run_status: 'running', attachments: audio('falhou', null, 'componente') })], 'msg_1');
  assert.deepEqual([falhou.fase, falhou.dito, falhou.transcricaoFalhou], ['pensando', null, 'componente']);
  const vazio = turnoDaMensagem([msg({ id: 'msg_1', run_id: 'run_1', run_status: 'running', attachments: audio('pronta', '') })], 'msg_1');
  assert.deepEqual([vazio.dito, vazio.transcricaoFalhou], ['', null], 'silêncio transcrito: vazio, não falha');
});

test('o texto falado e da legenda: sem marcas internas nem formatação', () => {
  assert.equal(textoFalado('## Resumo\n\n- **Reunião** às `15h` com a [Ana](https://x.y/z)\n- nome_do_arquivo.txt [[card 3]]'), 'Resumo\n\nReunião às 15h com a Ana\nnome_do_arquivo.txt');
  assert.equal(textoFalado('[[silencio]]'), '');
  assert.equal(textoFalado('antes\n```js\nx()\n```\ndepois'), 'antes\n\ndepois');
});
