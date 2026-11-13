/**
 * Os textos que o servidor manda para a tela, com CÓDIGO + VALORES ao lado do português (que continua indo, como
 * reserva). A tela traduz pelo código (web/src/i18n/<idioma>/servidor.ts, a área "servidor" do dicionário) e, quando
 * não conhece o código (o servidor é mais novo que a tela) ou o código não veio (o servidor é mais antigo), mostra o
 * português que veio junto: quem atualiza um lado antes do outro não quebra nada.
 *
 * Forma na resposta: o campo de sempre e, ao lado, o mesmo nome com "_t":
 *   { message: 'faça login', message_t: { codigo: 'erro.facaLogin' } }
 *   { faixa: { frase: 'Aguardando sua aprovação para enviar um e-mail…', frase_t: { codigo: 'resumo.frase.aprovarPara', valores: { … } } } }
 *
 * Os valores podem ser texto cru (nomes, títulos, o que o agente escreveu: não se traduz), número, outro Texto (que se
 * traduz também) ou uma lista (vira "a, b e c" / "a, b, and c" no idioma de quem lê). `forma`: a primeira letra
 * maiúscula ('maiuscula') e, em 'frase', também o ponto final.
 *
 * O português de cada código está aqui (TEXTOS) e, igual, em web/src/i18n/pt/servidor.ts; o teste da tela
 * (web/src/lib/textos-servidor.test.ts) confere que os dois são o mesmo texto.
 *
 * PRÓXIMOS PASSOS (ainda só em português, sem código; a tela em inglês mostra o português que veio):
 *  - o resumo dos cartões de aprovação que o servidor escreve (agent_proposals.summary: conexoes/servico.ts, o resumo
 *    de cada ação nas contas, acao.resumo) — aparece em "Aguardando você" e na conversa;
 *  - por isso também o grupo "outro" da faixa do card (resumo-tarefa.ts: cada()), que encaixa acao.resumo numa frase
 *    traduzida ("Criar contato … (done in HubSpot).");
 *  - o resultado das propostas que passam por ganchos de outros módulos (rotina, lançamentos, cards em lote, apagar de
 *    vez em Documentos) e o nome da ferramenta e o motivo do setor que entram nas frases de proposta.*;
 *  - o que ficou gravado antes (linhas antigas do histórico com frase diferente da do catálogo).
 */

export type Valor = string | number | Texto | readonly Valor[];
export interface Texto {
  readonly codigo: string;
  readonly valores?: Readonly<Record<string, Valor>>;
  readonly forma?: 'maiuscula' | 'frase';
}
type Msg = string | { readonly zero?: string; readonly one?: string; readonly other: string };

