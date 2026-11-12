/**
 * rc.27, regra do dono (12/11): "todos os benefícios, mesmo custosos, ligados por padrão; o usuário pode reduzir para
 * economizar". Confere:
 *  - cada agente (da equipe nova, criado, de um modelo de equipe) nasce com as ferramentas-benefício e as competências
 *    prontas; as que executam código (Terminal, Executar código) continuam fora, só com a senha;
 *  - quem vem da rc.26: uma vez por workspace, cada agente recebe o que falta; quem a pessoa editou recebe só as
 *    ferramentas novas (ninguém as escolheu); o que a pessoa tirar depois fica tirado;
 *  - na equipe: os conjuntos-benefício ligam sozinhos ao abrir (ausente = ligado), e o que a pessoa desliga em
 *    Configurações fica gravado e continua desligado também num motor recriado;
 *  - os ajudantes temporários e o trabalho contínuo (/meta) com o máximo útil por padrão.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BENEFICIOS, BENEFICIOS_NOVOS, COMPETENCIAS_PRONTAS, TOOLS, ferramentasDesligadas, grantBenefitTools } from '../src/services/characters.ts';
import { RODADAS_PADRAO } from '../src/services/comandos.ts';
import { AJUDANTES_PADRAO } from '../src/services/perfis.ts';
import type { HermesControlClient } from '../src/services/hermes.ts';
import { getSetting, setSetting } from '../src/services/sectors.ts';
import { harness, req, setupOwner } from './helpers.ts';

const lista = (v: string | null) => JSON.parse(v ?? '[]') as string[];

/** A ponte de controle com a lista da plataforma da API (o que o motor tem e o que ele aceita ligar). */
function plataforma(enabled: string[], safe = ['todo', 'web', 'vision', 'image_gen', 'skills', 'ergon_conexoes', 'ergon_cartoes', 'browser', 'video', 'video_gen', 'x_search', 'file', 'tts']) {
  const st = { enabled: [...enabled], sets: [] as string[][] };
  const control = {
    health: async () => true,
    apiToolsets: async () => ({ enabled: [...st.enabled], safe }),
    setApiToolsets: async (e: string[]) => { st.sets.push([...e]); st.enabled = e.filter((x) => safe.includes(x)); return [...st.enabled]; },
  } as unknown as HermesControlClient;
  return { st, control };
}

