/**
 * Zendesk Support, com um cliente OAuth do tipo Confidential. Conferido na documentação oficial em 05/11/2026:
 * developer.zendesk.com/api-reference/ticketing/oauth/grant_type_tokens (POST /oauth/tokens, client_credentials; "You must specify a scope"; "read write" cobre tudo)
 * support.zendesk.com/hc/en-us/articles/4408845965210 (criar o cliente no Admin Center: nomes da tela; o Secret aparece por inteiro só uma vez)
 * developer.zendesk.com/api-reference/introduction/pagination (page e per_page; page[size], page[after], meta.has_more)
 * developer.zendesk.com/api-reference/ticketing/users/users (GET /users/me aceita anônimo: por isso o id nulo vira erro)
 * developer.zendesk.com/api-reference/ticketing/ticket-management/search (GET /search: results, next_page, até 100 por página)
 * developer.zendesk.com/api-reference/ticketing/tickets/tickets (GET, POST e PUT de chamado; requester; assignee_email)
 * developer.zendesk.com/api-reference/ticketing/tickets/ticket_comments (lista; public: false é nota interna; o texto entra no PUT do chamado)
 * developer.zendesk.com/documentation/ticketing/managing-tickets/creating-and-updating-tickets (requester com e-mail)
 * support.zendesk.com/hc/en-us/articles/4408886879258 (busca: status:, requester:, assignee:, type:ticket)
 * support.zendesk.com/hc/en-us/articles/4408828984346 (avisos padrão: nota interna vai ao responsável; mudar responsável ou grupo, ou tirar de "resolvido", avisa a equipe;
 *   chamado novo avisa todos os atendentes e, se for em nome de outra pessoa, também ela. Só resolver, ou só mudar a prioridade, não dispara aviso padrão)
 * support.zendesk.com/hc/en-us/articles/10840968198042 (tokens de API: contas criadas desde 28/07/2026 não usam; nenhum novo desde 27/10/2026; todos param em 30/04/2027. Reconferido em 06/11/2026)
 * developer.zendesk.com/documentation/authentication/oauth-migration (o que substitui o token. A documentação recomenda o login pelo navegador quando dá; aqui fica o
 *   client_credentials, sem tela de autorização. O que os agentes fizerem fica em nome de quem criou o cliente, que precisa continuar com a permissão de administrar clientes)
 *
 * Só uma conta real confirma: que GET /users/me com este acesso responde quem criou o cliente (a documentação diz a quem as ações são atribuídas, mas não fala deste endereço).
 *
 * Não há menção em massa nos comentários de chamado. O campo `body` recebe texto puro: o Zendesk descarta o HTML dele.
 */
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { emails, ErroAcao, seg, type Acao, type Args, type Param } from '../tipos.ts';
import { hostSeguro, linhaDe, type ConectorDef, type Credenciais } from './declarativo.ts';

const SITUACAO: Record<string, string> = { aberto: 'open', pendente: 'pending', em_espera: 'hold', resolvido: 'solved' };
const SITUACAO_BUSCA: Record<string, string> = { novo: 'new', ...SITUACAO, fechado: 'closed' };
const PRIORIDADE: Record<string, string> = { baixa: 'low', normal: 'normal', alta: 'high', urgente: 'urgent' };

/** Aceita "empresa", "empresa.zendesk.com" ou o endereço colado: a credencial só vai a um subdomínio do Zendesk. */
const hostDe = (c: Credenciais): string => {
  const v = String(c.subdominio ?? '').trim();
  return hostSeguro(v.includes('.') ? v : `${v}.zendesk.com`, /^[a-z0-9-]+\.zendesk\.com$/).replace(/:\d+$/, '');
};

/** Conexão feita antes, com o token de API: não tem cliente OAuth, e mandar um vazio só daria um erro sem explicação. */
const idDoCliente = (c: Credenciais): string => {
  if (!c.identificador) throw new ProviderError('forbidden', 'esta conexão usa o token de API do Zendesk, que o Ergon não usa mais: conecte de novo em Conexões, com o identificador e o segredo de um cliente OAuth', { reauth: true, status: 403 });
  return c.identificador;
};

