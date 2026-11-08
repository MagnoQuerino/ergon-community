/**
 * Freshdesk, com a chave de API de um atendente. Conferido na documentação oficial em 05/11/2026:
 * developers.freshdesk.com/api (autenticação chave:X; erros com code; page e per_page, até 100; Create, View, List, Filter e Update de chamado;
 * Reply, Create a Note e conversas; "Currently Authenticated Agent" em GET /agents/me e "List All Agents" em GET /agents)
 * support.freshdesk.com/support/solutions/articles/215517 (onde achar a chave)
 * support.freshdesk.com/support/solutions/articles/220676 (avisos ao cliente: chamado criado, resolvido e fechado)
 *
 * Não conferido na página oficial, que não abriu por inteiro: o formato da resposta de /agents/me e /agents (`contact.name`, `contact.email`).
 * Por isso a leitura desses campos tolera a falta deles.
 * A paginação usa o cabeçalho Link, que o motor não entrega: a próxima página é calculada aqui, pelo total ou pela página cheia.
 * Não há menção em massa documentada. O corpo é HTML: o texto é escapado, e nada de quem escreve vira etiqueta.
 */
import { neutral } from '../../operations.ts';
import { dia, emails, ErroAcao, seg, type Acao, type Args, type CtxAcao, type Param } from '../tipos.ts';
import { hostSeguro, linhaDe, type ConectorDef, type Credenciais } from './declarativo.ts';

const SITUACAO: Record<string, number> = { aberto: 2, pendente: 3, resolvido: 4, fechado: 5 };
const PRIORIDADE: Record<string, number> = { baixa: 1, media: 2, alta: 3, urgente: 4 };
const nomeDe = (m: Record<string, number>, n: unknown): unknown => Object.entries(m).find(([, v]) => v === n)?.[0] ?? n;

/** Aceita "empresa", "empresa.freshdesk.com" ou o endereço colado: a chave só vai a um subdomínio do Freshdesk. */
const hostDe = (c: Credenciais): string => {
  const v = String(c.dominio ?? '').trim();
  return hostSeguro(v.includes('.') ? v : `${v}.freshdesk.com`, /^[a-z0-9-]+\.freshdesk\.com$/).replace(/:\d+$/, '');
};

/** O Freshdesk lê o corpo como HTML: sem isto, quebras de linha somem e "<" some com o texto. */
const html = (t: unknown): string => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\r?\n/g, '<br>');

const numero = (nome: string, v: unknown): number => {
  const s = String(v).trim();
  if (!/^\d+$/.test(s)) throw new ErroAcao(`"${nome}" precisa ser um número`);
  return Number(s);
};

/** O que vai ao cliente aparece inteiro no cartão de confirmação: o assunto vem antes, e um assunto enorme empurraria o fim do texto para fora dele. */
const MAX_ENVIO = 5000;
const MAX_ASSUNTO = 500;
const P_CHAMADO: Param = { tipo: 'texto', obrigatorio: true, descricao: 'número do chamado' };
/** Um único endereço: o resumo mostra o que foi escrito, e o corpo não pode levar só parte disso. */
const umEmail = (nome: string, v: unknown): string => {
  const l = emails({ [nome]: v }, nome, 2);
  if (l.length !== 1) throw new ErroAcao(`"${nome}" precisa ser um único e-mail`);
  return l[0];
};
const temSolicitante = (a: Args): boolean => String(a.solicitante ?? '').trim() !== '';
/** Resolvido e fechado podem mandar um e-mail automático ao cliente: a conta decide, e a documentação não diz o padrão. */
const avisaCliente = (a: Args): boolean => ['resolvido', 'fechado'].includes(String(a.situacao ?? ''));
/** O Freshdesk tem aviso por e-mail ao atendente que recebe o chamado e a todos do grupo que recebe (artigo 220676). */
const avisaEquipe = (a: Args): boolean => ['responsavel', 'grupo'].some((k) => String(a[k] ?? '').trim() !== '');

