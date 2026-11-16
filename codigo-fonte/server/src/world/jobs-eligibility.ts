/**
 * Quais rotinas podem rodar como Job remoto (computador principal desligado): só as que dependem de fontes
 * REMOTAS e autorizadas. Fontes do computador (banco local, arquivos do Ergon, WhatsApp local, conversa, pedido
 * digitado na hora) não são portáteis. A classificação é verificável: cada fonte tem o motivo.
 */
import { CATALOG } from '../services/routine-catalog.ts';

const REMOTE: Record<string, { adapter: string | null; note: string }> = {
  'web.noticias': { adapter: 'web_feed', note: 'feeds públicos (RSS/Atom)' },
  'web.regulatorio': { adapter: 'web_feed', note: 'feeds públicos de órgãos reguladores' },
  'web.concorrentes': { adapter: 'web_feed', note: 'páginas/feeds públicos' },
  'email': { adapter: null, note: 'Microsoft/Google por OAuth delegado ao Job (executor ainda não implementado)' },
  'email.caixa': { adapter: null, note: 'idem' }, 'email.pendencias': { adapter: null, note: 'idem' }, 'email.responder': { adapter: null, note: 'idem' }, 'email.relacionados': { adapter: null, note: 'idem' },
  'agenda': { adapter: null, note: 'calendário por OAuth delegado (executor ainda não implementado)' }, 'agenda.proximas': { adapter: null, note: 'idem' },
  'tarefas.pessoais': { adapter: null, note: 'To Do/Planner/Google Tasks por OAuth delegado (executor ainda não implementado)' },
};
const LOCAL_REASON: Record<string, string> = {
  entrada: 'pede um texto digitado na hora', contexto: 'contexto do workspace local', documentos: 'arquivos do Ergon local', planilhas: 'arquivos do Ergon local',
  mensagens: 'WhatsApp desta máquina', 'mensagens.texto': 'WhatsApp desta máquina', execucoes: 'histórico de execuções local', decisoes: 'decisões do quadro local',
  equipe: 'equipe local', 'equipe.funcoes': 'equipe local', semana: 'quadro local', entregas: 'quadro local',
};

export interface Eligibility { template: string; name: string; eligible: boolean; executorReady: boolean; adapter: string | null; blocking: Array<{ source: string; reason: string }> }

/** As fontes de uma rotina (as do modelo ou as que a pessoa escolheu): podem rodar fora daqui, e com qual adaptador. */
export function sourcesEligibility(sources: readonly string[]): Pick<Eligibility, 'eligible' | 'executorReady' | 'adapter' | 'blocking'> {
  const blocking: Eligibility['blocking'] = [];
  const adapters = new Set<string | null>();
  for (const s of sources) {
    if (REMOTE[s]) adapters.add(REMOTE[s].adapter);
    else blocking.push({ source: s, reason: LOCAL_REASON[s] ?? (s.startsWith('tarefas.') || s.startsWith('prazos.') ? 'tarefas do quadro local (Sync não dá leitura ao executor sem concessão específica)' : s.startsWith('financeiro.') || s.startsWith('contratos.') ? 'dados importados no Ergon local' : 'fonte local') });
  }
  if (!sources.length) blocking.push({ source: '-', reason: 'rotina sem fontes' });
  const eligible = blocking.length === 0;
  const ready = eligible && adapters.size === 1 && !adapters.has(null);
  return { eligible, executorReady: ready, adapter: ready ? [...adapters][0] : null, blocking };
}

export function jobEligibility(): Eligibility[] {
  return CATALOG.map((t) => {
    if (!t.defaults) return { template: t.key, name: t.name, eligible: false, executorReady: false, adapter: null, blocking: [{ source: '-', reason: 'rotina ainda sem configuração padrão' }] };
    return { template: t.key, name: t.name, ...sourcesEligibility(t.defaults.config.sources as string[]) };
  });
}