/** Erros das rotas (HttpError): reconhecidos pelo texto, no tratador de erros (app.ts), sem mudar quem os lança. */
const ERROS = {
  'erro.facaLogin': 'faça login',
  'erro.paginaDesatualizada': 'A página ficou desatualizada: recarregue e tente de novo.',
  'erro.telaTrancada': 'Tela trancada por inatividade: digite a senha para continuar.',
  'erro.digiteSenhaDados': 'Digite a sua senha para abrir os seus dados.',
  'erro.protejaErgon': 'Proteja o Ergon (senha e frase de recuperação) para continuar.',
  'erro.configure2fa': 'Configure um autenticador ou uma passkey para continuar.',
  'erro.confirmeIdentidade': 'Confirme a sua identidade para continuar.',
  'erro.somenteProprietario': 'somente o proprietário',
  'erro.somenteAdmin': 'somente quem administra o Ergon neste computador',
  'erro.origemNaoPermitida': 'origem não permitida',
  'erro.entreSites': 'requisição entre sites bloqueada',
  'erro.loginInvalido': 'usuário ou senha inválidos',
  'erro.senhaCurta': 'Use pelo menos {min} caracteres. Uma frase de 3 ou 4 palavras é fácil de lembrar e difícil de adivinhar.',
  'erro.senhaLonga': 'Senha longa demais (máximo de 200 caracteres).',
  'erro.fraseNaoConfere': 'frase de recuperação não confere',
  'erro.fraseOuUsuario': 'frase de recuperação ou usuário não conferem',
  'erro.fraseOutraConta': 'esta frase não é da conta informada',
  'erro.passkeyNaoReconhecida': 'passkey não reconhecida',
  'erro.passkeyNaoConfirmada': 'passkey não confirmada',
  'erro.senhaNaoAbriu': 'A senha confere, mas não abriu os dados desta conta. Use "Esqueci a senha" com a sua frase de recuperação.',
  'erro.reiniciouSenha': 'O Ergon reiniciou: digite a senha uma vez para abrir os seus dados.',
  'erro.reiniciouSenhaPasskey': 'O Ergon reiniciou: entre com a senha uma vez para abrir os seus dados. Depois, a passkey volta a bastar.',
  'erro.trancadoSenha': 'O Ergon está trancado: digite a senha para abrir.',
  'erro.trancadoContas': 'O Ergon está trancado: quem já tem conta precisa abrir antes.',
  'erro.semWorkspace': 'usuário sem workspace',
  'erro.workspaceNaoEncontrado': 'workspace não encontrado',
  'erro.agenteNaoEncontrado': 'agente não encontrado',
  'erro.naoEncontreAgente': 'não encontrei o agente "{nome}"',
  'erro.naoEncontreSetor': 'não encontrei o setor "{nome}"',
  'erro.cardNaoEncontrado': 'não encontrei esse card no quadro',
  'erro.cardNumeroNaoEncontrado': 'não encontrei o card #{numero} no quadro',
  'erro.tarefaNaoExiste': 'a tarefa não existe mais aqui',
  'erro.rotaNaoEncontrada': 'rota não encontrada',
  'erro.contaNaoEncontrada': 'conta não encontrada',
  'erro.propostaDecidida': 'esta proposta já foi decidida',
  'erro.pedidoDecidido': 'este pedido já foi decidido',
  'erro.pedidoRespondido': 'este pedido já foi respondido',
  'erro.perguntaRespondida': 'esta pergunta já foi respondida',
  'erro.acaoDecidida': 'esta ação já foi decidida',
  'erro.nadaEsperando': 'Nada esperando a sua decisão neste card.',
  'erro.jaDecidido': 'Já decidido noutro lugar: nada mudou agora.',
  'erro.tarefaConcluida': 'Esta tarefa já está concluída.',
  'erro.equipeTrabalhando': 'a equipe ainda está trabalhando neste card',
  'erro.orientarNaoAndando': 'Este trabalho não está em andamento agora: não há o que orientar.',
  'erro.orientarNaoAceitou': 'A equipe não recebeu a orientação agora. Tente de novo em instantes.',
  'erro.reservaForaDaConta': 'Esse modelo não está numa conta de IA conectada.',
  'erro.agenteTrabalhando': 'O agente já está trabalhando neste card.',
  'erro.agenteAindaTrabalhando': 'O agente ainda está trabalhando neste card: espere terminar.',
  'erro.rotinaExecutando': 'Esta rotina já está executando: espere terminar.',
  'erro.respostaEmAndamento': 'ainda há uma resposta em andamento nesta conversa',
  'erro.respostaEmAndamentoFila': 'Ainda há uma resposta em andamento nesta conversa: aguarde, cancele ou use Ctrl+Enter para pôr a mensagem na fila.',
  'erro.integracaoNaoConectada': 'integração não conectada',
  'erro.credencialAusente': 'credencial ausente: conecte de novo',
  'erro.conecteMicrosoft': 'Conecte a conta Microsoft primeiro: clique em "Entrar com a Microsoft".',
  'erro.nomeAgenteEmUso': 'Já existe um agente ativo chamado {nome}.',
  'erro.nomeSetorEmUso': 'Já existe um setor chamado {nome}.',
  'erro.compSemSkillMd': 'Não achei o arquivo principal da competência (SKILL.md).',
  'erro.compGrande': 'A competência tem {total} KB de texto; o limite é {limite} KB.',
  'erro.compVazia': 'Cole o texto da competência ou envie o arquivo SKILL.md.',
  'erro.compTextoGrande': 'O texto passa de {limite} KB.',
  'erro.compZipAbrir': 'Não consegui abrir o arquivo compactado.',
  'erro.compZipSemSkill': 'O arquivo compactado não tem um SKILL.md (o arquivo principal da competência).',
  'erro.compZipVarias': 'O arquivo compactado tem mais de uma competência no mesmo nível: envie uma de cada vez.',
  'erro.compAgenteAtivo': 'escolha um agente ativo desta equipe',
  'erro.compTreinarNoCartao': 'as competências do Treinar se removem no cartão delas',
  'erro.compTreinarLigar': 'as competências do Treinar se ligam e desligam no cartão delas',
  'erro.compVarreduraAtencao': 'a varredura de segurança achou pontos de atenção: marque que entendeu o risco para instalar',
  'erro.compVarreduraBarrou': 'a varredura de segurança barrou esta competência: ela não foi instalada',
  'erro.compNomeOcupado': 'já existe na equipe uma competência com este nome; dê outro nome à sua',
  'erro.compNaoRemove': 'esta competência já vem com a equipe e não pode ser removida: desligue-a nos agentes',
  'erro.compCabecalho': 'o cabeçalho da competência precisa do nome e da descrição',
  'erro.compNaoEncontrada': 'competência não encontrada',
  'erro.apelidoRepetido': 'Outra conta deste aplicativo já tem esse nome. Escolha outro.',
  'erro.principalSoConectada': 'Só uma conta conectada pode ser a principal.',
  'erro.appNome': 'dê um nome ao aplicativo (até 60 letras)',
  'erro.appNomeMontar': 'não consegui montar um nome para este aplicativo',
  'erro.appApelido': 'o apelido da conta tem até 40 letras',
  'erro.appIcone': 'ícone inválido',
  'erro.appProgramaOuEndereco': 'informe o programa OU o endereço, não os dois',
  'erro.appEnderecoOuPrograma': 'informe o endereço OU o programa, não os dois',
  'erro.appPrograma': 'programa inválido: só o nome (como npx ou uvx), sem espaços; o resto vai em argumentos',
  'erro.appArgumentos': 'argumentos inválidos (até 40, um por linha)',
  'erro.appCabecalhos': 'cabeçalhos valem só para endereço; num programa, use variáveis',
  'erro.appEndereco': 'endereço inválido: comece por https://',
  'erro.appVariaveis': 'variáveis valem só para programa; num endereço, use cabeçalhos',
  'erro.appChaves': 'chaves demais',
  'erro.appCabecalho': 'nome de cabeçalho inválido: {campo}',
  'erro.appVariavel': 'nome de variável inválido: {campo}',
  'erro.appValor': 'preencha o valor de {campo} (sem acentos)',
  'erro.appChave': 'este aplicativo não tem a chave {campo}',
  'erro.appRefEndereco': 'O endereço não pode trazer referências a chaves ($). Ponha a chave num cabeçalho.',
  'erro.appRefArgumento': 'Os argumentos não podem trazer referências a chaves ($). Ponha a chave numa variável.',
  'erro.appNaoRespondeu': 'o aplicativo não respondeu',
  'erro.capacidadeEsgotada': 'Capacidade de habitantes esgotada: adicione um andar ou uma estrutura (grátis na versão local) ou desative um agente.',
  'erro.semLugarNaCidade': 'Não achei lugar na cidade para mais uma construção.',
  'erro.limiteDiario': 'Limite de {limite} execuções em 24 h atingido (configurável).',
  'erro.rotinaUmaPorDia': 'Esta rotina já rodou nas últimas 24 horas (uma rodada por dia).',
  'erro.rotinaLimite': 'Limite de {limite} execuções desta rotina em 24 horas.',
  'erro.teamsLidoHoje': 'O Teams já foi lido nas últimas 24 horas por outra rotina (uma leitura por dia). Tente de novo amanhã.',
  'erro.exportandoOutra': 'Outra pessoa está baixando os dados agora. Tente de novo em alguns minutos.',
  'erro.conflitoRevisao': 'A tarefa mudou desde a última leitura; recarregue antes de salvar.',
  'erro.recomendacaoSemIa': 'A recomendação precisa de uma conta de IA conectada (Conexões).',
  'erro.equipeDesligadaAgora': 'A sua equipe de IA não está ligada agora; tente de novo em instantes.',
  'erro.equipeAbrindo': 'A sua equipe de IA ainda está ligando ou não respondeu agora; tente de novo em instantes.',
  'erro.equipeNaoLigada': 'Configuração de IA indisponível: a equipe de IA não está ligada nesta instalação.',
  'erro.catalogoSemEquipe': 'Catálogo de modelos indisponível: a equipe de IA não está ligada.',
  'erro.semInternetInstalar': 'Sem conexão com a internet agora: tente instalar quando houver conexão.',
  'erro.semRevisor': 'Ninguém da equipe faz revisão crítica agora: dê a ferramenta "Revisão socrática" a um agente (no perfil dele ou pedindo à coordenação).',
  'erro.revisaoAberta': 'Já há uma revisão em andamento nesta tarefa.',
  'erro.semMaterial': 'Não há material para revisar: peça um resultado ao responsável ou descreva a entrega na tarefa.',
  'erro.autoRevisao': '{nome} não revisa o próprio trabalho: defina outro responsável.',
  'erro.mensagemVazia': 'mensagem vazia',
  'erro.agenteDesativado': 'agente desativado',
  'erro.semNinguemAtivo': 'sem ninguém ativo na equipe',
  'erro.semResponsavel': 'Este card não tem um responsável ativo.',
  'erro.agenteNaoEncontradoOuDesativado': 'Agente não encontrado ou desativado.',
  'erro.soCardsDaEquipe': 'Só cards do quadro da equipe vão para a fila dos agentes.',
  'erro.nasSuasTarefas': 'Nas suas tarefas, conclua pelo próprio card.',
  'erro.naoEstaEsperando': 'Este card não está esperando em "A fazer".',
  'erro.quadroSoConexao': 'Este quadro só recebe alterações feitas por você numa conexão ligada.',
  'erro.espelhoApagar': 'Esta tarefa vem de um aplicativo: apague lá. Na próxima leitura, ela aparece aqui como ausente.',
  'erro.nomeVazio': 'o nome não pode ficar vazio',
  'erro.interno': 'erro interno',
  'erro.quadroIndisponivel': 'quadro indisponível',
  'erro.rotinasIndisponiveis': 'rotinas indisponíveis',
  'erro.semWorldOnline': 'Sem conexão com o Ergon Online agora: nada foi alterado. Tente de novo.',
  'erro.modelosTarefaNaoChegou': 'Os modelos por tarefa chegam com a próxima atualização da equipe de IA. Nada foi alterado.',
  'erro.tarefaDeApoioDesconhecida': 'Essa tarefa de apoio não existe na sua equipe de IA. Nada foi alterado.',
  'erro.modeloTarefaNaoGravado': 'Não foi possível gravar o modelo agora. Nada foi alterado: tente de novo.',
} as const satisfies Record<string, Msg>;

