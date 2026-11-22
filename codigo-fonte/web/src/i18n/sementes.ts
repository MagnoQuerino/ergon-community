// rc.45: o que o servidor grava em português ao criar o workspace (a equipe de partida, os setores e os quadros) aparece
// no idioma da tela. O banco guarda o português de sempre (a sincronia, a busca e o que a pessoa renomeia continuam
// iguais); aqui só se reconhece o texto EXATO de fábrica e se mostra a tradução. O que a pessoa mudou aparece como ela
// escreveu. Fonte: server/src/services/characters.ts (funções), sectors.ts (setores) e seed.ts (quadros); o teste
// sementes.test.ts confere que o português daqui é o mesmo do servidor. As equipes de nicho (team-presets.ts) ainda não.
import { fmtLista, idiomaAtual, t, type Chave } from './index.ts';
import { IDIOMA_PADRAO } from './idiomas.ts';
import { pt as PT_DIC } from './pt/index.ts';

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

/** A história (bio) dos personagens de fábrica: o português está no próprio dicionário (equipe.semente.bio.*). */
const BIOS: ReadonlyMap<string, string> = new Map(Object.entries(PT_DIC.equipe as Record<string, unknown>)
  .filter(([k, v]) => k.startsWith('semente.bio.') && typeof v === 'string').map(([k, v]) => [v as string, `equipe.${k}`]));

/**
 * rc.47: as equipes de nicho (team-presets.ts): os setores (nome e descrição), as funções de cada personagem e o primeiro
 * passo, que o servidor grava em português ao montar a equipe; e as perguntas do primeiro acesso (uso e área). O
 * português está no dicionário (equipe.preset.*, equipe.uso.*, equipe.nicho.*); o mesmo texto em dois presets cai na
 * mesma tradução.
 */
const PRESETS: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>();
  for (const [k, v] of Object.entries(PT_DIC.equipe as Record<string, unknown>)) {
    if (typeof v === 'string' && /^(preset|uso|nicho)\./.test(k) && !m.has(v)) m.set(v, `equipe.${k}`);
  }
  return m;
})();
/** A pergunta do primeiro acesso no idioma da tela (o rótulo que o servidor manda, em português, como reserva). */
export function textoDoPrimeiroAcesso(chave: `uso.${string}.rotulo` | `uso.${string}.dica` | `nicho.${string}` | `preset.${string}.titulo` | `preset.${string}.resumo`, reserva: string): string {
  return (PT_DIC.equipe as Record<string, unknown>)[chave] === reserva ? tt(`equipe.${chave}`) : reserva;
}

/** O texto no idioma da tela, se for o de fábrica; senão, como está (o que a pessoa escreveu nunca é trocado). */
export function daSemente(texto: string): string;
export function daSemente(texto: string | null | undefined): string | null | undefined;
export function daSemente(texto: string | null | undefined): string | null | undefined {
  if (!texto) return texto;
  const k = SEMENTES[texto] ?? BIOS.get(texto) ?? PRESETS.get(texto);
  return k ? t(k as never) : texto;
}

/** Para o teste: o português de fábrica que esta tabela reconhece. */
export const TEXTOS_DOS_PRESETS: readonly string[] = [...PRESETS.keys()];
export const TEXTOS_DE_FABRICA: readonly string[] = Object.keys(SEMENTES);

// ——— rc.45: a biblioteca de rotinas (server/src/services/routine-catalog.ts) e o horário delas fora do português ———

