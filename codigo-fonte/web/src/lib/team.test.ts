import assert from 'node:assert/strict';
import { test } from 'node:test';
import { agentOptions, coordLabel, examplesOf, holdersText, restOf, tipoComum } from './team.ts';

test('quem tem a ferramenta: contagem do servidor e até 3 nomes, o resto em "e mais" (nunca some calado)', () => {
  assert.equal(holdersText(undefined), 'ninguém');
  assert.equal(holdersText({ count: 0, sample: [] }), 'ninguém');
  assert.equal(holdersText({ count: 2, sample: ['Hipátia', 'Sócrates'] }), 'Hipátia, Sócrates');
  assert.equal(holdersText({ count: 3, sample: ['Aristóteles', 'Hipátia', 'Sócrates'] }), 'Aristóteles, Hipátia, Sócrates');
  assert.equal(holdersText({ count: 3_211, sample: ['Aristóteles', 'Hipátia', 'Sócrates'] }), 'Aristóteles, Hipátia, Sócrates e mais 3.208');
  // amostra maior que a contagem (corrida entre consultas): não inventa ninguém
  assert.equal(holdersText({ count: 1, sample: ['Hipátia', 'Sócrates'] }), 'Hipátia');
  assert.equal(holdersText({ count: 5, sample: [] }), '5 agentes');
});

test('exemplos da Ajuda: os colegas que o servidor manda, repetindo o primeiro se faltar', () => {
  assert.deepEqual(examplesOf([{ name: 'Hipátia' }, { name: 'Sócrates' }, { name: 'Euclides' }]), ['Hipátia', 'Sócrates', 'Euclides']);
  assert.deepEqual(examplesOf([{ name: 'Hipátia' }]), ['Hipátia', 'Hipátia', 'Hipátia']);
  assert.deepEqual(examplesOf([]), ['um agente', 'um agente', 'um agente']);
  assert.equal(coordLabel({ name: 'Gandalf' }), 'Gandalf');
  assert.equal(coordLabel(null), 'a coordenação');
});

test('filtro "Agente" do quadro: só quem tem card, sem repetir, em ordem alfabética (desativado com nome)', () => {
  const tasks = [
    { agent_id: 'agt_s', agent_name: 'Sócrates' }, { agent_id: null, agent_name: null }, { agent_id: 'agt_a', agent_name: 'Ésquilo' },
    { agent_id: 'agt_s', agent_name: 'Sócrates' }, { agent_id: 'agt_h', agent_name: 'Hipátia' }, { agent_id: 'agt_x' },
  ];
  assert.deepEqual(agentOptions(tasks), [
    { id: 'agt_x', name: 'Agente' }, { id: 'agt_a', name: 'Ésquilo' }, { id: 'agt_h', name: 'Hipátia' }, { id: 'agt_s', name: 'Sócrates' },
  ]);
  assert.deepEqual(agentOptions([]), []);
});

test('resto da equipe nas conversas: tira quem já tem conversa, na mesma ordem; com 10 mil, só filtra o que veio', () => {
  const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual(restOf(items, new Set(['b', 'd'])).map((x) => x.id), ['a', 'c']);
  assert.equal(restOf(items, new Set()), items, 'sem conversas: a mesma lista');
  const big = Array.from({ length: 48 }, (_, i) => ({ id: `agt_${i}` }));
  assert.equal(restOf(big, new Set(big.map((x) => x.id))).length, 0, 'página inteira já nas conversas: a próxima vem ao rolar');
});

test('personalidades na tela: o português do dicionário é o de shared/personalities.ts, e o inglês tem os mesmos exemplos', async () => {
  const { PERSONALITIES, EXTREME_WARNING } = await import('../../../shared/personalities.ts');
  const { default: pt } = await import('../i18n/pt/equipe.ts');
  const { default: en } = await import('../i18n/en/equipe.ts');
  const P = pt as Record<string, unknown>; const E = en as Record<string, unknown>;
  for (const p of PERSONALITIES) {
    assert.equal(P[`persona.${p.id}.nome`], p.label, p.id);
    assert.equal(P[`persona.${p.id}.resumo`], p.summary, p.id);
    assert.deepEqual(String(P[`persona.${p.id}.exemplos`]).split('\n'), p.examples, p.id);
    assert.equal(String(E[`persona.${p.id}.exemplos`]).split('\n').length, p.examples.length, `${p.id}: um exemplo em inglês para cada um`);
  }
  assert.equal(P['persona.aviso'], EXTREME_WARNING);
});

test('a descrição do tipo de construção vem do dicionário da Cidade; um tipo sem chave fica com a do dado', async () => {
  const { pt } = await import('../i18n/pt/index.ts');
  const { en } = await import('../i18n/en/index.ts');
  const { setIdioma } = await import('../i18n/index.ts');
  const { CATALOG } = await import('../../../shared/city.ts');
  // um tipo sem chave (de um pacote): fica com a descrição que veio no dado
  assert.equal(tipoComum('tipo-de-um-pacote', 'galpão'), 'galpão');
  const cidade = (d: unknown) => (d as Record<string, Record<string, string> | undefined>).cidade ?? {};
  try {
    for (const [idioma, dic] of [['pt-BR', pt], ['en', en]] as const) {
      await setIdioma(idioma, { guardar: false });
      for (const x of CATALOG) {
        const traduzido = cidade(dic)[`tipo.${x.id}.comum`];
        // com a chave da Cidade, o texto do idioma; sem ela (antes da junção com a área cidade), a reserva
        assert.equal(tipoComum(x.id, x.common), traduzido ?? x.common, `${idioma}: ${x.id}`);
      }
    }
  } finally {
    await setIdioma('pt-BR', { guardar: false });
  }
});

test('faixas e preço dos modelos: os termos do glossário (os mesmos do texto de Conexões, que aparece junto)', async () => {
  const { GLOSSARIO } = await import('../i18n/glossario.ts');
  const { default: pt } = await import('../i18n/pt/equipe.ts');
  const { default: en } = await import('../i18n/en/equipe.ts');
  const P = pt as Record<string, unknown>; const E = en as Record<string, unknown>;
  const termo = (x: string) => GLOSSARIO.find((g) => g.pt === x)?.en;
  for (const k of ['modelo.economico', 'modelo.intermediario', 'modelo.ponta']) assert.equal(E[k], termo(String(P[k])), k);
  assert.equal(E['faixa.economico'], 'budget');
  assert.equal(E['faixa.intermediario'], 'mid-range');
  assert.equal(E['faixa.ponta'], 'premium');
  assert.ok(String(P['modelo.preco']).includes('por milhão de tokens'));
  assert.equal(E['modelo.preco'], 'US${entrada} / US${saida} per million units of text (input / output)');
  assert.equal(E['ferramenta.bloqueada'], termo(String(P['ferramenta.bloqueada'])));
});
