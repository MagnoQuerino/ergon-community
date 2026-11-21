// Galeria dos blocos visuais (só desenvolvimento): as conversas de exemplo e as respostas do servidor simuladas.
import type { Bloco } from '../../../../shared/visuais/esquema.ts';
import { cercaVisual, cercaVoto } from '../../../../shared/visuais/cercas.ts';
import { relatorioComoMarkdown } from '../../../../shared/visuais/texto.ts';
import { EXEMPLOS } from '../../../../shared/visuais/exemplos.ts';
import type { Message } from '../../lib/types.ts';

const AGORA = Date.parse('2026-11-21T13:40:00Z');
const em = (min: number) => new Date(AGORA + min * 60_000).toISOString();
const v = (...bs: Bloco[]) => bs.map(cercaVisual).join('\n\n');
let n = 0;
const msg = (role: Message['role'], content: string, min: number): Message => ({ id: `m${++n}`, role, content, mode: 'real', run_id: role === 'agent' ? `r${n}` : null, created_at: em(min), run_status: role === 'agent' ? 'done' : null });

export const HIPATIA = { id: 'ag-hipatia', name: 'Hipátia', role: 'Finanças', color: '#B88B5B', sector_name: 'Financeiro', char_key: 'hipatia' };
export const ASPASIA = { id: 'ag-aspasia', name: 'Aspásia', role: 'Atendimento', color: '#6b4fb0', sector_name: 'Atendimento', char_key: 'aspasia' };

const nubank = EXEMPLOS.barras.fontes!;
export const CONVERSA_HIPATIA: Message[] = [
  msg('user', 'Hipátia, como ficaram os gastos de novembro até agora?', 0),
  msg('agent', `Fechei até o dia 20: **R$ 18,4 mil**, 8,2% abaixo de outubro. A folha segue sendo mais da metade; software caiu com o cancelamento de duas licenças sem uso.\n\n${v(
    { tipo: 'kpis', itens: [
      { rotulo: 'Gastos', valor: 18420.5, formato: 'moeda', variacao: -8.2, comparacao: 'vs. out', bom: 'baixa', meta: 20000 },
      { rotulo: 'Receita', valor: 46900, formato: 'moeda', variacao: 12.4, comparacao: 'vs. out' },
      { rotulo: 'Sobra do mês', valor: 28479.5, formato: 'moeda', variacao: 33.6, comparacao: 'vs. out' },
    ], fontes: nubank },
    EXEMPLOS.barras, EXEMPLOS.tabela,
  )}`, 1),
  msg('user', 'E o que vence até o fim do mês?', 4),
  msg('agent', `Três contas; uma pede atenção.\n\n${v(
    { tipo: 'linha_do_tempo', titulo: 'Vencimentos de novembro', hoje: '2026-11-21', marcos: [
      { data: '2026-11-20', titulo: 'Impostos (DAS)', detalhe: 'R$ 1.320 — guia ainda não paga', estado: 'atrasado' },
      { data: '2026-11-25', titulo: 'Marketing', detalhe: 'R$ 1.180 — débito automático', estado: 'em_dia' },
      { data: '2026-11-30', titulo: 'Folha', detalhe: 'R$ 9.800 — saldo cobre', estado: 'previsto' },
    ], fontes: [{ tipo: 'documento', titulo: 'Orçamento 2026.xlsx', periodo: 'nov/2026' }, ...nubank] },
    { tipo: 'aviso', tom: 'alerta', texto: 'O DAS venceu ontem: pagando até segunda a multa fica em R$ 4,40.' },
  )}`, 5),
];

export const CONVERSA_ASPASIA: Message[] = [
  msg('user', 'Aspásia, quantos % dos nossos e-mails estão sem resposta?', 10),
  msg('agent', `37% — e o grosso está no financeiro.\n\n${v({ ...EXEMPLOS.pizza, titulo: 'E-mails sem resposta' })}`, 11),
  msg('user', 'Como está a satisfação dos clientes no canal de e-mail?', 13),
  msg('agent', `Boa e subindo: 78% satisfeitos, 4 pontos acima de outubro.\n\n${v(EXEMPLOS.medidor)}`, 14),
  msg('user', 'E quantos renovariam hoje?', 16),
  msg('agent', `Sete em cada dez.\n\n${v({ ...EXEMPLOS.icones, lado: { numero: '70%', rotulo: 'renovariam', linhas: ['Os 3 restantes citam preço', '41 clientes responderam'] } })}`, 17),
];