/** O que vai ao cliente aparece inteiro no cartão de confirmação: o assunto vem antes, e um assunto enorme empurraria o fim do texto para fora dele. */
const MAX_ENVIO = 5000;
const MAX_ASSUNTO = 500;
const P_CHAMADO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'número do chamado' };

/** O cartão de confirmação diz o assunto do chamado e quem é o cliente: o agente só tem o número. */
const CARTAO_DO_CHAMADO: Acao['preparar'] = async (ctx, a) => {
  const j = await ctx.http(`/tickets/${seg(a.chamado)}?include=users`, { method: 'GET', kind: 'read' });
  const t = j?.ticket;
  const u = (j?.users ?? []).find((x: any) => x?.id === t?.requester_id);
  const cliente = u?.name || u?.email ? [u.name, u.name && u.email ? `(${u.email})` : u.email].filter(Boolean).join(' ') : `número ${t?.requester_id ?? 'desconhecido'}`;
  return { detalhe: `Assunto: ${neutral(String(t?.subject || 'sem assunto'), 200)}\nCliente: ${neutral(cliente, 200)}` };
};
const temSolicitante = (a: Args): boolean => String(a.solicitante ?? '').trim() !== '';
/** Os gatilhos padrão mandam e-mail a outra pessoa da equipe nestes casos: por isso a mudança conta como enviar. */
const avisaEquipe = (a: Args): boolean => ['responsavel', 'grupo'].some((k) => String(a[k] ?? '').trim() !== '') || !['', 'resolvido'].includes(String(a.situacao ?? ''));

/** Termo da busca: com espaço, vai entre aspas. */
const termo = (v: unknown): string => { const s = String(v).trim(); return /\s/.test(s) ? `"${s.replace(/"/g, '')}"` : s; };

const numero = (nome: string, v: unknown): number => {
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) throw new ErroAcao(`"${nome}" precisa ser um número`);
  return Number(s);
};

/** Um único endereço: o resumo mostra o que foi escrito, e o corpo não pode levar só parte disso. */
const umEmail = (nome: string, v: unknown): string => {
  const l = emails({ [nome]: v }, nome, 2);
  if (l.length !== 1) throw new ErroAcao(`"${nome}" precisa ser um único e-mail`);
  return l[0];
};
/** O Zendesk aceita o responsável pelo número ou pelo e-mail. */
const responsavelDe = (v: unknown): Record<string, string | number> => {
  const s = String(v ?? '').trim();
  if (!s) return {};
  if (/^\d+$/.test(s)) return { assignee_id: Number(s) };
  if (s.includes('@')) return { assignee_email: umEmail('responsavel', s) };
  throw new ErroAcao('"responsavel" precisa ser o número do atendente ou o e-mail dele');
};

/** A página seguinte da busca vem num endereço: só o número dela interessa. */
const paginaDe = (endereco: unknown): string | null => {
  if (typeof endereco !== 'string' || !endereco) return null;
  try { return new URL(endereco).searchParams.get('page'); } catch { return null; }
};

const historico = (j: any, a: Args): string => {
  const nomes = new Map<unknown, unknown>((j.users ?? []).map((u: any) => [u.id, u.name]));
  const t = a._chamado as any;
  const cab = t ? `${linhaDe('Chamado #{id}: {subject}. Situação: {status}. Prioridade: {priority}. Solicitante: {quem}. Responsável: {assignee_id}. Grupo: {group_id}. Atualizado em {updated_at}.', { ...t, quem: nomes.get(t.requester_id) ?? t.requester_id })}\n` : '';
  const linhas = (j.comments ?? []).map((c: any) => `- ${linhaDe('{created_at} {quem} [{tipo}]: {corpo}', { created_at: c.created_at, quem: nomes.get(c.author_id) ?? c.author_id, tipo: c.public ? 'resposta pública' : 'nota interna', corpo: c.plain_body ?? c.body }, 4000)}`);
  return cab + (linhas.length ? linhas.join('\n') : 'sem comentários');
};