describe('benefícios ligados por padrão', () => {
  test('a equipe nova nasce com as ferramentas-benefício e as competências prontas; nada que executa código', async () => {
    const h = await harness();
    const s = await setupOwner(h);
    const ags = h.db.all<{ name: string; tools: string; hermes_skills: string | null }>("SELECT name, tools, hermes_skills FROM agents WHERE workspace_id = ? AND status = 'active'", s.workspaceId);
    assert.ok(ags.length >= 10);
    for (const a of ags) {
      const t = lista(a.tools);
      assert.ok(BENEFICIOS.every((b) => t.includes(b)), `${a.name}: ${t.join(',')}`);
      assert.ok(!t.some((x) => TOOLS[x]?.guarded), `${a.name}: nada que executa código vem de graça`);
      assert.deepEqual(lista(a.hermes_skills), [...COMPETENCIAS_PRONTAS], a.name);
    }
    // agente criado pela pessoa, sem escolher ferramentas: as do setor e os benefícios
    const r = await req(h, 'POST', '/api/agents', s, { name: 'Tales', role: 'Pesquisa de mercado', sectorKey: 'brainstorm' });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    const novo = h.db.get<{ tools: string; hermes_skills: string }>('SELECT tools, hermes_skills FROM agents WHERE id = ?', r.json.id)!;
    assert.ok(BENEFICIOS.every((b) => lista(novo.tools).includes(b)) && lista(novo.tools).includes('arquivos'), novo.tools);
    assert.deepEqual(lista(novo.hermes_skills), [...COMPETENCIAS_PRONTAS]);
    // a marca da concessão de antes não muda nada numa equipe que já nasceu completa
    assert.equal(grantBenefitTools(h.db, null, s.workspaceId), 0);
    await h.close();
  });

  test('quem vem da rc.26: cada agente recebe o que falta, uma vez; quem a pessoa editou recebe só as ferramentas novas', async () => {
    const h = await harness();
    const s = await setupOwner(h);
    const id = (k: string) => h.db.get<{ id: string }>('SELECT id FROM agents WHERE workspace_id = ? AND char_key = ?', s.workspaceId, k)!.id;
    // como estava na rc.26: listas estreitas da semente, sem competências, e sem a marca da rc.27
    h.db.run("DELETE FROM workspace_settings WHERE workspace_id = ? AND key = 'tools.rc27'", s.workspaceId);
    h.db.run("UPDATE agents SET tools = ?, hermes_skills = NULL WHERE workspace_id = ? AND char_key = 'diogenes'", JSON.stringify(['quadro', 'passos', 'saida', 'contas']), s.workspaceId);
    h.db.run("UPDATE agents SET tools = ?, hermes_skills = NULL WHERE workspace_id = ? AND char_key = 'platao'", JSON.stringify(['arquivos', 'quadro', 'passos', 'contas']), s.workspaceId);
    // a pessoa tirou a pesquisa e as competências de Platão (fica registrado como dela)
    assert.equal((await req(h, 'PATCH', `/api/agents/${id('platao')}`, s, { tools: ['arquivos', 'quadro', 'passos', 'contas'], hermesSkills: [] })).status, 200);
    assert.ok(grantBenefitTools(h.db, null, s.workspaceId) >= 2);
    const dio = h.db.get<{ tools: string; hermes_skills: string }>('SELECT tools, hermes_skills FROM agents WHERE id = ?', id('diogenes'))!;
    assert.ok(BENEFICIOS.every((b) => lista(dio.tools).includes(b)), `lista do sistema: todos os benefícios (${dio.tools})`);
    assert.deepEqual(lista(dio.hermes_skills), [...COMPETENCIAS_PRONTAS], 'sem competências e sem escolha: as prontas');
    const pla = h.db.get<{ tools: string; hermes_skills: string }>('SELECT tools, hermes_skills FROM agents WHERE id = ?', id('platao'))!;
    assert.ok(BENEFICIOS_NOVOS.every((b) => lista(pla.tools).includes(b)), 'as novas, que ninguém escolheu, entram');
    assert.ok(!lista(pla.tools).includes('web'), 'a pesquisa que a pessoa tirou fica tirada');
    assert.deepEqual(lista(pla.hermes_skills), [], 'as competências que a pessoa tirou ficam tiradas');
    // uma vez só: o que a pessoa tirar depois fica tirado
    assert.equal((await req(h, 'PATCH', `/api/agents/${id('diogenes')}`, s, { tools: ['quadro', 'passos', 'saida', 'contas'] })).status, 200);
    assert.equal(grantBenefitTools(h.db, null, s.workspaceId), 0);
    assert.deepEqual(lista(h.db.get<{ tools: string }>('SELECT tools FROM agents WHERE id = ?', id('diogenes'))!.tools), ['quadro', 'passos', 'saida', 'contas']);
    await h.close();
  });

  test('um modelo de equipe (boas-vindas) não apaga os benefícios', async () => {
    const h = await harness();
    const s = await setupOwner(h);
    const r = await req(h, 'POST', '/api/onboarding', s, { use: 'publicitario', niche: 'marketing', company: 'Agência Lume' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const ativos = h.db.all<{ name: string; tools: string }>("SELECT name, tools FROM agents WHERE workspace_id = ? AND status = 'active' AND coordinator = 0", s.workspaceId);
    assert.ok(ativos.length >= 3);
    for (const a of ativos) assert.ok(BENEFICIOS.every((b) => lista(a.tools).includes(b)), `${a.name}: ${a.tools}`);
    await h.close();
  });

  test('na equipe: os benefícios ligam sozinhos ao abrir; o que a pessoa desliga fica gravado e vale num motor recriado', async () => {
    const p = plataforma(['todo', 'web', 'vision', 'image_gen', 'skills', 'ergon_conexoes', 'ergon_cartoes']);
    const h = await harness({ executor: 'hermes', hermesApiKey: 'chave-de-teste-123' }, { control: p.control });
    const s = await setupOwner(h);
    let r = await h.ai.ensureBeneficios(ferramentasDesligadas(h.db, null));
    assert.deepEqual(r?.ligou.sort(), ['browser', 'file', 'tts', 'video'], 'ausente = ligado (busca no X e criar vídeos precisam de chave: ficam)');
    assert.ok(!p.st.enabled.includes('x_search') && !p.st.enabled.includes('video_gen'));
    r = await h.ai.ensureBeneficios(ferramentasDesligadas(h.db, null));
    assert.deepEqual(r, { ligou: [], desligou: [] }, 'já está: nada a mandar');
    await h.ai.refreshToolsets().catch(() => undefined);
    // a pessoa desliga o navegador e a pesquisa em Configurações › Ferramentas: fica gravado
    const quer = Object.values(TOOLS).filter((t) => t.safe && t.toolset && p.st.enabled.includes(t.toolset) && !['navegador', 'web'].includes(t.id)).map((t) => t.id);
    const put = await req(h, 'PUT', '/api/ai/tools', s, { enabled: quer });
    assert.equal(put.status, 200, JSON.stringify(put.json));
    assert.equal(getSetting(h.db, s.workspaceId, 'ferramentas.navegador'), 'desligado');
    assert.equal(getSetting(h.db, s.workspaceId, 'ferramentas.web'), 'desligado');
    assert.equal(getSetting(h.db, s.workspaceId, 'ferramentas.video'), null, 'o que ela não mexeu não é gravado');
    // o motor é recriado: as migrações do cofre põem tudo de novo
    p.st.enabled = ['todo', 'web', 'vision', 'image_gen', 'skills', 'ergon_conexoes', 'ergon_cartoes', 'browser', 'file', 'tts', 'video'];
    r = await h.ai.ensureBeneficios(ferramentasDesligadas(h.db, null));
    assert.deepEqual(r?.desligou.sort(), ['browser', 'web'], 'a escolha dela vale de novo');
    assert.ok(!p.st.enabled.includes('browser') && p.st.enabled.includes('video'));
    // ligar de novo pela tela: gravado como ligado
    setSetting(h.db, s.workspaceId, 'ferramentas.navegador', 'ligado');
    assert.ok(!ferramentasDesligadas(h.db, [s.workspaceId]).has('navegador'));
    await h.close();
  });

  test('ajudantes ligados com o máximo do motor e /meta com 20 rodadas (o mesmo do motor)', () => {
    assert.deepEqual(AJUDANTES_PADRAO, { ligado: true, max: 10 });
    assert.equal(RODADAS_PADRAO.meta, 20);
  });
});