/** As linhas do histórico (audit_events.result) que são frases fixas do sistema. */
const HISTORICO = {
  'historico.comNota': '{situacao} — {nota}',
  'historico.situacao.solicitada': 'Solicitada',
  'historico.situacao.processamento': 'Em processamento',
  'historico.situacao.resultado': 'Resultado produzido',
  'historico.situacao.validacao': 'Em validação',
  'historico.situacao.concluida': 'Concluída',
  'historico.situacao.aguardando_info': 'Aguardando informações',
  'historico.situacao.falha': 'Falha',
  'historico.situacao.revisao': 'Revisão necessária',
  'historico.situacao.aguardando_aprovacao': 'Aguardando aprovação',
  'historico.nota.decidiuCartao': 'você decidiu no cartão de confirmação',
  'historico.nota.etapaAjuda': 'etapa de ajuda de {nome}: esperando a vez',
  'historico.nota.etapaEsperando': 'etapa {etapa} de {total}: esperando a vez',
  'historico.nota.respondeuEsperando': '{nome} respondeu: esperando a vez',
  'historico.nota.ajudaChegou': 'a ajuda dos colegas chegou',
  // o "1 entregáveis gerados" que o servidor gravava antes também é reconhecido (casa com a forma do plural)
  'historico.nota.entregaveis': { one: '{n} entregável gerado', other: '{n} entregáveis gerados' },
  'historico.nota.documentoProduzido': 'documento produzido',
  'historico.nota.analisandoArquivo': 'o sistema está analisando o arquivo',
  'historico.nota.postaPorVoce': 'posta para trabalhar por você',
  'historico.nota.pegouDaFila': 'pegou da fila',
  'historico.nota.cartaoConta': 'esperando a sua confirmação num cartão (ação numa conta)',
  'historico.nota.cartaoDepoisDeLer': 'esperando a sua aprovação num cartão (abrir sites ou rodar programas)',
  'historico.nota.novaEstrategia': '{coord} chamou {nome} para uma nova estratégia',
  'historico.nota.resolvendo': '{nome} está resolvendo com a equipe',
  'historico.enfileirada': 'enfileirada',
  'historico.aprovacaoLigada': 'conclusão só com a sua aprovação',
  'historico.aprovacaoDesligada': 'conclusão automática quando o resultado for validado',
  'historico.prioridadeTopo': 'prioridade: topo da fila',
  'historico.semPrioridade': 'sem prioridade',
  'historico.ordemMudada': 'ordem da fila mudada',
  'historico.postaBotao': 'posta para trabalhar (botão)',
  'historico.pegouDaFilaAuto': 'pegou da fila (andamento automático)',
  'historico.rodadaAjustes': 'rodada {rodada}: ajustes pedidos por você, no mesmo card',
  'historico.equipeTentou': { one: 'A equipe tentou resolver em {n} rodada e não conseguiu: o card vai para você, com o último motivo', other: 'A equipe tentou resolver em {n} rodadas e não conseguiu: o card vai para você, com o último motivo' },
  'historico.tituloMantido': '{nome} sugeriu outro título (“{titulo}”); fica o que a pessoa escolheu',
  'historico.cardCancelado': 'card #{numero} cancelado (saiu do quadro; o histórico fica)',
  'historico.dadosBaixados': 'dados baixados (arquivo legível, sem cifra)',
  'historico.reservaUsada': 'o modelo principal não respondeu: o trabalho foi feito pelo modelo reserva {modelo}',
  'historico.orientou': 'orientação enviada ao trabalho em andamento',
  'historico.equipePausada': 'equipe em pausa: o trabalho novo espera você retomar',
  'historico.equipeRetomada': 'equipe retomada: o trabalho que esperava volta a andar',
} as const satisfies Record<string, Msg>;

