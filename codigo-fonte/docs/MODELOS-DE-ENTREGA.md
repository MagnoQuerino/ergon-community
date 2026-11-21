# Modelos de entrega (rc.42)

O que um agente manda para a pessoa ao fim de um card vem num de cinco modelos. O cartão mostra o tipo e itens curtos —
bater o olho e saber o que fazer —; o relatório completo fica em **Ver detalhes**, com as ações ali mesmo (Aprovar o item
ou tudo, Devolver com instruções). Código: `server/src/services/modelos-entrega.ts`; tela: `web/src/components/EntregaDetalhes.tsx`.

## Os cinco modelos

| Tipo | Quando | No cartão | Núcleo (travado) |
|---|---|---|---|
| `decisao` — Aguardando sua decisão | a pessoa decide, aprova ou escolhe | um item por ponto | `itens[1..8]`: `titulo` (4–60, uma linha), `acao`, `contexto` (de onde veio e por que pede decisão), `objeto` (sobre o que, com os dados), `riscos{prazo, inacao, em_jogo}` |
| `entrega` — Entregue | um documento/arquivo ficou pronto | a linha do que foi entregue, arquivos, atenção | `resumo` (≤120), `arquivos[0..10]`, `atencao[0..5]` (≤90), `detalhes` |
| `relatorio` — Resumo | resumo/levantamento sem decisão | a conclusão e até 6 pontos | `resumo` (≤120), `pontos[1..6]` (≤90), `detalhes` |
| `pergunta` — Pergunta | falta uma informação que só a pessoa tem | a pergunta e as opções | `pergunta` (≤160), `opcoes[0..4]` (≤60), `porque` |
| `bloqueio` — Bloqueado | não deu para fazer | o motivo e o que destrava | `motivo` (≤120), `precisa` (≤160), `tentado[0..5]`, `detalhes` |

Em todos, `referencias[]` (até 5 por item na decisão, 8 no topo): `{tipo, titulo, url}` ou `{tipo, titulo, id}` — o
e-mail, o documento, o PR, o evento, a tarefa, o arquivo, a conversa ou o card citado, como chip clicável. `url` só
http(s) dos aplicativos das Conexões (e do próprio Ergon), sem usuário:senha; `id` (`art_`, `tsk_`, `cnv_`) conferido
no workspace. Obrigatório quando o trabalho leu objetos das contas (pelo registro do serviço). As listas das Conexões
devolvem o link de cada objeto (`link:` nos e-mails e eventos, `endereço:` nos arquivos, `html_url` no GitHub).

## Como se força

1. A instrução da última etapa pede a ferramenta `entregar` (complemento do motor, conjunto `ergon_cartoes`, sempre
   ligado), que leva o JSON a `/internal/bridge/v1/entrega`.
2. Fora do modelo, a ferramenta devolve os erros (`itens[0].titulo: 78 caracteres; o máximo é 60. Encurte`) e o agente
   refaz no mesmo turno — até 3 recusas por execução.
3. Terminou sem registrar: o cartão já mostra o **formato mínimo seguro** (a frase "Para você decidir" separada em itens
   curtos; o texto inteiro nos detalhes; nunca o parágrafo cru) e uma continuação curta com o mesmo agente pede o
   registro (até 2 vezes, sem segurar o card nem tirá-lo de "Aguardando você"). Quando ele registra, a entrega dele
   toma o lugar do mínimo.
4. Pergunta e bloqueio sem registro saem dos fatos (a pergunta do agente, o motivo da conferência).

O texto livre do agente continua na conversa e no documento; o cartão, "Aguardando você", os avisos do Telegram, do
Discord e do Teams usam o modelo (o tipo, os itens e o link "Ver detalhes" para o card no Ergon).

## Personalização

A pessoa pede ao coordenador ("Ari, nos resumos quero também o valor em R$"); ele usa as ações de gestão
`modelos-entrega.ajustar` (pede o cartão da pessoa) e `modelos-entrega.restaurar` (direto: volta ao seguro de fábrica).
Livre, por tipo: até 10 campos a mais (`extras`, obrigatórios ou não), o tom e uma instrução curta. Travado: o núcleo de
cada tipo, as referências, os itens curtos e o botão de detalhes — a rota recusa (422 `essencial_travado`) tirar ou
sobrepor, e a validação sempre os exige. Configurações › Modelos de entrega mostra os ativos e "Restaurar originais".
