/**
 * Intercom, com o token de acesso de um app privado do próprio espaço de trabalho. Conferido na documentação oficial em 05/11/2026:
 * developers.intercom.com/docs/build-an-integration/learn-more/authentication (token de acesso em Bearer) e .../rest-apis (us, eu e au)
 * developers.intercom.com/docs/build-an-integration/getting-started (New App, Create app, Authentication)
 * developers.intercom.com/docs/build-an-integration/learn-more/authentication/oauth-scopes (nomes das permissões)
 * developers.intercom.com/docs/build-an-integration/learn-more/rest-apis/update-your-api-version (cabeçalho Intercom-Version)
 * developers.intercom.com/docs/references/changelog (a 2.16 é a última que a documentação chama de estável; "body" é HTML)
 * developers.intercom.com/docs/references/rest-api/errors/http-responses (403 api_plan_restricted)
 * developers.intercom.com/docs/references/rest-api/api.intercom.io/admins/identifyadmin (GET /me) e .../admins/listadmins (GET /admins)
 * developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/searchconversations (filtros; o cursor vai no corpo)
 * .../conversations/retrieveconversation (display_as; até as 500 partes mais recentes), .../conversations/replyconversation (comment e note)
 * .../conversations/manageconversation (close, open, snoozed, assignment; assignee_id 0 tira o responsável; sem "body" nada chega ao cliente)
 * .../tickets/createticket e developers.intercom.com/docs/guides/tickets/build-a-ticket-form (POST /tickets; ticket_attributes)
 * .../ticket-types/listtickettypes (GET /ticket_types; is_internal: true nunca é mostrado ao cliente)
 *
 * A busca manda o cursor no corpo, e o motor sempre o põe no endereço quando há `proximo`: por isso o `cursor` é um parâmetro próprio,
 * e a linha "cursor:" sai no `texto`. O agente usa igual aos outros conectores.
 * Não há menção em massa documentada. Notas aceitam menção a atendentes por HTML: o texto é escapado, e nada de quem escreve vira etiqueta.
 */
import { neutral } from '../../operations.ts';
import { ErroAcao, seg, type Acao, type Args, type CtxAcao, type Param } from '../tipos.ts';
import { linhaDe, type ConectorDef, type Credenciais } from './declarativo.ts';

const REGIOES: Record<string, string> = { us: 'https://api.intercom.io', eu: 'https://api.eu.intercom.io', au: 'https://api.au.intercom.io' };
const ESTADO: Record<string, string> = { aberta: 'open', fechada: 'closed', adiada: 'snoozed' };

/** O endereço vem desta lista, nunca do texto da pessoa: a credencial só vai ao Intercom. Em branco é a região principal, a dos Estados Unidos. */
const baseDe = (c: Credenciais): string => {
  const b = REGIOES[String(c.regiao ?? '').trim().toLowerCase() || 'us'];
  if (!b) throw new ErroAcao('região inválida: use us (Estados Unidos), eu (Europa) ou au (Austrália)');
  return b;
};

const escapar = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** O corpo é lido como HTML: cada linha vira um parágrafo, e etiquetas escritas no texto não valem. */
const html = (t: unknown): string => {
  const linhas = String(t ?? '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map(escapar);
  return linhas.length > 1 ? linhas.map((l) => `<p>${l}</p>`).join('') : (linhas[0] ?? '');
};
/** A busca devolve HTML; a leitura de uma conversa já pede texto puro. */
const semHtml = (t: unknown): string => String(t ?? '').replace(/<[^>]+>/g, ' ').trim();
const quando = (s: unknown): string => (typeof s === 'number' ? new Date(s * 1000).toISOString() : '');

const numero = (nome: string, v: unknown): number => {
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) throw new ErroAcao(`"${nome}" precisa ser um número`);
  return Number(s);
};

/** Mesma leitura do motor para booleanos: a regra de risco olha os parâmetros antes de eles serem conferidos. */
const paraCliente = (a: Args): boolean => a.para_cliente === true || a.para_cliente === 'true' || a.para_cliente === 'sim';
/** Atribuir avisa quem recebe: a documentação traz skip_notifications justamente para desligar esse aviso. Tirar o responsável (0) não avisa ninguém. */
const avisaResponsavel = (a: Args): boolean => { const r = String(a.responsavel ?? '').trim(); return (r !== '' && r !== '0') || String(a.time ?? '').trim() !== ''; };

