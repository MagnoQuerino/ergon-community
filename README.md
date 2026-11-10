# Ergon Community

### Uma equipe inteira de IA trabalhando para você, no seu computador.

Imagine abrir o computador e encontrar uma pequena cidade grega em pixel art, viva, inspirada em Alexandria. Nela,
**doze personagens históricos** já estão no trabalho: **Aristóteles** coordena, **Hipátia** pesquisa, **Arquimedes**
faz as contas, **Fídias** cuida do design. Você pede, e eles dividem o trabalho, montam o plano, conferem uns aos outros
e entregam.

É isso o Ergon. Você não fica conversando com um chatbot, você comanda uma equipe.

- **Peça como pediria a uma pessoa:** "responde o João no Teams", "organiza minha semana", "revisa esse contrato".
- **Veja o trabalho acontecendo** na cidade e no quadro de tarefas, com cada card mostrando quem está com ele e o que falta.
- **Decida de relance:** quando a equipe precisa de você, o card diz exatamente o que você está aprovando, com um botão.
- **Seus dados ficam com você:** tudo roda na sua máquina, cifrado com a sua senha. Sem conta no projeto, sem
  servidor nosso no meio. A IA usa a conta de IA que **você** conectar.

> 🇬🇧 **In English:** Ergon is a team of AI agents that works on your own computer: twelve historical characters,
> led by Aristotle, who plan, split and deliver your tasks while you watch them in a pixel-art city. The whole app is
> available in **English** (Settings › My account), the launcher speaks English (`ergon install`, `ergon update`,
> `ergon help`), and your data stays encrypted on your machine. Download links are right below.

---

## Comece em 3 passos

1. **Baixe o instalador** do seu sistema (logo abaixo).
2. **Crie a sua conta** e guarde a frase de recuperação (24 palavras: ela é a chave de tudo).
3. **Conecte uma conta de IA** e faça o primeiro pedido ao Aristóteles.

### Windows 10 e 11

Baixe e abra **[`Ergon Desktop para Windows.exe`](Ergon%20Desktop%20para%20Windows.exe)** (aqui na raiz).
- **Não precisa instalar Docker** nem outro programa: ele instala tudo sozinho num ambiente próprio do Ergon, separado
  do resto do computador.
- Se o Windows ainda não tiver o recurso de ambientes Linux ligado, o instalador liga e pede um reinício. Depois
  continua de onde parou.
- No fim, o Ergon abre numa janela.
- Atualizações chegam por **Configurações › Atualizações**, com backup antes e um botão para voltar à versão anterior.

### Linux (Ubuntu 24.04 ou mais novo, Debian 12)

