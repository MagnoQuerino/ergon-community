// Área "conexoes" em chinês simplificado (zh-CN): PARCIAL (a chave que falta vem do inglês). Tipada pelo português.
// REVISÃO POR NATIVO PENDENTE: tradução gerada na rc.44 a partir do inglês, com o glossário de ../GLOSSARIO.md;
// precisa da revisão de um falante nativo antes da versão final (COMO-TRADUZIR.md, "Chinês e hindi").
import type pt from '../pt/conexoes.ts';
import type { TraducaoParcial } from '../tipos.ts';

export const REVISAO_NATIVA_PENDENTE = true;

const conexoes: TraducaoParcial<typeof pt> = {
  'titulo': '连接',
  'intro': '为智能体提供动力的 AI 账户，以及团队代你使用的应用和渠道。凭据只保存在这台电脑上并加密；绝不会进入浏览器。',
  'acao.fechar': '关闭',
  'acao.cancelar': '取消',
  'acao.salvar': '保存',
  'acao.desligar': '关闭',
  'acao.conferindo': '正在核对…',
  'acao.autorizarDeNovo': '重新授权',
  'acao.outraConta': '换成另一个账户',
  'estado.off': '未连接',
  'estado.pending': '正在连接…',
  'estado.connected': '已连接',
  'estado.error': '需要处理',
  'estado.soon': '即将推出',
  'estado.indisponivel': '暂不可用',
  'estado.semConexao': '离线',
  'detalhes': '详情',
  'secao.tarefas.titulo': '任务和看板',
  'secao.tarefas.texto': '在“任务”中选择列表或看板：会双向同步。',
  'secao.conversas.titulo': '聊天和团队协作',
  'secao.conversas.texto': '智能体会读取账户能访问的内容，并在你要求时回复。',
  'secao.vendas.titulo': '销售和客服',
  'secao.vendas.texto': '客户、商机和工单：智能体会查询，并记录你们商定的内容。',
  'secao.documentos.titulo': '文档、代码和日历',
  'secao.documentos.texto': '凭据能访问的页面、代码仓库和日历。',
  'secao.financeiro.titulo': '财务',
  'secao.financeiro.texto': '按你的要求查询、管理客户和收款。这里不会付款或转账。',
  'ia.titulo': 'AI 账户',
  'ia.texto': '为智能体所用模型付费的账户。',
  'busca.placeholder': '搜索（例如 Slack、Trello、HubSpot）',
  'busca.aria': '搜索应用',
  'busca.todos': '全部（{n}）',
  'busca.conectados': '已连接（{n}）',
};

export default conexoes;