/** O que vai ao cliente aparece inteiro no cartão de confirmação: o título vem antes, e um título enorme empurraria o fim do texto para fora dele. */
const MAX_ENVIO = 5000;
const MAX_TITULO = 500;
const P_CONVERSA: Param = { tipo: 'texto', obrigatorio: true, descricao: 'número da conversa' };

/**
 * O cartão de confirmação diz o assunto e quem é o cliente: o agente só tem o número. Quem começou pode ser um atendente ou um robô,
 * e aí não é o cliente: o que a conversa traz dele é o número do contato.
 */
const CARTAO_DA_CONVERSA: Acao['preparar'] = async (ctx, a) => {
  const j = await ctx.http(`/conversations/${seg(a.conversa)}?display_as=plaintext`, { method: 'GET', kind: 'read' });
  const assunto = semHtml(j?.title) || semHtml(j?.source?.subject) || semHtml(j?.source?.body) || 'sem assunto';
  const autor = j?.source?.author;
  const contato = j?.contacts?.contacts?.[0]?.id;
  const cliente = autor && !['admin', 'bot'].includes(String(autor.type)) && (autor.name || autor.email)
    ? [autor.name, autor.name && autor.email ? `(${autor.email})` : autor.email].filter(Boolean).join(' ')
    : contato ? `contato ${contato}` : 'não identificado';
  return { detalhe: `Assunto: ${neutral(assunto, 200)}\nCliente: ${neutral(cliente, 200)}` };
};

/** Responder e mudar exigem dizer qual atendente faz: é a pessoa dona do token. */
const comoAdmin = async (ctx: CtxAcao, a: Args): Promise<Args> => {
  const eu = await ctx.http('/me');
  if (!eu?.id) throw new ErroAcao('o Intercom não disse quem é o dono do token');
  return { ...a, _admin: String(eu.id) };
};

const filtrosDe = (a: Args): unknown[] => {
  const f: unknown[] = [];
  if (a.situacao && a.situacao !== 'todas') f.push({ field: 'state', operator: '=', value: ESTADO[String(a.situacao)] });
  if (a.texto) f.push({ field: 'source.body', operator: '~', value: a.texto });
  if (a.assunto) f.push({ field: 'source.subject', operator: '~', value: a.assunto });
  if (a.email) f.push({ field: 'source.author.email', operator: '=', value: a.email });
  if (a.responsavel) f.push({ field: 'admin_assignee_id', operator: '=', value: numero('responsavel', a.responsavel) });
  if (a.time) f.push({ field: 'team_assignee_id', operator: '=', value: numero('time', a.time) });
  return f.length ? f : [{ field: 'created_at', operator: '>', value: 0 }];
};

const linhaConversa = (c: any): string => `- ${linhaDe('#{id} [{state}] de {autor}: {inicio} (responsável {admin_assignee_id}, time {team_assignee_id}, atualizada em {atualizada})', { ...c, autor: c.source?.author?.name ?? c.source?.author?.email, inicio: [semHtml(c.title || c.source?.subject), semHtml(c.source?.body)].filter(Boolean).join(' | '), atualizada: quando(c.updated_at) })}`;

const historico = (j: any): string => {
  const partes: any[] = j.conversation_parts?.conversation_parts ?? [];
  const total = Number(j.conversation_parts?.total_count ?? partes.length);
  const cab = linhaDe('Conversa #{id}: {titulo}. Situação: {state}. Responsável: {admin_assignee_id}. Time: {team_assignee_id}. Atualizada em {atualizada}.', { ...j, titulo: j.title || j.source?.subject || 'sem título', atualizada: quando(j.updated_at) });
  const inicio = j.source ? [`- ${linhaDe('{em} {autor} [mensagem inicial]: {corpo}', { em: quando(j.created_at), autor: j.source.author?.name ?? j.source.author?.email, corpo: j.source.body }, 4000)}`] : [];
  const linhas = partes.map((p) => `- ${linhaDe('{em} {autor} [{tipo}]: {corpo}', { em: quando(p.created_at), autor: p.author?.name, tipo: p.part_type === 'note' ? 'nota interna' : p.part_type === 'comment' ? 'mensagem' : p.part_type, corpo: p.body }, 4000)}`);
  const aviso = total > partes.length ? `\n(mostrando as ${partes.length} partes mais recentes de ${total})` : '';
  return [cab, ...inicio, ...linhas].join('\n') + aviso;
};

