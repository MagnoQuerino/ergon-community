// O que o servidor manda com CÓDIGO + VALORES (server/src/lib/textos.ts) chega à tela no idioma dela: o dicionário tem
// o mesmo português do servidor, cada código tem o seu inglês, o tradutor monta plural, lista e frase, e o que a tela
// não conhece fica no português que veio (a reserva). Nas duas línguas.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { after, before, describe, test } from 'node:test';
import { idiomaAtual, setIdioma } from '../i18n/index.ts';
import { pt } from '../i18n/pt/index.ts';
import { en } from '../i18n/en/index.ts';
import * as tela from './textos-tela.ts';
import { ApiError, api } from './api.ts';

type Msg = string | Record<string, string>;
const PT = pt.servidor as unknown as Record<string, Msg>;
const EN = en.servidor as unknown as Record<string, Msg>;
const servidorTs = new URL('../../../server/src/lib/textos.ts', import.meta.url);

describe('o catálogo do servidor e o dicionário da tela', () => {
  test('cada código do servidor está na área "servidor" com o MESMO português, e tem inglês', async (t) => {
    if (!fs.existsSync(servidorTs)) { t.skip('sem o servidor nesta cópia'); return; }
    const { TEXTOS } = await import(servidorTs.href) as { TEXTOS: Record<string, Msg> };
    const erros: string[] = [];
    for (const [codigo, m] of Object.entries(TEXTOS)) {
      if (!(codigo in PT)) { erros.push(`falta na tela: ${codigo}`); continue; }
      if (JSON.stringify(PT[codigo]) !== JSON.stringify(m)) erros.push(`português diferente em ${codigo}: tela ${JSON.stringify(PT[codigo])} · servidor ${JSON.stringify(m)}`);
      if (!(codigo in EN)) erros.push(`sem inglês: ${codigo}`);
    }
    assert.deepEqual(erros, []);
  });
});

describe('em português', () => {
  test('o texto que veio do servidor fica como veio (é a reserva e é o mesmo do dicionário)', () => {
    assert.equal(idiomaAtual(), 'pt-BR');
    assert.equal(tela.textoDoServidor({ codigo: 'erro.facaLogin' }, 'faça login'), 'faça login');
    const r = { message: 'faça login', message_t: { codigo: 'erro.facaLogin' } };
    assert.equal(tela.traduzirResposta(r).message, 'faça login');
    assert.equal(tela.textoBaixado(2), 'Arquivo baixado. 2 arquivos ficaram de fora: a lista e o motivo estão no LEIA-ME, dentro do arquivo. Guarde em lugar seguro: ele não é cifrado.');
  });
});

