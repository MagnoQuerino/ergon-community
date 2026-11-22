/**
 * rc.47: a Lei DPDP da Índia sobre o que o Ergon já faz para a LGPD e o GDPR. O dono liga o aviso e preenche quem
 * responde pelos dados, o Grievance Officer, o Consent Manager (opcional) e o prazo (até 90 dias); cada pessoa vê o aviso
 * uma vez por versão, consente (com registro) e retira tão fácil quanto deu; nomeia um representante; e tudo isso entra em
 * "Baixar meus dados". Os termos de uso não mudam.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AVISO_DPDP_VERSAO, PRAZO_MAXIMO_DIAS } from '../src/services/dpdp.ts';
import { TERMOS_VERSAO } from '../src/services/termos.ts';
import { harness, req, setupOwner } from './helpers.ts';

const CONFIG = {
  ligado: true, responsavel: 'Sharma Traders Pvt Ltd', prazoDias: 30,
  grievance: { nome: 'Anita Rao', email: 'grievance@sharma.example', telefone: '+91 98123 45678', endereco: 'MG Road, Bengaluru' },
  consentManager: { nome: 'ConsentHub', registro: 'CM-0001', url: 'https://consenthub.example/in' },
};

test('DPDP: desligado por padrão; ligar pede quem responde e um contato; prazo até 90 dias; o dono configura', async () => {
  const h = await harness();
  try {
    const s = await setupOwner(h);
    const me = (await req(h, 'GET', '/api/me', s)).json;
    assert.equal(me.dpdp.ligado, false, 'nada muda para quem não liga');
    assert.equal(me.dpdp.versao, AVISO_DPDP_VERSAO);
    assert.equal(me.termos.versao, TERMOS_VERSAO, 'os termos de uso não mudaram');
    let r = await req(h, 'PUT', '/api/privacidade/dpdp', s, { ligado: true, responsavel: 'Sharma Traders' });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'incompleto');
    r = await req(h, 'PUT', '/api/privacidade/dpdp', s, { ...CONFIG, prazoDias: PRAZO_MAXIMO_DIAS + 1 });
    assert.equal(r.status, 400, 'acima do teto das Regras: recusado');
    r = await req(h, 'PUT', '/api/privacidade/dpdp', s, { ...CONFIG, consentManager: { nome: 'X', url: 'http://inseguro.example' } });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'url');
    r = await req(h, 'PUT', '/api/privacidade/dpdp', s, { ...CONFIG, grievance: { ...CONFIG.grievance, email: 'não é email' } });
    assert.equal(r.status, 400); assert.equal(r.json.error, 'email');
    r = await req(h, 'PUT', '/api/privacidade/dpdp', s, CONFIG);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(r.json, CONFIG);
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'privacidade.dpdp.config'"));
    // sem Consent Manager: o campo é opcional
    r = await req(h, 'PUT', '/api/privacidade/dpdp', s, { ...CONFIG, consentManager: null });
    assert.equal(r.json.consentManager, null);
    r = await req(h, 'PUT', '/api/privacidade/dpdp', s, CONFIG);
    const me2 = (await req(h, 'GET', '/api/me', s)).json;
    assert.equal(me2.dpdp.ligado, true); assert.equal(me2.dpdp.aceito, false, 'a pessoa ainda não consentiu: o aviso aparece');
    assert.deepEqual(me2.dpdp.config.grievance, CONFIG.grievance);
    assert.equal(me2.dpdp.config.prazoDias, 30);
  } finally { await h.close(); }
});

test('DPDP: consentir (com versão e idioma), retirar com o mesmo esforço, o histórico e o representante em "Baixar meus dados"', async () => {
  const h = await harness();
  try {
    const s = await setupOwner(h);
    assert.equal((await req(h, 'POST', '/api/me/consentimento', s, { versao: AVISO_DPDP_VERSAO })).status, 409, 'desligado: não há o que consentir');
    await req(h, 'PUT', '/api/privacidade/dpdp', s, CONFIG);
    assert.equal((await req(h, 'POST', '/api/me/consentimento', s, { versao: '2020-01-01' })).status, 409, 'outra versão: recarregar');
    let r = await req(h, 'POST', '/api/me/consentimento', s, { versao: AVISO_DPDP_VERSAO, idioma: 'hi' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.aceito, true); assert.ok(r.json.aceitoEm);
    const linha = h.db.get<{ idioma: string; versao: string }>('SELECT idioma, versao FROM consentimentos WHERE user_id = ?', s.userId)!;
    assert.deepEqual(linha, { idioma: 'hi', versao: AVISO_DPDP_VERSAO });
    assert.equal((await req(h, 'GET', '/api/me', s)).json.dpdp.aceito, true);
    r = await req(h, 'DELETE', '/api/me/consentimento', s);
    assert.equal(r.json.aceito, false); assert.ok(r.json.retiradoEm, 'retirado, com data');
    assert.ok(h.db.get("SELECT 1 AS x FROM audit_events WHERE action = 'privacidade.dpdp.retirado'"));
    await req(h, 'POST', '/api/me/consentimento', s, { versao: AVISO_DPDP_VERSAO, idioma: 'en-IN' });
    // o representante (seção 14): nome e contato, cifrados como os outros dados
    assert.equal((await req(h, 'PUT', '/api/me/representante', s, { nome: 'R', contato: 'x' })).status, 400);
    r = await req(h, 'PUT', '/api/me/representante', s, { nome: 'Vikram Sharma', contato: 'vikram@example.in', relacao: 'irmão' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(r.json.representante.nome, 'Vikram Sharma');
    assert.equal((await req(h, 'GET', '/api/me/representante', s)).json.representante.contato, 'vikram@example.in');
    // "Baixar meus dados": os consentimentos e o representante vão junto (minha-conta.json)
    const hist = (await import('../src/services/dpdp.ts')).historicoDeConsentimentos(h.db, s.userId);
    assert.equal(hist.length, 2); assert.ok(hist[0].retiradoEm); assert.equal(hist[1].retiradoEm, null);
    const fonte = await import('node:fs').then((fs) => fs.readFileSync(new URL('../src/services/meus-dados.ts', import.meta.url), 'utf8'));
    assert.match(fonte, /consentimentos: historicoDeConsentimentos\(db, user\.id\), representante: lerRepresentante\(db, user\.id\)/);
    r = await req(h, 'DELETE', '/api/me/representante', s);
    assert.equal(r.json.representante, null);
  } finally { await h.close(); }
});
