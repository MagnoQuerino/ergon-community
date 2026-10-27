# Rotinas

Rotinas são trabalhos prontos que a equipe digital já sabe fazer: o usuário escolhe o que delegar, ajusta o horário
e acompanha o resultado, sem prompt nem configuração técnica. O menu **Rotinas** substituiu **Arquivos**. Os
arquivos ficam em Atividade › Arquivos e nas entregas das rotinas.

## Como uma rotina funciona

Uma rotina é uma definição que existe independente dos agentes. Ela diz o que coletar, quando rodar, quem executa e o
que entregar. Se quem executa sai da equipe, a coordenação assume e o fluxo continua.

1. **Coleta**: código comum, sem modelo. Junta tarefas (em andamento, fila, novas, concluídas, paradas, sem
   responsável), decisões pendentes, o trabalho dos agentes e as mensagens que chegaram pelos canais.
2. **Condição**: decide se vale chamar o modelo.
   - **sempre**: chama o modelo em toda execução.
   - **novidades**: só chama se algo mudou desde a última execução. Sem novidade, o próprio Ergon entrega o retrato
     do dia.
   - **sinal**: só chama quando a coleta acha algo que pede atenção, como uma tarefa parada. Sem sinal, registra
     "nada pedindo atenção" e não incomoda.
3. **Trabalho do agente**: é uma execução comum, com a mesma fila, o mesmo limite diário e o mesmo motor das
   conversas. Os dados vão como fatos: títulos e trechos vindos de terceiros são tratados como dados, nunca como
   instruções.
4. **Entrega**: o resultado vai para a conversa da rotina (dá para responder ali e pedir detalhes) e para um arquivo
   `.md` cifrado. Cada execução guarda os dados coletados como evidência, o resultado e o consumo de tokens.

**Sem conta de IA**, a rotina ainda entrega o resumo montado pelo Ergon com os fatos, e diz que foi feito sem modelo.

### Contas conectadas: agenda, e-mail e suas tarefas

Com Microsoft 365 e/ou Google conectados (Conexões), as rotinas podem ler, **só leitura e só o mínimo**:

| Fonte | O que entra | O que nunca entra |
|---|---|---|
| `agenda` | Compromissos de hoje no seu fuso: horário, título, local ou "online" (os cancelados ficam de fora) | Descrição, participantes, anexos |
| `email` | Desde a última execução, caixa prioritária (Outlook: "Prioritário"; Gmail: "Principal"): hora, remetente, assunto, importante, não lido | Corpo, anexos, outras caixas e promoções |
| `tarefas.pessoais` | Suas tarefas com prazo até hoje (atrasadas primeiro): To Do, Planner, Google Tasks | Tarefas sem prazo ou com prazo futuro |
| `contas` | Aviso automático: autorização vencida ou vencendo, sem permissão, erro de leitura | — |

Assuntos, títulos e nomes vêm de terceiros: chegam ao agente neutralizados (sem linhas de controle) e marcados como
dados. O **Briefing Diário** usa as três fontes; um Briefing instalado antes passou a usá-las uma vez, sozinho.

### Guardião dos Prazos

Avisa **antes** do atraso (seg a sex às 14:00, Hesíodo, condição "sinal": sem risco, nem chama o modelo).

| Fonte | O que entra |
|---|---|
| `prazos.risco` | Tarefas abertas com prazo — da equipe, suas e espelhadas: **atrasadas** (há quantos dias), **vencendo hoje** e as dos **próximos dias** (antecedência `horizonDays`, padrão 3) que têm sinal de risco: sem responsável, parada há N dias, ainda não começou, a última execução falhou, aguardando informações ou aprovação. As que estão andando no prazo só são contadas. |
| `prazos.mudancas` | Prazos adiados, antecipados, definidos ou retirados desde a última vez, e por quem (você, o Ergon ou o aplicativo espelhado) — do registro de cada tarefa. |
| `prazos.pessoais` | Suas tarefas das contas conectadas (To Do, Planner, Google Tasks) com prazo até a antecedência. |