const ROT = PT_DIC.rotinas as Record<string, unknown>;
/** as chaves montadas (catalogo.<modelo>.nome…) não passam pela checagem de tipo do t() */
const tt = t as unknown as (k: string, v?: Record<string, string | number>) => string;
/** O nome de uma rotina da biblioteca no idioma da tela; renomeada pela pessoa (ou criada na conversa), como está. */
export function nomeDaRotina(nome: string, modelo?: string | null): string {
  const k = modelo ? `catalogo.${modelo}.nome` : Object.keys(ROT).find((x) => x.startsWith('catalogo.') && x.endsWith('.nome') && ROT[x] === nome);
  return k && ROT[k] === nome ? tt(`rotinas.${k}`) : nome;
}
/** O benefício (a frase do cartão) da rotina da biblioteca, se for o texto de fábrica. */
export function beneficioDaRotina(texto: string, modelo: string): string {
  const k = `catalogo.${modelo}.beneficio`;
  return ROT[k] === texto ? tt(`rotinas.${k}`) : texto;
}
/** O nome do grupo da biblioteca. */
export function categoriaDaRotina(chave: string, rotulo: string): string {
  const k = `catalogo.categoria.${chave}`;
  return ROT[k] === rotulo ? tt(`rotinas.${k}`) : rotulo;
}
/** rc.47: um texto da ficha da rotina (catalogo.<modelo>.<campo>, fonte.<id>, precisa.<id>) traduzido, se for o de fábrica. */
function daFicha(k: string, texto: string): string;
function daFicha(k: string, texto: string | undefined): string | undefined;
function daFicha(k: string, texto: string | undefined): string | undefined {
  return texto !== undefined && ROT[k] === texto ? tt(`rotinas.${k}`) : texto;
}
const FONTE_POR_TEXTO = new Map(Object.keys(ROT).filter((k) => k.startsWith('fonte.')).map((k) => [ROT[k] as string, k]));
/** Uma fonte da rotina ("Tarefas em andamento e em revisão", que o servidor escreve em português) no idioma da tela. */
export function fonteDaRotina(texto: string): string {
  const k = FONTE_POR_TEXTO.get(texto);
  return k ? tt(`rotinas.${k}`) : texto;
}
/** O que a rotina pede ao executar (os rótulos de fábrica traduzidos). */
export function entradaDaRotina<T extends { text?: { label: string; placeholder: string }; files?: { label: string } }>(modelo: string | null | undefined, e: T): T {
  if (!modelo) return e;
  const c = `catalogo.${modelo}.`;
  return {
    ...e,
    ...(e.text ? { text: { ...e.text, label: daFicha(c + 'entradaTexto', e.text.label), placeholder: daFicha(c + 'entradaTextoEx', e.text.placeholder) } } : {}),
    ...(e.files ? { files: { ...e.files, label: daFicha(c + 'entradaArquivos', e.files.label) } } : {}),
  };
}
/** Os campos que a rotina acompanha (rótulo, exemplo e dica de fábrica traduzidos). */
export function parametrosDaRotina<T extends { key: string; label: string; placeholder?: string; hint?: string }>(modelo: string | null | undefined, ps: T[]): T[] {
  if (!modelo) return ps;
  return ps.map((p) => {
    const c = `catalogo.${modelo}.param.${p.key}`;
    return { ...p, label: daFicha(c, p.label), placeholder: daFicha(c + '.ex', p.placeholder), hint: daFicha(c + '.dica', p.hint) };
  });
}
/** A ficha de uma rotina da biblioteca no idioma da tela: entrega, o que examina, aprovação, exemplo, fontes, o que precisa. */
export function fichaDaRotina<T extends {
  key?: string; produces: string; examines?: string; approvals: string; sample?: string | null; sources: string[];
  needs?: Array<{ id: string; label: string }>; input?: Parameters<typeof entradaDaRotina>[1]; params?: Array<{ key: string; label: string; placeholder?: string; hint?: string }>;
}>(m: T, modelo: string | null | undefined = m.key): T {
  if (idiomaAtual() === IDIOMA_PADRAO || !modelo) return m;
  const c = `catalogo.${modelo}.`;
  return {
    ...m,
    produces: daFicha(c + 'entrega', m.produces), approvals: daFicha(c + 'aprovacao', m.approvals),
    ...(m.examines !== undefined ? { examines: daFicha(c + 'examina', m.examines) } : {}),
    ...(m.sample ? { sample: daFicha(c + 'exemplo', m.sample) } : {}),
    sources: m.sources.map(fonteDaRotina),
    ...(m.needs ? { needs: m.needs.map((n) => ({ ...n, label: daFicha(`precisa.${n.id}`, n.label) })) } : {}),
    ...(m.input ? { input: entradaDaRotina(modelo, m.input) } : {}),
    ...(m.params ? { params: parametrosDaRotina(modelo, m.params) } : {}),
  };
}
/** Uma rotina instalada no idioma da tela: o que pede ao executar, o que acompanha e as fontes. */
export function rotinaNaTela<T extends {
  template: string | null; input: Parameters<typeof entradaDaRotina>[1] | null;
  paramSpecs: Array<{ key: string; label: string; placeholder?: string; hint?: string }>; config: { sourceLabels: string[] };
}>(r: T): T {
  if (idiomaAtual() === IDIOMA_PADRAO) return r;
  return {
    ...r,
    input: r.input ? entradaDaRotina(r.template, r.input) : r.input,
    paramSpecs: parametrosDaRotina(r.template, r.paramSpecs),
    config: { ...r.config, sourceLabels: r.config.sourceLabels.map(fonteDaRotina) },
  };
}
const LOCAL: Record<string, string> = { en: 'en-US', 'en-IN': 'en-IN', 'zh-CN': 'zh-CN', hi: 'hi-IN', 'pt-BR': 'pt-BR' };
/**
 * O horário de uma rotina ("Seg a sex às 17:30", que o servidor escreve em português) no idioma da tela, a partir do
 * gatilho; em português, o texto do servidor como sempre.
 */
