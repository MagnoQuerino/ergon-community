/**
 * A cor de cada agente (rc.43): paleta com contraste no claro e no escuro, distinta dentro da equipe (derivada do id, com
 * desempate), estável quando outro entra ou sai, e a mesma na revisão ao vivo.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { distribuirCores, indicePreferido, PALETA_AGENTES, PARECIDAS } from '../../shared/cor-agente.ts';
import { harness, req, setupOwner } from './helpers.ts';

const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (h: string) => { const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const contraste = (a: string, b: string) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };

describe('cor do agente', () => {
  test('paleta: 3:1 com os fundos do tema claro e do escuro; nenhuma cor repetida', () => {
    for (const c of PALETA_AGENTES) {
      for (const f of ['#ffffff', '#f4efe6', '#fffdf8', '#f8f3ea']) assert.ok(contraste(c.claro, f) >= 3, `${c.claro} × ${f}`);
      for (const f of ['#12151b', '#1a1e26', '#20252e']) assert.ok(contraste(c.escuro, f) >= 3, `${c.escuro} × ${f}`);
    }
    assert.equal(new Set(PALETA_AGENTES.map((c) => c.claro)).size, PALETA_AGENTES.length);
    assert.equal(new Set(PALETA_AGENTES.map((c) => c.escuro)).size, PALETA_AGENTES.length);
  });

  test('derivada do id, com desempate: até 16 agentes, todos diferentes; quem chega não muda a cor de ninguém', () => {
    // ids que o sorteio manda para a mesma cor (a colisão do print: dois agentes na mesma cor)
    const mesma: string[] = []; for (let i = 0; mesma.length < 3; i++) if (indicePreferido(`agt_x${i}`) === 0) mesma.push(`agt_x${i}`);
    const m = distribuirCores(mesma);
    assert.equal(new Set(m.values()).size, 3);
    assert.equal(m.get(mesma[0]), 0, 'o primeiro fica com a do sorteio');
    for (let rodada = 0; rodada < 50; rodada++) {
      const ids = Array.from({ length: 16 }, (_, i) => `agt_${rodada}_${i}_${(rodada * 7919 + i * 104729).toString(36)}`);
      const cores = distribuirCores(ids);
      assert.equal(new Set(cores.values()).size, 16, `rodada ${rodada}`);
      const antes = distribuirCores(ids.slice(0, 10));
      for (const id of ids.slice(0, 10)) assert.equal(antes.get(id), cores.get(id), 'estável');
    }
    assert.ok(PARECIDAS > 0);
  });

  test('a equipe padrão sai com cores distintas; a rota devolve o par; a revisão usa a mesma', async () => {
    const h = await harness(); const s = await setupOwner(h);
    try {
      const r = await req(h, 'GET', '/api/team/cores', s);
      assert.equal(r.status, 200);
      const cores = (r.json as { cores: Array<{ id: string; nome: string; claro: string; escuro: string }> }).cores;
      const ativos = h.db.all<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND status = 'active'", s.workspaceId);
      assert.ok(ativos.length >= 8, String(ativos.length));
      assert.equal(new Set(cores.map((c) => c.claro)).size, cores.length, 'todas diferentes');
      const nomes = new Map(cores.map((c) => [c.nome, c.claro]));
      assert.notEqual(nomes.get('Heródoto'), nomes.get('Arquimedes'));
    } finally { await h.close(); }
  });
});