const REL = EXEMPLOS.relatorio as Extract<Bloco, { tipo: 'relatorio' }>;
export const CONVERSA_RELATORIO: Message[] = [
  msg('user', 'Hipátia, me manda o relatório de gastos de novembro, com os impostos separados.', 20),
  msg('agent', `Está pronto. O resumo vai aqui; o relatório completo abre como documento, com revisão e PDF.\n\n${v(REL)}`, 26),
];

/** A sala "Comercial": pessoas e agentes; a enquete com os votos (mensagens só com o voto). */
export const SALA = {
  nome: 'Comercial', membros: ['Ana Ribeiro', 'Bruno Costa', 'Carla Mendes', 'Davi Souza', 'Aristóteles', 'Aspásia'],
  mensagens: [
    { quem: 'Ana Ribeiro', papel: 'pessoa', texto: '@Aristóteles compara as duas propostas de CRM e monta o cronograma da troca?', min: 30 },
    { quem: 'Aristóteles', papel: 'agente', texto: `Comparei as duas propostas que o Bruno mandou. O Pipedrive sai mais barato por usuário e integra com o Outlook; o HubSpot tem mais automação, mas trava no plano Starter.\n\n${v(
      { tipo: 'comparativo', titulo: 'HubSpot × Pipedrive', opcoes: [
        { nome: 'HubSpot Starter', subtitulo: '5 usuários · anual', valor: 10800, pros: ['Automação de e-mail inclusa', 'Interface que o time já conhece'], contras: ['Relatórios só no plano Pro', 'Reajuste de 9% em março'] },
        { nome: 'Pipedrive Advanced', subtitulo: '5 usuários · anual', valor: 8940, pros: ['R$ 1.860 a menos no ano', 'Integração nativa com o Outlook'], contras: ['Migração dos contatos é manual'], recomendada: true },
      ], formato: 'moeda', fontes: [{ tipo: 'documento', titulo: 'Proposta HubSpot.pdf' }, { tipo: 'documento', titulo: 'Proposta Pipedrive.pdf' }, { tipo: 'conversa', titulo: 'Sala Comercial', periodo: '18–21/11' }] },
      { tipo: 'linha_do_tempo', titulo: 'Troca do CRM', hoje: '2026-11-21', marcos: [
        { data: '2026-11-21', titulo: 'Decisão do grupo', estado: 'em_dia' },
        { data: '2026-11-26', titulo: 'Contrato assinado', detalhe: 'Bruno', estado: 'previsto' },
        { data: '2026-12-03', titulo: 'Migração dos 1.240 contatos', detalhe: 'Aspásia', estado: 'previsto' },
        { data: '2026-12-08', titulo: 'Time usando o CRM novo', estado: 'risco' },
      ], fontes: [{ tipo: 'calculo', titulo: 'Cronograma do Aristóteles' }] },
    )}`, min: 32 },
    { quem: 'Aristóteles', papel: 'agente', texto: `Bora decidir? Cada um vota com um clique.\n\n${v({ tipo: 'enquete', id: 'enq-crm', pergunta: 'Qual CRM a gente contrata?', opcoes: ['HubSpot Starter', 'Pipedrive Advanced', 'Ficar com a planilha'], eleitores: 5 })}`, min: 33 },
    { quem: 'Bruno Costa', papel: 'pessoa', texto: cercaVoto({ enquete: 'enq-crm', opcao: 1 }), min: 34 },
    { quem: 'Carla Mendes', papel: 'pessoa', texto: cercaVoto({ enquete: 'enq-crm', opcao: 0 }), min: 35 },
    { quem: 'Davi Souza', papel: 'pessoa', texto: cercaVoto({ enquete: 'enq-crm', opcao: 1 }), min: 36 },
    { quem: 'Aspásia', papel: 'agente', texto: cercaVoto({ enquete: 'enq-crm', opcao: 1 }), min: 36.5 },
    { quem: 'Carla Mendes', papel: 'pessoa', texto: 'Fui de HubSpot pela automação, mas topo o Pipedrive se a Aspásia cuidar da migração.', min: 37 },
  ],
};