export const ZENDESK: ConectorDef = {
  kind: 'zendesk', nome: 'Zendesk', site: 'zendesk.com', grupo: 'suporte',
  sobre: 'Chamados do Zendesk: os agentes buscam, leem o histórico, deixam notas internas, mudam a situação e o responsável, abrem chamados e respondem ao cliente.',
  campos: [
    { name: 'subdominio', label: 'Subdomínio do Zendesk', placeholder: 'suaempresa (de suaempresa.zendesk.com)' },
    { name: 'identificador', label: 'Identificador do cliente OAuth (Identifier)', placeholder: 'ergon' },
    { name: 'segredo', label: 'Segredo do cliente OAuth (Secret)', secret: true, placeholder: 'Cole o segredo aqui' },
  ],
  ajuda: {
    url: 'https://support.zendesk.com/hc/en-us/articles/4408845965210-Using-OAuth-authentication-with-your-application',
    passos: 'O Zendesk está encerrando os tokens de API, então aqui a conexão usa um cliente OAuth. Entre com uma conta de administrador e abra o Admin Center. Vá em Apps and integrations › APIs › OAuth clients e clique em Add OAuth client. Em Name, escreva Ergon. Em Client kind, escolha Confidential. Se a tela pedir Redirect URLs, escreva https://localhost: esse endereço não é usado aqui. Deixe Scopes em branco. Clique em Save. O campo Secret aparece preenchido só nessa hora: copie e guarde. Clique em Save de novo. Cole aqui o subdomínio (a primeira parte do endereço: suaempresa, de suaempresa.zendesk.com), o Identifier e o Secret. Tudo o que os agentes fizerem fica em nome de quem criou o cliente. Se preferir que as respostas saiam em outro nome, crie o cliente com uma conta só para isso.',
  },
  base: (c) => `https://${hostDe(c)}/api/v2`,
  auth: { tipo: 'cliente', tokenUrl: (c) => `https://${hostDe(c)}/oauth/tokens`, id: idDoCliente, segredo: (c) => c.segredo, escopo: 'read write' },
  erroNoCorpo: (j) => {
    if (j?.user && typeof j.user === 'object') {
      if (j.user.id === null || j.user.id === undefined) return { mensagem: 'o Zendesk não reconheceu o identificador e o segredo', permissao: true };
      if (j.user.role === 'end-user') return { mensagem: 'este cliente OAuth foi criado por uma conta sem acesso de atendente: crie com um atendente ou administrador', permissao: true };
    }
    if (!j?.error) return null;
    const e = typeof j.error === 'string' ? { title: j.error, message: j.description } : j.error;
    const mensagem = [e.title, e.message].filter(Boolean).join(': ');
    return { mensagem: mensagem || 'erro sem detalhe', permissao: /forbidden|unauthori|permission|access/i.test(mensagem) };
  },
  quemSou: { caminho: '/users/me', nome: (j) => String(j.user?.name ?? j.user?.email ?? 'conta do Zendesk'), id: (j) => j.user?.id },
  acoes: [
    {
      id: 'zendesk.buscar', descricao: 'busca chamados, do mais recente ao mais antigo. Dá para combinar palavras, situação, solicitante e responsável', risco: 'ler',
      params: {
        busca: { tipo: 'texto', descricao: 'palavras do chamado; aceita também a busca do Zendesk, como subject:"nota fiscal"' },
        situacao: { tipo: 'texto', descricao: 'situação do chamado', opcoes: Object.keys(SITUACAO_BUSCA) },
        solicitante: { tipo: 'texto', descricao: 'quem pediu: e-mail, nome, "me" para quem criou o cliente OAuth ou "none" para ninguém' },
        responsavel: { tipo: 'texto', descricao: 'quem cuida: e-mail, nome, "me" para quem criou o cliente OAuth ou "none" para sem responsável' },
        limite: { tipo: 'numero', descricao: 'chamados por página, até 100 (padrão 25)', padrao: 25, max: 100 },
      },
      resumo: (a) => `buscar chamados no Zendesk${a.busca ? `: ${String(a.busca)}` : ''}`,
      metodo: 'GET', caminho: '/search', consulta: { query: '{_consulta}', per_page: '{limite}', sort_by: 'updated_at', sort_order: 'desc' },
      antes: async (_ctx, a) => {
        const partes = ['type:ticket'];
        if (a.situacao) partes.push(`status:${SITUACAO_BUSCA[String(a.situacao)]}`);
        if (a.solicitante) partes.push(`requester:${termo(a.solicitante)}`);
        if (a.responsavel) partes.push(`assignee:${termo(a.responsavel)}`);
        if (a.busca) partes.push(String(a.busca).trim());
        return { ...a, _consulta: partes.join(' ') };
      },
      lista: 'results', linha: '#{id} [{status}] {subject} (solicitante {requester_id}, responsável {assignee_id}, atualizado em {updated_at})',
      proximo: (j) => paginaDe(j.next_page), paramCursor: 'page',
    },
    {
      id: 'zendesk.ler', descricao: 'lê um chamado com o histórico: respostas ao cliente e notas internas, marcadas', risco: 'ler',
      params: { chamado: P_CHAMADO, limite: { tipo: 'numero', descricao: 'comentários por página, até 100 (padrão 100)', padrao: 100, max: 100 } },
      resumo: 'ler o chamado #{chamado} do Zendesk', metodo: 'GET', caminho: '/tickets/{chamado}/comments', consulta: { 'page[size]': '{limite}', include: 'users' },
      antes: async (ctx, a) => {
        if (!a.chamado) throw new ErroAcao('falta "chamado"');
        return a.cursor ? a : { ...a, _chamado: (await ctx.http(`/tickets/${seg(a.chamado)}`)).ticket };
      },
      texto: historico, proximo: (j) => (j.meta?.has_more ? j.meta.after_cursor : null), paramCursor: 'page[after]',
    },
    {
      id: 'zendesk.responder', descricao: 'responde ao cliente no chamado: o cliente recebe', risco: 'enviar',
      params: { chamado: P_CHAMADO, texto: { tipo: 'texto', obrigatorio: true, descricao: 'a resposta, em texto puro, até 5000 caracteres', max: MAX_ENVIO } },
      resumo: 'Responder ao cliente no chamado #{chamado} do Zendesk. O cliente recebe:\n{texto}', preparar: CARTAO_DO_CHAMADO, metodo: 'PUT', caminho: '/tickets/{chamado}',
      corpo: { ticket: { comment: { body: '{texto}', public: true } } }, texto: 'Resposta enviada no chamado #{chamado}.',
    },
    {
      id: 'zendesk.nota', descricao: 'deixa uma nota interna no chamado: o cliente não vê, mas o responsável pelo chamado recebe por e-mail', risco: 'enviar',
      params: { chamado: P_CHAMADO, texto: { tipo: 'texto', obrigatorio: true, descricao: 'a nota, em texto puro, até 5000 caracteres', max: MAX_ENVIO } },
      resumo: 'Deixar uma nota interna no chamado #{chamado} do Zendesk (o cliente não vê; o responsável pelo chamado recebe por e-mail):\n{texto}', preparar: CARTAO_DO_CHAMADO, metodo: 'PUT', caminho: '/tickets/{chamado}',
      corpo: { ticket: { comment: { body: '{texto}', public: false } } }, texto: 'Nota interna registrada no chamado #{chamado}.',
    },
    {
      id: 'zendesk.atualizar', descricao: 'muda a situação, a prioridade, o responsável ou o grupo de um chamado. Mudar o responsável ou o grupo, ou tirar de resolvido, avisa a equipe por e-mail', risco: (a) => (avisaEquipe(a) ? 'enviar' : 'organizar'),
      params: {
        chamado: P_CHAMADO,
        situacao: { tipo: 'texto', descricao: 'nova situação', opcoes: Object.keys(SITUACAO) },
        prioridade: { tipo: 'texto', descricao: 'nova prioridade', opcoes: Object.keys(PRIORIDADE) },
        responsavel: { tipo: 'texto', descricao: 'número do atendente ou e-mail dele' },
        grupo: { tipo: 'texto', descricao: 'número do grupo' },
      },
      resumo: (a) => {
        const m = [a.situacao && `situação para ${String(a.situacao)}`, a.prioridade && `prioridade para ${String(a.prioridade)}`, a.responsavel && `responsável para ${String(a.responsavel)}`, a.grupo && `grupo para ${String(a.grupo)}`].filter(Boolean);
        return `Mudar o chamado #${String(a.chamado)} do Zendesk: ${m.join('; ') || 'nada informado'}${avisaEquipe(a) ? '. O Zendesk pode avisar a equipe por e-mail.' : ''}`;
      },
      preparar: CARTAO_DO_CHAMADO, metodo: 'PUT', caminho: '/tickets/{chamado}',
      corpo: (a: Args) => {
        const ticket = {
          ...(a.situacao ? { status: SITUACAO[String(a.situacao)] } : {}),
          ...(a.prioridade ? { priority: PRIORIDADE[String(a.prioridade)] } : {}),
          ...responsavelDe(a.responsavel),
          ...(a.grupo ? { group_id: numero('grupo', a.grupo) } : {}),
        };
        if (!Object.keys(ticket).length) throw new ErroAcao('diga o que mudar: situacao, prioridade, responsavel ou grupo');
        return { ticket };
      },
      texto: 'Chamado #{chamado} atualizado.',
    },
    {
      id: 'zendesk.criar', descricao: 'cria um chamado. Sem "solicitante", fica em nome de quem criou o cliente OAuth. O Zendesk pode avisar os atendentes por e-mail e, com "solicitante", avisa essa pessoa', rotulo: 'cria um chamado. O Zendesk pode avisar os atendentes por e-mail e, se houver quem pediu, avisa essa pessoa', risco: 'enviar',
      params: {
        assunto: { tipo: 'texto', obrigatorio: true, descricao: 'assunto do chamado, até 500 caracteres', max: MAX_ASSUNTO },
        descricao: { tipo: 'texto', obrigatorio: true, descricao: 'o que aconteceu, em texto puro, até 5000 caracteres', max: MAX_ENVIO },
        prioridade: { tipo: 'texto', descricao: 'prioridade', opcoes: Object.keys(PRIORIDADE) },
        solicitante: { tipo: 'texto', descricao: 'e-mail do cliente, se o chamado for em nome dele' },
        nome_solicitante: { tipo: 'texto', descricao: 'nome do cliente: necessário se ele ainda não existe no Zendesk' },
        responsavel: { tipo: 'texto', descricao: 'número do atendente ou e-mail dele' },
        grupo: { tipo: 'texto', descricao: 'número do grupo' },
      },
      resumo: (a) => `${temSolicitante(a) ? `Criar um chamado no Zendesk em nome de ${String(a.solicitante)}. O Zendesk avisa essa pessoa por e-mail e pode avisar os atendentes.` : 'Criar um chamado no Zendesk. O Zendesk pode avisar os atendentes por e-mail.'}\nAssunto: ${String(a.assunto)}\n${String(a.descricao)}`,
      metodo: 'POST', caminho: '/tickets',
      corpo: (a: Args) => ({
        ticket: {
          subject: a.assunto, comment: { body: a.descricao },
          ...(a.prioridade ? { priority: PRIORIDADE[String(a.prioridade)] } : {}),
          ...(temSolicitante(a) ? { requester: { email: umEmail('solicitante', a.solicitante), ...(a.nome_solicitante ? { name: a.nome_solicitante } : {}) } } : {}),
          ...responsavelDe(a.responsavel),
          ...(a.grupo ? { group_id: numero('grupo', a.grupo) } : {}),
        },
      }),
      texto: 'Chamado criado: #{ticket.id}.',
    },
  ],
};
