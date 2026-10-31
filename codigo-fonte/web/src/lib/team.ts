// A equipe pela função, nunca pelo nome (o mesmo critério do servidor, em server/src/services/team.ts): o
// Coordenador é o único cargo fixo (marcado pelo servidor); quem revisa sai das ferramentas de cada agente hoje.
// Assim um tema com outros nomes (Gandalf coordenando, por exemplo) continua funcionando em todas as telas.
// Quem coordena e quem revisa vêm prontos do servidor (state.team, o card): as telas não precisam da equipe inteira.

/** O cargo fixo: as ferramentas que o Coordenador sempre tem e a que só ele tem (o servidor confere). */
export const COORDINATOR_TOOLS = ['quadro', 'encaminhar', 'delegar', 'regras'];
export const COORDINATOR_ONLY = ['encaminhar'];

/** Nome para frases: "Aristóteles", "Gandalf"… ou "a coordenação" se ninguém coordena. */
export const coordLabel = (coord: { name: string } | null | undefined) => coord?.name ?? 'a coordenação';

/** Três nomes de colegas (fora o Coordenador) para os exemplos de frases da Ajuda; repete o primeiro se faltar. */
export function examplesOf(others: Array<{ name: string }>): [string, string, string] {
  const pick = (i: number) => others[i]?.name ?? others[0]?.name ?? 'um agente';
  return [pick(0), pick(1), pick(2)];
}

/**
 * Quem tem a ferramenta, em uma linha: "ninguém", "Hipátia, Sócrates" ou "Hipátia, Sócrates, Euclides e mais 3.208".
 * O servidor manda a contagem e uma amostra (o Coordenador primeiro): o resto vira "e mais", nunca some calado.
 */
export function holdersText(h: { count: number; sample: string[] } | null | undefined): string {
  if (!h || h.count <= 0) return 'ninguém';
  const shown = h.sample.slice(0, h.count);
  const rest = h.count - shown.length;
  if (!shown.length) return `${h.count.toLocaleString('pt-BR')} agente${h.count === 1 ? '' : 's'}`;
  return rest > 0 ? `${shown.join(', ')} e mais ${rest.toLocaleString('pt-BR')}` : shown.join(', ');
}

/**
 * O filtro "Agente" de um quadro: só quem tem card nele (nome vindo do card, desativados incluídos), sem repetir, em
 * ordem alfabética. Filtrar por quem não tem card daria uma lista vazia.
 */
export function agentOptions(tasks: Array<{ agent_id: string | null; agent_name?: string | null }>): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const t of tasks) if (t.agent_id && !seen.has(t.agent_id)) seen.set(t.agent_id, t.agent_name ?? 'Agente');
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR') || (a.id < b.id ? -1 : 1));
}

/** O resto da equipe numa lista de contatos: tira quem já aparece acima (as seções de conversas), na mesma ordem. */
export function restOf<T extends { id: string }>(items: T[], shown: ReadonlySet<string>): T[] {
  return shown.size ? items.filter((a) => !shown.has(a.id)) : items;
}
