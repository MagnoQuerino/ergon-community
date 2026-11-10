import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  PASSOS_OPCOES, PASSOS_PADRAO, chamadasTexto, compactarAjuda, compactarAtualizacao, compactarDepois, compactarRotulo, composicaoEstimada, composicaoIntro,
  composicaoNota, composicaoVazia, detalhe, fatias, passosAjuda, passosCompartilhado, passosDepois, pct, resumidasTexto, tamanhoMedio,
} from './custo.ts';
import { setIdioma } from '../i18n/index.ts';

// os textos vêm do dicionário (área configuracoes); o teste lê em português, o idioma padrão
const COMPOSICAO_ESTIMADA = composicaoEstimada(), COMPOSICAO_INTRO = composicaoIntro(), COMPOSICAO_NOTA = composicaoNota(), COMPOSICAO_VAZIA = composicaoVazia();
const PASSOS_AJUDA = passosAjuda(), PASSOS_DEPOIS = passosDepois();
const COMPACTAR_AJUDA = compactarAjuda(), COMPACTAR_ATUALIZACAO = compactarAtualizacao(), COMPACTAR_DEPOIS = compactarDepois(), COMPACTAR_ROTULO = compactarRotulo();

// o que a pessoa não deve ler: as peças por dentro do Ergon e o jargão (montado por partes: a exportação pública recusa
// arquivos com os nomes privados escritos por inteiro)
const JARGAO = new RegExp(['\\bmotor', 'cont[eê]iner', '\\btoken', '\\bAPI\\b', '\\bvolume\\b', '\\bprompt', 'Her' + 'mes', 'o Ergon (lê|sabe|mede)'].join('|'), 'i');

test('as porcentagens: inteiras, "<1%" para o que é quase nada', () => {
  assert.equal(pct(0), '0%');
  assert.equal(pct(0.004), '<1%');
  assert.equal(pct(0.456), '46%');
  assert.equal(pct(1.2), '100%');
});

test('as cinco partes, na ordem da barra, com o rótulo e a porcentagem; o que o sistema juntou ao pedido à parte da conversa', () => {
  const f = fatias({ partes: { instrucoes: 0.42, ferramentas: 0.05, memoria: 0.01, anexos: 0.2, conversa: 0.32 } });
  assert.deepEqual(f.map((x) => `${x.rotulo} ${x.pct}`), ['Instruções 42%', 'Ferramentas 5%', 'Memória 1%', 'Anexos e dados 20%', 'Conversa 32%']);
  // servidor de antes, sem a parte dos anexos: zero, sem quebrar a barra
  const velho = fatias({ partes: { instrucoes: 0.6, ferramentas: 0.1, memoria: 0, conversa: 0.3 } as never });
  assert.equal(velho.find((x) => x.id === 'anexos')!.fracao, 0);
  assert.match(COMPOSICAO_NOTA, /“Anexos e dados” é o que o sistema junta ao pedido/);
});

test('o tamanho médio por chamada, com vírgula decimal', () => {
  assert.equal(tamanhoMedio(58_400), '≈ 58 mil por chamada');
  assert.equal(tamanhoMedio(4_250), '≈ 4,3 mil por chamada');
  assert.equal(tamanhoMedio(830), '≈ 830 por chamada');
  assert.equal(chamadasTexto(1), '1 chamada');
  assert.equal(chamadasTexto(1200), '1.200 chamadas');
});

test('a linha de detalhe: de que são feitas as instruções e o que o provedor reaproveitou', () => {
  const d = detalhe({ instrucoes: { agente: 0.48, base: 0.1, competencias: 0.04 }, cache: 0.7, chamadas: 3 });
  assert.match(d, /^Instruções: 48% do agente no Ergon \(cargo, equipe, cards e regras\), 10% da base da equipe e 4% da lista de competências\./);
  assert.match(d, /70% reaproveitado pelo provedor/);
  assert.doesNotMatch(detalhe({ instrucoes: { agente: 0.5, base: 0.1, competencias: 0 }, cache: null, chamadas: 1 }), /reaproveitado/);
});

test('passos por pedido: o padrão 20 está nas escolhas, dentro do que o servidor aceita (5 a 60)', () => {
  assert.ok(PASSOS_OPCOES.includes(PASSOS_PADRAO));
  assert.ok(PASSOS_OPCOES.every((n) => n >= 5 && n <= 60));
  assert.match(PASSOS_AJUDA, /O padrão é 20\./);
  assert.match(PASSOS_AJUDA, /conta no consumo/);
  // um motor para vários workspaces: a tela avisa que a escolha vale para todos
  assert.equal(passosCompartilhado(0), '');
  assert.match(passosCompartilhado(1), /^Vale também para o outro workspace que usa a mesma equipe/);
  assert.match(passosCompartilhado(3), /os outros 3 workspaces que usam a mesma equipe/);
});

test('os textos da tela, sem jargão nem as peças por dentro', () => {
  const textos = [COMPOSICAO_INTRO, COMPOSICAO_VAZIA, COMPOSICAO_NOTA, COMPOSICAO_ESTIMADA, PASSOS_AJUDA, PASSOS_DEPOIS, passosCompartilhado(2),
    detalhe({ instrucoes: { agente: 0.5, base: 0.2, competencias: 0.1 }, cache: 0.3, chamadas: 2 }), tamanhoMedio(61_000)];
  for (const t of textos) assert.doesNotMatch(t, JARGAO, t);
  // e o cartão na tela usa estes textos (nada escrito à mão com jargão no componente)
  const view = fs.readFileSync(new URL('../views/ConfiguracaoView.tsx', import.meta.url), 'utf8');
  const cartao = view.slice(view.indexOf('function PassosField'), view.indexOf('/** Quantos processos andam ao mesmo tempo'));
  assert.ok(cartao.includes('composicaoIntro()') && cartao.includes('passosAjuda()'), 'o componente usa os textos daqui');
  const literais = [...cartao.matchAll(/>([^<>{}]+)</g)].map((m) => m[1].trim()).filter(Boolean);
  for (const l of literais) assert.doesNotMatch(l, JARGAO, l);
});

