// Os textos que o servidor manda para a tela com CÓDIGO + VALORES ao lado do português (lib/textos.ts): o português de
// sempre continua igual (reserva), o código é reconhecido nos erros das rotas, nas linhas do histórico e na Saúde, e o
// que o servidor gera na hora segue o idioma da tela que pediu (o README de "Baixar meus dados" em inglês).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { readZip } from '../src/lib/zip.ts';
import { decimalTx, emPt, idiomaDoPedido, reconhecer, textoDoResultado, TEXTOS, tx } from '../src/lib/textos.ts';
import { HttpError } from '../src/lib/util.ts';
import { throttle } from '../src/security/factors.ts';
import { fatoDaAcao, textoDoPendente, textosDoFeito } from '../src/services/resumo-tarefa.ts';
import { harness, req, setupOwner } from './helpers.ts';

describe('textos do servidor com código', () => {
  test('o português sai do catálogo: marcadores, plural, listas e a forma de frase', () => {
    assert.equal(emPt(tx('erro.naoEncontreAgente', { nome: 'Hipátia' })), 'não encontrei o agente "Hipátia"');
    assert.equal(emPt(tx('resumo.qtd.email', { n: 1 })), 'um e-mail');
    assert.equal(emPt(tx('resumo.qtd.email', { n: 3 })), '3 e-mails');
    assert.equal(emPt(['Ana', 'Bruno', 'Carla']), 'Ana, Bruno e Carla');
    assert.equal(emPt(tx('resumo.frase.naoFeito', undefined, 'frase')), 'Não foi feito.');
    assert.equal(emPt({ codigo: 'junto', valores: { itens: [tx('saude.cifrado'), tx('saude.pedeSenha')], sep: ' · ' } }), 'cifrado · pede a senha ao reiniciar');
    // todo código tem texto: nenhum vazio
    for (const [k, m] of Object.entries(TEXTOS)) for (const s of typeof m === 'string' ? [m] : Object.values(m)) assert.ok(String(s).trim(), k);
  });

  test('reconhece as frases fixas (com os valores) e deixa de fora o que não conhece', () => {
    assert.deepEqual(reconhecer('faça login', 'erro.'), { codigo: 'erro.facaLogin' });
    assert.deepEqual(reconhecer('não encontrei o card #12 no quadro', 'erro.'), { codigo: 'erro.cardNumeroNaoEncontrado', valores: { numero: '12' } });
    assert.deepEqual(reconhecer('Já existe um agente ativo chamado Tales.', 'erro.'), { codigo: 'erro.nomeAgenteEmUso', valores: { nome: 'Tales' } });
    assert.equal(reconhecer('um erro que ninguém escreveu no catálogo', 'erro.'), null);
    assert.equal(reconhecer('faça login', 'historico.'), null, 'só o prefixo pedido');
    // número só onde o marcador é número: "menos de 1 MB" não é "{mb} MB"
    assert.equal(reconhecer('menos de 1 MB', 'saude.'), null);
    // o tamanho vai como número (cada idioma escreve do seu jeito: "12,4" / "12.4"), e o português volta igual
    const mb = reconhecer('12,4 MB', 'saude.');
    assert.deepEqual(mb, { codigo: 'saude.tamanhoMb', valores: { mb: decimalTx(12.4, 1) } });
    assert.equal(emPt(mb), '12,4 MB');
    assert.equal(emPt(reconhecer('12,0 MB', 'saude.')), '12,0 MB', 'as casas de decimal() ficam');
    assert.deepEqual(reconhecer('123,4 GB livres', 'saude.'), { codigo: 'saude.gbLivres', valores: { gb: decimalTx(123.4, 1) } });
    assert.deepEqual(reconhecer('1 parada há mais de 10 min', 'saude.'), { codigo: 'saude.paradas', valores: { n: 1 } });
  });

  test('entregáveis no plural: o que o servidor grava agora e o "1 entregáveis gerados" de antes', () => {
    assert.equal(emPt(tx('historico.nota.entregaveis', { n: 1 })), '1 entregável gerado');
    assert.equal(emPt(tx('historico.nota.entregaveis', { n: 3 })), '3 entregáveis gerados');
    const nota = (r: string) => (textoDoResultado('task.work_state', r) as { valores?: { nota?: unknown } } | null)?.valores?.nota;
    assert.deepEqual(nota('Resultado produzido — 1 entregável gerado'), { codigo: 'historico.nota.entregaveis', valores: { n: 1 } });
    assert.deepEqual(nota('Resultado produzido — 1 entregáveis gerados'), { codigo: 'historico.nota.entregaveis', valores: { n: 1 } });
  });

  test('o resultado de uma proposta: reconhecido no registro (Atividade), sem pegar o que não é do catálogo', () => {
    assert.deepEqual(textoDoResultado('proposal.applied', 'setor Vendas criado'), { codigo: 'proposta.setorCriado', valores: { nome: 'Vendas' } });
    assert.deepEqual(textoDoResultado('proposal.applied', 'setor Vendas atualizado'), { codigo: 'proposta.setorAtualizado', valores: { nome: 'Vendas' } }, 'o molde mais específico');
    assert.deepEqual(textoDoResultado('proposal.rejected', 'recusada'), { codigo: 'proposta.recusada' });
    assert.deepEqual(textoDoResultado('proposal.applied', 'Tales desativado; 2 tarefas passaram a colegas'), { codigo: 'proposta.desativadoRedistribuido', valores: { nome: 'Tales', n: 2 } });
    assert.deepEqual(textoDoResultado('proposal.failed', 'não encontrei o agente "Zé"'), { codigo: 'erro.naoEncontreAgente', valores: { nome: 'Zé' } });
    assert.equal(textoDoResultado('proposal.applied', 'Resumo semanal ativado'), null);
    assert.equal(textoDoResultado('task.queue', 'recusada'), null, 'fora das propostas, só o histórico');
  });

  test('a linha do histórico: a situação com a nota em duas partes; nota desconhecida deixa o português', () => {
    assert.deepEqual(textoDoResultado('task.work_state', 'Em processamento — pegou da fila'),
      { codigo: 'historico.comNota', valores: { situacao: { codigo: 'historico.situacao.processamento' }, nota: { codigo: 'historico.nota.pegouDaFila' } } });
    assert.deepEqual(textoDoResultado('task.work_state', 'Concluída'), { codigo: 'historico.situacao.concluida' });
    assert.equal(textoDoResultado('task.work_state', 'Falha — o agente disse uma coisa qualquer'), null);
    assert.deepEqual(textoDoResultado('task.queue', 'prioridade: topo da fila'), { codigo: 'historico.prioridadeTopo' });
    assert.deepEqual(textoDoResultado('task.persist_exhausted', 'A equipe tentou resolver em 2 rodadas e não conseguiu: o card vai para você, com o último motivo'),
      { codigo: 'historico.equipeTentou', valores: { n: 2 } });
  });

  test('HttpError com Texto: o português vem do catálogo e o código vai junto', () => {
    const e = new HttpError(409, 'busy', tx('erro.agenteTrabalhando'));
    assert.equal(e.message, 'O agente já está trabalhando neste card.');
    assert.deepEqual(e.texto, { codigo: 'erro.agenteTrabalhando' });
    assert.equal(new HttpError(400, 'x', 'texto solto').texto, null);
  });

  test('a faixa do card: o que espera o clique e o que foi feito, com código e o mesmo português', () => {
    const email = fatoDaAcao({ conexao: 'microsoft', acao: 'email.enviar', args: JSON.stringify({ para: ['ana@x.com', 'bruno@x.com'], assunto: 'Orçamento' }), resumo: null });
    const [p] = textoDoPendente([email]);
    assert.equal(emPt(p), 'enviar um e-mail para ana@x.com e bruno@x.com, sobre “Orçamento”');
    assert.equal((p as { codigo: string }).codigo, 'resumo.pendente.email');
    const [f] = textosDoFeito([email, email]);
    assert.equal(f.codigo, 'resumo.feito.email');
    assert.equal(emPt(f), '2 e-mails enviados para ana@x.com e bruno@x.com, sobre “Orçamento”.');
  });

  test('o idioma do pedido pelo cabeçalho X-Ergon-Lang (sem ele, português)', () => {
    assert.equal(idiomaDoPedido({ 'x-ergon-lang': 'en' }), 'en');
    assert.equal(idiomaDoPedido({ 'x-ergon-lang': 'en-US' }), 'en');
    assert.equal(idiomaDoPedido({ 'x-ergon-lang': 'pt-BR' }), 'pt-BR');
    assert.equal(idiomaDoPedido({}), 'pt-BR');
  });
});

