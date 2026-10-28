/**
 * A equipe pela função, nunca pelo nome. Um único cargo é fixo e está sempre presente: o Coordenador (marcado no
 * banco, um por workspace). Os outros são livres — quem revisa e quem recebe cada demanda saem do que cada agente
 * faz hoje (ferramentas, papel e métodos), não do personagem. Assim a equipe pode ser renomeada, reorganizada ou
 * trocada por outro tema (Gandalf coordenando, por exemplo) sem nada quebrar: o Ergon é a forma, o conteúdo é do
 * usuário. A Grécia clássica é só o ponto de partida.
 */
import type { Db } from '../db/db.ts';
import { fold } from '../lib/util.ts';
import { characterByKey, routeStems } from './characters.ts';

export interface Member { id: string; name: string; role: string; char_key: string | null; skey: string; tools: string[]; skills: string[]; created_at: string; coordinator: boolean }

/** O cargo fixo: a função, o setor e as ferramentas que não mudam. Nome, aparência, história e foco são livres. */
export const COORDINATOR_ROLE = 'Coordenação da equipe';
export const COORDINATOR_SECTOR = 'coordenacao';
export const COORDINATOR_TOOLS = ['quadro', 'encaminhar', 'delegar', 'regras'];
/** ferramentas que só o Coordenador tem (encaminhar as demandas é o que define o cargo) */
export const COORDINATOR_ONLY = ['encaminhar'];

/** O único cargo fixo: o que não muda no Coordenador (as mensagens dizem o que ainda pode mudar). */
const FIXED = 'O Coordenador é o único cargo fixo do Ergon: ';
export const FIXED_MSG = {
  role: `${FIXED}a função dele não muda. Nome, aparência, história e foco podem mudar.`,
  sector: `${FIXED}ele fica no setor de coordenação.`,
  tools: `${FIXED}ele mantém Quadro, Encaminhamento, Pedir a colegas e Regras (as outras ferramentas são livres).`,
  archive: `${FIXED}ele não sai da equipe. Dá para mudar o nome, a aparência, a história e o foco.`,
  only: 'Encaminhar as demandas é do Coordenador (o único cargo fixo); os outros agentes pedem ajuda a colegas.',
};

/** O protocolo do cargo: vai sempre nas instruções do Coordenador, antes do foco que o usuário escreveu. */
export const COORDINATION_PROTOCOL = 'Você é o Coordenador da equipe — o único cargo fixo do Ergon. Para cada pedido do usuário: '
  + '(1) entenda o objetivo: o que ele quer receber, para quê e em que formato; se não estiver claro, pergunte antes, em uma ou duas perguntas curtas, e só planeje depois da resposta; '
  + '(2) se é algo que você mesmo resolve (sobre a equipe, o andamento, uma resposta curta), responda direto; '
  + '(3) se é trabalho da equipe, planeje do início ao fim e escreva o plano assim: uma linha [[plano objetivo="o que o usuário vai receber"]] e, em ordem, '
  + 'uma linha [[etapa agente="Nome" faz="o que essa pessoa faz, com o contexto necessário"]] por etapa (pedido simples: uma ou duas etapas; cada etapa recebe o que as anteriores entregaram). '
  + 'O sistema cria o card com as etapas e põe a equipe para trabalhar; você não precisa pedir de novo. Diga ao usuário, em uma frase, quem vai fazer o quê; '
  + '(4) quando o trabalho voltar para você aqui na conversa, entregue ao usuário exatamente o que ele pediu, no formato pedido — a entrega é sua; '
  + '(5) antes de uma entrega importante, inclua uma etapa de revisão com quem revisa na equipe; (6) acompanhe o que ficou pendente (você recebe a lista dos pedidos em andamento). '
  + 'Não faça o trabalho dos especialistas: planeje, encaminhe e entregue. Se faltar alguém para um tipo de trabalho, proponha criar ou ajustar um agente.';

/** O foco do Coordenador: as instruções guardadas sem o protocolo (versões antigas guardavam os dois juntos). */
export function coordinatorFocus(charter: string | null | undefined): string {
  return (charter ?? '').replace(/(Você coordena a equipe do Ergon\.\s*)?Para cada pedido: \(1\)[\s\S]*?confira o andamento\./, '')
    .replace(/\s+/g, ' ').trim();
}

