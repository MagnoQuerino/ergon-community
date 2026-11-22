/**
 * rc.47: a Lei DPDP da Índia (Digital Personal Data Protection Act, 2023, e as Regras de 2025), sobre o que o Ergon já faz
 * para a LGPD e o GDPR (dados no computador da pessoa, cifrados; "Baixar meus dados"; "Excluir minha conta"; desligar
 * cada conexão; os termos de uso com versão e aceite). O que a DPDP pede a mais e entra aqui, sem inventar obrigação:
 *
 * - um AVISO de consentimento próprio, separado dos termos, em linguagem clara, em inglês ou numa língua da 8ª Lista
 *   (a tela tem inglês e hindi, além de português e chinês): que dados, para quê, como retirar o consentimento, como
 *   exercer os direitos e como reclamar ao Data Protection Board of India (seção 5 e Regra 3);
 * - quem responde pelos dados (o "Data Fiduciary": aqui, quem é dono do serviço, isto é, do workspace), com o contato de
 *   quem responde às perguntas e reclamações (o "Grievance Officer"; a lei só obriga a um DPO o Significant Data
 *   Fiduciary) e o prazo de resposta, que as Regras limitam a 90 dias (Regra 14);
 * - o Consent Manager (registrado no Board, seção 6(7)): opcional, só um campo que o dono preenche se usar um;
 * - retirar o consentimento tão fácil quanto dar (seção 6(4)), com registro de quando foi dado e retirado;
 * - nomear um representante para exercer os direitos em caso de morte ou incapacidade (seção 14).
 *
 * Os prazos da maior parte das obrigações valem a partir de 13 de maio de 2027: o aviso só aparece quando o dono liga a
 * DPDP no workspace (Configurações › Privacidade). Os termos de uso não mudam (TERMOS_VERSAO fica): o aviso tem a versão
 * dele (AVISO_DPDP_VERSAO), e mudar o texto do aviso pede o consentimento de novo, só dele.
 */
import type { Db } from '../db/db.ts';
import { HttpError, id as novoId, now } from '../lib/util.ts';
import { CLOSED_VALUE } from '../security/fields.ts';
import { audit, type Bus } from './bus.ts';
import { getSetting, setSetting } from './sectors.ts';

/** A versão do texto do aviso (web/src/legal/aviso-dpdp.ts): mudou o texto, muda aqui, e o aviso aparece de novo. */
export const AVISO_DPDP_VERSAO = '2026-11-21';
/** O teto das Regras DPDP de 2025 (Regra 14(3)): responder às reclamações em até 90 dias. */
export const PRAZO_MAXIMO_DIAS = 90;
const PADRAO_DIAS = 30;
const CHAVE = 'privacidade.dpdp';

export interface ConfigDpdp {
  ligado: boolean;
  /** quem responde pelos dados (o Data Fiduciary): a empresa ou a pessoa dona do serviço */
  responsavel: string;
  /** o Grievance Officer (ou a pessoa que responde pelas perguntas e reclamações) */
  grievance: { nome: string; email: string; telefone: string; endereco: string };
  /** o Consent Manager registrado no Board, se o dono usar um (opcional) */
  consentManager: { nome: string; registro: string; url: string } | null;
  /** em quantos dias o dono responde às reclamações e pedidos (até 90) */
  prazoDias: number;
}
const VAZIA: ConfigDpdp = { ligado: false, responsavel: '', grievance: { nome: '', email: '', telefone: '', endereco: '' }, consentManager: null, prazoDias: PADRAO_DIAS };