/** O resumo do card (services/resumo-tarefa.ts): a situação, a faixa "Para você decidir"/"Feito" e as frases dela. */
const RESUMO = {
  'resumo.aEquipe': 'A equipe',
  'resumo.umColega': 'um colega',
  'resumo.umaInformacao': 'uma informação',
  'resumo.app.email': 'e-mail',
  'resumo.app.agenda': 'agenda',
  'resumo.eMais': '{itens} e mais {mais}',
  'resumo.em': ' em {apps}',
  'resumo.no': ' no {apps}',
  'resumo.para': ' para {quem}',
  'resumo.comCopia': ', com cópia para {quem}',
  'resumo.sobre': ', sobre {nomes}',
  'resumo.comConvite': ', com convite para {quem}',
  'resumo.parenteses': ' ({t})',
  'resumo.espaco': ' {t}',
  'resumo.doisPontos': ': {t}',
  'resumo.paraPasta': { one: ' para a pasta {nomes}', other: ' para as pastas {nomes}' },
  'resumo.qtd.email': { one: 'um e-mail', other: '{n} e-mails' },
  'resumo.qtd.mensagem': { one: 'uma mensagem', other: '{n} mensagens' },
  'resumo.qtd.item': { one: 'um item', other: '{n} itens' },
  'resumo.qtd.cobranca': { one: 'uma cobrança', other: '{n} cobranças' },
  'resumo.qtd.tarefa': { one: 'uma tarefa', other: '{n} tarefas' },
  'resumo.pendente.apagar': 'apagar {qtd}{em}',
  'resumo.pendente.mover': 'mover {qtd}{pasta}',
  'resumo.pendente.cobranca': 'criar {qtd}{em}{valores}, e o Asaas avisa o cliente',
  'resumo.pendente.email': 'enviar {qtd}{para}{copia}{sobre}',
  'resumo.pendente.resposta': 'responder {qtd}',
  'resumo.pendente.mensagem': 'mandar {qtd}{para}{no}',
  'resumo.pendente.tarefaComNome': { one: 'criar a tarefa {nomes}{em}', other: 'criar as tarefas {nomes}{em}' },
  'resumo.pendente.tarefa': 'criar {qtd}{em}',
  'resumo.pendente.tarefaMudar': { one: 'mudar a tarefa{nomes}{em}', other: 'mudar as tarefas{nomes}{em}' },
  'resumo.pendente.agendaMarcar': 'marcar na agenda{nomes}{convite}',
  'resumo.pendente.agendaDesmarcar': 'desmarcar na agenda{nomes}{convite}',
  'resumo.pendente.documentoCriar': { one: 'criar o documento{nomes}{em}', other: 'criar os documentos{nomes}{em}' },
  'resumo.pendente.documentoAtualizar': { one: 'atualizar o documento{nomes}{em}', other: 'atualizar os documentos{nomes}{em}' },
  'resumo.feito.apagar.email': { one: 'E-mail apagado{em}.', other: '{n} e-mails apagados{em}.' },
  'resumo.feito.apagar.mensagem': { one: 'Mensagem apagada{em}.', other: '{n} mensagens apagadas{em}.' },
  'resumo.feito.apagar.item': { one: 'Item apagado{em}.', other: '{n} itens apagados{em}.' },
  'resumo.feito.mover': { one: 'E-mail movido{para}.', other: '{n} e-mails movidos{para}.' },
  'resumo.feito.cobranca': { one: 'Cobrança criada{em}{valores}.', other: '{n} cobranças criadas{em}{valores}.' },
  'resumo.feito.email': { one: 'E-mail enviado{para}{copia}{sobre}.', other: '{n} e-mails enviados{para}{copia}{sobre}.' },
  'resumo.feito.resposta': { one: 'Resposta enviada por e-mail.', other: '{n} respostas enviadas por e-mail.' },
  'resumo.feito.mensagem': { one: 'Mensagem enviada{para}{no}.', other: '{n} mensagens enviadas{para}{no}.' },
  'resumo.feito.tarefaComNome': { one: 'Tarefa criada{em}: {nomes}.', other: 'Tarefas criadas{em}: {nomes}.' },
  'resumo.feito.tarefa': { one: 'Tarefa criada{em}.', other: '{n} tarefas criadas{em}.' },
  'resumo.feito.tarefaMudar': { one: 'Tarefa atualizada{em}{nomes}.', other: 'Tarefas atualizadas{em}{nomes}.' },
  'resumo.feito.agendaMarcar': 'Marcado na agenda{nomes}{convite}.',
  'resumo.feito.agendaAtualizar': 'Atualizado na agenda{nomes}{convite}.',
  'resumo.feito.agendaDesmarcar': 'Desmarcado na agenda{nomes}{convite}.',
  'resumo.feito.documentoCriar': { one: 'Documento{nomes} criado{em}.', other: 'Documentos{nomes} criados{em}.' },
  'resumo.feito.documentoAtualizar': { one: 'Documento{nomes} atualizado{em}.', other: 'Documentos{nomes} atualizados{em}.' },
  'resumo.feito.outro': '{acoes} (feito{em}).',
  'resumo.depoisDeLer.pagina': 'que {agente} mexa na página aberta no navegador depois de ler as suas contas',
  'resumo.depoisDeLer.sites': { one: 'que {agente} abra o site {sites} depois de ler as suas contas', other: 'que {agente} abra os sites {sites} depois de ler as suas contas' },
  'resumo.depoisDeLer.programa': 'que {agente} rode o programa {alvo} depois de ler as suas contas',
  'resumo.depoisDeLer.umPrograma': 'que {agente} rode um programa depois de ler as suas contas',
  'resumo.depoisDeLer.navegador': 'que {agente} use o navegador em {alvo} depois de ler as suas contas',
  'resumo.depoisDeLer.umSite': 'que {agente} abra um site depois de ler as suas contas',
  'resumo.avisoSemCartao': 'Aprovar só conclui este card: nada é enviado, criado ou pago numa conta por este clique.',
  'resumo.situacao.esperandoAprovacao': 'Esperando sua aprovação',
  'resumo.situacao.esperandoConfirmacao': 'Esperando sua confirmação',
  'resumo.situacao.precisaDecisao': 'Precisa da sua decisão',
  'resumo.situacao.feito': 'Feito',
  'resumo.situacao.trabalhando': 'Trabalhando',
  'resumo.situacao.precisaDeVoce': 'Precisa de você',
  'resumo.situacao.naoFeito': 'Não foi feito',
  'resumo.situacao.naFila': 'Na fila',
  'resumo.situacao.esperandoComecar': 'Esperando para começar',
  'resumo.titulo.paraDecidir': 'Para você decidir',
  'resumo.titulo.feito': 'O que foi feito',
  'resumo.titulo.agora': 'Agora',
  'resumo.titulo.responder': 'Para você responder',
  'resumo.titulo.falta': 'O que falta',
  'resumo.titulo.soVoce': 'Só você resolve',
  'resumo.titulo.aconteceu': 'O que aconteceu',
  'resumo.titulo.confirmar': 'Para você confirmar',
  'resumo.frase.aprovarPara': 'Aguardando sua aprovação para {acoes}',
  'resumo.frase.aprovar': 'Aguardando sua aprovação {itens}',
  'resumo.frase.paraX': 'para {x}',
  'resumo.frase.aprovadaPorVoce': 'Aprovada por você',
  'resumo.frase.conferidaSistema': 'Concluída e conferida pelo sistema',
  'resumo.frase.naEtapa': '{quem} está na etapa {etapa} de {total}: {titulo}',
  'resumo.frase.trabalhandoAgora': '{quem} está trabalhando nisto agora',
  'resumo.frase.trabalhando': '{quem} está trabalhando nisto',
  'resumo.frase.pergunta': '{quem} pergunta: {pergunta}',
  'resumo.frase.faltaAlgo': 'Falta algo seu: {falta}',
  'resumo.frase.naoFeitoMotivo': 'Não foi feito: {motivo}',
  'resumo.frase.naoFeito': 'Não foi feito',
  'resumo.frase.confirme': 'Confirme quando estiver feito: {titulo}',
  'resumo.frase.aprovarFeito': 'Aguardando sua aprovação. {feito}',
  'resumo.frase.aprovarDocumento': 'Aguardando sua aprovação do documento {documento}, entregue por {autor}',
  'resumo.frase.aprovarEntrega': 'Aguardando sua aprovação da entrega de {autor}',
  'resumo.frase.naoPassou': 'A entrega de {autor} não passou na conferência{motivos}. Aprove assim mesmo ou peça um ajuste',
  'resumo.frase.esperandoColegas': 'Esperando {nomes} terminar a parte que falta (card {cards})',
  'resumo.frase.naFilaCoordenacao': 'Na fila: {posicao}º de {total}. A coordenação encaminha quando chegar a vez',
  'resumo.frase.naFila': 'Na fila: {posicao}º de {total}. {quem} começa quando chegar a vez',
  'resumo.frase.comecaLogo': '{quem} começa assim que puder',
  'resumo.frase.coordenacaoVaiEncaminhar': 'A coordenação vai encaminhar a quem faz',
  'resumo.item.aParte': 'À parte, decida no cartão abaixo: {x}',
  'resumo.item.jaFeito': 'Já feito: {feito}',
  'resumo.item.ficouParaVoce': 'Ficou para você decidir: {x}',
  'resumo.doAgente': '{autor}: {texto}',
  'resumo.entregue.analise': 'Relatório e indicadores calculados a partir da planilha, nos arquivos abaixo.',
  'resumo.entregue.documento': 'Documento {documento} entregue, nos arquivos abaixo.',
  'resumo.entregue.arquivos': { one: 'Documento entregue, nos arquivos abaixo.', other: '{n} arquivos entregues, nos arquivos abaixo.' },
  'resumo.motivo.execucao': 'o trabalho parou no meio',
  'resumo.motivo.modelo': 'a resposta não foi escrita pela conta de IA',
  'resumo.motivo.conteudo': 'a entrega ficou curta demais',
  'resumo.motivo.alegacao': 'a resposta só disse que terminou',
  'resumo.motivo.pendencias': 'ficou uma pergunta sem resposta',
  'resumo.motivo.entregavel': 'o documento não foi salvo',
  'resumo.motivo.operacao': 'a análise do arquivo não foi feita',
  'resumo.motivo.conexao': 'a ação na conta não foi confirmada pelo aplicativo',
  'resumo.motivo.declaracao': 'o agente disse que não fez',
} as const satisfies Record<string, Msg>;