const pagina = (a: Args): number => (a.cursor ? numero('cursor', a.cursor) : 1);
/** O cursor errado é recusado antes de chamar o serviço. */
const conferirCursor = async (_ctx: CtxAcao, a: Args): Promise<Args> => { pagina(a); return a; };
/** Página cheia indica que pode haver mais. */
const paginaCheia = (j: any, a: Args): string | null => (Array.isArray(j) && j.length >= Number(a.limite) ? String(pagina(a) + 1) : null);

const linhaChamado = (x: any): string => linhaDe('#{id} [{situacao}, prioridade {prioridade}] {subject} (solicitante {requester_id}, responsável {responder_id}, grupo {group_id}, atualizado em {updated_at})', { ...x, situacao: nomeDe(SITUACAO, x.status), prioridade: nomeDe(PRIORIDADE, x.priority) });

/** O cartão de confirmação diz o assunto do chamado e quem é o cliente: o agente só tem o número. */
const CARTAO_DO_CHAMADO: Acao['preparar'] = async (ctx, a) => {
  const t = await ctx.http(`/tickets/${seg(a.chamado)}?include=requester`, { method: 'GET', kind: 'read' });
  const u = t?.requester;
  const cliente = u?.name || u?.email ? [u.name, u.name && u.email ? `(${u.email})` : u.email].filter(Boolean).join(' ') : `número ${t?.requester_id ?? 'desconhecido'}`;
  return { detalhe: `Assunto: ${neutral(String(t?.subject || 'sem assunto'), 200)}\nCliente: ${neutral(cliente, 200)}` };
};

const historico = (j: any, a: Args): string => {
  const t = a._chamado as any;
  const cab = t ? `${linhaDe('Chamado #{id}: {subject}. Situação: {situacao}. Prioridade: {prioridade}. Solicitante: {requester.name} {requester.email}. Responsável: {responder_id}. Grupo: {group_id}. Atualizado em {updated_at}.', { ...t, situacao: nomeDe(SITUACAO, t.status), prioridade: nomeDe(PRIORIDADE, t.priority) })}\n${linhaDe('Pedido inicial: {description_text}', t, 4000)}\n` : '';
  const itens: any[] = Array.isArray(j) ? j : [];
  const linhas = itens.map((c) => `- ${linhaDe('{created_at} {quem} [{tipo}]: {body_text}', { ...c, quem: c.from_email ?? c.user_id, tipo: c.private ? 'nota interna' : c.incoming ? 'do cliente' : 'resposta pública' }, 4000)}`);
  return cab + (linhas.length ? linhas.join('\n') : 'sem conversas');
};

const meuEmail = async (ctx: CtxAcao): Promise<string> => {
  const eu = await ctx.http('/agents/me');
  const email = eu?.contact?.email ?? eu?.email;
  if (!email) throw new ErroAcao('não consegui saber o seu e-mail no Freshdesk: diga o "solicitante"');
  return String(email);
};

