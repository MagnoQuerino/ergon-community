/**
 * Jira Cloud: escrita nos projetos pela API v3. Referências (conferidas em nov/2026):
 *   https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json (issue, issue/{key}, transitions, comment, createmeta, IssueTransition, FieldMetadata)
 *   https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/ e .../document/nodes/text/ (ADF: texto nunca vazio)
 *   https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/ (e-mail:token em Basic, no endereço do site)
 *   https://support.atlassian.com/atlassian-account/docs/manage-api-tokens-for-your-atlassian-account/ (token com escopos só vale em api.atlassian.com)
 * Inverso da leitura em JiraProvider (task-providers.ts): tarefa = chave ("PROJ-1"); coluna = id da situação; concluída =
 * categoria "done" da situação; prazo = duedate; descrição em ADF. Situação só muda por transição do fluxo: quem decide o
 * que é possível é o Jira, e cada tarefa pode oferecer transições diferentes.
 */
import { fold } from '../../../lib/util.ts';
import { ProviderError } from '../../mirror.ts';
import { neutral } from '../../operations.ts';
import { DONE, jiraHost, recusado, request } from '../../task-providers.ts';
import { ErroAcao, seg, type EscritorTarefas, type Escrita } from '../tipos.ts';

/** coluna sintética de projeto sem situações (ver getBoard) */
const UMA_COLUNA = '__tarefas__';

/** Texto simples em ADF: um parágrafo por linha. Linha vazia sai porque o ADF não aceita texto vazio (e a leitura já separa os parágrafos). */
const adf = (texto: string) => ({ type: 'doc', version: 1, content: texto.split(/\r?\n/).filter((l) => l.trim()).map((l) => ({ type: 'paragraph', content: [{ type: 'text', text: l }] })) });
/** O resumo do Jira é uma linha só, de até 255 caracteres. */
const umaLinha = (s: string) => s.replace(/\s*[\r\n]+\s*/g, ' ').trim().slice(0, 255);

interface Status { id: string; nome: string; categoria: string }
interface Transicao { id: string; nome: string; paraId: string; paraNome: string; categoria: string; exige: string[] }
const paraOpcoes = (ts: Transicao[]) => [...new Set(ts.map((t) => neutral(t.paraNome, 60)))];
/** A que não pede campo na tela do Jira, se houver. */
const melhor = (ts: Transicao[]): Transicao => ts.find((t) => !t.exige.length) ?? ts[0];
const semCaminho = (texto: string, ts: Transicao[]) => new ErroAcao(
  `${texto}. ${ts.length ? `Transições disponíveis: ${paraOpcoes(ts).join(', ')}` : 'Nenhuma transição disponível para esta conta (pode faltar a permissão "Transition issues")'}`, paraOpcoes(ts));

