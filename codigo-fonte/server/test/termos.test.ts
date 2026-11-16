/**
 * Termos de uso (16/11): Executar código e Terminal vêm ligados por padrão, avisado nos termos. Só depois do aceite da
 * versão atual: na conta nova (com a caixa marcada) ou, para quem já usava, no aviso depois da atualização.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { TERMOS_VERSAO, aceitouTermos, codigoPorPadrao } from '../src/services/termos.ts';
import { instructionsFor } from '../src/services/runs.ts';
import { decidir } from '../src/services/conexoes/regra.ts';
import { harness, req, sessionFrom, setupOwner } from './helpers.ts';

const ferramentas = (h: Awaited<ReturnType<typeof harness>>, ws: string, key: string) =>
  JSON.parse(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE workspace_id = ? AND char_key = ?', ws, key)!.tools) as string[];

describe('termos de uso e Executar código por padrão', () => {
  test('conta nova com os termos aceitos: versão gravada; os agentes ganham Executar código e Terminal uma vez', async () => {
    const h = await harness();
    try {
      const st = (await req(h, 'GET', '/api/auth/state', null)).json;
      assert.equal(st.termosVersao, TERMOS_VERSAO, 'a tela da conta nova sabe a versão');
      const r = await req(h, 'POST', '/api/auth/setup', null, { username: 'ana', password: 'senha-local-123', displayName: 'Ana', termos: TERMOS_VERSAO });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const s = await sessionFrom(h, r.res.headers['set-cookie']);
      assert.ok(aceitouTermos(h.db, s.userId));
      assert.ok(codigoPorPadrao(h.db, s.workspaceId));
      const me = (await req(h, 'GET', '/api/me', s)).json;
      assert.equal(me.termos.aceitos, true);
      const arq = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND char_key = 'arquimedes'", s.workspaceId)!.id;
      instructionsFor(h.db, s.workspaceId, arq, '');
      assert.ok(ferramentas(h, s.workspaceId, 'arquimedes').includes('calculo') && ferramentas(h, s.workspaceId, 'arquimedes').includes('terminal'));
      // a pessoa tirou do agente: não volta sozinho
      h.db.run('UPDATE agents SET tools = ? WHERE id = ?', JSON.stringify(['quadro']), arq);
      instructionsFor(h.db, s.workspaceId, arq, '');
      assert.deepEqual(ferramentas(h, s.workspaceId, 'arquimedes'), ['quadro']);
    } finally { await h.close(); }
  });

  test('quem já usava: nada muda até aceitar; o aviso aceita só a versão atual', async () => {
    const h = await harness();
    try {
      const s = await setupOwner(h); // sem o campo termos (como antes desta versão)
      assert.equal((await req(h, 'GET', '/api/me', s)).json.termos.aceitos, false, 'o aviso aparece');
      assert.ok(!codigoPorPadrao(h.db, s.workspaceId));
      const arq = h.db.get<{ id: string }>("SELECT id FROM agents WHERE workspace_id = ? AND char_key = 'arquimedes'", s.workspaceId)!.id;
      instructionsFor(h.db, s.workspaceId, arq, '');
      assert.ok(!ferramentas(h, s.workspaceId, 'arquimedes').includes('calculo'), 'sem aceite, o código não vem');
      assert.equal((await req(h, 'POST', '/api/me/termos', s, { versao: '2020-01-01' })).status, 409, 'versão antiga não vale');
      const ok = await req(h, 'POST', '/api/me/termos', s, { versao: TERMOS_VERSAO });
      assert.equal(ok.status, 200); assert.equal(ok.json.aceitos, true);
      assert.ok(ferramentas(h, s.workspaceId, 'arquimedes').includes('calculo'), 'a equipe ganha na hora do aceite');
      assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'termos.aceite' AND actor_id = ?", s.userId), 'o aceite fica registrado');
    } finally { await h.close(); }
  });

  test('desligado pela pessoa para a equipe: o aceite não religa', async () => {
    const h = await harness();
    try {
      const s = await setupOwner(h);
      h.db.run("INSERT INTO workspace_settings (workspace_id, key, value, updated_at) VALUES (?, 'ferramentas.terminal', 'desligado', ?)", s.workspaceId, new Date().toISOString());
      await req(h, 'POST', '/api/me/termos', s, { versao: TERMOS_VERSAO });
      const t = ferramentas(h, s.workspaceId, 'arquimedes');
      assert.ok(t.includes('calculo')); assert.ok(!t.includes('terminal'));
    } finally { await h.close(); }
  });

  test('com código ligado, ler vai direto; criar, enviar e apagar continuam confirmando', () => {
    const base = { origem: 'pessoa' as const, leuDeFora: false, liberarTudo: false, codigoLigado: true };
    assert.equal(decidir({ ...base, risco: 'ler' }), 'direto');
    assert.equal(decidir({ ...base, risco: 'organizar' }), 'confirmar');
    assert.equal(decidir({ ...base, risco: 'enviar' }), 'confirmar');
    assert.equal(decidir({ ...base, risco: 'apagar' }), 'confirmar');
    assert.equal(decidir({ ...base, risco: 'ler', ajuste: 'confirmar' }), 'confirmar', 'a escolha da pessoa na conexão vale acima');
  });
});