/**
 * O resultado de aprovar ou recusar uma proposta da equipe (services/proposals.ts: decideProposal), que "Aguardando
 * você" mostra depois do clique. Os sufixos (comFuncao, coordenadorFixo, naoAchei) vão juntos com junto(…, '').
 */
const PROPOSTA = {
  'proposta.recusada': 'recusada',
  'proposta.agenteRenomeado': '{antes} agora é {nome}',
  'proposta.agenteAtualizado': '{nome} atualizado',
  'proposta.comFuncao': ' ({funcao})',
  'proposta.coordenadorFixo': ' — Coordenador: função e setor são fixos e ficaram como estavam',
  'proposta.desativado': '{nome} desativado',
  'proposta.desativadoRedistribuido': { one: '{nome} desativado; {n} tarefa passou a colegas', other: '{nome} desativado; {n} tarefas passaram a colegas' },
  'proposta.deVolta': '{nome} de volta à equipe',
  'proposta.setorAtualizado': 'setor {nome} atualizado',
  'proposta.setorCriado': 'setor {nome} criado',
  'proposta.tarefaPara': 'tarefa #{numero} criada para {nome}',
  'proposta.tarefaSuas': 'tarefa #{numero} criada nas suas tarefas',
  'proposta.naoAchei': ' (não achei "{nome}" na equipe)',
  'proposta.ferramentaLiberada': '{ferramenta} liberada para {nome}',
  'proposta.ferramentaRetirada': '{ferramenta} retirada de {nome}',
  'proposta.mudouDeSetor': '{nome} agora está no setor {setor}',
  'proposta.agenteCriado': '{nome} criado no setor {setor}',
} as const satisfies Record<string, Msg>;

