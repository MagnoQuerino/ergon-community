/**
 * A gestão pelo coordenador ligada aos serviços das outras frentes da rc.29 (gestao.ts, preparar e materializar): o que
 * o coordenador diz vira o que a rota da tela recebe, com as mesmas validações (as da própria rota, que roda depois) e o
 * mesmo cartão de aprovação.
 *  - Conexões com várias contas (multiconta, inclusive o GoHighLevel, que entra pelo mesmo modelo): "conta" pode ser o
 *    apelido, o e-mail ou o número; vira o id da conta (acharConta, o mesmo que o agente usa em conexoes_executar).
 *  - Conexões próprias (MCP próprio): app e conta (o apelido) viram o nome da conexão; as chaves nunca passam por aqui.
 *  - Competência enviada (loja): o arquivo que a pessoa mandou é lido no Ergon e passa pela mesma varredura do motor; o
 *    cartão diz o que a varredura achou; "barrada" não vira cartão, e "atenção" só entra se a pessoa aplicar o cartão.
 */
import type { Db } from '../db/db.ts';
import { clip, fold } from '../lib/util.ts';
import { openArtifact } from './artifacts.ts';
import { pacoteDoPedido } from './competencias.ts';
import type { AcaoGestao } from './gestao.ts';
import { acharConta, contasDe, nomeDaConta, nomeUnico } from './integrations.ts';
import type { McpProprios } from './mcp-proprio.ts';
import type { Recursos } from './recursos.ts';

type Params = Record<string, unknown>;
const CONTA_DA_ROTA = /^(|principal|nova|c[0-9a-f]{8})$/;
const ARQUIVO = /^art_[0-9a-f]{8,}$/;

export interface GestaoServicosDeps {
  db: Db; filesDir: string; apps: () => McpProprios; recursos: () => Recursos;
  /** a memória de um agente com o que espera aprovação (o cartão mostra o texto da anotação); null = ainda não pronta */
  memoria?: (ws: string, agentId: string) => Promise<{ pendentes: Array<{ id: string; alvo: string; itens: Array<{ acao: string; texto: string; antes: string }> }> } | null>;
}
const TRECHO = 6000;

/** O arquivo que a pessoa mandou, como o pedido da tela de competências: SKILL.md vira texto; .zip, o conteúdo compactado. */
function pedidoDoArquivo(d: GestaoServicosDeps, ws: string, arquivo: string): { texto?: string; zip?: string; nomeArquivo: string } {
  const a = openArtifact(d.db, d.filesDir, ws, arquivo);
  const zip = /\.zip$/i.test(a.filename) || /zip/i.test(a.mime);
  return zip ? { zip: Buffer.from(a.data).toString('base64'), nomeArquivo: a.filename } : { texto: Buffer.from(a.data).toString('utf8'), nomeArquivo: a.filename };
}