export const RESPOSTAS: Array<[RegExp, (m: RegExpMatchArray) => unknown]> = [
  [/^\/api\/artifacts\/art_rel\w*\/preview/, () => ({ kind: 'text', mime: 'text/markdown', text: relatorioComoMarkdown(REL) })],
  [/^\/api\/conversations\?agentId=ag-hipatia/, () => [{ id: 'c-hipatia', agent_id: 'ag-hipatia', title: 'Gastos de novembro', created_at: em(0), last_at: em(5) }, { id: 'c-relatorio', agent_id: 'ag-hipatia', title: 'Relatório de gastos', created_at: em(20), last_at: em(26) }]],
  [/^\/api\/conversations\?agentId=ag-aspasia/, () => [{ id: 'c-aspasia', agent_id: 'ag-aspasia', title: 'E-mails e satisfação', created_at: em(10), last_at: em(17) }]],
  [/^\/api\/conversations\/c-hipatia\/messages/, () => CONVERSA_HIPATIA],
  [/^\/api\/conversations\/c-aspasia\/messages/, () => CONVERSA_ASPASIA],
  [/^\/api\/conversations\/c-relatorio\/messages/, () => CONVERSA_RELATORIO],
  [/^\/api\/conversations\/[\w-]+\/cards/, () => []],
  [/^\/api\/proposals\?conversationId=/, () => []],
  [/^\/api\/ai\/status/, () => ({ executor: 'real', available: true, accounts: [{ connected: true }], byok: [], default: { provider: 'nous', model: 'x', label: '', billing: 'gratis' } })],
  [/^\/api\/recursos/, () => ({ checkpoints: false, codigoInseguro: false, limpeza: false, buscaFerramentas: false, conectores: [], voz: { transcrever: null, falar: 'local' }, navegador: { chromium: false, pronto: false }, escrita: [] })],
  [/^\/api\/comandos/, () => ({ ativos: [], recentes: [] })],
  [/^\/api\/visuais\/link\?url=/, () => ({ titulo: 'Calendário de obrigações de dezembro de 2026', descricao: 'Datas do DAS, DCTFWeb e eSocial, com o que muda para o Simples Nacional a partir de janeiro.', imagem: 'https://www.gov.br/capa-calendario.png', site: 'Receita Federal' })],
  [/^\/api\/visuais\/arquivo\/art_/, () => ({ id: 'art_x', nome: 'Contrato de prestação de serviços.pdf', mime: 'application/pdf', tamanho: 248_312, tipo: 'pdf', paginas: 7,
    texto: 'CONTRATO DE PRESTAÇÃO DE SERVIÇOS\n\nPelo presente instrumento particular, de um lado ACELEN REFINO S.A., inscrita no CNPJ sob o nº 00.000.000/0001-00, com sede na Av. Tancredo Neves, 1632, Salvador/BA, doravante CONTRATANTE, e de outro lado ERGON TECNOLOGIA LTDA., doravante CONTRATADA, têm entre si justo e contratado o seguinte:\n\nCLÁUSULA 1ª — DO OBJETO\n1.1. A CONTRATADA prestará à CONTRATANTE os serviços de implantação e suporte da plataforma Ergon, conforme o Anexo I.\n\nCLÁUSULA 2ª — DO PRAZO\n2.1. O presente contrato vigorará por 12 (doze) meses a contar da assinatura.' })],
];

/** Os envios (POST) que respondem algo além de "ok". */
export const ENVIOS: Array<[RegExp, () => unknown]> = [
  [/^\/api\/visuais\/relatorio\/documento/, () => ({ id: 'art_relatorio0000000000000000000000', nome: 'Gastos de novembro v2.md', tamanho: 2140 })],
];