/** A Saúde (services/health.ts): o estado, o nome de cada parte e os pedaços fixos do detalhe. */
/** O cartão da gestão do coordenador (gestao.ts: resumoT): a frase, os campos e o rótulo de cada ação (o mesmo de ACOES). */
const GESTAO = {
  'proposta.gestao.quer': '{agente} quer: {acao}.',
  'proposta.gestao.campo': '- {campo}: {valor}',
  'proposta.gestao.par': '{campo}: {valor}',
  'proposta.gestao.sim': 'sim',
  'proposta.gestao.nao': 'não',
  'proposta.gestao.nenhum': '(nenhum)',
  'proposta.gestao.nadaMuda': 'Nada muda até você aplicar.',
  'proposta.gestao.nome.agt': 'agente {nome}',
  'proposta.gestao.nome.tsk': 'card {nome}',
  'proposta.gestao.nome.rtn': 'rotina {nome}',
  'proposta.gestao.nome.skl': 'competência {nome}',
  'proposta.gestao.nome.col': 'coluna {nome}',
  'proposta.gestao.nome.brd': 'quadro {nome}',
  'proposta.gestao.nome.trn': 'treinamento {nome}',
  'proposta.gestao.nome.bld': 'prédio {nome}',
  'proposta.gestao.nome.art': 'arquivo {nome}',
  'proposta.gestao.nome.fld': 'pasta {nome}',
  'proposta.gestao.nome.rgc': 'regra {nome}',
  'proposta.gestao.nome.ws': 'workspace {nome}',
  'proposta.gestao.nome.wsEste': 'workspace {nome} (este)',
  'proposta.gestao.acao.quadros.ver': 'Ver os quadros (da equipe e da pessoa)',
  'proposta.gestao.acao.quadro.ver': 'Ver os cards de um quadro, com as colunas',
  'proposta.gestao.acao.tarefa.ver': 'Ver um card (histórico, entregas, pendências)',
  'proposta.gestao.acao.tarefa.criar': 'Criar um card',
  'proposta.gestao.acao.tarefa.editar': 'Editar ou mover um card (nome, descrição, coluna, responsável, prazo, concluir)',
  'proposta.gestao.acao.tarefa.trabalhar': 'Pôr a equipe para trabalhar num card',
  'proposta.gestao.acao.tarefa.cancelar': 'Cancelar um card (o trabalho para e ele sai do quadro)',
  'proposta.gestao.acao.decisoes.ver': 'Ver o que espera a pessoa ("Com você")',
  'proposta.gestao.acao.equipe.ver': 'Ver a equipe',
  'proposta.gestao.acao.agente.ver': 'Ver um agente',
  'proposta.gestao.acao.setores.ver': 'Ver os setores',
  'proposta.gestao.acao.agente.criar': 'Criar um agente',
  'proposta.gestao.acao.agente.editar': 'Mudar um agente (nome, função, instruções, ferramentas, competências, modelo)',
  'proposta.gestao.acao.agente.mover': 'Mudar um agente de setor',
  'proposta.gestao.acao.agente.personalidade': 'Mudar a personalidade de um agente',
  'proposta.gestao.acao.agente.desativar': 'Desativar um agente (as tarefas dele passam a colegas)',
  'proposta.gestao.acao.agente.reativar': 'Trazer de volta um agente desativado',
  'proposta.gestao.acao.setor.criar': 'Criar um setor',
  'proposta.gestao.acao.distribuicao.ver': 'Ver a sugestão de distribuição da equipe',
  'proposta.gestao.acao.distribuicao.aplicar': 'Aplicar a distribuição sugerida da equipe',
  'proposta.gestao.acao.memoria.ver': 'Ver a memória de um agente (e o que espera aprovação)',
  'proposta.gestao.acao.memoria.decidir': 'Aprovar ou recusar uma anotação na memória de um agente',
  'proposta.gestao.acao.competencias.ver': 'Ver as competências e os treinamentos de um agente',
  'proposta.gestao.acao.competencia.ver': 'Ler uma competência aprendida',
  'proposta.gestao.acao.competencia.mudar': 'Desativar, ativar, remover ou restaurar uma competência',
  'proposta.gestao.acao.loja.ver': 'Procurar na loja de competências',
  'proposta.gestao.acao.loja.previa': 'Ler uma competência da loja antes de instalar',
  'proposta.gestao.acao.loja.varredura': 'Ver a verificação de segurança de uma competência da loja',
  'proposta.gestao.acao.loja.instalar': 'Instalar uma competência da loja',
  'proposta.gestao.acao.competencia.enviar': 'Instalar uma competência pronta (SKILL.md ou pasta .zip) que a pessoa enviou ou colou, num agente ou na equipe toda (arquivo: o identificador do arquivo que ela mandou; ou texto: o SKILL.md inteiro)',
  'proposta.gestao.acao.competencia.conteudo': 'Ler uma competência da biblioteca da equipe',
  'proposta.gestao.acao.competencia.ligar': 'Ligar ou desligar uma competência da biblioteca num agente',
  'proposta.gestao.acao.competencia.remover': 'Tirar uma competência da biblioteca da equipe (sai de todos os agentes)',
  'proposta.gestao.acao.treinar.comecar': 'Ensinar uma competência nova a um agente (Treinar: por um pedido, links, arquivos ou o texto de uma SKILL.md)',
  'proposta.gestao.acao.treinar.decidir': 'Aprovar ou descartar o que um treinamento escreveu',
  'proposta.gestao.acao.biblioteca.ver': 'Ver a biblioteca de competências prontas',
  'proposta.gestao.acao.ia.estado': 'Ver o estado da equipe de IA e das contas',
  'proposta.gestao.acao.modelos.ver': 'Ver os modelos disponíveis',
  'proposta.gestao.acao.modelo.padrao': 'Trocar o modelo padrão da equipe',
  'proposta.gestao.acao.modelos-tarefa.ver': 'Ver o modelo de cada tarefa de apoio',
  'proposta.gestao.acao.modelos-tarefa.mudar': 'Trocar o modelo das tarefas de apoio',
  'proposta.gestao.acao.ferramentas.ver': 'Ver as ferramentas da equipe',
  'proposta.gestao.acao.ferramentas.mudar': 'Ligar ou desligar ferramentas da equipe',
  'proposta.gestao.acao.conta-ia.remover': 'Desconectar uma conta de IA',
  'proposta.gestao.acao.conselho.ver': 'Ver o conselho de modelos',
  'proposta.gestao.acao.conselho.mudar': 'Montar o conselho de modelos',
  'proposta.gestao.acao.conexoes.ver': 'Ver as conexões, as permissões e as regras',
  'proposta.gestao.acao.integracoes.ver': 'Ver os aplicativos conectados',
  'proposta.gestao.acao.conexao.permissoes': 'Mudar o que a equipe pode fazer numa conexão (conta: o nome dela, o e-mail ou o número; sem conta, a principal)',
  'proposta.gestao.acao.conexao.so-leitura': 'Deixar uma conexão só para leitura (ou liberar a escrita) (conta: o nome dela, o e-mail ou o número; sem conta, a principal)',
  'proposta.gestao.acao.conexao.testar': 'Testar uma conexão (conta: o nome dela, o e-mail ou o número; sem conta, a principal)',
  'proposta.gestao.acao.conexao.desconectar': 'Desconectar uma conta de um aplicativo (conta: o nome dela, o e-mail ou o número; sem conta, a principal)',
  'proposta.gestao.acao.conta.mudar': 'Mudar uma conta de um aplicativo: o nome dela, ligar ou desligar para a equipe e as rotinas, ou torná-la a principal (conta: o nome dela, o e-mail ou o número)',
  'proposta.gestao.acao.conexoes.liberar-tudo': 'Liberar a equipe para agir nas contas sem pedir confirmação',
  'proposta.gestao.acao.conexoes.aprovar-depois-de-ler': 'Pedir aprovação para abrir sites ou rodar programas depois de ler as contas',
  'proposta.gestao.acao.conexoes.confirmar-organizar': 'Pedir confirmação antes de organizar nas contas',
  'proposta.gestao.acao.regras.ver': 'Ver as regras de "mandar sem me pedir"',
  'proposta.gestao.acao.regra.desfazer': 'Desfazer uma regra de "mandar sem me pedir"',
  'proposta.gestao.acao.conectores.ver': 'Ver os aplicativos prontos para conectar (conectores)',
  'proposta.gestao.acao.conector.instalar': 'Instalar um aplicativo pronto (conector)',
  'proposta.gestao.acao.conector.ligar': 'Ligar ou desligar um conector',
  'proposta.gestao.acao.conector.escrita': 'Liberar ou travar a escrita de um conector',
  'proposta.gestao.acao.conector.remover': 'Remover um conector',
  'proposta.gestao.acao.conector.proprio.ver': 'Ver os aplicativos que a pessoa conectou por conta própria, com as contas e as ferramentas',
  'proposta.gestao.acao.conector.proprio.criar': 'Criar uma conexão própria (aplicativo com servidor MCP) como mais uma conta do aplicativo, com apelido; sem chaves: as chaves a pessoa completa na tela',
  'proposta.gestao.acao.conector.proprio.testar': 'Testar uma conexão própria e listar as ferramentas dela',
  'proposta.gestao.acao.conector.proprio.ferramenta': 'Mudar o que uma ferramenta de uma conexão própria conta (leitura, escrita ou envio em nome da pessoa)',
  'proposta.gestao.acao.conector.proprio.conta': 'Mudar o apelido de uma conta de uma conexão própria, ou torná-la a principal do aplicativo',
  'proposta.gestao.acao.conector.proprio.remover': 'Desconectar uma conta de uma conexão própria (as chaves dela saem do cofre)',
  'proposta.gestao.acao.rotinas.ver': 'Ver as rotinas',
  'proposta.gestao.acao.rotina.ver': 'Ver uma rotina',
  'proposta.gestao.acao.rotinas.biblioteca': 'Ver a biblioteca de rotinas prontas',
  'proposta.gestao.acao.rotina.criar': 'Criar uma rotina',
  'proposta.gestao.acao.rotina.editar': 'Mudar uma rotina (horário, pedido, ligar ou pausar)',
  'proposta.gestao.acao.rotina.duplicar': 'Duplicar uma rotina',
  'proposta.gestao.acao.rotina.rodar': 'Rodar uma rotina agora',
  'proposta.gestao.acao.rotina.apagar': 'Apagar uma rotina',
  'proposta.gestao.acao.ajustes.ver': 'Ver os ajustes da equipe',
  'proposta.gestao.acao.ajustes.mudar': 'Mudar os ajustes da equipe',
  'proposta.gestao.acao.ajudantes.mudar': 'Mudar os ajudantes temporários dos agentes',
  'proposta.gestao.acao.iniciativa.mudar': 'Mudar a iniciativa da equipe',
  'proposta.gestao.acao.autonomia.mudar': 'Mudar se a equipe começa os cards sozinha',
  'proposta.gestao.acao.passos.mudar': 'Mudar os passos por pedido',
  'proposta.gestao.acao.resumo-conversas.mudar': 'Mudar o resumo das conversas longas',
  'proposta.gestao.acao.pausa.mudar': 'Pausar ou retomar o trabalho novo da equipe',
  'proposta.gestao.acao.limite.mudar': 'Mudar o limite de trabalhos',
  'proposta.gestao.acao.capacidades.ver': 'Ver as capacidades e proteções da equipe',
  'proposta.gestao.acao.capacidades.mudar': 'Mudar as proteções da equipe (voltar atrás, aviso de código, limpeza)',
  'proposta.gestao.acao.preferencias.mudar': 'Mudar as preferências da pessoa (aparência, idioma, avisos)',
  'proposta.gestao.acao.canais.ver': 'Ver os canais (Telegram e Discord)',
  'proposta.gestao.acao.canal.mudar': 'Mudar um canal (ligar, desligar, quem responde)',
  'proposta.gestao.acao.canal.parear': 'Parear uma conta num canal',
  'proposta.gestao.acao.canal.remover': 'Remover um canal',
  'proposta.gestao.acao.workspaces.ver': 'Ver os workspaces',
  'proposta.gestao.acao.workspace.criar': 'Criar um workspace',
  'proposta.gestao.acao.workspace.editar': 'Renomear ou mudar um workspace',
  'proposta.gestao.acao.cidade.ver': 'Ver os prédios da cidade',
  'proposta.gestao.acao.cidade.ajustes.ver': 'Ver os ajustes da cidade',
  'proposta.gestao.acao.cidade.ajustes.mudar': 'Mudar os ajustes da cidade',
  'proposta.gestao.acao.predio.criar': 'Construir um prédio',
  'proposta.gestao.acao.predio.editar': 'Mudar um prédio',
  'proposta.gestao.acao.predio.remover': 'Remover um prédio',
  'proposta.gestao.acao.andar.criar': 'Acrescentar um andar a um prédio',
  'proposta.gestao.acao.documentos.ver': 'Ver as pastas e os arquivos',
  'proposta.gestao.acao.documentos.buscar': 'Procurar nos arquivos',
  'proposta.gestao.acao.pasta.criar': 'Criar uma pasta',
  'proposta.gestao.acao.documentos.lixeira': 'Mandar arquivos ou pastas para a lixeira',
  'proposta.gestao.acao.documentos.restaurar': 'Tirar arquivos da lixeira',
  'proposta.gestao.acao.conversas.ver': 'Ver as conversas recentes',
  'proposta.gestao.acao.busca': 'Procurar em cards, conversas e arquivos',
  'proposta.gestao.acao.consumo.ver': 'Ver o consumo',
  'proposta.gestao.acao.limites.ver': 'Ver os limites de uso',
  'proposta.gestao.acao.atividade.ver': 'Ver a atividade recente',
  'proposta.gestao.acao.seguranca.ver': 'Ver o estado da segurança (sem mudar nada)',
  'proposta.gestao.acao.chaves.ver': 'Ver os nomes das chaves guardadas para a equipe (nunca o valor)',
  'proposta.gestao.acao.chave.apagar': 'Apagar uma chave guardada para a equipe',
  'proposta.gestao.acao.pacotes.ver': 'Ver os pacotes instalados',
  'proposta.gestao.acao.pacotes.catalogo': 'Ver o catálogo oficial de pacotes',
  'proposta.gestao.acao.pacote.instalar': 'Instalar um pacote do catálogo oficial',
  'proposta.gestao.acao.versao.ver': 'Ver a versão instalada e se há atualização',
  'proposta.gestao.acao.saude.ver': 'Ver a saúde da instalação',
  'proposta.gestao.acao.copia.agora': 'Fazer uma cópia de segurança agora',
} as const;

