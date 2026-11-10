# Glossário da tradução (português → inglês)

Os termos que se traduzem sempre do mesmo jeito. A lista que o teste usa está em `glossario.ts`; os marcados com
**(conferido)** são checados pelo teste de completude: todo texto em português que tem o termo (com as maiúsculas
como estão aqui) precisa ter, no inglês, o termo da direita.

## Regras que valem nas duas línguas

- **A moeda do World não se traduz** (decisão de 09/11): o mesmo nome e o símbolo **₯** também em inglês. Só o
  número segue o idioma: `fmtDracmas(1250)` → `₯ 1.250` / `₯ 1,250`. O nome da moeda está na lista do módulo do World
  (só na distribuição proprietária), que o teste de completude também confere.
- **Os nomes dos personagens ficam como estão** nesta versão, com acento: Aristóteles, Hipátia, Heródoto…
  ("Pedir a Aristóteles" → "Ask Aristóteles"). Eles vêm dos dados, não do dicionário.
- **Sem o nome do motor** na tela, em nenhuma língua. Os agentes são a equipe.
- **O Ergon não é uma pessoa**: nada de "Ergon knows", "Ergon thinks", "Ergon decided". Use o agente pelo nome, "the
  team", "the system" ou a voz neutra.
- **Sem jargão técnico** na tela: nada de engine, container, image, bridge, endpoint, "responded 500". Diga o que a
  pessoa precisa fazer.
- Tom: frases curtas, diretas, na segunda pessoa ("you"), como no português. Maiúscula só no começo da frase e nos
  nomes próprios (áreas do menu e modos com nome: Focus Mode, Living city, Work Center).

## Termos

| Português | Inglês | |
|---|---|---|
| ₯ | ₯ | (conferido) o símbolo da moeda do World, não se traduz |
| Cidade | City | |
| Equipe | Team | |
| Rotinas | Routines | (conferido) |
| Fluxos da equipe | Team flows | (conferido) |
| Tarefas | Tasks | |
| Documentos | Documents | |
| Atividade | Activity | |
| Conexões | Connections | (conferido) |
| Configurações | Settings | (conferido) |
| Ajuda | Help | |
| Treinar | Train | (conferido) |
| Saúde | Health | (conferido) |
| Atualizações | Updates | |
| Segurança | Security | |
| Minha conta | My account | (conferido) |
| Pessoas | People | |
| Pacotes | Packages | |
| Loja | Store | |
| Workspace | Workspace | |
| Modo Foco | Focus Mode | (conferido) |
| Pedir a {nome} | Ask {nome} | |
| Aguardando você | Waiting for you | (conferido) |
| Estado do Ergon | Ergon status | (conferido) |
| Música ambiente | Ambient music | (conferido) |
| Cidade viva | Living city | (conferido) |
| Modo calmo | Calm mode | (conferido) |
| Central de Trabalho | Work Center | (conferido) |
| A fazer | To do | (conferido) coluna |
| Em andamento | In progress | coluna |
| Com você | With you | (conferido) coluna |
| Concluído | Done | coluna |
| Para você decidir | For you to decide | (conferido) a faixa da entrega |
| Feito | Done | a linha da entrega |
| card | card | |
| quadro | board | |
| Ágora | Agora | (conferido) sem acento em inglês |
| Stoa do Ergon | Stoa of Ergon | (conferido) |
| Termas | Baths | (conferido) |
| Ginásio | Gymnasium | (conferido) |
| Teatro | Theater | |
| Bairro | District | |
| construção | building | |
| posto | post | |
| agente | agent | |
| Coordenador | Coordinator | |
| setor | sector | |
| conta de IA | AI account | |
| assinatura Nous | Nous subscription | |
| Briefing Diário | Daily Briefing | |
| Tentar de novo | Try again | |
| modelo econômico | budget model | a faixa do modelo; sozinha: budget |
| modelo intermediário | mid-range model | sozinha: mid-range |
| modelo de ponta | premium model | sozinha: premium |
| por milhão de tokens | per million units of text | o preço: 'US$3.00 / US$15.00 per million units of text (input / output)', sem espaço depois de US$ |
| bloqueada | locked | o estado da ferramenta travada |

Termo novo: acrescente aqui e em `glossario.ts` (o teste confere que os dois têm os mesmos termos).