Datas de outro ano aparecem com o ano (18/03/2024), para uma tarefa antiga não parecer desta semana.

### Contrato de evidência (conferência de cada execução)

Cada execução guarda a **conferência** da entrega, com veredito visível no histórico e no detalhe:

- **Painel do Ergon**: as contagens que importam, contadas por código (vai no topo do arquivo; o agente não as altera).
- **Fontes**: cada leitura de cada conta fica registrada (lida, não conectada, sem permissão, autorização vencida,
  erro). Autorização vencida marca a conexão com erro e o briefing diz "reconecte".
- **Autor**: modelo de IA real ou resumo montado pelo Ergon; simulação nunca conta como trabalho.
- **Horários, datas e tarefas citados**: todo horário (09:00, 9h30), toda data (27/10) e toda tarefa (#14) do texto
  do agente precisam existir nos dados.
- **Cobertura** (rotinas de alerta, como o Guardião): toda tarefa atrasada ou vencendo hoje tem de ser avisada. Se o
  agente esquecer alguma, o Ergon acrescenta o aviso com a linha dos fatos e a conferência fica "em parte". Hoje a
  cobertura confere as tarefas do Ergon (#N); as das contas (sem número) aparecem nos fatos, mas não são conferidas
  uma a uma.
- **Entrega**: na conversa e no arquivo, quando configurado.

**Conferido** = tudo ok; **conferido em parte** = alguma fonte ficou sem ler (e o texto diz qual) ou faltou avisar algo
que o Ergon completou; **não conferido** = o texto cita horário, data ou tarefa que não está nos dados — a entrega vai com o aviso, para você não confiar no que não
confere. O contexto montado pelo Ergon tem limite próprio (`ERGON_MAX_CONTEXT_CHARS`, 16 mil caracteres); passou
disso, os fatos são cortados com aviso, sem quebrar a execução.

**Identidade e recuperação**: cada horário agendado vira no máximo uma execução, mesmo com reinício no meio. O que
parou antes de chegar ao agente é retomado no passo seguinte. A execução do agente que terminou durante um
reinício é reconciliada. Se o Ergon estava desligado ou trancado e o atraso passou de 6 horas, a execução fica
registrada como **perdida** em vez de rodar fora de hora. O horário segue o fuso do usuário, horário de verão
incluído.

**Controles**:
- limite de execuções por rotina por dia, além do limite diário geral;
- uma execução por vez em cada rotina;
- "Executar agora" com identificador de pedido, então um clique repetido não executa duas vezes;
- pausar, editar (cada mudança vira uma versão nova), restaurar uma versão, duplicar e remover. O histórico fica.

## Ativação adaptativa: funciona de primeira, sem configurar

Ativar é um clique (com uma dica opcional). A rotina entra **em preparo** e o usuário vai para a tela do preparo: à
esquerda, o andamento e o que a rotina é; à direita, a conversa com o Aristóteles já aberta.

1. **Estudo silencioso.** O Ergon junta o que já sabe do usuário, por código e só deste workspace: contas conectadas,
   quadros e temas das tarefas, ritmo (a que horas costuma começar, em que dias trabalha), como escreve aos agentes
   (tamanho, tom, com quem mais fala), canais, regras e agentes que ele criou. A coordenação lê isso e adapta a rotina
   ao caso dele: o foco (o que priorizar e o que ignorar), o tom e o formato da entrega, o horário (antes de ele
   começar o dia) e, se fizer sentido, quantos dias contam como tarefa parada.
2. **Perguntas só se precisar.** Se uma escolha mudar muito o resultado e os dados não derem pista, ela pergunta com
   opções clicáveis (no máximo duas perguntas; "outra resposta" deixa escrever). As respostas vão juntas e a
   preparação continua.
3. **Pronta.** A rotina liga já ajustada e roda a primeira vez ali mesmo, para o usuário ver como fica. Essa primeira
   execução vale mesmo sem novidade. Na mesma conversa dá para pedir mudanças ("mude para as 9h"): valem na hora e
   cada uma vira uma versão nova.

Enquanto a coordenação estuda, a tela mostra o emblema em movimento com frases que se revezam ("Consultando o oráculo
de Delfos…", "Localizando os pergaminhos corretos…") e os passos reais do preparo.

**Sem conta de IA** (ou se o estudo falhar), o Ergon faz o melhor ajuste sozinho: o horário fica antes de o usuário
costumar começar, o foco vai para os temas que mais aparecem no trabalho dele e a dica dele é aplicada. A tela diz
o que mudaria com uma conta de IA conectada. Com poucos dados, a rotina começa no padrão e se ajusta conforme o uso.

## Criar e ajustar conversando com o Aristóteles

"Criar rotina com Aristóteles" abre a conversa com a coordenação. Ela mostra uma prévia (o que faz, quando, o que
olha, quem executa e o que entrega) e propõe a rotina. A rotina só vale depois que o usuário clica em **Ativar
rotina** no cartão.

A coordenação não escreve código. Ela só compõe operações que o Ergon já valida:
- as fontes da lista;
- uma das três condições;
- um agente da equipe;
- a forma de entrega.

Fonte desconhecida é descartada. Do mesmo jeito, dá para pedir ajustes ("ajuste o briefing para 7h e ignore as
tarefas pessoais"). O ajuste vale só para aquela instalação: o modelo da biblioteca não muda, e as rotinas da
biblioteca usam sempre a instrução mais atual do modelo.

## Recomendação inteligente

É um botão liga/desliga em Rotinas, **ligado por padrão** (todas as automações começam ligadas). O aviso fica no próprio cartão, para a escolha continuar consciente: a análise lê pedidos e tarefas do
workspace e usa o modelo uma vez por semana. A primeira análise acontece no dia seguinte; quem desligar não volta a
ter análise sem ligar de novo.

Ligada, a coordenação procura trabalho que se repete ou é feito de improviso, como tarefas que voltam toda semana ou
pedidos parecidos aos agentes. Cada sugestão chega em **Aguardando você**: o contador do topo agora é um botão que
abre a lista de decisões. A sugestão vem com um recado em tom de colega, a ficha técnica da rotina e o motivo (a
evidência).

Recusada, a sugestão vai para a **base de recusas** e não volta sozinha. Se o usuário mudar de ideia, há duas formas
de trazê-la de volta exatamente como estava, sem refazer a análise:
- pedir na conversa ("aquela rotina que recusei");
- clicar em **Reconsiderar** no painel.

"Analisar agora" faz a análise na hora.

## Pedido e documentos (rotinas sob demanda)

Algumas rotinas trabalham a partir de um **pedido**: o objetivo (Planejador), o assunto (Recuperador), o problema
(Investigador), a ata colada (Secretário), o que apresentar (Apresentação). Em **Executar agora** abre uma janela com
o campo do pedido e, quando a rotina lê documentos, a escolha dos arquivos:

- **do Ergon** (Atividade › Arquivos), procurando pelo nome;
- **enviar um arquivo** na hora;
- **do OneDrive/SharePoint ou do Google Drive** (com a conta conectada), procurando pelo nome — o Ergon baixa a versão
  atual a cada execução; documentos do Google viram Word, Excel ou PowerPoint para a leitura.

Essas rotinas não rodam sozinhas logo depois de ativar (não há pedido ainda): o preparo termina em "Pronta para usar".
O pedido é do usuário (vai ao agente como "Pedido do usuário"); documentos, e-mails e notícias são dados de terceiros e
chegam **desarmados** (linhas de controle neutralizadas), sempre marcados como dados.

## O que acompanhar (parâmetros)

Rotinas agendadas que acompanham algo se configuram uma vez — na ativação ou em **Editar**:

| Rotina | O que acompanhar |
|---|---|
| Radar de Notícias | assuntos e palavras-chave; feeds RSS (opcional) |
| Radar Regulatório | órgãos e temas; feeds oficiais (opcional) |
| Radar de Concorrência | concorrentes; feeds dos sites (opcional) |
| Guardião de Contratos | os contratos (arquivos do Ergon ou da nuvem) |
| Conferência Financeira | fonte A e fonte B (ex.: extrato OFX e planilha de controle) |
| Analista de Planilhas | planilhas acompanhadas (só para rodar agendada) |

Sem o que acompanhar, a rotina **não roda à toa**: no horário, registra "Falta configurar: …" (sem chamar o modelo), e
"Executar agora" pede para configurar antes. Listas aceitam um item por linha ou separados por ponto e vírgula;
endereços de feed só em `https`.

## Documentos que o Ergon lê (por código, sem o modelo)

| Tipo | O que sai |
|---|---|
| Word (.docx) | parágrafos numerados (§D1.12) e tabelas; texto apagado no controle de alterações fica de fora |
| Excel (.xlsx) e CSV | as abas com as linhas; datas no formato de data viram AAAA-MM-DD |
| PowerPoint (.pptx) | o texto de cada slide |
| PDF com texto | o texto das páginas, inclusive fontes com tabela ToUnicode (o comum no Word "Salvar como PDF") |
| XML de NF-e / NFS-e (ABRASF) | emitente, número, data, valor, parcelas |
| Extrato OFX | cada lançamento (data, valor, histórico) |
| Legenda/transcrição (.vtt, .srt) | a fala, sem os carimbos de tempo |

O que não dá para ler é **dito** na entrega e na conferência: PDF digitalizado ("sem texto"), PDF protegido por
senha, formato antigo do Office (.doc/.xls/.ppt), imagem. Limites: até 12 arquivos por execução, 15 MB por arquivo da
nuvem, proteção contra ZIP malicioso (tamanho descompactado). O contexto das rotinas que leem documentos tem limite
próprio (`ERGON_MAX_DOCUMENT_CHARS`, 60 mil caracteres); passou disso, o texto é cortado com aviso.

## Fontes novas

| Fonte | O que entra | Código citável |
|---|---|---|
| `entrada` | o pedido desta execução | — |
| `documentos` | o texto dos documentos, parágrafo a parágrafo | D1, §D1.12 |
| `planilhas` | **análise do Ergon**: tipo de cada coluna, totais, média, mediana, mínimo, máximo, vazios, repetidas, valores fora da curva (com a linha), total por mês com a variação do último mês, total por categoria | — |
| `contexto` | o histórico do assunto no Ergon: tarefas, conversas, arquivos e rotinas que citam as palavras do pedido | #14 |
| `equipe.funcoes` | quem faz o quê e quantas tarefas abertas cada um tem | — |
| `semana` | por responsável: concluídas, criadas, abertas, atrasadas, prazo cumprido (%); execuções e tokens | #14 |
| `entregas` | arquivos entregues desde a última vez | — |
| `email.caixa` | e-mails prioritários com o começo do texto (Outlook "Prioritário", Gmail "Principal") | E3 |
| `email.pendencias` | conversas **sem resposta sua** e as que **você enviou e estão sem resposta** (14 dias) | P2 |
| `email.responder` | os importantes esperando você, com o texto **sem o histórico citado** e as mensagens anteriores da conversa | R1 |
| `email.relacionados` | e-mails dos últimos 30 dias sobre o assunto (palavras do pedido ou das reuniões) | H4 |
| `mensagens.texto` | mensagens recebidas pelos canais, com o texto | M5 |
| `agenda.proximas` | reuniões das próximas 36 horas com participantes, organizador e descrição (só as com outras pessoas) | Q1 |
| `web.noticias` / `web.regulatorio` / `web.concorrentes` | Google Notícias (pt-BR) dos termos configurados e os feeds RSS/Atom indicados, só o que é novo desde a última vez | N7 |
| `financeiro.lancamentos` | lançamentos lidos de NF-e, NFS-e, OFX, planilhas (e, para conferir, de PDF/texto) | L5 |
| `financeiro.conferencia` | casamento entre duas fontes (mesmo valor e data até ±3 dias), o que só está numa, valores diferentes, repetidos | A L5 / B L9 |
| `contratos.obrigacoes` | datas dos contratos com o tipo (vigência, renovação, reajuste, aviso prévio, pagamento) e as **calculadas** (fim pela duração, último dia do aviso prévio) | C1.3 |

Fontes públicas: só `https`, nunca endereços internos (rede local, nuvem, localhost — conferido a cada
redirecionamento), tempo e tamanho limitados. A resposta da web não pode citar link que não veio das fontes.

## Propostas para você aprovar

- **Tarefas** (Planejador, Secretário, Radar de Compromissos, Investigador): a resposta escreve
  `[[propor-tarefa titulo=… responsavel=… prazo=… origem=…]]`; cada uma vira um cartão em **Aguardando você**. Aplicada,
  vai para o quadro da equipe (com o responsável) ou para as suas tarefas. Nada entra sem o clique.
- **Lançamentos** (Financeiro por Documentos): os valores e as datas são do Ergon; o agente só sugere a categoria. Um
  cartão "Registrar N lançamentos" — aprovado, vira `lancamentos-aprovados-….csv` em Atividade › Arquivos, com
  auditoria.

## Arquivos que o Ergon produz

Além do `.md` de cada entrega: **planilha de indicadores** (Analista, Apresentação), **planilha de lançamentos** com a
categoria sugerida, **planilha da conferência**, **calendário de obrigações** dos contratos, **planilha da semana**
(Relatório Semanal) — todas CSV para o Excel em português — e a **apresentação editável (.pptx)**: os slides vêm do
texto do agente; os gráficos de barras (por mês, por categoria) são desenhados com os números contados pelo Ergon.

## Conferências novas

| Conferência | Quando | O que reprova |
|---|---|---|
| Números citados estão nos dados | Analista, Apresentação, Comparador, Relatório Semanal, Financeiro, Conferência | número que não existe nos dados (aceita o arredondamento; ignora contagens pequenas e anos) |
| Links citados são das fontes | radares | link que não veio de uma fonte lida |
| Trechos citados existem | Revisor, Comparador | §D1.12 que não existe no documento |
| Itens citados existem | todas | E3, P2, L5, C1.3… que não estão nos dados (#14 sempre) |
| Documentos lidos / fontes públicas lidas | quem lê | — (deixa **em parte** e diz qual não leu) |
| Cobertura | Caçador de Pendências (toda pendência P), Guardião de Contratos (tudo dos próximos 15 dias) | — (o Ergon acrescenta o que faltou e deixa **em parte**) |
| Tarefas propostas | Planejador, Secretário | — (sem proposta, **em parte**) |
| Datas sugeridas | rotinas que planejam ou rascunham | — (datas novas são ditas como sugestões, não reprovam) |

## As 24 rotinas

| Rotina | Quando (padrão) | Quem | Pede ou acompanha | Entrega |
|---|---|---|---|---|
| Briefing Diário | seg–sex 08:00 | Aristóteles | — | briefing |
| Guardião dos Prazos | seg–sex 14:00 (sinal) | Hesíodo | — | alertas com cobertura |
| Supervisor de Projetos | seg e qui 10:00 (sinal) | Hipódamo | — | diagnóstico |
| Recuperador de Contexto | quando pedir | Heródoto | o assunto (+ documentos) | histórico do assunto |
| Planejador de Projetos | quando pedir | Hipódamo | o objetivo (+ documentos) | plano + tarefas propostas |
| Radar de Compromissos | seg–sex 17:30 (novidades) | Aspásia | — (e-mail) | tarefas propostas |
| Caçador de Pendências | seg, qua e sex 09:30 (sinal) | Hesíodo | — (e-mail) | pendências + cobranças para copiar |
| Caixa de Entrada Inteligente | seg–sex 07:45 (novidades) | Aspásia | — (e-mail) | resumo priorizado |
| Assistente de Respostas | quando pedir | Aspásia | qual e-mail (opcional) | rascunhos de resposta |
| Preparador de Reuniões | seg–sex 07:30 (sinal) | Aristóteles | qual reunião (opcional) | pauta, pendências, perguntas |
| Secretário de Reuniões | quando pedir | Aristóteles | ata colada ou arquivo | decisões + tarefas propostas |
| Relatório Semanal | sex 16:00 | Arquimedes | — | relatório + planilha da semana |
| Analista de Planilhas | quando pedir (ou agendada) | Arquimedes | planilhas | análise + indicadores |
| Apresentação de Resultados | quando pedir | Arquimedes | o que apresentar + dados | .pptx + indicadores |
| Comparador Inteligente | quando pedir | Hipátia | o que comparar + propostas | quadro e recomendação |
| Revisor de Documentos | quando pedir | Sócrates | o documento (+ requisitos) | parecer com trechos |
| Investigador de Problemas | quando pedir | Sócrates | o problema (+ registros) | causas, testes, plano + tarefas |
| Preparador Comercial | quando pedir | Heródoto | o pedido do cliente (+ edital) | rascunho de proposta |
| Radar de Notícias | seg, qua e sex 08:30 (novidades) | Hipátia | assuntos (+ feeds) | resumo com links |
| Radar Regulatório | seg–sex 09:00 (sinal) | Hipátia | órgãos e temas (+ feeds) | alertas normativos com links |
| Radar de Concorrência | seg 08:00 (novidades) | Hipátia | concorrentes (+ feeds) | movimentos com links |
| Financeiro por Documentos | quando pedir | Arquimedes | comprovantes (NF-e, OFX, planilha, PDF) | lançamentos para aprovar |
| Guardião de Contratos | seg 09:00 (sinal) | Hesíodo | contratos | alertas + calendário |
| Conferência Financeira | seg 10:00 (sinal) | Arquimedes | fonte A e fonte B | divergências + planilha |

Sem conta de IA, cada uma ainda entrega o que o Ergon conta (fatos, indicadores, lançamentos, conferência,
calendário), dizendo que foi sem modelo.

## Fases

| Fase | Situação |
| --- | --- |
| 1 — Biblioteca e rotinas internas | **Feito**: Briefing, Guardião dos Prazos, Supervisor, Recuperador de Contexto e Planejador de Projetos. |
| 2 — Comunicações | **Feito** com e-mail (Microsoft e Google): Radar de Compromissos, Caçador de Pendências, Caixa de Entrada Inteligente, Assistente de Respostas, Preparador de Reuniões. Teams e WhatsApp entram pela fonte `mensagens.texto` quando conectados (Teams ainda não está). |
| 3 — Documentos e produção | **Feito**: Analista de Planilhas, Apresentação de Resultados, Revisor de Documentos, Comparador, Relatório Semanal, Secretário de Reuniões, Investigador de Problemas, Preparador Comercial. |
| 4 — Rotinas do usuário | O Aristóteles compõe rotinas com as fontes do Ergon (agora com as novas), com prévia, aprovação, versões e restauração. Falta um teste de execução antes de ativar. |
| 5 — Inteligência contínua | **Feito**: radares (notícias, regulatório, concorrência), Financeiro por Documentos, Guardião de Contratos, Conferência Financeira. Compartilhar rotinas entre workspaces: não começou. |

## O que ainda não faz

- **Não envia nada**: respostas e cobranças são rascunhos para copiar. Gravar o rascunho na sua caixa (Outlook/Gmail)
  pede a permissão de escrita de e-mail (Mail.ReadWrite / gmail.compose), que não foi concedida — decisão sua.
- Imagem e PDF digitalizado não são lidos (sem OCR). Fórmulas do Excel valem pelo último valor salvo.
- O gatilho "por evento" (reagir na hora a um e-mail ou a uma tarefa) ainda não existe: as rotinas rodam sob demanda,
  em dias e horário, ou por condição em cada horário.
- Radares leem notícias públicas e feeds; não abrem o site da notícia nem consultam bases pagas. O Diário Oficial
  entra pela busca de notícias (`site:in.gov.br`), não pela base oficial.
- Datas de contratos vêm do texto (frases com dd/mm/aaaa ou "1º de março de 2026" e as regras de prazo e aviso
  prévio); contrato com datas só em tabela-imagem ou escritas de outro jeito não entra — a rotina diz "nenhuma data
  encontrada".
- Conferência casa por valor e data; não lê o histórico do banco para casar descrições diferentes do mesmo pagamento.