const SAUDE = {
  'saude.estado.operacional': 'Operacional',
  'saude.estado.limitado': 'Operacional com limitações',
  'saude.estado.atencao': 'Necessita atenção',
  'saude.estado.indisponivel': 'Indisponível',
  'saude.tudoFuncionando': 'tudo funcionando',
  'saude.problema': '{nome}: {detalhe}',
  'saude.nome.banco': 'Banco de dados',
  'saude.nome.cofre': 'Proteção dos dados',
  'saude.nome.motor': 'Equipe de IA',
  'saude.nome.execucoes': 'Execuções dos agentes',
  'saude.nome.rotinas': 'Rotinas',
  'saude.nome.contas': 'Contas e apps conectados',
  'saude.nome.espelhos': 'Listas ligadas a aplicativos',
  'saude.nome.backup': 'Backup',
  'saude.nome.disco': 'Espaço em disco',
  'saude.nome.cofres': 'Cofres de contas removidas',
  'saude.nome.dados-antigos': 'Cópia antiga dos dados da equipe',
  'saude.bancoIntegro': 'íntegro',
  'saude.tamanhoMb': '{mb} MB',
  'saude.cifrado': 'cifrado',
  'saude.abreSozinho': 'abre sozinho ao reiniciar (sem trancamento)',
  'saude.pedeSenha': 'pede a senha ao reiniciar',
  'saude.semProtecao': 'ainda sem proteção: proteja em Configurações › Segurança',
  'saude.trancado': 'trancado',
  'saude.semIa': 'esta instalação está configurada para não usar contas de IA: os agentes não trabalham nos pedidos (as conferências e rotinas sem IA funcionam)',
  'saude.noAr': 'no ar',
  'saude.cofreAberto': 'cofre aberto',
  'saude.foraDoAr': 'fora do ar agora',
  'saude.semConexoes': 'as Conexões não estão nesta versão da equipe: os agentes ainda não conseguem usar as contas conectadas',
  'saude.nas24h': '{n} nas últimas 24 h',
  'saude.falharam': '{n} falharam',
  'saude.paradas': { one: '{n} parada há mais de 10 min', other: '{n} paradas há mais de 10 min' },
  'saude.ativas': { one: '{n} ativa', other: '{n} ativas' },
  'saude.falharam24h': '{n} falharam (24 h)',
  'saude.perdidas': '{n} perdidas',
  'saude.reprovadas': '{n} com a conferência reprovada',
  'saude.emParte': '{n} conferidas em parte',
  'saude.nenhumaConectada': 'nenhuma conectada',
  'saude.conectadas': { one: '{n} conectada', other: '{n} conectadas' },
  'saude.comErro': 'com erro: {quais} (entre de novo em Conexões)',
  'saude.googleVence': 'Google vence em menos de 2 dias (modo de teste)',
  'saude.nenhumBackup': 'nenhum backup ainda',
  'saude.gbLivres': '{gb} GB livres',
} as const satisfies Record<string, Msg>;

export const TEXTOS: Readonly<Record<string, Msg>> = { ...ERROS, ...HISTORICO, ...RESUMO, ...PROPOSTA, ...GESTAO, ...SAUDE };
export type Codigo = keyof typeof ERROS | keyof typeof HISTORICO | keyof typeof RESUMO | keyof typeof PROPOSTA | keyof typeof GESTAO | keyof typeof SAUDE;

/** Um texto do sistema: o código e os valores dos marcadores. */
export function tx(codigo: Codigo, valores?: Readonly<Record<string, Valor>>, forma?: Texto['forma']): Texto {
  return forma ? { codigo, valores, forma } : valores ? { codigo, valores } : { codigo };
}
/** Pedaços já montados, juntos com um separador (" · " da Saúde). */
export const junto = (itens: readonly Valor[], sep: string): Texto => ({ codigo: 'junto', valores: { itens, sep } });
/**
 * Um número com casas decimais (o tamanho na Saúde: "51,4 MB"): vai como número, e cada idioma escreve do seu jeito
 * ("51,4" / "51.4"). Em português sai igual a decimal() de texto-tela.ts (vírgula, sem separador de milhar).
 */