export const INTERCOM: ConectorDef = {
  kind: 'intercom', nome: 'Intercom', site: 'intercom.com', grupo: 'suporte',
  sobre: 'Conversas e chamados do Intercom: os agentes buscam, leem o histórico, deixam notas internas, mudam a situação e o responsável, abrem chamados e respondem ao cliente.',
  campos: [
    { name: 'token', label: 'Token de acesso', secret: true, placeholder: 'Cole o token aqui' },
    { name: 'regiao', label: 'Região da sua conta (só se for eu ou au)', placeholder: 'em branco para Estados Unidos', pattern: /^(us|eu|au)$/i, patternHelp: 'use us (Estados Unidos), eu (Europa) ou au (Austrália)', opcional: true },
  ],
  ajuda: {
    url: 'https://app.intercom.com/a/apps/_/developer-hub',
    passos: 'Abra o Developer Hub do Intercom e clique em New App. Dê um nome, escolha o seu espaço de trabalho e clique em Create app. No app, abra Authentication e copie o Access Token: ele vale como uma senha. Se a tela mostrar a lista de permissões, marque Read conversations, Write conversations, Read tickets, Write tickets, Read one admin e Read admins. Cole o token aqui. Na região, deixe em branco se a conta for dos Estados Unidos. Escreva eu se for da Europa, ou au se for da Austrália. Na dúvida, deixe em branco.',
  },
  base: baseDe,
  auth: { tipo: 'cabecalhos', cabecalhos: (c) => ({ Authorization: `Bearer ${c.token}`, 'Intercom-Version': '2.16' }) },
  erroNoCorpo: (j) => {
    if (j?.type !== 'error.list') return null;
    const e = Array.isArray(j.errors) ? j.errors[0] : null;
    const codigo = String(e?.code ?? '');
    return { mensagem: [codigo, e?.message].filter(Boolean).join(': ') || 'erro sem detalhe', permissao: /unauthorized|forbidden|restricted|token/i.test(codigo) };
  },
  quemSou: { caminho: '/me', nome: (j) => String(j.app?.name ? `${j.name} (${j.app.name})` : (j.name ?? j.email ?? 'conta do Intercom')), id: (j) => (j.id ? [j.app?.id_code, j.id].filter(Boolean).join(':') : null) },
  acoes: [
    {
      id: 'intercom.buscar', descricao: 'busca conversas, da mais recente à mais antiga, pela situação, por uma palavra da primeira mensagem, pelo assunto, pelo e-mail de quem escreveu ou pelo responsável', risco: 'ler',
      params: {
        situacao: { tipo: 'texto', descricao: 'situação da conversa (padrão aberta)', opcoes: [...Object.keys(ESTADO), 'todas'], padrao: 'aberta' },
        texto: { tipo: 'texto', descricao: 'uma palavra da primeira mensagem' },
        assunto: { tipo: 'texto', descricao: 'uma palavra do assunto' },
        email: { tipo: 'texto', descricao: 'e-mail de quem começou a conversa' },
        responsavel: { tipo: 'texto', descricao: 'número do atendente: veja em intercom.atendentes' },
        time: { tipo: 'texto', descricao: 'número do time' },
        limite: { tipo: 'numero', descricao: 'conversas por página, até 150 (padrão 20)', padrao: 20, max: 150 },
        cursor: { tipo: 'texto', descricao: 'continua de onde parou: use o que veio em "cursor" na resposta anterior' },
      },
      resumo: 'buscar conversas no Intercom', metodo: 'POST', caminho: '/conversations/search',
      corpo: (a: Args) => ({ query: { operator: 'AND', value: filtrosDe(a) }, pagination: { per_page: a.limite, ...(a.cursor ? { starting_after: a.cursor } : {}) } }),
      texto: (j) => {
        const itens: any[] = j.conversations ?? [];
        const prox = j.pages?.next?.starting_after;
        return (itens.length ? itens.map(linhaConversa).join('\n') : 'nada encontrado') + (prox ? `\ncursor: ${String(prox)}` : '');
      },
    },
    {
      id: 'intercom.ler', descricao: 'lê uma conversa ou chamado com o histórico: mensagens, notas internas, marcadas, e mudanças', risco: 'ler',
      params: { conversa: P_CONVERSA }, resumo: 'ler a conversa #{conversa} do Intercom',
      metodo: 'GET', caminho: '/conversations/{conversa}', consulta: { display_as: 'plaintext' }, texto: historico,
    },
    { id: 'intercom.atendentes', descricao: 'lista os atendentes, com o número de cada um: serve para escolher o responsável', risco: 'ler', params: {}, resumo: 'listar os atendentes do Intercom', metodo: 'GET', caminho: '/admins', lista: 'admins', linha: '{name} {email} (número: {id})' },
    { id: 'intercom.tipos', descricao: 'lista os tipos de chamado, com o número de cada um: serve para criar um chamado', risco: 'ler', params: {}, resumo: 'listar os tipos de chamado do Intercom', metodo: 'GET', caminho: '/ticket_types', lista: 'data',
      linha: (x) => linhaDe('{name} (número: {id}, {quem})', { ...x, quem: x.is_internal === true ? 'só a equipe vê' : 'o cliente pode ver' }) },
    {
      id: 'intercom.responder', descricao: 'responde ao cliente na conversa: o cliente recebe', risco: 'enviar',
      params: { conversa: P_CONVERSA, texto: { tipo: 'texto', obrigatorio: true, descricao: 'a resposta, em texto puro, até 5000 caracteres', max: MAX_ENVIO } },
      resumo: 'Responder ao cliente na conversa #{conversa} do Intercom. O cliente recebe:\n{texto}', preparar: CARTAO_DA_CONVERSA, metodo: 'POST', caminho: '/conversations/{conversa}/reply',
      antes: comoAdmin, corpo: (a: Args) => ({ message_type: 'comment', type: 'admin', admin_id: a._admin, body: html(a.texto) }), texto: 'Resposta enviada na conversa #{conversa}.',
    },
    {
      id: 'intercom.nota', descricao: 'deixa uma nota interna na conversa: só a equipe vê', risco: 'organizar',
      params: { conversa: P_CONVERSA, texto: { tipo: 'texto', obrigatorio: true, descricao: 'a nota, em texto puro, até 5000 caracteres', max: MAX_ENVIO } },
      resumo: 'Deixar uma nota interna na conversa #{conversa} do Intercom (o cliente não vê):\n{texto}', preparar: CARTAO_DA_CONVERSA, metodo: 'POST', caminho: '/conversations/{conversa}/reply',
      antes: comoAdmin, corpo: (a: Args) => ({ message_type: 'note', type: 'admin', admin_id: a._admin, body: html(a.texto) }), texto: 'Nota interna registrada na conversa #{conversa}.',
    },
    {
      id: 'intercom.situacao', descricao: 'abre, fecha ou adia uma conversa, sem mandar mensagem ao cliente', risco: 'organizar',
      params: {
        conversa: P_CONVERSA,
        situacao: { tipo: 'texto', obrigatorio: true, descricao: 'nova situação', opcoes: Object.keys(ESTADO) },
        ate: { tipo: 'texto', descricao: 'só para adiar: quando volta, com fuso, como 2026-11-06T09:00:00-03:00' },
      },
      resumo: (a) => `Mudar a conversa #${String(a.conversa)} do Intercom para ${String(a.situacao)}${a.ate ? ` até ${String(a.ate)}` : ''}. O cliente não recebe mensagem.`,
      preparar: CARTAO_DA_CONVERSA, metodo: 'POST', caminho: '/conversations/{conversa}/parts', antes: comoAdmin,
      corpo: (a: Args) => {
        if (a.situacao === 'fechada') return { message_type: 'close', type: 'admin', admin_id: a._admin, skip_notifications: true };
        if (a.situacao === 'aberta') return { message_type: 'open', admin_id: a._admin, skip_notifications: true };
        const ate = String(a.ate ?? '').trim();
        const ms = /(z|[+-]\d{2}:\d{2})$/i.test(ate) ? Date.parse(ate) : Number.NaN;
        if (Number.isNaN(ms)) throw new ErroAcao('para adiar, diga em "ate" a data e a hora com fuso, como 2026-11-06T09:00:00-03:00');
        return { message_type: 'snoozed', admin_id: a._admin, snoozed_until: Math.floor(ms / 1000) };
      },
      texto: 'Conversa #{conversa} agora está {situacao}.',
    },
    {
      id: 'intercom.atribuir', descricao: 'muda o responsável de uma conversa, sem mandar mensagem ao cliente. O novo responsável recebe aviso', risco: (a) => (avisaResponsavel(a) ? 'enviar' : 'organizar'),
      params: { conversa: P_CONVERSA, responsavel: { tipo: 'texto', obrigatorio: true, descricao: 'número do atendente ou do time; 0 tira o responsável' } },
      resumo: (a) => `Mudar o responsável da conversa #${String(a.conversa)} do Intercom para ${String(a.responsavel)}. O cliente não recebe mensagem.${avisaResponsavel(a) ? ' O novo responsável recebe aviso.' : ''}`,
      preparar: CARTAO_DA_CONVERSA, metodo: 'POST', caminho: '/conversations/{conversa}/parts', antes: comoAdmin,
      corpo: (a: Args) => ({ message_type: 'assignment', type: 'admin', admin_id: a._admin, assignee_id: String(numero('responsavel', a.responsavel)) }),
      texto: 'Conversa #{conversa} com o responsável {responsavel}.',
    },
    {
      id: 'intercom.criar', descricao: 'cria um chamado. Tipos que só a equipe vê não chegam ao cliente. Tipos que o cliente pode ver exigem para_cliente: sim. Com responsável ou time, quem recebe pode ser avisado', rotulo: 'cria um chamado. Os tipos que só a equipe vê não chegam ao cliente; os que o cliente pode ver chegam a ele. Com responsável ou time, quem recebe pode ser avisado', risco: (a) => (paraCliente(a) || avisaResponsavel(a) ? 'enviar' : 'organizar'),
      params: {
        tipo: { tipo: 'texto', obrigatorio: true, descricao: 'número do tipo de chamado: veja em intercom.tipos' },
        contato: { tipo: 'texto', obrigatorio: true, descricao: 'cliente do chamado: número do contato ou e-mail. O Intercom cria o contato se o e-mail for novo' },
        titulo: { tipo: 'texto', obrigatorio: true, descricao: 'título do chamado, até 500 caracteres', max: MAX_TITULO },
        descricao: { tipo: 'texto', obrigatorio: true, descricao: 'o que aconteceu, em texto puro, até 5000 caracteres', max: MAX_ENVIO },
        responsavel: { tipo: 'texto', descricao: 'número do atendente' },
        time: { tipo: 'texto', descricao: 'número do time' },
        para_cliente: { tipo: 'booleano', descricao: 'sim, se o tipo de chamado pode ser visto pelo cliente' },
      },
      resumo: (a) => `${paraCliente(a) ? `Criar um chamado no Intercom que ${String(a.contato)} pode ver e receber.` : `Criar um chamado interno no Intercom, sobre ${String(a.contato)}.`}${avisaResponsavel(a) ? ' O responsável ou o time pode ser avisado.' : ''}\nTítulo: ${String(a.titulo)}\n${String(a.descricao)}`,
      metodo: 'POST', caminho: '/tickets',
      // o risco olha só o parâmetro: esta conferência impede que um tipo visível ao cliente passe como interno
      antes: async (ctx, a) => {
        const tipos: any[] = (await ctx.http('/ticket_types'))?.data ?? [];
        const t = tipos.find((x) => String(x.id) === String(a.tipo));
        if (!t) throw new ErroAcao('tipo de chamado não encontrado', tipos.map((x) => linhaDe('{id} ({name})', x)));
        if (t.is_internal !== true && !a.para_cliente) throw new ErroAcao(linhaDe('o tipo "{name}" pode ser visto pelo cliente: para criar assim, diga para_cliente: sim', t));
        return a;
      },
      corpo: (a: Args) => ({
        ticket_type_id: String(a.tipo),
        contacts: [String(a.contato).includes('@') ? { email: a.contato } : { id: a.contato }],
        ticket_attributes: { _default_title_: a.titulo, _default_description_: a.descricao },
        ...(a.responsavel || a.time ? { assignment: { ...(a.responsavel ? { admin_assignee_id: String(a.responsavel) } : {}), ...(a.time ? { team_assignee_id: String(a.time) } : {}) } } : {}),
      }),
      texto: 'Chamado criado (número: {id}).',
    },
  ],
};