const txt = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const URL_HTTPS = /^https:\/\/[^\s"'<>]{4,300}$/;

export function lerConfigDpdp(db: Db, ws: string): ConfigDpdp {
  const v = getSetting(db, ws, CHAVE);
  if (!v || v === CLOSED_VALUE) return { ...VAZIA, grievance: { ...VAZIA.grievance } };
  try {
    const j = JSON.parse(v) as Partial<ConfigDpdp>;
    const g = j.grievance ?? VAZIA.grievance;
    const cm = j.consentManager && txt(j.consentManager.nome, 120) ? { nome: txt(j.consentManager.nome, 120), registro: txt(j.consentManager.registro, 80), url: txt(j.consentManager.url, 300) } : null;
    return {
      ligado: j.ligado === true, responsavel: txt(j.responsavel, 160),
      grievance: { nome: txt(g.nome, 120), email: txt(g.email, 200), telefone: txt(g.telefone, 40), endereco: txt(g.endereco, 300) },
      consentManager: cm, prazoDias: Math.min(PRAZO_MAXIMO_DIAS, Math.max(1, Math.round(Number(j.prazoDias) || PADRAO_DIAS))),
    };
  } catch { return { ...VAZIA, grievance: { ...VAZIA.grievance } }; }
}

/** Grava a configuração (só o dono). Ligar pede o mínimo que o aviso precisa mostrar: quem responde e um contato. */
export function gravarConfigDpdp(db: Db, bus: Bus | null, ws: string, userId: string, b: Partial<ConfigDpdp>): ConfigDpdp {
  const g = b.grievance ?? VAZIA.grievance;
  const cmNome = txt(b.consentManager?.nome, 120);
  const c: ConfigDpdp = {
    ligado: b.ligado === true, responsavel: txt(b.responsavel, 160),
    grievance: { nome: txt(g.nome, 120), email: txt(g.email, 200), telefone: txt(g.telefone, 40), endereco: txt(g.endereco, 300) },
    consentManager: cmNome ? { nome: cmNome, registro: txt(b.consentManager?.registro, 80), url: txt(b.consentManager?.url, 300) } : null,
    prazoDias: Math.round(Number(b.prazoDias ?? PADRAO_DIAS)),
  };
  if (!Number.isFinite(c.prazoDias) || c.prazoDias < 1 || c.prazoDias > PRAZO_MAXIMO_DIAS) throw new HttpError(400, 'prazo', `O prazo de resposta vai de 1 a ${PRAZO_MAXIMO_DIAS} dias (o teto das Regras DPDP).`);
  if (c.grievance.email && !EMAIL.test(c.grievance.email)) throw new HttpError(400, 'email', 'O e-mail do Grievance Officer não parece um e-mail.');
  if (c.consentManager?.url && !URL_HTTPS.test(c.consentManager.url)) throw new HttpError(400, 'url', 'O endereço do Consent Manager precisa começar com https://.');
  if (c.ligado && (!c.responsavel || !c.grievance.nome || !(c.grievance.email || c.grievance.telefone))) {
    throw new HttpError(400, 'incompleto', 'Para ligar, preencha quem responde pelos dados e o nome e um contato (e-mail ou telefone) do Grievance Officer.');
  }
  const antes = lerConfigDpdp(db, ws);
  setSetting(db, ws, CHAVE, JSON.stringify(c));
  if (antes.ligado !== c.ligado || JSON.stringify(antes) !== JSON.stringify(c)) {
    audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'privacidade.dpdp.config', evidence: { ligado: c.ligado, prazoDias: c.prazoDias, consentManager: !!c.consentManager },
      result: c.ligado ? 'aviso de consentimento da Lei DPDP (Índia) ligado' : 'aviso de consentimento da Lei DPDP (Índia) desligado' });
  }
  return c;
}

interface ConsentRow { id: string; versao: string; idioma: string; dado_em: string; retirado_em: string | null }
const ultimo = (db: Db, userId: string, ws: string) => db.get<ConsentRow>("SELECT id, versao, idioma, dado_em, retirado_em FROM consentimentos WHERE user_id = ? AND workspace_id = ? AND tipo = 'dpdp' ORDER BY dado_em DESC, rowid DESC LIMIT 1", userId, ws);

/** O que a tela precisa: se o aviso vale aqui, o texto configurado e se a pessoa já consentiu nesta versão. */
export function estadoDpdp(db: Db, ws: string, userId: string): { ligado: boolean; versao: string; aceito: boolean; aceitoEm: string | null; retiradoEm: string | null; config: Omit<ConfigDpdp, 'ligado'> | null } {
  const c = lerConfigDpdp(db, ws);
  const u = ultimo(db, userId, ws);
  const vale = !!u && u.versao === AVISO_DPDP_VERSAO && !u.retirado_em;
  const { ligado, ...resto } = c;
  return { ligado, versao: AVISO_DPDP_VERSAO, aceito: vale, aceitoEm: vale ? u!.dado_em : null, retiradoEm: u?.retirado_em ?? null, config: ligado ? resto : null };
}