export function horarioDaRotina(texto: string | null, gatilho: { kind: string; days?: number[]; time?: string } | null | undefined): string | null {
  if (idiomaAtual() === IDIOMA_PADRAO || !gatilho) return texto;
  if (gatilho.kind !== 'schedule' || !gatilho.days?.length) return tt('rotinas.horario.quandoPedir');
  const d = [...new Set(gatilho.days)].sort((a, b) => a - b);
  const chave = d.join(',');
  const dia = (n: number) => new Intl.DateTimeFormat(LOCAL[idiomaAtual()] ?? 'en-US', { weekday: 'short', timeZone: 'UTC' }).format(new Date(Date.UTC(2023, 0, 1 + n)));
  const dias = chave === '0,1,2,3,4,5,6' ? tt('rotinas.horario.todosOsDias') : chave === '1,2,3,4,5' ? tt('rotinas.horario.segASex') : fmtLista(d.map(dia));
  return tt('rotinas.horario.diasHora', { dias, hora: gatilho.time ?? '' });
}

// ——— rc.45: as ferramentas que o servidor descreve em português (server/src/services/characters.ts, TOOLS e toolStatus) ———
const CFG = PT_DIC.configuracoes as Record<string, unknown>;
const SUFIXOS = Object.keys(CFG).filter((k) => k.startsWith('ferramenta.sufixo.'));
/** O nome de uma ferramenta no idioma da tela (o texto de fábrica; outro, como está). */
export function nomeDaFerramenta(id: string, nome: string): string {
  const k = `ferramenta.${id}.nome`;
  return CFG[k] === nome ? tt(`configuracoes.${k}`) : nome;
}
/** A nota de uma ferramenta (o que faz e, depois de " — ", por que está desligada ou bloqueada) no idioma da tela. */
export function notaDaFerramenta(id: string, nota: string): string {
  const k = `ferramenta.${id}.nota`; const base = CFG[k];
  if (typeof base !== 'string' || !nota.startsWith(base)) return nota;
  const resto = nota.slice(base.length);
  const suf = resto.startsWith(' — ') ? SUFIXOS.find((s) => CFG[s] === resto.slice(3)) : undefined;
  return tt(`configuracoes.${k}`) + (!resto ? '' : suf ? ` — ${tt(`configuracoes.${suf}`)}` : resto);
}
