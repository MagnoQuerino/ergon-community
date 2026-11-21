// Área "visuais": os blocos visuais que os agentes mandam na conversa (métricas, gráficos, tabelas, enquetes, relatórios).
// Os arquivos da área estão em ../particao.ts; o passo a passo, em ../COMO-TRADUZIR.md. O conteúdo dos blocos (títulos,
// rótulos, valores) vem do agente; aqui ficam só as palavras da moldura.
import type { Area } from '../tipos.ts';

const visuais = {
  'montando': 'Montando o visual…',
  'invalido': 'Visual fora do formato: os dados em texto',

  // ——— o menu do bloco ———
  'menu.acoes': 'Ações do visual',
  'menu.baixarPng': 'Baixar PNG',
  'menu.verDados': 'Ver dados',
  'menu.esconderDados': 'Esconder dados',
  'menu.copiar': 'Copiar como texto',
  'menu.copiado': 'Copiado',
  'menu.naoGerou': 'Não deu para gerar.',
  'dados.titulo': 'Dados do gráfico',

  // ——— as fontes ———
  'fonte.titulo': 'Fonte',
  'fonte.titulos': 'Fontes',
  'fonte.chip': '{tipo}: {titulo}',
  'fonte.maisDica': { one: 'Mais {n} fonte', other: 'Mais {n} fontes' },
  'fonte.estimativa': 'Estimativa',
  'fonte.estimativaDica': 'O agente estimou: o dado não veio de uma fonte conferida',
  'fonte.tipo.conexao': 'Conexão',
  'fonte.tipo.documento': 'Documento',
  'fonte.tipo.site': 'Site',
  'fonte.tipo.calculo': 'Cálculo',
  'fonte.tipo.conversa': 'Conversa',

  // ——— métricas ———
  'kpi.subiu': 'subiu',
  'kpi.caiu': 'caiu',
  'kpi.meta': 'meta {valor}',
  'kpi.daMeta': '{pct} da meta',
  'kpi.serie': { one: 'Tendência de {n} ponto', other: 'Tendência de {n} pontos' },

  // ——— tabela, comparativo, ficha ———
  'tabela.total': 'Total',
  'tabela.ordenar': 'Ordenar por {coluna}',
  'tabela.mais': { one: 'Mostrar a linha', other: 'Mostrar todas ({n})' },
  'tabela.menos': 'Mostrar menos',
  'comparativo.recomendada': 'Recomendada',
  'comparativo.pros': 'Prós',
  'comparativo.contras': 'Contras',
  'ficha.parametro': 'Parâmetro',
  'ficha.valor': 'Valor',

  // ——— prazos, metas, listas ———
  'tempo.hoje': 'hoje',
  'tempo.estado.feito': 'Feito',
  'tempo.estado.em_dia': 'Em dia',
  'tempo.estado.atrasado': 'Atrasado',
  'tempo.estado.risco': 'Em risco',
  'tempo.estado.previsto': 'Previsto',
  'progresso.de': '{atual} de {meta}',
  'progresso.ate': 'até {data}',
  'checklist.feitos': { one: '{n} de {total} feito', other: '{n} de {total} feitos' },
  'checklist.estado.feito': 'feito',
  'checklist.estado.andamento': 'em andamento',
  'checklist.estado.pendente': 'pendente',
  'checklist.estado.bloqueado': 'bloqueado',
  'status.estado.ok': 'Ok',
  'status.estado.atencao': 'Atenção',
  'status.estado.erro': 'Fora',
  'status.estado.parado': 'Parado',
  'semaforo.cor.verde': 'Verde',
  'semaforo.cor.amarelo': 'Amarelo',
  'semaforo.cor.vermelho': 'Vermelho',
  'aviso.tom.info': 'Para saber',
  'aviso.tom.dica': 'Dica',
  'aviso.tom.alerta': 'Atenção',
  'aviso.tom.risco': 'Risco',
  'aviso.tom.sucesso': 'Feito',
  'matriz.esforco': 'Esforço',
  'matriz.impacto': 'Impacto',
  'matriz.q1': 'Ganhos rápidos',
  'matriz.q2': 'Grandes apostas',
  'matriz.q3': 'Tarefas de fundo',
  'matriz.q4': 'Evitar',

  // ——— enquete e decisão ———
  'enquete.votar': 'Votar em {opcao}',
  'enquete.votos': { zero: 'Nenhum voto ainda', one: '{n} voto', other: '{n} votos' },
  'enquete.deTotal': '{n} de {total} votaram',
  'enquete.naFrente': 'Na frente: {opcao}',
  'enquete.decisao': 'Decisão: {opcao} · {n} de {total} votos',
  'enquete.naoVotou': 'O voto não foi. Tente de novo.',
  'decisao.titulo': 'Decisão',
  'decisao.votos': { one: '{n} voto', other: '{n} votos' },
  'decisao.votosDe': '{n} de {total} votos',

  // ——— prévias ———
  'pessoa.email': 'Escrever',
  'pessoa.telefone': 'Ligar',
  'pessoa.site': 'Abrir o site',
  'galeria.abrir': 'Abrir a imagem: {legenda}',
  'link.abrir': 'Abrir em {site}',
  'arquivo.abrir': 'Abrir',
  'arquivo.paginas': { one: '{n} página', other: '{n} páginas' },
  'arquivo.abas': { one: '{n} aba', other: '{n} abas' },
  'arquivo.indisponivel': 'Prévia indisponível',
  'mapa.abrir': 'Abrir no mapa',
  'referencias.abrir': 'Abrir {titulo}',

  // ——— relatório ———
  'relatorio.semTitulo': 'Relatório',
  'relatorio.abrir': 'Abrir relatório',
  'relatorio.versao': 'v{n}',
  'relatorio.secoes': { one: '{n} seção', other: '{n} seções' },
} as const satisfies Area;

export default visuais;