export function gestaoServicos(d: GestaoServicosDeps) {
  async function preparar(ws: string, a: AcaoGestao, entrada: Params): Promise<{ parametros: Params; nota?: string } | string> {
    const p: Params = { ...entrada };
    const notas: string[] = [];

    // ---- Conexões com várias contas: a conta pelo nome que a pessoa usa
    if (a.rota.includes(':kind') && typeof p.kind === 'string' && typeof p.conta === 'string' && !CONTA_DA_ROTA.test(p.conta)) {
      const contas = contasDe(d.db, ws, p.kind);
      const c = acharConta(contas, p.conta);
      if (!c) {
        const nomes = contas.map(nomeUnico(contas));
        return `Não achei a conta "${clip(p.conta, 60)}" deste aplicativo${nomes.length ? `. Contas: ${nomes.join(', ')}` : ' (ele não tem contas aqui)'}. Pergunte à pessoa qual é.`;
      }
      p.conta = c.conta || 'principal';
      // a posição da conta muda quando outra vira a principal: o cartão guarda a conta (o id), e o clique age nela
      p.integracao = c.id;
      notas.push(`Conta: ${nomeUnico(contas)(c)}${c.conta ? '' : ' (principal)'}.`);
    } else if (a.rota.includes(':kind') && typeof p.kind === 'string' && (p.conta === undefined || p.conta === '' || p.conta === 'principal') && contasDe(d.db, ws, p.kind).length > 1) {
      const principal = contasDe(d.db, ws, p.kind).find((x) => x.conta === '');
      if (principal) { p.integracao = principal.id; notas.push(`Conta: ${nomeDaConta(principal) || 'a principal'} (principal).`); }
      else notas.push('Conta: a principal.');
    } else if (a.rota.includes(':kind') && typeof p.kind === 'string' && typeof p.conta === 'string' && /^c[0-9a-f]{8}$/.test(p.conta)) {
      const c = contasDe(d.db, ws, p.kind).find((x) => x.conta === p.conta);
      if (c) p.integracao = c.id;
    }
    if (p.integracao !== undefined && typeof p.integracao !== 'string') delete p.integracao;

    // ---- workspace: só o da conversa (o coordenador de um workspace não mexe em outro)
    if (a.rota === '/api/workspaces/:id' && a.metodo !== 'GET') {
      if (p.id === undefined) p.id = ws;
      if (p.id !== ws) return 'A gestão vale só para o workspace desta conversa: para mudar outro workspace, peça ao coordenador dele (ou faça na tela).';
    }

    // ---- loja: a prévia e a verificação vão no cartão; o "vi" é a pessoa aplicando o cartão, nunca o coordenador
    if (a.rota === '/api/recursos/loja/instalar') {
      if (typeof p.id !== 'string' || !p.id.trim()) return 'Diga a competência da loja (id, como loja.ver mostra).';
      const id = p.id;
      const [v, pr] = await Promise.all([
        d.recursos().varredura(ws, id).catch(() => null) as Promise<{ politica?: string; resumo?: string; achados?: Array<{ gravidade?: string; descricao?: string }> } | null>,
        d.recursos().previa(ws, id).catch(() => null) as Promise<{ texto?: string; nome?: string; titulo?: string; origem?: string; confianca?: string } | null>,
      ]);
      if (v?.politica !== 'allow' && v?.politica !== 'ask' && v?.politica !== 'block') return 'A verificação de segurança não trouxe um resultado agora: nada foi pedido. Tente de novo daqui a pouco ou diga à pessoa para instalar pela loja na tela.';
      if (v.politica === 'block') return `A verificação de segurança barrou esta competência (${clip(v.resumo ?? '', 300)}). Ela não entra; conte isso à pessoa.`;
      p.vi = true;
      const achados = (v.achados ?? []).slice(0, 8).map((x) => `${x.gravidade ?? ''}: ${clip(String(x.descricao ?? ''), 160)}`);
      const origem = pr?.origem ?? pr?.confianca;
      notas.push(`Competência da loja: ${clip(String(pr?.titulo ?? pr?.nome ?? id), 120)}${origem ? ` (origem: ${clip(String(origem), 80)})` : ''}.`);
      notas.push(v.politica === 'ask'
        ? `A verificação de segurança pediu atenção: ${clip(v.resumo ?? '', 300)}${achados.length ? `\n${achados.map((x) => `  · ${x}`).join('\n')}` : ''}\nAplicar é aceitar esse risco.`
        : 'A verificação de segurança não achou nada de risco.');
      notas.push(typeof pr?.texto === 'string' && pr.texto.trim() ? `O texto da competência:\n${clip(pr.texto, TRECHO)}` : '(o texto da competência não veio agora: leia na loja antes de aplicar)');
    }

    // ---- aprovar o que um treinamento escreveu: o cartão mostra o que vai passar a valer
    if (a.rota === '/api/trainings/:id/decision') {
      const t = typeof p.id === 'string' ? d.db.get<{ title: string; status: string; draft: string | null; agente: string }>('SELECT t.title, t.status, t.draft, a.name AS agente FROM trainings t JOIN agents a ON a.id = t.agent_id WHERE t.id = ? AND t.workspace_id = ?', p.id, ws) : undefined;
      if (!t) return 'Não achei este treinamento. Veja os de um agente com competencias.ver.';
      if (t.status !== 'em_revisao') return `Este treinamento não espera decisão (está ${t.status.replace('_', ' ')}).`;
      let skill = '';
      try { skill = String((JSON.parse(t.draft ?? '{}') as Record<string, string>)['SKILL.md'] ?? ''); } catch { skill = ''; }
      notas.push(`Competência: ${t.title}, de ${t.agente}.`);
      if (p.decision === 'aprovar') notas.push(skill.trim() ? `O que passa a valer:\n${clip(skill, TRECHO)}` : '(sem o texto principal da competência: confira na aba Treinar do agente)');
    }

    // ---- anotação na memória de um agente: o texto dela vai no cartão
    if (a.rota === '/api/agents/:id/memoria/:pid' && d.memoria) {
      const mem = typeof p.id === 'string' ? await d.memoria(ws, p.id).catch(() => null) : null;
      const pend = mem?.pendentes.find((x) => x.id === p.pid);
      if (!pend) return 'Não achei esta anotação esperando aprovação. Veja com memoria.ver.';
      const itens = pend.itens.map((x) => `  · ${x.acao}${x.antes ? ` (antes: ${clip(x.antes, 400)})` : ''}: ${clip(x.texto, 1500)}`).join('\n');
      notas.push(`A anotação (${pend.alvo === 'pessoa' ? 'sobre você' : 'nas notas do agente'}):\n${itens || '  (vazia)'}`);
    }

    // ---- conexões próprias (servidor MCP próprio): cada conexão é uma conta do aplicativo
    const ehProprio = a.rota.startsWith('/api/recursos/apps-proprios') || a.rota.startsWith('/api/recursos/conectores/:nome');
    if (ehProprio && a.rota.includes(':nome') && typeof p.nome !== 'string' && typeof p.app === 'string') {
      const achado = d.apps().achar(ws, p.app, typeof p.conta === 'string' ? p.conta : null);
      if (!achado) {
        const daqui = d.apps().listar(ws).filter((x) => fold(x.app) === fold(String(p.app)));
        return daqui.length
          ? `O aplicativo ${clip(String(p.app), 60)} tem mais de uma conta: diga qual (${daqui.map((x) => x.apelido || (x.principal ? 'principal' : x.nome)).join(', ')}).`
          : `Não há conexão própria "${clip(String(p.app), 60)}". Veja as que existem com conector.proprio.ver.`;
      }
      p.nome = achado.nome;
      delete p.app; delete p.conta;
      notas.push(`Conexão: ${achado.app}${achado.apelido ? ` (${achado.apelido})` : ''}${achado.principal ? ', a conta principal' : ''}.`);
    }
    // remover uma conexão própria pela rota dos conectores prontos tiraria só o servidor do motor: a conta continuaria na
    // lista (e na política das ferramentas), sem promover outra a principal; a tela usa a rota dela, e a gestão também
    if (a.rota === '/api/recursos/conectores/:nome' && a.metodo === 'DELETE' && typeof p.nome === 'string' && d.apps().listar(ws).some((x) => x.nome === p.nome)) {
      return 'Esta é uma conexão própria: para desconectá-la use conector.proprio.remover (com o app e a conta, ou o mesmo nome).';
    }
    if (a.rota === '/api/recursos/apps-proprios' && a.metodo === 'POST') {
      const tem = (v: unknown) => !!v && typeof v === 'object' && Object.keys(v as Params).length > 0;
      // "$" no endereço ou nos argumentos seria trocado pela chave de outra conexão e mandado ao aplicativo
      if ((typeof p.endereco === 'string' && p.endereco.includes('$')) || (Array.isArray(p.argumentos) && p.argumentos.some((x) => typeof x === 'string' && x.includes('$')))) {
        return 'O endereço e os argumentos de um aplicativo não podem trazer referências a chaves ($): nada foi pedido. As chaves a pessoa completa na tela, em Conexões › Conectar outro aplicativo.';
      }
      if (tem(p.cabecalhos) || tem(p.variaveis)) {
        return 'As chaves de um aplicativo (cabeçalhos e variáveis) vão direto ao cofre pela tela, nunca pela gestão. Diga à pessoa para conectar em Conexões › Conectar outro aplicativo, onde ela cola a configuração e a chave.';
      }
      if (p.transporte === 'stdio') notas.push('Isto roda um programa dentro do ambiente da equipe, com o mesmo acesso dela: aplique só se você confia em quem o publicou.');
      notas.push('Ela começa só consultando; mudar dados só depois de você liberar a escrita, e enviar em seu nome pede o seu sim a cada vez.');
    }

    // ---- competência enviada: a mesma varredura da tela, antes do cartão
    if (a.rota === '/api/recursos/competencias/instalar') {
      // o que o cartão mostra e a verificação olha é o que entra: nada de um zip à parte, que a pessoa não leria
      if (p.zip !== undefined) return 'Mande a competência pelo identificador do arquivo que a pessoa enviou (arquivo) ou pelo texto do SKILL.md (texto), nunca o conteúdo compactado.';
      if (p.arquivo !== undefined) { delete p.texto; delete p.nomeArquivo; }
      if (p.arquivo !== undefined && (typeof p.arquivo !== 'string' || !ARQUIVO.test(p.arquivo))) return 'O arquivo da competência é o identificador do arquivo que a pessoa mandou nesta conversa.';
      if (p.arquivo === undefined && typeof p.texto !== 'string') return 'Mande a competência: o arquivo que a pessoa enviou (arquivo) ou o texto inteiro do SKILL.md (texto).';
      let pacote: ReturnType<typeof pacoteDoPedido>;
      const pedido = typeof p.arquivo === 'string' ? pedidoDoArquivo(d, ws, p.arquivo) : { texto: String(p.texto), nomeArquivo: typeof p.nomeArquivo === 'string' ? p.nomeArquivo : '' };
      try { pacote = pacoteDoPedido(pedido); } catch (e) { return `A competência não serve: ${clip(e instanceof Error ? e.message : String(e), 300)}. Conte à pessoa.`; }
      const v = await d.recursos().varrerEnvio(ws, pacote) as { veredito?: string; politica?: string; resumo?: string; achados?: Array<{ gravidade?: string; descricao?: string }> } | null;
      const achados = (v?.achados ?? []).slice(0, 8).map((x) => `${x.gravidade ?? ''}: ${clip(String(x.descricao ?? ''), 160)}`);
      // sem um resultado conhecido da verificação, o cartão não diria a verdade ("não achou nada"): nada de cartão
      if (v?.politica !== 'allow' && v?.politica !== 'ask' && v?.politica !== 'block') return 'A verificação de segurança não trouxe um resultado agora: nada foi pedido. Tente de novo daqui a pouco ou diga à pessoa para enviar pela tela de competências.';
      if (v?.politica === 'block') return `A verificação de segurança barrou esta competência (${clip(v.resumo ?? '', 300)}). Ela não entra; conte isso à pessoa.`;
      // o aceite do risco é a pessoa aplicando o cartão, que mostra o que a verificação achou (nunca o coordenador sozinho)
      p.riscoAceito = v?.politica === 'ask';
      if (typeof p.arquivo === 'string') notas.push(`Arquivo: ${pedido.nomeArquivo}.`);
      notas.push(`Competência: ${pacote.titulo || pacote.nome} (${Object.keys(pacote.arquivos).length} arquivo(s)).`);
      notas.push(v?.politica === 'ask'
        ? `A verificação de segurança pediu atenção: ${clip(v.resumo ?? '', 300)}${achados.length ? `\n${achados.map((x) => `  · ${x}`).join('\n')}` : ''}\nAplicar é aceitar esse risco.`
        : 'A verificação de segurança não achou nada de risco.');
    }
    return { parametros: p, ...(notas.length ? { nota: notas.join('\n') } : {}) };
  }

  /** O arquivo da competência entra no pedido só na hora de rodar (no cartão fica o identificador e o nome dele). */
  async function materializar(ws: string, a: AcaoGestao, corpo: Params): Promise<Params> {
    if (a.rota !== '/api/recursos/competencias/instalar' || typeof corpo.arquivo !== 'string') return corpo;
    const { arquivo, texto: _t, zip: _z, nomeArquivo: _n, ...resto } = corpo;
    return { ...resto, ...pedidoDoArquivo(d, ws, arquivo as string) };
  }

  /** Na hora de rodar: a conta guardada pelo id volta à posição de agora (outra pode ter virado a principal). */
  function naHora(ws: string, a: AcaoGestao, p: Params): Params | string {
    if (typeof p.integracao !== 'string') return p;
    const { integracao, ...resto } = p;
    const row = d.db.get<{ conta: string; kind: string }>('SELECT conta, kind FROM integrations WHERE id = ? AND workspace_id = ?', integracao, ws);
    if (!row || row.kind !== resto.kind) return 'A conta deste pedido mudou ou saiu do aplicativo: nada foi feito. Peça de novo.';
    // sem conta no pedido (a principal) e ela ainda é a principal: segue sem, como a tela manda
    if (a.rota.includes(':kind') && (resto.conta !== undefined || row.conta !== '')) resto.conta = row.conta || 'principal';
    return resto;
  }

  return { preparar, materializar, naHora };
}