describe('em inglês', () => {
  before(async () => { await setIdioma('en', { guardar: false }); });
  after(async () => { await setIdioma('pt-BR', { guardar: false }); });

  test('o tradutor: código simples, valores, plural (com e sem {n} no texto), lista, frase e texto dentro de texto', () => {
    assert.equal(idiomaAtual(), 'en');
    const d = tela.textoDoServidor;
    assert.equal(d({ codigo: 'erro.facaLogin' }, 'faça login'), 'Please sign in.');
    assert.equal(d({ codigo: 'erro.cardNumeroNaoEncontrado', valores: { numero: '1234' } }, 'x'), 'Couldn\'t find card #1234 on the board.', 'número de card sem separador');
    assert.equal(d({ codigo: 'resumo.qtd.email', valores: { n: 1 } }, 'x'), 'an email');
    assert.equal(d({ codigo: 'resumo.qtd.email', valores: { n: 1250 } }, 'x'), '1,250 emails');
    assert.equal(d({ codigo: 'resumo.situacao.esperandoAprovacao' }, 'x'), 'Waiting for your approval');
    const pendente = { codigo: 'resumo.frase.aprovarPara', forma: 'frase', valores: { acoes: [{ codigo: 'resumo.pendente.email', valores: {
      qtd: { codigo: 'resumo.qtd.email', valores: { n: 2 } }, para: { codigo: 'resumo.para', valores: { quem: ['ana@x.com', 'bruno@x.com'] } }, copia: '',
      sobre: { codigo: 'resumo.sobre', valores: { nomes: ['“Orçamento”'] } } } }] } } as const;
    assert.equal(d(pendente, 'x'), 'Waiting for your approval to send 2 emails to ana@x.com and bruno@x.com, about “Orçamento”.');
    assert.equal(d({ codigo: 'resumo.feito.outro', forma: 'maiuscula', valores: { acoes: ['fechar a issue #12'], em: '' } }, 'x'), 'Fechar a issue #12 (done).', 'o texto do agente vai como veio');
    assert.equal(d({ codigo: 'junto', valores: { itens: [{ codigo: 'saude.cifrado' }, { codigo: 'saude.pedeSenha' }], sep: ' · ' } }, 'x'), 'encrypted · asks for the password after a restart');
    assert.equal(d({ codigo: 'historico.comNota', valores: { situacao: { codigo: 'historico.situacao.processamento' }, nota: { codigo: 'historico.nota.pegouDaFila' } } }, 'x'), 'In progress — taken from the queue');
    // o tamanho da Saúde: o número no formato do inglês (ponto decimal, as mesmas casas), nunca "51,4"
    const mb = (v: number) => ({ codigo: 'saude.tamanhoMb', valores: { mb: { codigo: 'decimal', valores: { v, casas: 1 } } } });
    assert.equal(d({ codigo: 'junto', valores: { itens: [{ codigo: 'saude.bancoIntegro' }, mb(51.4)], sep: ' · ' } }, 'x'), 'intact · 51.4 MB');
    assert.equal(d(mb(1250), 'x'), '1,250.0 MB');
    assert.equal(d({ codigo: 'saude.gbLivres', valores: { gb: { codigo: 'decimal', valores: { v: 123.4, casas: 1 } } } }, 'x'), '123.4 GB free');
    assert.equal(d({ codigo: 'historico.nota.entregaveis', valores: { n: 1 } }, 'x'), '1 deliverable generated');
    assert.equal(d({ codigo: 'historico.nota.entregaveis', valores: { n: 3 } }, 'x'), '3 deliverables generated');
    // o recado depois de Aprovar ou Recusar em "Aguardando você"
    assert.equal(d({ codigo: 'proposta.recusada' }, 'recusada'), 'declined');
    assert.equal(d({ codigo: 'proposta.tarefaPara', valores: { numero: 1234, nome: 'Hipátia' } }, 'x'), 'task #1234 created for Hipátia', 'número de card sem separador');
    assert.equal(d({ codigo: 'proposta.desativadoRedistribuido', valores: { nome: 'Tales', n: 1 } }, 'x'), 'Tales deactivated; 1 task moved to teammates');
    assert.equal(d({ codigo: 'junto', valores: { itens: [{ codigo: 'proposta.agenteAtualizado', valores: { nome: 'Tales' } }, { codigo: 'proposta.coordenadorFixo' }], sep: '' } }, 'x'),
      'Tales updated — Coordinator: role and sector are fixed and stayed as they were');
  });

  test('sem código conhecido, sem valor do plural ou com um pedaço desconhecido: o português que veio', () => {
    const d = tela.textoDoServidor;
    assert.equal(d(undefined, 'faça login'), 'faça login');
    assert.equal(d({ codigo: 'erro.umQueATelaNaoConhece' }, 'texto do servidor novo'), 'texto do servidor novo');
    assert.equal(d({ codigo: 'resumo.qtd.email', valores: { n: 'dois' } }, 'dois e-mails'), 'dois e-mails');
    assert.equal(d({ codigo: 'historico.comNota', valores: { situacao: { codigo: 'historico.situacao.falha' }, nota: { codigo: 'nao.existe' } } }, 'Falha — algo'), 'Falha — algo');
  });

  test('a resposta inteira: message, frase, situação, itens e o resultado do histórico trocados; o resto como veio', () => {
    const r = tela.traduzirResposta({
      error: 'unauthenticated', message: 'faça login', message_t: { codigo: 'erro.facaLogin' },
      resumo: { situacao: { tom: 'feito', texto: 'Feito', texto_t: { codigo: 'resumo.situacao.feito' } },
        faixa: { titulo: 'O que foi feito', titulo_t: { codigo: 'resumo.titulo.feito' }, frase: 'X.', frase_t: { codigo: 'resumo.frase.aprovadaPorVoce', forma: 'frase' },
          itens: ['Já feito: a', 'texto do agente'], itens_t: [{ codigo: 'resumo.item.jaFeito', valores: { feito: 'a' } }, 'texto do agente'], doAgente: null, doAgente_t: null } },
      log: [{ action: 'task.queue', result: 'sem prioridade', result_t: { codigo: 'historico.semPrioridade' } }, { action: 'x', result: 'frase do agente' }],
    });
    assert.equal(r.message, 'Please sign in.');
    assert.equal(r.error, 'unauthenticated', 'o código de lógica não muda');
    assert.equal(r.resumo.situacao.texto, 'Done');
    assert.equal(r.resumo.situacao.tom, 'feito');
    assert.equal(r.resumo.faixa.titulo, 'What was done');
    assert.equal(r.resumo.faixa.frase, 'Approved by you.');
    assert.deepEqual(r.resumo.faixa.itens, ['Already done: a', 'texto do agente']);
    assert.equal(r.log[0].result, 'no priority');
    assert.equal(r.log[1].result, 'frase do agente');
  });

  test('o cartão da gestão do coordenador (summary_t): a ação, os campos, sim/não e o nome no idioma da tela', () => {
    const r = tela.traduzirResposta({ proposals: [{ kind: 'gestao', summary: 'Aristóteles quer: Criar um agente.\n- name: Temístocles\n- ativo: sim\n- agente: agente Sócrates\nNada muda até você aplicar.',
      summary_t: { codigo: 'junto', valores: { sep: '\n', itens: [
        { codigo: 'proposta.gestao.quer', valores: { agente: 'Aristóteles', acao: { codigo: 'proposta.gestao.acao.agente.criar' } } },
        { codigo: 'proposta.gestao.campo', valores: { campo: 'name', valor: 'Temístocles' } },
        { codigo: 'proposta.gestao.campo', valores: { campo: 'ativo', valor: { codigo: 'proposta.gestao.sim' } } },
        { codigo: 'proposta.gestao.campo', valores: { campo: 'agente', valor: { codigo: 'proposta.gestao.nome.agt', valores: { nome: 'Sócrates' } } } },
        { codigo: 'proposta.gestao.nadaMuda' }] } } }] });
    assert.equal(r.proposals[0].summary, 'Aristóteles wants to: Create an agent.\n- name: Temístocles\n- ativo: yes\n- agente: agent Sócrates\nNothing changes until you apply it.');
  });

  test('cada código do servidor monta em inglês, sem marcador sobrando e sem letra do português', () => {
    const erros: string[] = [];
    for (const [codigo, m] of Object.entries(PT)) {
      if (!/^(erro|historico|resumo|proposta|saude)\./.test(codigo)) continue;
      const nomes = new Set((typeof m === 'string' ? [m] : Object.values(m)).flatMap((s) => [...s.matchAll(/\{(\w+)\}/g)].map((x) => x[1])));
      const valores = Object.fromEntries([...nomes].map((k) => [k, k === 'n' ? 2 : 'X']));
      if (typeof m !== 'string') valores.n = 2;
      const s = tela.textoDoServidor({ codigo, valores }, '\u0000');
      if (s === '\u0000') erros.push(`${codigo}: não montou`);
      else if (/\{\w+\}/.test(s) || /[ãõçÃÕÇ]/.test(s)) erros.push(`${codigo}: ${s}`);
    }
    assert.deepEqual(erros, []);
  });

  test('as frases da tela (textos-tela.ts) em inglês, inclusive as constantes importadas antes da troca', () => {
    assert.equal(tela.motivoDoLogin('consent_required'), 'Your company requires the administrator\'s approval.');
    assert.equal(tela.motivoDoLogin('A conta não concluiu o login: access_denied', 'google'), 'Authorization was declined on the Google page.');
    assert.equal(tela.motivoDoLogin('A conta não concluiu o login: invalid_request (AADSTS50020: x)'), 'Microsoft did not finish the authorization (code AADSTS50020, for support).');
    assert.equal(tela.textoDaVolta('microsoft', 'recusado', false), 'Microsoft sign-in canceled.');
    assert.equal(tela.textoBaixado(1), 'File downloaded. 1 file was left out: the list and the reason are in the README inside the file. Keep it somewhere safe: it is not encrypted.');
    assert.equal(tela.textoDoLiberado({ liberado: 2.4 * 1024 ** 3, removidas: 3 }, false), '2.4 GB freed: 3 old team versions deleted. None of your data was deleted.');
    assert.equal(tela.motivoDaFalha(null), 'It didn\'t work. Use "Try again" or send it back with an instruction.');
    assert.match(tela.FRASE_RENOVANDO, /^Updating the team/, 'a constante acompanha a troca de idioma');
    assert.match(tela.TEXTO_BAIXAR_DADOS, /^A ZIP file/);
    assert.equal(tela.CONFIRMAR_DADOS_ANTIGOS, 'apagar sem volta', 'o código que o servidor confere não muda');
  });

  test('api.ts manda o idioma no cabeçalho e o erro chega traduzido (o código do erro continua o mesmo)', async () => {
    const antes = globalThis.fetch;
    let lang: string | null = null;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      lang = new Headers(init?.headers).get('X-Ergon-Lang');
      return new Response(JSON.stringify({ error: 'busy', message: 'O agente já está trabalhando neste card.', message_t: { codigo: 'erro.agenteTrabalhando' } }), { status: 409 });
    }) as typeof fetch;
    try {
      await assert.rejects(api.post('/api/tasks/x/work'), (e: unknown) => e instanceof ApiError && e.code === 'busy' && e.message === 'The agent is already working on this card.');
      assert.equal(lang, 'en');
    } finally { globalThis.fetch = antes; }
  });
});