describe('nas rotas', () => {
  test('o erro da rota leva message_t; a Atividade e a Saúde levam o código das frases do sistema', async () => {
    throttle.reset();
    const h = await harness();
    const sem = await req(h, 'GET', '/api/tasks', null);
    assert.equal(sem.status, 401);
    assert.equal(sem.json.message, 'faça login', 'o português de sempre continua');
    assert.deepEqual(sem.json.message_t, { codigo: 'erro.facaLogin' });
    const s = await setupOwner(h);
    const t = await req(h, 'POST', '/api/tasks', s, { title: 'Card para a fila' });
    assert.equal(t.status, 201, JSON.stringify(t.json));
    const saude = await req(h, 'GET', '/api/saude', s);
    assert.equal(saude.status, 200, JSON.stringify(saude.json));
    assert.ok(saude.json.rotulo_t?.codigo.startsWith('saude.estado.'));
    const banco = saude.json.componentes.find((c: { id: string }) => c.id === 'banco');
    assert.deepEqual(banco.nome_t, { codigo: 'saude.nome.banco' });
    assert.equal(emPt(banco.detalhe_t), banco.detalhe, 'o código monta o mesmo português');
    await h.app.close();
  });

  test('aprovar ou recusar uma proposta: o recado vai com result_t (e a Atividade também), o português de sempre ao lado', async () => {
    throttle.reset();
    const h = await harness();
    const s = await setupOwner(h);
    const propor = (id: string, payload: object) => h.db.run("INSERT INTO agent_proposals (id, workspace_id, kind, payload, summary, status, created_at) VALUES (?, ?, ?, ?, 'x', 'proposed', ?)",
      id, s.workspaceId, (payload as { kind: string }).kind, JSON.stringify(payload), new Date().toISOString());
    propor('apr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { kind: 'sector_new', name: 'Vendas Externas', description: 'quem vende fora' });
    const ok = await req(h, 'POST', '/api/proposals/apr_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', s, { decision: 'apply' });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
    assert.equal(ok.json.result, 'setor Vendas Externas criado');
    assert.deepEqual(ok.json.result_t, { codigo: 'proposta.setorCriado', valores: { nome: 'Vendas Externas' } });
    propor('apr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', { kind: 'sector_new', name: 'Outro', description: '' });
    const nao = await req(h, 'POST', '/api/proposals/apr_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', s, { decision: 'reject' });
    assert.equal(nao.json.result, 'recusada');
    assert.deepEqual(nao.json.result_t, { codigo: 'proposta.recusada' });
    propor('apr_cccccccccccccccccccccccccccccccc', { kind: 'edit_agent', agent: 'Ninguém Daqui', changes: { name: 'X' } });
    const falha = await req(h, 'POST', '/api/proposals/apr_cccccccccccccccccccccccccccccccc', s, { decision: 'apply' });
    assert.equal(falha.json.status, 'failed');
    assert.deepEqual(falha.json.result_t, { codigo: 'erro.naoEncontreAgente', valores: { nome: 'Ninguém Daqui' } });
    const atividade = await req(h, 'GET', '/api/activity', s);
    const linha = (atividade.json as Array<{ action: string; result: string; result_t?: unknown }>).find((e) => e.action === 'proposal.applied' && e.result === 'setor Vendas Externas criado');
    assert.deepEqual(linha?.result_t, { codigo: 'proposta.setorCriado', valores: { nome: 'Vendas Externas' } });
    await h.app.close();
  });

  test('Baixar meus dados com a tela em inglês: o README vem em inglês; sem o cabeçalho, o LEIA-ME de sempre', async () => {
    throttle.reset();
    const h = await harness();
    const s = await setupOwner(h);
    h.db.run('UPDATE sessions SET auth_at = ? WHERE user_id = ?', new Date().toISOString(), s.userId);
    const baixar = (lang?: string) => h.app.inject({ method: 'POST', url: '/api/me/export', payload: '{}',
      headers: { cookie: s.cookie, 'x-csrf-token': s.csrf, origin: 'http://localhost:8787', 'content-type': 'application/json', ...(lang ? { 'x-ergon-lang': lang } : {}) } });
    const en = await baixar('en');
    assert.equal(en.statusCode, 200, en.body);
    const zipEn = readZip(en.rawPayload);
    assert.equal([...zipEn.keys()][0], 'README.txt');
    const readme = zipEn.get('README.txt')!.read().toString('utf8');
    assert.match(readme, /Your Ergon data/);
    assert.match(readme, /THIS FILE IS NOT ENCRYPTED/);
    assert.doesNotMatch(readme, /ATENÇÃO|Baixado em/);
    assert.doesNotMatch(readme, /\btokens?\b/i, 'sem jargão no inglês');
    // o aviso das contas conectadas no idioma de quem baixou (os nomes dos campos são dados: ficam iguais)
    const aviso = (zip: ReturnType<typeof readZip>) => {
      const nome = [...zip.keys()].find((k) => k.endsWith('contas-conectadas.json'));
      return nome ? (JSON.parse(zip.get(nome)!.read().toString('utf8').replace(/^﻿/, '')) as { aviso: string }).aviso : null;
    };
    assert.match(aviso(zipEn) ?? '', /^Only the names\./);
    const pt = await baixar();
    assert.equal(pt.statusCode, 200, pt.body);
    const zipPt = readZip(pt.rawPayload);
    assert.equal([...zipPt.keys()][0], 'LEIA-ME.txt');
    assert.match(zipPt.get('LEIA-ME.txt')!.read().toString('utf8'), /Os seus dados do Ergon/);
    assert.match(aviso(zipPt) ?? '', /^Só os nomes\./);
    await h.app.close();
  });
});