export const decimalTx = (v: number, casas = 1): Texto => ({ codigo: 'decimal', valores: { v, casas } });

const ehTexto = (v: unknown): v is Texto => !!v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Texto).codigo === 'string';

/** "a, b e c" */
export const listaPt = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} e ${xs.at(-1)}`);

function formaDoPlural(m: Msg, n: number): string {
  if (typeof m === 'string') return m;
  if (n === 0 && m.zero) return m.zero;
  return n === 1 ? m.one ?? m.other : m.other;
}
const maiusc = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const comPonto = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

/** O texto em português (a reserva que vai junto e o que o servidor sempre escreveu). */
export function emPt(v: Valor | null | undefined): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (Array.isArray(v)) return listaPt(v.map((x) => emPt(x)));
  if (!ehTexto(v)) return '';
  let s: string;
  if (v.codigo === 'junto') {
    const itens = (v.valores?.itens ?? []) as readonly Valor[];
    s = itens.map((x) => emPt(x)).join(String(v.valores?.sep ?? ' '));
  } else if (v.codigo === 'decimal') {
    s = Number(v.valores?.v ?? 0).toFixed(Number(v.valores?.casas ?? 1)).replace('.', ',');
  } else {
    const m = TEXTOS[v.codigo];
    if (m === undefined) return '';
    const vals = v.valores ?? {};
    s = formaDoPlural(m, Number(vals.n ?? 0)).replace(/\{(\w+)\}/g, (_x, k: string) => emPt(vals[k]));
  }
  return v.forma === 'frase' ? comPonto(maiusc(s)) : v.forma === 'maiuscula' ? maiusc(s) : s;
}

// ------------------------------------------------------------------------------------ reconhecer pelo texto

interface Molde { codigo: string; re: RegExp; nomes: string[]; tamanho: number }
const exatos = new Map<string, string>();
const moldes: Molde[] = [];
const escapar = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** os moldes que juntam outros textos não se reconhecem sozinhos (pegariam qualquer frase com ": " ou " — ") */
const SO_MONTAR = new Set(['saude.problema', 'historico.comNota']);
/** marcadores que são sempre número (12 · 12,5 · 1.250): o molde só aceita número ali */
const NUMERICOS = new Set(['n', 'mb', 'gb', 'etapa', 'total', 'rodada', 'numero', 'limite', 'min', 'mais', 'posicao']);
/** os que podem ter vírgula decimal ("51,4"): voltam como número (decimalTx), e cada idioma escreve do seu jeito */
const DECIMAIS = new Set(['mb', 'gb']);
/** "51,4" → decimalTx(51.4, 1) · "1.250,5" → decimalTx(1250.5, 1) · "51" → 51 */
function numeroPt(s: string): Valor {
  const [inteiro, casas = ''] = s.replace(/\.(?=\d{3}(?:\D|$))/g, '').split(',');
  const v = Number(casas ? `${inteiro}.${casas}` : inteiro);
  if (!Number.isFinite(v)) return s;
  return casas ? decimalTx(v, casas.length) : v;
}
for (const [codigo, m] of Object.entries(TEXTOS)) {
  if (SO_MONTAR.has(codigo) || codigo.startsWith('proposta.gestao.') || !/^(erro|historico|proposta|saude)\./.test(codigo)) continue;
  for (const forma of typeof m === 'string' ? [m] : Object.values(m).filter((x): x is string => typeof x === 'string')) {
    const nomes = [...forma.matchAll(/\{(\w+)\}/g)].map((x) => x[1]);
    if (!nomes.length) { if (!exatos.has(forma)) exatos.set(forma, codigo); continue; }
    const fixos = forma.split(/\{\w+\}/).map(escapar);
    const re = new RegExp(`^${fixos.map((f, i) => (i === 0 ? f : `${NUMERICOS.has(nomes[i - 1]) ? '(\\d[\\d.,]*)' : '(.+?)'}${f}`)).join('')}$`, 's');
    moldes.push({ codigo, re, nomes, tamanho: forma.replace(/\{\w+\}/g, '').length });
  }
}
// o molde com mais texto fixo é o mais específico: tenta antes
moldes.sort((a, b) => b.tamanho - a.tamanho);

/**
 * O código de um texto já escrito em português (o erro de uma rota, a linha do histórico), quando ele é uma das frases
 * fixas do catálogo com o prefixo dado. Os marcadores voltam como texto (o {n} do plural, como número). Sem frase
 * conhecida: null (a tela mostra o português).
 */
export function reconhecer(texto: string | null | undefined, prefixo: string): Texto | null {
  const t = (texto ?? '').trim();
  if (!t) return null;
  const exato = exatos.get(t);
  if (exato?.startsWith(prefixo)) return { codigo: exato };
  for (const m of moldes) {
    if (!m.codigo.startsWith(prefixo)) continue;
    const x = m.re.exec(t);
    if (!x) continue;
    const valores: Record<string, Valor> = {};
    m.nomes.forEach((nome, i) => { valores[nome] = nome === 'n' && /^\d+$/.test(x[i + 1]) ? Number(x[i + 1]) : DECIMAIS.has(nome) ? numeroPt(x[i + 1]) : x[i + 1]; });
    return { codigo: m.codigo, valores };
  }
  return null;
}

/** A linha do histórico com código: a situação do card ("Em processamento — pegou da fila") em duas partes. */
export function textoDoResultado(action: string, result: string | null | undefined): Texto | null {
  const r = (result ?? '').trim();
  if (!r) return null;
  if (action === 'task.work_state') {
    const i = r.indexOf(' — ');
    const situacao = reconhecer(i < 0 ? r : r.slice(0, i), 'historico.situacao.');
    if (!situacao) return null;
    if (i < 0) return situacao;
    const nota = reconhecer(r.slice(i + 3), 'historico.nota.');
    return nota ? tx('historico.comNota', { situacao, nota }) : null;
  }
  // a decisão de uma proposta (aprovada, recusada, falhou): o resultado dela, ou o erro que a impediu
  if (action.startsWith('proposal.')) return reconhecer(r, 'proposta.') ?? reconhecer(r, 'historico.') ?? reconhecer(r, 'erro.');
  return reconhecer(r, 'historico.');
}

/** As linhas do registro (histórico do card, Atividade) com `result_t` ao lado do `result`, quando é frase do sistema. */
export function comTextoDoResultado<T extends { action: string; result: string }>(rows: T[]): Array<T & { result_t?: Texto }> {
  return rows.map((e) => { const t = textoDoResultado(e.action, e.result); return t ? { ...e, result_t: t } : e; });
}

// ------------------------------------------------------------------------------------ o idioma de quem pediu

export type IdiomaDoPedido = 'pt-BR' | 'en';
/** O idioma da tela que fez o pedido (cabeçalho X-Ergon-Lang, que web/src/lib/api.ts manda): o que o servidor gera na hora segue ele. */
export function idiomaDoPedido(headers: Readonly<Record<string, string | string[] | undefined>>): IdiomaDoPedido {
  const v = headers['x-ergon-lang'];
  const s = (Array.isArray(v) ? v[0] : v ?? '').trim().toLowerCase();
  return s === 'en' || s.startsWith('en-') ? 'en' : 'pt-BR';
}
