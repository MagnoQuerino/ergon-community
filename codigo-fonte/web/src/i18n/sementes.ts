// rc.45: o que o servidor grava em português ao criar o workspace (a equipe de partida, os setores e os quadros) aparece
// no idioma da tela. O banco guarda o português de sempre (a sincronia, a busca e o que a pessoa renomeia continuam
// iguais); aqui só se reconhece o texto EXATO de fábrica e se mostra a tradução. O que a pessoa mudou aparece como ela
// escreveu. Fonte: server/src/services/characters.ts (funções), sectors.ts (setores) e seed.ts (quadros); o teste
// sementes.test.ts confere que o português daqui é o mesmo do servidor. As equipes de nicho (team-presets.ts) ainda não.
import { t, type Chave } from './index.ts';

/** O texto de fábrica → a chave da tradução. */
const SEMENTES: Readonly<Record<string, Chave>> = {
  // as funções da equipe de partida (characters.ts)
  'Coordenação da equipe': 'equipe.semente.papel.aristoteles', // i18n-ok: o texto que o servidor grava
  'Acompanhamento, prazos e agenda': 'equipe.semente.papel.hesiodo', // i18n-ok: o texto que o servidor grava
  'Ações práticas e tarefas': 'equipe.semente.papel.diogenes', // i18n-ok: o texto que o servidor grava
  'Comunicações (Teams, WhatsApp, e-mail)': 'equipe.semente.papel.aspasia', // i18n-ok: o texto que o servidor grava
  'Produção de texto': 'equipe.semente.papel.herodoto', // i18n-ok: o texto que o servidor grava
  'Design e apresentações': 'equipe.semente.papel.fidias', // i18n-ok: o texto que o servidor grava
  'Conceitos e reflexão profunda': 'equipe.semente.papel.platao', // i18n-ok: o texto que o servidor grava
  'Revisão crítica (questionamento)': 'equipe.semente.papel.socrates', // i18n-ok: o texto que o servidor grava
  'Pesquisa e Arquivos': 'equipe.semente.papel.hipatia', // i18n-ok: o texto que o servidor grava
  'Números, planilhas e dados': 'equipe.semente.papel.arquimedes', // i18n-ok: o texto que o servidor grava
  'Conferência técnica e qualidade': 'equipe.semente.papel.euclides', // i18n-ok: o texto que o servidor grava
  'Projetos e planejamento': 'equipe.semente.papel.hipodamo', // i18n-ok: o texto que o servidor grava
  // os setores (sectors.ts): nome e descrição
  'Coordenação e projetos': 'equipe.semente.setor.coordenacao', // i18n-ok: o texto que o servidor grava
  'Central de demandas': 'equipe.semente.setor.central', // i18n-ok: o texto que o servidor grava
  'Produção (textos e design)': 'equipe.semente.setor.producao', // i18n-ok: o texto que o servidor grava
  'Brainstorming e pesquisa': 'equipe.semente.setor.brainstorm', // i18n-ok: o texto que o servidor grava
  'Análise e qualidade': 'equipe.semente.setor.qualidade', // i18n-ok: o texto que o servidor grava
  // i18n-ok: o texto que o servidor grava
  'Recebe os pedidos, divide em etapas, encaminha a quem faz, organiza a fila e acompanha o plano.': 'equipe.semente.setorDesc.coordenacao',
  // i18n-ok: o texto que o servidor grava
  'Atende quem chega (chat, Teams, WhatsApp), registra pedidos, acompanha prazos e resolve o operacional.': 'equipe.semente.setorDesc.central',
  // i18n-ok: o texto que o servidor grava
  'Escreve relatórios, propostas, e-mails e atas; monta apresentações e peças visuais.': 'equipe.semente.setorDesc.producao',
  // i18n-ok: o texto que o servidor grava
  'Explora alternativas, pesquisa com fontes e dá forma a conceitos e estratégias.': 'equipe.semente.setorDesc.brainstorm',
  // i18n-ok: o texto que o servidor grava
  'Números e planilhas, conferência técnica e revisão crítica antes da entrega.': 'equipe.semente.setorDesc.qualidade',
  // os quadros (seed.ts)
  'Minhas tarefas': 'equipe.semente.quadro.minhas', // i18n-ok: o texto que o servidor grava
  'Quadro da equipe': 'equipe.semente.quadro.equipe', // i18n-ok: o texto que o servidor grava
};

/** O texto no idioma da tela, se for o de fábrica; senão, como está (o que a pessoa escreveu nunca é trocado). */
export function daSemente(texto: string): string;
export function daSemente(texto: string | null | undefined): string | null | undefined;
export function daSemente(texto: string | null | undefined): string | null | undefined {
  if (!texto) return texto;
  const k = SEMENTES[texto];
  return k ? t(k as never) : texto;
}

/** Para o teste: o português de fábrica que esta tabela reconhece. */
export const TEXTOS_DE_FABRICA: readonly string[] = Object.keys(SEMENTES);