describe('a troca de idioma refaz o que já veio do servidor (nada fica na língua de antes)', () => {
  after(async () => { await setIdioma('pt-BR', { guardar: false }); });

  test('carregado em português, mostrado em inglês ao trocar, e de volta ao português ao voltar', async () => {
    assert.equal(idiomaAtual(), 'pt-BR');
    const r = tela.traduzirResposta({
      message: 'faça login', message_t: { codigo: 'erro.facaLogin' },
      log: [{ action: 'task.queue', result: 'sem prioridade', result_t: { codigo: 'historico.semPrioridade' } }],
      faixa: { itens: ['Já feito: a', 'texto do agente'], itens_t: [{ codigo: 'resumo.item.jaFeito', valores: { feito: 'a' } }, 'texto do agente'] },
    });
    assert.equal(r.message, 'faça login');
    await setIdioma('en', { guardar: false });
    assert.equal(r.message, 'Please sign in.', 'o mesmo objeto, já no idioma novo');
    assert.equal(r.log[0].result, 'no priority');
    assert.deepEqual(r.faixa.itens, ['Already done: a', 'texto do agente']);
    await setIdioma('pt-BR', { guardar: false });
    assert.equal(r.message, 'faça login', 'o português que veio não se perde');
    assert.equal(r.log[0].result, 'sem prioridade');
    assert.deepEqual(r.faixa.itens, ['Já feito: a', 'texto do agente']);
  });

  test('carregado em inglês: ao voltar ao português, o português que veio (não o inglês)', async () => {
    await setIdioma('en', { guardar: false });
    const r = tela.traduzirResposta({ status: 'applied', result: 'setor Vendas criado', result_t: { codigo: 'proposta.setorCriado', valores: { nome: 'Vendas' } } });
    assert.equal(r.result, 'sector Vendas created');
    // a mesma resposta passando de novo (o cache de live.ts) não troca a reserva pelo inglês
    tela.traduzirResposta(r);
    await setIdioma('pt-BR', { guardar: false });
    assert.equal(r.result, 'setor Vendas criado');
    assert.equal(r.status, 'applied', 'o que não tem _t fica como veio');
  });
});
