/**
 * Recursos livres (rc.42, regra do dono): as ferramentas não são separadas por agente. Todo agente tem por padrão tudo o
 * que não é protegido; a especialidade é orientação no prompt (área natural), não trava; os recursos com custo são um
 * interruptor da equipe; as protegidas vêm com o "Ativar acesso total?" da equipe. Exceção: o Coordenador é sempre o
 * Coordenador (o papel não muda nem sai), e o prompt dele continua editável.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { COM_CUSTO, PROTEGIDAS, TOOLS, abrirFerramentas, ferramentasAbertas, ferramentasEfetivas, toolsetsFor } from '../src/services/characters.ts';
import { almaDoAgente, instructionsFor } from '../src/services/runs.ts';
import { VISUAIS_NO_PROMPT } from '../../shared/visuais/prompt.ts';
import { harness, req, setupOwner } from './helpers.ts';

const lista = (v: string | null): string[] => { try { const x = JSON.parse(v ?? '[]'); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };

describe('recursos livres: nenhuma trava por agente', () => {
  test('nenhum agente fica sem ferramenta por causa do papel: equipe padrão, Coordenador e agentes novos de qualquer papel', async () => {
    const h = await harness(); const s = await setupOwner(h);
    try {
      for (const [name, role, sectorKey] of [['Tales', 'Pesquisa de mercado', 'brainstorm'], ['Safo', 'Atendimento a clientes', 'auto'], ['Zenão', 'Financeiro', 'auto']]) {
        const r = await req(h, 'POST', '/api/agents', s, { name, role, sectorKey });
        assert.equal(r.status, 201, JSON.stringify(r.json));
      }
      const todos = toolsetsFor(ferramentasEfetivas(ferramentasAbertas()));
      assert.ok(todos.length >= 8, todos.join(','));
      const ags = h.db.all<{ name: string; tools: string | null; coordinator: number }>("SELECT name, tools, coordinator FROM agents WHERE workspace_id = ? AND status = 'active'", s.workspaceId);
      assert.ok(ags.some((a) => Number(a.coordinator) === 1) && ags.length >= 13);
      for (const a of ags) {
        const tem = new Set(toolsetsFor(ferramentasEfetivas(lista(a.tools))));
        const falta = todos.filter((t) => !tem.has(t));
        assert.deepEqual(falta, [], `${a.name}${Number(a.coordinator) ? ' (Coordenador)' : ''} sem: ${falta.join(',')}`);
        // e todas as do Ergon que não são do cargo de coordenação
        for (const t of ferramentasAbertas()) assert.ok(lista(a.tools).includes(t), `${a.name} sem ${t}`);
        assert.ok(!PROTEGIDAS.some((t) => lista(a.tools).includes(t)), `${a.name}: protegida só com o acesso total`);
      }
    } finally { await h.close(); }
  });

  test('recursos com custo: interruptor da equipe, não item por agente (tirar da lista de um agente não tira dele)', () => {
    for (const t of COM_CUSTO) {
      assert.ok(TOOLS[t] && TOOLS[t].aviso === 'custo', t);
      assert.ok(ferramentasEfetivas(['web']).includes(t), t);
    }
    assert.ok(!PROTEGIDAS.some((t) => ferramentasEfetivas(['web']).includes(t)), 'sem o acesso total, nada protegido');
    assert.ok(PROTEGIDAS.every((t) => ferramentasEfetivas(['web'], { acessoTotal: true }).includes(t)));
  });

  test('especialidade é orientação: o papel vai no prompt como área natural; o Coordenador prefere delegar, sem trava', async () => {
    const h = await harness(); const s = await setupOwner(h);
    try {
      const esp = h.db.get<{ id: string; role: string }>("SELECT id, role FROM agents WHERE workspace_id = ? AND coordinator = 0 AND status = 'active' LIMIT 1", s.workspaceId)!;
      const coord = h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND coordinator = 1', s.workspaceId)!.id;
      const alma = almaDoAgente(h.db, s.workspaceId, esp.id);
      assert.match(alma, new RegExp(`Sua área natural é ${esp.role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: é por onde a equipe costuma te procurar, não um limite`));
      const ic = instructionsFor(h.db, s.workspaceId, coord, '');
      assert.match(ic, /Prefira passar ao especialista o trabalho longo/);
      assert.doesNotMatch(ic, /Não faça o trabalho dos especialistas/);
    } finally { await h.close(); }
  });

  test('o papel de Coordenador é fixo (não muda nem sai); o prompt dele é editável', async () => {
    const h = await harness(); const s = await setupOwner(h);
    try {
      const coord = h.db.get<{ id: string; role: string }>('SELECT id, role FROM agents WHERE workspace_id = ? AND coordinator = 1', s.workspaceId)!;
      assert.equal((await req(h, 'PATCH', `/api/agents/${coord.id}`, s, { role: 'Vendas' })).status, 409, 'a função não muda');
      assert.equal((await req(h, 'PATCH', `/api/agents/${coord.id}`, s, { sectorKey: 'brainstorm' })).status, 409, 'o setor não muda');
      assert.equal((await req(h, 'POST', `/api/agents/${coord.id}/deactivate`, s)).status, 409, 'não sai da equipe');
      assert.equal(h.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM agents WHERE workspace_id = ? AND coordinator = 1 AND status = 'active'", s.workspaceId)!.n, 1);
      assert.equal(h.db.get<{ role: string }>('SELECT role FROM agents WHERE id = ?', coord.id)!.role, coord.role);
      // o prompt (foco da coordenação) é da pessoa
      const foco = 'Priorize os clientes da carteira Sul e responda sempre em tópicos.';
      assert.equal((await req(h, 'PATCH', `/api/agents/${coord.id}`, s, { charter: foco })).status, 200);
      assert.match(instructionsFor(h.db, s.workspaceId, coord.id, ''), /Priorize os clientes da carteira Sul/);
    } finally { await h.close(); }
  });

  test('quem já tinha equipe: todos passam ao padrão aberto (o Coordenador também), uma vez; quem a pessoa restringiu fica', async () => {
    const h = await harness(); const s = await setupOwner(h);
    try {
      const id = (k: string) => h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND char_key = ?', s.workspaceId, k)!.id;
      const coord = h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND coordinator = 1', s.workspaceId)!.id;
      h.db.run("DELETE FROM workspace_settings WHERE workspace_id = ? AND key = 'tools.aberto'", s.workspaceId);
      // como era: o Coordenador sem as "pesadas", um especialista com a lista estreita do sistema
      h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro', 'encaminhar', 'delegar', 'regras', 'web', 'contas']), coord);
      h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro', 'passos', 'saida', 'contas']), id('diogenes'));
      // a pessoa restringiu Platão de propósito
      const restrito = ['arquivos', 'quadro', 'passos', 'contas'];
      assert.equal((await req(h, 'PATCH', `/api/agents/${id('platao')}`, s, { tools: restrito })).status, 200);
      assert.ok(abrirFerramentas(h.db, null, s.workspaceId) >= 2);
      const de = (x: string) => lista(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', x)!.tools);
      for (const t of ferramentasAbertas(true)) assert.ok(de(coord).includes(t), `Coordenador com ${t}`);
      for (const t of ferramentasAbertas()) assert.ok(de(id('diogenes')).includes(t), `Diógenes com ${t}`);
      assert.deepEqual(de(id('platao')), restrito, 'a restrição da pessoa fica');
      // os blocos visuais não são item da lista: o restrito também mostra os números como visual (a ferramenta visual
      // vem com os cartões, sempre ligados no motor; a regra vai no SOUL de todos)
      assert.ok(!('visual' in TOOLS), 'visual não é ferramenta por agente');
      for (const x of [coord, id('platao'), id('diogenes')]) assert.ok(almaDoAgente(h.db, s.workspaceId, x).includes(VISUAIS_NO_PROMPT), x);
      assert.equal(abrirFerramentas(h.db, null, s.workspaceId), 0, 'uma vez só');
    } finally { await h.close(); }
  });
});