export const FRESHDESK: ConectorDef = {
  kind: 'freshdesk', nome: 'Freshdesk', site: 'freshdesk.com', grupo: 'suporte',
  sobre: 'Chamados do Freshdesk: os agentes buscam, leem o histórico, deixam notas internas, mudam a situação e o responsável, abrem chamados e respondem ao cliente.',
  campos: [
    { name: 'dominio', label: 'Domínio do Freshdesk', placeholder: 'suaempresa (de suaempresa.freshdesk.com)' },
    { name: 'chave', label: 'Chave de API', secret: true, placeholder: 'Cole a chave aqui' },
  ],
  ajuda: {
    url: 'https://support.freshdesk.com/support/solutions/articles/215517-how-to-find-your-api-key',
    passos: 'Entre no Freshdesk com a conta de um atendente que possa responder chamados: a chave tem as mesmas permissões dessa conta. Clique na sua foto, no canto superior direito, e escolha Profile Settings. No painel da direita, clique em View API key e resolva o captcha. Copie a chave e cole aqui. O domínio é a primeira parte do endereço: suaempresa, de suaempresa.freshdesk.com. Se a chave não aparecer, o seu plano pode não incluir este acesso.',
  },
  base: (c) => `https://${hostDe(c)}/api/v2`,
  auth: { tipo: 'basic', usuario: (c) => c.chave, senha: () => 'X' },
  erroNoCorpo: (j) => {
    if (!j || typeof j !== 'object' || Array.isArray(j) || j.id !== undefined) return null;
    const e = Array.isArray(j.errors) ? j.errors[0] : j;
    if (!e?.code) return null;
    const detalhe = [e.code, e.message].filter(Boolean).join(': ');
    return { mensagem: detalhe, permissao: /invalid_credentials|access_denied|require_feature/.test(String(e.code)) };
  },
  quemSou: { caminho: '/agents/me', nome: (j) => String(j.contact?.name ?? j.contact?.email ?? j.email ?? 'conta do Freshdesk'), id: (j) => j.id },
  acoes: [
    {
      id: 'freshdesk.buscar', descricao: 'filtra chamados por situação, prioridade, responsável, grupo, etiqueta ou data. O Freshdesk não busca por palavras do texto', risco: 'ler',
      params: {
        situacao: { tipo: 'texto', descricao: 'situação do chamado', opcoes: Object.keys(SITUACAO) },
        prioridade: { tipo: 'texto', descricao: 'prioridade', opcoes: Object.keys(PRIORIDADE) },
        responsavel: { tipo: 'texto', descricao: 'número do atendente: veja em freshdesk.atendentes' },
        grupo: { tipo: 'texto', descricao: 'número do grupo' },
        etiqueta: { tipo: 'texto', descricao: 'uma etiqueta do chamado' },
        atualizado_desde: { tipo: 'texto', descricao: 'data no formato AAAA-MM-DD' },
        filtro: { tipo: 'texto', descricao: "filtro do Freshdesk, sem aspas duplas, como (status:2 OR status:3) AND tag:'vip'" },
      },
      resumo: 'buscar chamados no Freshdesk', metodo: 'GET', caminho: '/search/tickets', consulta: { query: '{_consulta}' },
      antes: async (_ctx, a) => {
        const partes: string[] = [];
        if (a.situacao) partes.push(`status:${SITUACAO[String(a.situacao)]}`);
        if (a.prioridade) partes.push(`priority:${PRIORIDADE[String(a.prioridade)]}`);
        if (a.responsavel) partes.push(`agent_id:${numero('responsavel', a.responsavel)}`);
        if (a.grupo) partes.push(`group_id:${numero('grupo', a.grupo)}`);
        if (a.etiqueta) {
          if (/['"]/.test(String(a.etiqueta))) throw new ErroAcao('"etiqueta" não pode ter aspas');
          partes.push(`tag:'${String(a.etiqueta)}'`);
        }
        const desde = dia(a, 'atualizado_desde');
        if (desde) partes.push(`updated_at:>'${desde}'`);
        if (a.filtro) {
          if (String(a.filtro).includes('"')) throw new ErroAcao('"filtro" não pode ter aspas duplas');
          partes.push(`(${String(a.filtro)})`);
        }
        if (!partes.length) throw new ErroAcao('diga ao menos um filtro: situacao, prioridade, responsavel, grupo, etiqueta, atualizado_desde ou filtro');
        const consulta = `"${partes.join(' AND ')}"`;
        if (consulta.length > 512) throw new ErroAcao('o filtro passou de 512 caracteres, o máximo do Freshdesk');
        pagina(a);
        return { ...a, _consulta: consulta };
      },
      lista: 'results', linha: linhaChamado, paramCursor: 'page',
      // 30 por página e até 10 páginas, segundo a documentação
      proximo: (j, a) => { const n = pagina(a); return n < 10 && n * 30 < Number(j.total ?? 0) ? String(n + 1) : null; },
    },
    {
      id: 'freshdesk.listar', descricao: 'lista chamados, do mais recente ao mais antigo; dá para pedir os de um cliente. Sem "atualizado_desde", o Freshdesk mostra só os criados nos últimos 30 dias', rotulo: 'lista chamados, do mais recente ao mais antigo; dá para pedir os de um cliente', risco: 'ler',
      params: {
        solicitante: { tipo: 'texto', descricao: 'e-mail do cliente' },
        atualizado_desde: { tipo: 'texto', descricao: 'data e hora, como 2026-01-19T02:00:00Z' },
        limite: { tipo: 'numero', descricao: 'chamados por página, até 100 (padrão 30)', padrao: 30, max: 100 },
      },
      resumo: 'listar chamados do Freshdesk', metodo: 'GET', caminho: '/tickets',
      consulta: { email: '{solicitante}', updated_since: '{atualizado_desde}', order_by: 'updated_at', order_type: 'desc', per_page: '{limite}' },
      antes: conferirCursor, lista: '', linha: linhaChamado, proximo: paginaCheia, paramCursor: 'page',
    },
    {
      id: 'freshdesk.ler', descricao: 'lê um chamado com o histórico: mensagens do cliente, respostas e notas internas, marcadas', risco: 'ler',
      params: { chamado: P_CHAMADO, limite: { tipo: 'numero', descricao: 'mensagens por página, até 100 (padrão 100)', padrao: 100, max: 100 } },
      resumo: 'ler o chamado #{chamado} do Freshdesk', metodo: 'GET', caminho: '/tickets/{chamado}/conversations', consulta: { per_page: '{limite}' },
      antes: async (ctx, a) => {
        if (!a.chamado) throw new ErroAcao('falta "chamado"');
        pagina(a);
        return a.cursor ? a : { ...a, _chamado: await ctx.http(`/tickets/${seg(a.chamado)}?include=requester`) };
      },
      texto: historico, proximo: paginaCheia, paramCursor: 'page',
    },
    {
      id: 'freshdesk.atendentes', descricao: 'lista os atendentes, com o número de cada um: serve para escolher o responsável', risco: 'ler',
      params: { limite: { tipo: 'numero', descricao: 'atendentes por página, até 100 (padrão 100)', padrao: 100, max: 100 } },
      resumo: 'listar os atendentes do Freshdesk', metodo: 'GET', caminho: '/agents', consulta: { per_page: '{limite}' }, antes: conferirCursor,
      lista: '', linha: '{contact.name} {contact.email} (número: {id})', proximo: paginaCheia, paramCursor: 'page',
    },
    {
      id: 'freshdesk.responder', descricao: 'responde ao cliente no chamado: o cliente recebe', risco: 'enviar',
      params: { chamado: P_CHAMADO, texto: { tipo: 'texto', obrigatorio: true, descricao: 'a resposta, em texto puro, até 5000 caracteres', max: MAX_ENVIO } },
      resumo: 'Responder ao cliente no chamado #{chamado} do Freshdesk. O cliente recebe:\n{texto}', preparar: CARTAO_DO_CHAMADO, metodo: 'POST', caminho: '/tickets/{chamado}/reply',
      corpo: (a: Args) => ({ body: html(a.texto) }), texto: 'Resposta enviada no chamado #{chamado} (id: {id}).',
    },
    {
      id: 'freshdesk.nota', descricao: 'deixa uma nota interna no chamado: só a equipe vê', risco: 'organizar',
      params: { chamado: P_CHAMADO, texto: { tipo: 'texto', obrigatorio: true, descricao: 'a nota, em texto puro, até 5000 caracteres', max: MAX_ENVIO } },
      resumo: 'Deixar uma nota interna no chamado #{chamado} do Freshdesk (o cliente não vê):\n{texto}', preparar: CARTAO_DO_CHAMADO, metodo: 'POST', caminho: '/tickets/{chamado}/notes',
      corpo: (a: Args) => ({ body: html(a.texto), private: true }), texto: 'Nota interna registrada no chamado #{chamado} (id: {id}).',
    },
    {
      id: 'freshdesk.atualizar', descricao: 'muda a situação, a prioridade, o responsável ou o grupo de um chamado. Resolver ou fechar pode mandar um e-mail automático ao cliente; mudar o responsável ou o grupo pode avisar quem recebe', risco: (a) => (avisaCliente(a) || avisaEquipe(a) ? 'enviar' : 'organizar'),
      params: {
        chamado: P_CHAMADO,
        situacao: { tipo: 'texto', descricao: 'nova situação', opcoes: Object.keys(SITUACAO) },
        prioridade: { tipo: 'texto', descricao: 'nova prioridade', opcoes: Object.keys(PRIORIDADE) },
        responsavel: { tipo: 'texto', descricao: 'número do atendente: veja em freshdesk.atendentes' },
        grupo: { tipo: 'texto', descricao: 'número do grupo' },
      },
      resumo: (a) => {
        const m = [a.situacao && `situação para ${String(a.situacao)}`, a.prioridade && `prioridade para ${String(a.prioridade)}`, a.responsavel && `responsável para ${String(a.responsavel)}`, a.grupo && `grupo para ${String(a.grupo)}`].filter(Boolean);
        return `Mudar o chamado #${String(a.chamado)} do Freshdesk: ${m.join('; ') || 'nada informado'}${avisaCliente(a) ? '. O Freshdesk pode avisar o cliente por e-mail.' : ''}${avisaEquipe(a) ? '. O Freshdesk pode avisar por e-mail o responsável ou o grupo.' : ''}`;
      },
      preparar: CARTAO_DO_CHAMADO, metodo: 'PUT', caminho: '/tickets/{chamado}',
      corpo: (a: Args) => {
        const mudanca = {
          ...(a.situacao ? { status: SITUACAO[String(a.situacao)] } : {}),
          ...(a.prioridade ? { priority: PRIORIDADE[String(a.prioridade)] } : {}),
          ...(a.responsavel ? { responder_id: numero('responsavel', a.responsavel) } : {}),
          ...(a.grupo ? { group_id: numero('grupo', a.grupo) } : {}),
        };
        if (!Object.keys(mudanca).length) throw new ErroAcao('diga o que mudar: situacao, prioridade, responsavel ou grupo');
        return mudanca;
      },
      texto: 'Chamado #{chamado} atualizado.',
    },
    {
      id: 'freshdesk.criar', descricao: 'cria um chamado. Sem "solicitante", fica em seu nome. Com "solicitante", o Freshdesk pode avisar essa pessoa por e-mail; com responsável ou grupo, pode avisar quem recebe', rotulo: 'cria um chamado, em seu nome ou de quem pediu. O Freshdesk pode avisar por e-mail quem pediu, o responsável ou o grupo', risco: (a) => (temSolicitante(a) || avisaEquipe(a) ? 'enviar' : 'organizar'),
      params: {
        assunto: { tipo: 'texto', obrigatorio: true, descricao: 'assunto do chamado, até 500 caracteres', max: MAX_ASSUNTO },
        descricao: { tipo: 'texto', obrigatorio: true, descricao: 'o que aconteceu, em texto puro, até 5000 caracteres', max: MAX_ENVIO },
        solicitante: { tipo: 'texto', descricao: 'e-mail do cliente, se o chamado for em nome dele' },
        situacao: { tipo: 'texto', descricao: 'situação inicial (padrão aberto)', opcoes: Object.keys(SITUACAO), padrao: 'aberto' },
        prioridade: { tipo: 'texto', descricao: 'prioridade (padrão baixa)', opcoes: Object.keys(PRIORIDADE), padrao: 'baixa' },
        responsavel: { tipo: 'texto', descricao: 'número do atendente: veja em freshdesk.atendentes' },
        grupo: { tipo: 'texto', descricao: 'número do grupo' },
      },
      resumo: (a) => `${temSolicitante(a) ? `Criar um chamado no Freshdesk em nome de ${String(a.solicitante)}. O Freshdesk pode avisar essa pessoa por e-mail.` : 'Criar um chamado no Freshdesk, em seu nome.'}${avisaEquipe(a) ? ' O Freshdesk pode avisar por e-mail o responsável ou o grupo.' : ''}\nAssunto: ${String(a.assunto)}\n${String(a.descricao)}`,
      metodo: 'POST', caminho: '/tickets',
      antes: async (ctx, a) => ({ ...a, _email: temSolicitante(a) ? umEmail('solicitante', a.solicitante) : await meuEmail(ctx) }),
      corpo: (a: Args) => ({
        subject: a.assunto, description: html(a.descricao), email: a._email,
        status: SITUACAO[String(a.situacao)], priority: PRIORIDADE[String(a.prioridade)],
        ...(a.responsavel ? { responder_id: numero('responsavel', a.responsavel) } : {}),
        ...(a.grupo ? { group_id: numero('grupo', a.grupo) } : {}),
      }),
      texto: 'Chamado criado: #{id}.',
    },
  ],
};