const list = (v: string | null): string[] => { try { const x = JSON.parse(v ?? '[]'); return Array.isArray(x) ? x.map(String) : []; } catch { return []; } };

export function activeTeam(db: Db, workspaceId: string, exceptId?: string): Member[] {
  return db.all<{ id: string; name: string; role: string; char_key: string | null; skey: string; tools: string | null; skills: string | null; created_at: string; coordinator: number }>(
    `SELECT a.id, a.name, a.role, a.char_key, p.key AS skey, a.tools, a.skills, a.created_at, a.coordinator FROM agents a JOIN profiles p ON p.id = a.profile_id
      WHERE a.workspace_id = ? AND a.status = 'active' ${exceptId ? 'AND a.id <> ?' : ''} ORDER BY a.created_at, a.rowid`, ...(exceptId ? [workspaceId, exceptId] : [workspaceId]))
    .map((a) => ({ ...a, tools: list(a.tools), skills: list(a.skills), coordinator: Number(a.coordinator) === 1 }));
}

/**
 * Quem coordena: o Coordenador (cargo fixo). Os outros critérios só valem num banco que ainda não marcou ninguém
 * (antes da migração 0014 ou se a marca foi apagada à mão) — o boot refaz a marca (ensureCoordinator).
 */
export function coordinatorOf(team: Member[]): Member | undefined {
  return team.find((a) => a.coordinator) ?? team.find((a) => a.tools.includes('encaminhar')) ?? team.find((a) => a.skey === 'coordenacao')
    ?? team.find((a) => a.tools.includes('delegar')) ?? team[0];
}

/** Quem faz a revisão crítica: quem tem a ferramenta de revisão e não coordena (de preferência da qualidade). */
export function reviewerOf(team: Member[], exceptId?: string | null): Member | undefined {
  const coord = coordinatorOf(team);
  const can = team.filter((a) => a.tools.includes('revisao') && a.id !== exceptId);
  return can.find((a) => a.id !== coord?.id && a.skey === 'qualidade') ?? can.find((a) => a.id !== coord?.id) ?? can[0];
}

/** Radicais das palavras de um texto livre (papel, métodos): "Roteirista de vídeos" → roteir, video. */
function stemsOf(text: string): string[] {
  return [...new Set(fold(text).replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length >= 5).map((w) => w.slice(0, 6)))];
}

/**
 * Quem deve fazer uma demanda, pelas palavras dela: compara com o papel e os métodos de cada agente hoje e, para
 * os personagens que mantêm a função original, também com as regras de encaminhamento conhecidas. Quem coordena
 * não entra (ele é quem encaminha; fica com o que ninguém mais pegar).
 */
export function routeTo(team: Member[], text: string): { member: Member; words: string[] } | null {
  const t = ` ${fold(text)} `;
  const tokens = text.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}-]+$/gu, '')).filter(Boolean);
  const wordFor = (stem: string) => tokens.find((w) => fold(w).includes(stem)) ?? stem;
  const coord = coordinatorOf(team);
  let best: { member: Member; stems: string[] } | null = null;
  for (const m of team) {
    if (m.id === coord?.id) continue;
    const ch = characterByKey(m.char_key);
    const original = ch && fold(ch.role) === fold(m.role) ? routeStems(ch.key) : [];
    const own = stemsOf(`${m.role} ${m.skills.join(' ')}`);
    const hits = [...new Set([...original, ...own])].filter((s) => t.includes(s));
    if (hits.length && (!best || hits.length > best.stems.length)) best = { member: m, stems: hits };
  }
  return best ? { member: best.member, words: [...new Set(best.stems.map(wordFor))] } : null;
}

/** Acha um agente pelo nome como a pessoa escreveu (sem acento, sem caixa, aceita só o começo). */
export function findMember(team: Array<{ id: string; name: string }>, name: string): { id: string; name: string } | undefined {
  const n = fold(name).replace(/^(o|a)\s+/, '').trim();
  if (!n) return undefined;
  return team.find((a) => fold(a.name) === n) ?? team.find((a) => fold(a.name).startsWith(n) || n.startsWith(fold(a.name)));
}
