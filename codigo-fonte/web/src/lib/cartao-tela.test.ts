// O card do quadro e o detalhe: etiquetas, campos à vista, contagem do comentário, links seguros, iniciais e números.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { camposNoCard, contarLetras, corDaPaleta, etiquetasDe, iniciais, lerNumero, linkSeguro, nomeDoLink, textoDoValor } from './cartao-tela.ts';
import type { CampoQuadro } from './types.ts';

const campo = (x: Partial<CampoQuadro> & Pick<CampoQuadro, 'id' | 'type'>): CampoQuadro => ({ boardId: 'b', name: x.id, options: [], position: 0, showOnCard: false, ...x });
const fmt = { numero: (n: number) => `n${n}`, data: (d: string) => `d${d}` };
const membros = [{ id: 'u1', name: 'Ana Maria Souza' }];
const fields = [
  campo({ id: 'et', type: 'labels', options: [{ id: 'o1', name: 'Urgente', color: 'urgente' }, { id: 'o2', name: 'VIP', color: 'roxo-inventado' }] }),
  campo({ id: 'custo', type: 'number', name: 'Custo', showOnCard: true }),
  campo({ id: 'fase', type: 'select', name: 'Fase', showOnCard: true, options: [{ id: 's1', name: 'Obra', color: 'info' }] }),
  campo({ id: 'nota', type: 'text', name: 'Nota' }),
  campo({ id: 'dono', type: 'person', name: 'Dono', showOnCard: true }),
];

describe('o cartão na tela', () => {
  test('etiquetas: na ordem das opções; cor fora da paleta vira a neutra; opção apagada some', () => {
    assert.deepEqual(etiquetasDe(fields, { et: ['o2', 'o1', 'sumiu'] }), [{ id: 'o1', name: 'Urgente', color: 'urgente' }, { id: 'o2', name: 'VIP', color: 'neutro' }]);
    assert.deepEqual(etiquetasDe(fields, undefined), []);
    assert.equal(corDaPaleta('url(javascript:x)'), 'neutro');
  });
  test('campos no cartão: só os marcados e com valor; lista pelo nome da opção; pessoa pelo nome', () => {
    assert.deepEqual(camposNoCard(fields, { custo: 12.5, fase: 's1', nota: 'não aparece', dono: 'u1' }, membros, fmt),
      [{ id: 'custo', name: 'Custo', texto: 'n12.5', cor: null }, { id: 'fase', name: 'Fase', texto: 'Obra', cor: 'info' }, { id: 'dono', name: 'Dono', texto: 'Ana Maria Souza', cor: null }]);
    assert.deepEqual(camposNoCard(fields, { custo: null, fase: 'apagada', dono: 'saiu' }, membros, fmt), []);
    assert.equal(textoDoValor(campo({ id: 'd', type: 'date' }), '2026-12-01', membros, fmt), 'd2026-12-01');
    assert.equal(textoDoValor(campo({ id: 'd', type: 'date' }), 'ontem', membros, fmt), null);
  });
  test('comentário: conta por letra, como o servidor', () => {
    assert.equal(contarLetras('  olá 👍  '), 5);
    assert.equal(contarLetras('é'.repeat(240)), 240);
  });
  test('links: só http e https; o nome é o título ou o site', () => {
    assert.equal(linkSeguro('https://acme.example/a?b=1'), 'https://acme.example/a?b=1');
    for (const ruim of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'nada']) assert.equal(linkSeguro(ruim), null, ruim);
    assert.equal(nomeDoLink('https://acme.example/propostas/2026/'), 'acme.example/propostas/2026');
    assert.equal(nomeDoLink('https://acme.example/x', ' Proposta '), 'Proposta');
    assert.ok(nomeDoLink(`https://acme.example/${'a'.repeat(80)}`).length < 50);
  });
  test('iniciais e números digitados', () => {
    assert.deepEqual([iniciais('Ana Maria Souza'), iniciais('carla'), iniciais('  ')], ['AS', 'C', '?']);
    assert.deepEqual(['1.250,5', '1250.5', '1,250.5', '12', ' -3,2 ', 'mil', ''].map(lerNumero), [1250.5, 1250.5, 1250.5, 12, -3.2, null, null]);
  });
});
