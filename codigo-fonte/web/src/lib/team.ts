// A equipe pela função, nunca pelo nome (o mesmo critério do servidor, em server/src/services/team.ts): o
// Coordenador é o único cargo fixo (marcado pelo servidor); quem revisa sai das ferramentas de cada agente hoje.
// Assim um tema com outros nomes (Gandalf coordenando, por exemplo) continua funcionando em todas as telas.
import type { Agent } from './types.ts';

const has = (a: Agent, tool: string) => a.tools.some((t) => t.id === tool);

/** O cargo fixo: as ferramentas que o Coordenador sempre tem e a que só ele tem (o servidor confere). */
export const COORDINATOR_TOOLS = ['quadro', 'encaminhar', 'delegar', 'regras'];
export const COORDINATOR_ONLY = ['encaminhar'];

/** Quem coordena: o Coordenador (cargo fixo, marcado pelo servidor); os outros critérios só valem em dados antigos. */
export function coordinatorOf(agents: Agent[]): Agent | undefined {
  const on = agents.filter((a) => a.status === 'active');
  return on.find((a) => !!a.coordinator) ?? on.find((a) => has(a, 'encaminhar')) ?? on.find((a) => a.profile === 'coordenacao') ?? on.find((a) => has(a, 'delegar')) ?? on[0];
}

/** Quem faz a revisão crítica: quem tem a ferramenta de revisão e não coordena (de preferência da qualidade). */
export function reviewerOf(agents: Agent[], exceptId?: string | null): Agent | undefined {
  const coord = coordinatorOf(agents);
  const can = agents.filter((a) => a.status === 'active' && has(a, 'revisao') && a.id !== exceptId);
  return can.find((a) => a.id !== coord?.id && a.profile === 'qualidade') ?? can.find((a) => a.id !== coord?.id) ?? can[0];
}

/** Nome para frases: "Aristóteles", "Gandalf"… ou "a coordenação" se ninguém coordena. */
export const coordName = (agents: Agent[]) => coordinatorOf(agents)?.name ?? 'a coordenação';