/** Dar o consentimento (a versão que a tela mostrou, no idioma em que a pessoa leu). Fica registrado com data e hora. */
export function consentir(db: Db, bus: Bus | null, ws: string, userId: string, versao: string, idioma: string): void {
  if (!lerConfigDpdp(db, ws).ligado) throw new HttpError(409, 'desligado', 'O aviso da Lei DPDP não está ligado neste workspace.');
  if (versao !== AVISO_DPDP_VERSAO) throw new HttpError(409, 'versao', 'O aviso mudou desde que a tela abriu: recarregue e leia a versão atual.');
  const lang = /^[A-Za-z-]{2,10}$/.test(idioma) ? idioma : 'en';
  db.run("INSERT INTO consentimentos (id, user_id, workspace_id, tipo, versao, idioma, dado_em) VALUES (?, ?, ?, 'dpdp', ?, ?, ?)", novoId('cns'), userId, ws, versao, lang, now());
  audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'privacidade.dpdp.consentimento', targetType: 'user', targetId: userId,
    evidence: { versao, idioma: lang }, result: `consentimento dado ao aviso DPDP (versão ${versao})` });
}

/**
 * Retirar o consentimento, tão fácil quanto dar. Fica registrado; o aviso volta a aparecer, e a pessoa decide o que fazer
 * com os dados dela (baixar, excluir a conta). O que já foi feito com o consentimento antes de retirar continua válido
 * (seção 6(5)); o que vem depois espera um consentimento novo.
 */
export function retirarConsentimento(db: Db, bus: Bus | null, ws: string, userId: string): void {
  const u = ultimo(db, userId, ws);
  if (!u || u.retirado_em) return;
  db.run('UPDATE consentimentos SET retirado_em = ? WHERE id = ?', now(), u.id);
  audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'privacidade.dpdp.retirado', targetType: 'user', targetId: userId,
    evidence: { versao: u.versao }, result: 'consentimento ao aviso DPDP retirado pela pessoa' });
}

/** O histórico dos consentimentos da pessoa (entra em "Baixar meus dados"). */
export function historicoDeConsentimentos(db: Db, userId: string): Array<{ tipo: string; versao: string; idioma: string; dadoEm: string; retiradoEm: string | null }> {
  return db.all<{ tipo: string; versao: string; idioma: string; dado_em: string; retirado_em: string | null }>('SELECT tipo, versao, idioma, dado_em, retirado_em FROM consentimentos WHERE user_id = ? ORDER BY dado_em', userId)
    .map((r) => ({ tipo: r.tipo, versao: r.versao, idioma: r.idioma, dadoEm: r.dado_em, retiradoEm: r.retirado_em }));
}

// ---------------------------------------------------------------- o representante (seção 14)
export interface Representante { nome: string; contato: string; relacao: string; atualizadoEm: string }
export function lerRepresentante(db: Db, userId: string): Representante | null {
  const r = db.get<{ nome: string; contato: string; relacao: string; atualizado_em: string }>('SELECT nome, contato, relacao, atualizado_em FROM representantes WHERE user_id = ?', userId);
  if (!r || r.nome === CLOSED_VALUE) return null;
  return { nome: r.nome, contato: r.contato, relacao: r.relacao, atualizadoEm: r.atualizado_em };
}
/** Nomear (ou trocar) o representante: o nome e um contato, cifrados como os outros dados da pessoa. */
export function nomearRepresentante(db: Db, bus: Bus | null, ws: string, userId: string, b: { nome?: string; contato?: string; relacao?: string }): Representante {
  const nome = txt(b.nome, 120); const contato = txt(b.contato, 200); const relacao = txt(b.relacao, 80);
  if (nome.length < 2 || contato.length < 5) throw new HttpError(400, 'representante', 'Preencha o nome e um contato (e-mail ou telefone) de quem vai representar você.');
  const quando = now();
  db.run(`INSERT INTO representantes (user_id, nome, contato, relacao, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (user_id) DO UPDATE SET nome = excluded.nome, contato = excluded.contato, relacao = excluded.relacao, atualizado_em = excluded.atualizado_em`,
  userId, db.seal(ws, nome), db.seal(ws, contato), db.seal(ws, relacao), quando, quando);
  audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'privacidade.representante', targetType: 'user', targetId: userId, result: 'representante nomeado (Lei DPDP, seção 14)' });
  return { nome, contato, relacao, atualizadoEm: quando };
}
export function removerRepresentante(db: Db, bus: Bus | null, ws: string, userId: string): void {
  if (db.run('DELETE FROM representantes WHERE user_id = ?', userId).changes) {
    audit(db, bus, { workspaceId: ws, actorType: 'user', actorId: userId, action: 'privacidade.representante.removido', targetType: 'user', targetId: userId, result: 'representante removido' });
  }
}
