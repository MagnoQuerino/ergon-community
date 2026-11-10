// Os nomes de fábrica na tela (construções, tipos e andares) seguem o idioma; o que a pessoa escreveu fica como está.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CATALOG } from '../../../shared/city.ts';
import { pt } from '../i18n/pt/index.ts';
import { setIdioma } from '../i18n/index.ts';
import { TIPOS_DE_FABRICA, comumDoTipo, descricaoDoTipo, nomeDaConstrucao, nomeDoAndar, nomeDoTipo } from './buildings.ts';
import { areaDef } from './areas.ts';
import { indicadores, modoCidade } from '../lib/barra.ts';
import { elapsed } from '../lib/ambient.ts';

const dic = pt.cidade as Record<string, unknown>;

test('o dicionário repete o catálogo: o português na tela é o mesmo de shared/city.ts, e todo tipo tem tradução', () => {
  assert.deepEqual([...TIPOS_DE_FABRICA].sort(), CATALOG.map((c) => c.id).sort(), 'um tipo do catálogo sem nome no dicionário');
  for (const c of CATALOG) {
    assert.equal(dic[`tipo.${c.id}.nome`], c.name, `${c.id}: nome`);
    assert.equal(dic[`tipo.${c.id}.comum`], c.common, `${c.id}: equivalente de hoje`);
    assert.equal(dic[`tipo.${c.id}.descricao`], c.description, `${c.id}: descrição`);
  }
});

test('nomes de fábrica em português ficam como o servidor grava; em inglês, traduzidos; o da pessoa nunca muda', async () => {
  await setIdioma('pt-BR', { guardar: false });
  assert.equal(nomeDaConstrucao('Stoa de Ergon', 'stoa'), 'Stoa de Ergon', 'em português, o nome que o servidor grava (as outras telas leem building_name cru)');
  assert.equal(nomeDaConstrucao('Stoa do Ergon'), 'Stoa de Ergon');
  assert.equal(nomeDaConstrucao('Termas', 'termas'), 'Termas');
  assert.equal(nomeDoAndar('Térreo'), 'Térreo');
  assert.equal(nomeDoAndar('2º andar'), '2º andar');
  assert.equal(comumDoTipo('termas'), 'piscina');

  await setIdioma('en', { guardar: false });
  try {
    assert.equal(nomeDaConstrucao('Stoa de Ergon', 'stoa'), 'Stoa of Ergon');
    assert.equal(nomeDaConstrucao('Stoa do Ergon'), 'Stoa of Ergon');
    assert.equal(nomeDaConstrucao('Ágora', 'agora'), 'Agora');
    assert.equal(nomeDaConstrucao('Termas', 'termas'), 'Baths');
    assert.equal(nomeDaConstrucao('Ginásio'), 'Gymnasium');
    assert.equal(nomeDaConstrucao('Bairro', 'bairro'), 'District');
    assert.equal(nomeDaConstrucao('Teatro', 'teatro'), 'Theater');
    assert.equal(nomeDaConstrucao('Empórion 2', 'emporion'), 'Emporion 2', 'o número da segunda construção do mesmo tipo fica');
    // o que a pessoa escreveu (ou o nome de outro tipo numa construção) não se traduz
    assert.equal(nomeDaConstrucao('Escritório da Ana', 'stoa'), 'Escritório da Ana');
    assert.equal(nomeDaConstrucao('Termas', 'stoa'), 'Termas', 'com o tipo dado, só o nome do próprio tipo é de fábrica');
    assert.equal(nomeDoAndar('Térreo'), 'Ground floor');
    assert.equal(nomeDoAndar('3º andar'), 'Floor 3');
    assert.equal(nomeDoAndar('Sala da diretoria'), 'Sala da diretoria');
    assert.equal(nomeDoTipo('ginasio'), 'Gymnasium');
    assert.equal(comumDoTipo('termas'), 'pool');
    assert.match(descricaoDoTipo('agora'), /Connections/);
    assert.equal(nomeDoTipo('mod-sem-dicionario'), 'mod-sem-dicionario', 'tipo desconhecido: o que veio');
    // os rótulos montados fora do React também trocam
    assert.equal(modoCidade(true).label, 'Calm mode');
    assert.match(modoCidade(false).title, /^Living city/);
    assert.deepEqual(indicadores({ busy: 1250, limit: null, decisoes: 1, entregas: 2 }).map((i) => i.texto), ['1,250 in progress', '1 needs you', '2 deliveries']);
    assert.equal(elapsed(new Date(Date.now() - 2 * 86_400_000).toISOString()), '2 days ago');
  } finally {
    await setIdioma('pt-BR', { guardar: false });
  }
});

test('os nomes das áreas e o que os agentes fazem nelas são chaves do dicionário (traduzidas na hora de mostrar)', () => {
  for (const k of ['agora', 'teatro', 'termas', 'ginasio', 'bairro'] as const) {
    const def = areaDef(k)!;
    assert.ok(def.name.startsWith('cidade.lugar.') && def.name.slice('cidade.'.length) in dic, `${k}: ${def.name}`);
    for (const a of def.activities) if (a.label) assert.ok(a.label.slice('cidade.'.length) in dic, `${k}/${a.id}: ${a.label}`);
  }
});