Baixe e abra **[`Ergon Desktop para Linux.deb`](Ergon%20Desktop%20para%20Linux.deb)** com o instalador de aplicativos
do sistema.
- O pacote traz o que o Ergon precisa, o [Podman](https://podman.io) (de código aberto), e **não instala Docker**.
- Abra o Ergon pelo menu: ele se instala na sua conta, sem pedir administrador, e abre numa janela.
- Mais detalhes: [docs/DESKTOP.md](docs/DESKTOP.md).

### macOS

Por enquanto, pelo pacote com contêineres, com o [Podman](https://podman.io) instalado e ligado:
1. Baixe esta pasta (botão verde **Code › Download ZIP**) e descompacte.
2. Num terminal, dentro da pasta, rode: `bash "Instalar Ergon no Linux e macOS.sh"`.
3. Depois disso, o comando `ergon` funciona em qualquer terminal. `ergon help` mostra o que ele faz (`start`, `stop`,
   `update`…); os nomes antigos em português continuam funcionando.

Passo a passo e o que fazer se esquecer a senha: [docs/INSTALAR.md](docs/INSTALAR.md).

Todas as versões, com as somas SHA-256 para conferir os arquivos, ficam na
[página de versões](https://github.com/MagnoQuerino/ergon-community/releases).

---

## O que a sua equipe sabe fazer

### 💬 Conversa e quadro de tarefas
Peça na conversa ou crie cards. A coordenação dá um nome claro a cada pedido, distribui, acompanha e entrega.
- **Nada é dado como feito sem prova:** a tarefa só é concluída com evidência do que foi feito.
- **Pequenos tropeços a equipe resolve sozinha:** confere e tenta de novo, sem repetir o que já saiu.
- **Para você, só o que só você pode decidir.**

### ✅ Aprovar de relance
Quando algo precisa de você, o card diz exatamente o que está em jogo: *"Aprovar o envio de 2 e-mails para Fulano e
Cicrano sobre o orçamento"*, com o botão **Aprovar** ali do lado. Quer mais autonomia? Diga ao Aristóteles *"podem
mandar sem me pedir"* e escolha por quanto tempo: só neste pedido, 24 horas ou sempre. Todas as regras ficam num lugar
só, com **Desfazer**.

### 🔌 Conexões que os agentes usam de verdade
- **Microsoft 365 e Google:** e-mail, agenda, arquivos, Teams e tarefas ([Microsoft](docs/MICROSOFT.md),
  [Google](docs/GOOGLE.md)).
- **Gestão de tarefas, ligada nos dois sentidos:** Trello, Jira, Asana, monday.com, ClickUp, Notion, Pipefy, Todoist,
  Linear e outros. Marcou como feito aqui, fica feito lá.
- **Conversa:** Slack, Discord, Telegram e WhatsApp experimental ([riscos](docs/WHATSAPP.md)).
- **CRM, atendimento e financeiro:** o financeiro cadastra clientes e cria cobranças, **nunca paga nem transfere**, e
  qualquer conexão fica em **Só leitura** com um clique.
- **Confirmação por padrão:** o que não partiu de você pede a sua confirmação, a menos que você ligue "Liberar tudo"
  em Conexões.

### 🔁 Rotinas
Briefing do dia, guardião de prazos, radar de compromissos, revisão de contratos, conferência financeira e outras. O
que foi lido e conferido fica sempre à vista ([docs/ROTINAS.md](docs/ROTINAS.md)).

### 🎓 Treinar
Ensine uma competência a um agente com texto, documentos e links. Você revisa e aprova antes de ela entrar em uso.

### 🏛️ Uma cidade que mostra o trabalho
Cada card em andamento aparece na cidade, junto de quem está trabalhando nele. Quem treina vai ao Ginásio, e a
entrega que espera você é apresentada no palco do Teatro.
- **Para concentrar:** **Modo Foco** (o trabalho sem a cidade) e **Modo calmo** (menos movimento).
- **Para trabalhar ouvindo:** música lo-fi tocada no seu computador, sem internet.
- **Seis skins:** Distrito Platina, Reino de Brumaverde, Base Siroco, Enseada Coral, Vila Ronrom e Cromo-9. Mudam os
  prédios, as roupas, a paisagem e até 10 personagens com nome e bio.

### 🛍️ Loja de pacotes
Skins, temas, efeitos, pets e equipes prontas.
- Os oficiais vêm junto, assinados, e funcionam sem internet.
- Os **modelos da comunidade** ([catalogo/](catalogo/)) aparecem quando você pede ([docs/LOJA.md](docs/LOJA.md)).

### 🔒 Privado de verdade
- **Cifra e recuperação:** banco e arquivos cifrados com a sua senha, frase de recuperação de 24 palavras e 2º fator
  opcional (TOTP e passkeys).
- **Backup:** conferido, com restauração que dá para desfazer.
- **Seus dados são seus:** **Baixar meus dados** entrega tudo em formato legível, quando você quiser.

### 🌎 Português e inglês
A tela inteira nos dois idiomas, trocando na hora em **Configurações › Minha conta**. A equipe responde no idioma em
que você escreve.

---

## O que tem nesta pasta

| | |
|---|---|
| `Ergon Desktop para Windows.exe` | instala o Ergon no Windows (sem Docker) |
| `Ergon Desktop para Linux.deb` | instala o Ergon no Linux (sem Docker) |
| `Instalar Ergon no Linux e macOS.sh` | instala o Ergon no macOS (pacote com contêineres) |
| `docs/` | guias: instalar, desktop, loja, rotinas, conexões, novidades ([CHANGELOG](docs/CHANGELOG.md)) |
| `catalogo/` | modelos da comunidade que a loja lista |
| `codigo-fonte/` | o código do Ergon, para quem quer estudar ou contribuir ([como](.github/CONTRIBUTING.md)) |

## Licença

Código aberto, [Apache-2.0](LICENSE). Componentes de terceiros e as licenças deles: [NOTICE](NOTICE).
Encontrou uma falha de segurança? Veja [.github/SECURITY.md](.github/SECURITY.md).