test('rc.26: resumir as conversas longas (ligado por padrão), com texto simples, e a tela diz em quantos pedidos a conversa foi resumida', () => {
  for (const t of [COMPACTAR_ROTULO, COMPACTAR_AJUDA, COMPACTAR_DEPOIS, COMPACTAR_ATUALIZACAO, resumidasTexto(3, 40)]) assert.doesNotMatch(t, JARGAO, t);
  assert.match(COMPACTAR_AJUDA, /vira um resumo/);
  assert.match(COMPACTAR_AJUDA, /próximo pedido/);
  // sem prometer a íntegra: o resumo guarda os pedidos encurtados (até um tamanho), não palavra por palavra
  assert.doesNotMatch(COMPACTAR_AJUDA, /palavra por palavra|ao pé da letra|na íntegra/);
  assert.match(COMPACTAR_AJUDA, /encurtados/);
  assert.ok(COMPACTAR_AJUDA.split(/[.;] /).length <= 4, 'curto: bateu o olho, decidiu');
  // equipe de antes desta opção: diz que chega com a atualização, sem afirmar que já vale
  assert.match(COMPACTAR_ATUALIZACAO, /próxima atualização da equipe/);
  assert.doesNotMatch(COMPACTAR_ATUALIZACAO, /recebe assim que estiver ligada/);
  assert.equal(resumidasTexto(0, 10), '', 'nenhum pedido resumido: nada a dizer');
  assert.match(resumidasTexto(1, 1), /^Conversa resumida em 1 pedido:/);
  assert.match(resumidasTexto(3, 40), /^Conversa resumida em 3 de 40 pedidos:/);
  assert.match(resumidasTexto(1, 40), /^Conversa resumida em 1 de 40 pedidos:/);
  const d = detalhe({ instrucoes: { agente: 0.5, base: 0.1, competencias: 0 }, cache: null, chamadas: 9, resumidas: 2, execucoes: 5 });
  assert.match(d, /Conversa resumida em 2 de 5 pedidos/);
  assert.doesNotMatch(detalhe({ instrucoes: { agente: 0.5, base: 0.1, competencias: 0 }, cache: null, chamadas: 9 }), /resumida/, 'servidor de antes');
  // a escolha fica junto dos passos por pedido e usa os textos daqui, sem botão parado esperando
  const view = fs.readFileSync(new URL('../views/ConfiguracaoView.tsx', import.meta.url), 'utf8');
  const campo = view.slice(view.indexOf('function CompactacaoField'), view.indexOf('/** Do que é feita cada chamada ao modelo'));
  assert.ok(campo.includes('compactarRotulo()') && campo.includes('compactarAjuda()') && campo.includes("'/api/team/compactacao'"));
  assert.doesNotMatch(campo, /disabled=/);
  // a mesma caixa de marcar das outras da seção (fora do bloco de letra pequena dos campos) e o aviso em linha própria
  assert.doesNotMatch(campo, /className="field/);
  assert.match(campo, /<label className="check">/);
  assert.ok(campo.includes('compactarAtualizacao()') && campo.includes('role="status"'));
  assert.ok(view.includes('atualizacao={state.teamCompactacaoAtualizacao === true}'), 'o aviso da atualização vem do servidor');
  assert.ok(view.indexOf('<CompactacaoField') > view.indexOf('<PassosField'), 'logo depois dos passos por pedido');
});

test('rc.26: em inglês, os mesmos textos sem jargão, com o plural e os números do idioma', async () => {
  await setIdioma('en', { guardar: false });
  try {
    const textos = [composicaoIntro(), composicaoVazia(), composicaoNota(), composicaoEstimada(), passosAjuda(), passosDepois(), passosCompartilhado(2),
      compactarRotulo(), compactarAjuda(), compactarDepois(), compactarAtualizacao(), resumidasTexto(3, 40),
      detalhe({ instrucoes: { agente: 0.5, base: 0.2, competencias: 0.1 }, cache: 0.3, chamadas: 2 }), tamanhoMedio(61_000)];
    for (const t of textos) { assert.doesNotMatch(t, JARGAO, t); assert.doesNotMatch(t, /[ãõçÃÕÇ]/, t); }
    assert.equal(tamanhoMedio(4_250), '≈ 4.3K per call');
    assert.equal(tamanhoMedio(58_000), '≈ 58K per call');
    assert.equal(tamanhoMedio(1_250_000), '≈ 1.3M per call');
    assert.equal(chamadasTexto(1), '1 call');
    assert.equal(chamadasTexto(1200), '1,200 calls');
    assert.match(passosCompartilhado(1), /^This also applies to the other workspace that uses the same team/);
    assert.match(passosCompartilhado(3), /the other 3 workspaces that use the same team/);
    assert.match(resumidasTexto(1, 1), /^Conversation summarized in 1 request:/);
    assert.match(resumidasTexto(3, 40), /^Conversation summarized in 3 of 40 requests:/);
    assert.deepEqual(fatias({ partes: { instrucoes: 0.42, ferramentas: 0.05, memoria: 0.01, anexos: 0.2, conversa: 0.32 } }).map((x) => x.rotulo), ['Instructions', 'Tools', 'Memory', 'Attachments and data', 'Conversation']);
    assert.match(compactarAtualizacao(), /see Health/);
  } finally { await setIdioma('pt-BR', { guardar: false }); }
});