export function escritorJira(site: string, email: string, token: string): EscritorTarefas {
  const host = jiraHost(site);
  /** Endereço inválido falha ao usar, como erro de ação: a fábrica roda fora do tratamento de erro de quem envia. */
  const api = (caminho: string): string => {
    if (!host) throw new ErroAcao('endereço do Jira inválido (use sua-empresa.atlassian.net)');
    return `https://${host}/rest/api/3${caminho}`;
  };
  const auth = { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` };
  const ler = (caminho: string): Promise<any> => request(api(caminho), { headers: auth });
  const escrever = async (method: 'POST' | 'PUT', caminho: string, body: unknown): Promise<any> => {
    try { return await request(api(caminho), { method, headers: auth, body, kind: 'write' }); } catch (e) {
      if (recusado(e)) throw new ErroAcao(`o Jira recusou o pedido (o projeto pode exigir outros campos, ou o campo não está na tela deste tipo de tarefa): ${neutral((e as Error).message, 240)}`);
      throw e;
    }
  };
  const escrita = (tarefa: string): Escrita => ({ id: tarefa, versao: null, url: `https://${host}/browse/${seg(tarefa)}` });
  const situacao = async (tarefa: string): Promise<any> => (await ler(`/issue/${seg(tarefa)}?fields=status`)).fields?.status ?? {};
  const transicoes = async (tarefa: string): Promise<Transicao[]> =>
    (((await ler(`/issue/${seg(tarefa)}/transitions?expand=transitions.fields`)).transitions ?? []) as any[]).filter((t) => t.isAvailable !== false).map((t) => ({
      id: String(t.id), nome: String(t.name ?? ''), paraId: String(t.to?.id ?? ''), paraNome: String(t.to?.name ?? ''), categoria: String(t.to?.statusCategory?.key ?? ''),
      exige: Object.values((t.fields ?? {}) as Record<string, any>).filter((f) => f.required === true && f.hasDefaultValue !== true).map((f) => String(f.name ?? f.key)),
    }));
  const transitar = async (tarefa: string, t: Transicao): Promise<void> => {
    try { await request(api(`/issue/${seg(tarefa)}/transitions`), { method: 'POST', headers: auth, body: { transition: { id: t.id } }, kind: 'write' }); } catch (e) {
      if (recusado(e)) throw new ErroAcao(`o Jira recusou a transição "${neutral(t.nome, 60)}"${t.exige.length ? `: ela pede ${t.exige.map((c) => neutral(c, 40)).join(', ')}` : ''}. Faça essa mudança no próprio Jira`);
      throw e;
    }
  };
  const statusDoProjeto = async (projeto: string): Promise<Status[]> => {
    const vistos = new Map<string, Status>();
    for (const it of (await ler(`/project/${seg(projeto)}/statuses`)) as any[]) for (const s of it.statuses ?? []) vistos.set(String(s.id), { id: String(s.id), nome: String(s.name), categoria: String(s.statusCategory?.key ?? '') });
    return [...vistos.values()];
  };
  const nomeDaColuna = async (projeto: string, coluna: string): Promise<string> => {
    try { return (await statusDoProjeto(projeto)).find((s) => s.id === coluna)?.nome ?? coluna; } catch { return coluna; }
  };
  /** Já na situação pedida não faz nada: repetir dá no mesmo. */
  const moverPara = async (projeto: string, tarefa: string, coluna: string, lida?: any): Promise<void> => {
    const agora = lida ?? await situacao(tarefa);
    const f = fold(coluna);
    if (String(agora.id ?? '') === coluna || fold(String(agora.name ?? '')) === f) return;
    const ts = await transicoes(tarefa);
    const alvo = ts.filter((t) => t.paraId === coluna || fold(t.paraNome) === f);
    if (!alvo.length) throw semCaminho(`o Jira não oferece caminho de "${neutral(String(agora.name ?? ''), 60)}" para "${neutral(await nomeDaColuna(projeto, coluna), 60)}" nesta tarefa`, ts);
    await transitar(tarefa, melhor(alvo));
  };
  /** O tipo comum do projeto: "Task" ou "Tarefa"; senão, o primeiro do nível padrão (nem subtarefa, nem épico). */
  const tipoDeTarefa = async (projeto: string): Promise<string> => {
    const tipos = (((await ler(`/issue/createmeta/${seg(projeto)}/issuetypes?maxResults=200`)).issueTypes ?? []) as any[]).filter((t) => t.subtask !== true);
    const t = tipos.find((x) => /^(task|tarefa)$/i.test(String(x.name))) ?? tipos.find((x) => x.hierarchyLevel === 0) ?? tipos[0];
    if (!t) throw new ErroAcao(`não há tipo de tarefa que esta conta possa criar no projeto ${neutral(projeto, 20)} (pode faltar a permissão "Create issues")`);
    return String(t.id);
  };
  return {
    async criar(quadro, t) {
      // confere a coluna antes de criar: depois, um erro não desfaz a tarefa
      let destino: Status | null = null;
      if (t.coluna && t.coluna !== UMA_COLUNA) {
        const todos = await statusDoProjeto(quadro);
        const f = fold(t.coluna);
        destino = todos.find((s) => s.id === t.coluna || fold(s.nome) === f) ?? null;
        if (!destino) throw new ErroAcao(`este projeto não tem a situação "${neutral(t.coluna, 60)}"`, todos.map((s) => neutral(s.nome, 60)));
      }
      const j = await escrever('POST', '/issue', { fields: {
        project: { key: quadro }, summary: umaLinha(t.titulo), issuetype: { id: await tipoDeTarefa(quadro) },
        ...(t.descricao?.trim() ? { description: adf(t.descricao) } : {}), ...(t.prazo ? { duedate: t.prazo } : {}),
      } });
      const chave = String(j?.key ?? j?.id ?? '');
      if (!chave) throw new ProviderError('unavailable', 'o Jira não confirmou a criação (pode ter feito ou não): confira lá antes de repetir');
      if (destino) {
        // nada de repetir daqui em diante: a tarefa já existe, e tentar de novo criaria outra
        try {
          const inicial = await situacao(chave);
          try { await moverPara(quadro, chave, destino.id, inicial); } catch (e) {
            // a primeira coluna vem sempre (tasks.ts) e o fluxo pode começar em outra de "a fazer": a tarefa está onde deveria, e a leitura mostra em qual
            if (destino.categoria !== 'new' || String(inicial.statusCategory?.key ?? '') !== 'new') throw e;
          }
        } catch (e) {
          throw new ErroAcao(`a tarefa ${chave} foi criada, mas não foi para "${neutral(destino.nome, 60)}": ${neutral(e instanceof Error ? e.message : String(e), 400)}. Não crie de novo: ela já existe`, e instanceof ErroAcao ? e.opcoes : undefined, escrita(chave));
        }
      }
      return escrita(chave);
    },
    async concluir(_quadro, tarefa, feita) {
      if ((String((await situacao(tarefa)).statusCategory?.key ?? '') === 'done') === feita) return escrita(tarefa);
      const ts = await transicoes(tarefa);
      if (feita) {
        const prontas = ts.filter((t) => t.categoria === 'done');
        if (!prontas.length) throw semCaminho('o Jira não oferece transição para uma situação de concluído nesta tarefa', ts);
        // "Cancelado" também é da categoria concluído: sem um nome claro de feito, a escolha é da pessoa
        const claras = prontas.filter((t) => DONE.test(t.paraNome));
        if (!claras.length && prontas.length > 1) throw new ErroAcao('há mais de uma situação de concluído nesta tarefa: diga para qual mover', paraOpcoes(prontas));
        await transitar(tarefa, melhor(claras.length ? claras : prontas));
      } else {
        const abertas = ts.filter((t) => t.categoria !== 'done');
        if (!abertas.length) throw semCaminho('o Jira não oferece transição para reabrir esta tarefa', ts);
        const novas = abertas.filter((t) => t.categoria === 'new');
        await transitar(tarefa, melhor(novas.length ? novas : abertas));
      }
      return escrita(tarefa);
    },
    async mover(quadro, tarefa, coluna) {
      if (coluna === UMA_COLUNA) return { id: tarefa };
      await moverPara(quadro, tarefa, coluna);
      return escrita(tarefa);
    },
    async editar(_quadro, tarefa, m) {
      // a leitura mostra "PROJ-1 · resumo": a chave não faz parte do resumo
      const prefixo = `${tarefa} · `;
      const fields = {
        ...(m.titulo !== undefined ? { summary: umaLinha(m.titulo.startsWith(prefixo) ? m.titulo.slice(prefixo.length) : m.titulo) } : {}),
        ...(m.descricao !== undefined ? { description: m.descricao.trim() ? adf(m.descricao) : null } : {}),
        ...(m.prazo !== undefined ? { duedate: m.prazo } : {}),
      };
      if (!Object.keys(fields).length) return { id: tarefa };
      await escrever('PUT', `/issue/${seg(tarefa)}`, { fields });
      return escrita(tarefa);
    },
    async comentar(_quadro, tarefa, texto) {
      if (!texto.trim()) throw new ErroAcao('o comentário está vazio');
      await escrever('POST', `/issue/${seg(tarefa)}/comment`, { body: adf(texto) });
    },
  };
}
