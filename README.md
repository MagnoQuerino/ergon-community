# Ergon Community

**Uma equipe de agentes de IA que trabalha no seu computador.** Doze personagens históricos — Aristóteles na
coordenação, Hipátia na pesquisa, Arquimedes nos números, Fídias no design e outros — dividem as tarefas, conversam
com você, montam planos, entregam resultados e mostram o trabalho numa cidade em pixel art inspirada em Alexandria.

Roda inteiro na sua máquina. Não precisa de conta e não envia seus dados para servidores do projeto. A IA dos
agentes usa a conta de IA que você conectar.

## Instalar

### Windows 10 e 11

Baixe e abra **[`Ergon Desktop para Windows.exe`](Ergon%20Desktop%20para%20Windows.exe)** (aqui na raiz). Ele instala
tudo sozinho num ambiente próprio do Ergon, separado do resto do computador: **não precisa instalar Docker** nem outro
programa. Se o Windows ainda não tiver o recurso de ambientes Linux ligado, o instalador liga e pede um reinício; depois
continua de onde parou. No fim o Ergon abre numa janela: crie a conta, anote a frase de recuperação e conecte uma
conta de IA. Atualizações aparecem em **Configurações › Verificar atualizações**.

### Linux (Ubuntu 24.04 ou mais novo, Debian 12)

Baixe e abra **[`Ergon Desktop para Linux.deb`](Ergon%20Desktop%20para%20Linux.deb)** com o instalador de aplicativos
do sistema. O pacote traz o que o Ergon precisa (o Podman, motor de contêineres de código aberto) e **não instala
Docker**. Abra o Ergon pelo menu: ele se instala na sua conta, sem pedir administrador, e abre numa janela. Crie a
conta, anote a frase de recuperação e conecte uma conta de IA. Mais detalhes: [docs/DESKTOP.md](docs/DESKTOP.md).

### macOS

Por enquanto pelo pacote com contêineres, com o [Podman](https://podman.io) instalado e ligado: baixe esta pasta (botão
verde **Code › Download ZIP**), descompacte e, num terminal, dentro da pasta: `bash "Instalar Ergon no Linux e macOS.sh"`.
Passo a passo e o que fazer se esquecer a senha: [docs/INSTALAR.md](docs/INSTALAR.md).

Todas as versões, com as somas SHA-256 para conferir os arquivos, ficam na
[página de versões](https://github.com/MagnoQuerino/ergon-community/releases/latest).

## O que vem

- **Conversa e quadro de tarefas.** Peça na conversa ou crie cards; a coordenação distribui, acompanha e entrega.
  Uma tarefa só é dada como concluída com evidência.
- **Rotinas.** Briefing do dia, guardião de prazos, radar de compromissos, revisão de contratos, conferência
  financeira e outras, com o que foi lido e conferido sempre à vista ([docs/ROTINAS.md](docs/ROTINAS.md)).
- **Treinar.** Ensine uma competência a um agente com texto, documentos e links; você revisa e aprova antes do uso.
- **Conexões.** Trello, Jira, Asana, monday.com, ClickUp, Notion, Pipefy, Todoist, Linear e GitHub Projects;
  Microsoft 365 e Google em leitura ([Microsoft](docs/MICROSOFT.md), [Google](docs/GOOGLE.md)); WhatsApp
  experimental, somente leitura ([riscos](docs/WHATSAPP.md)).
- **Seis skins da cidade.** Distrito Platina, Reino de Brumaverde, Base Siroco, Enseada Coral, Vila Ronrom e
  Cromo-9: prédios, roupas, paisagem e até 10 personagens com nome e bio. Só aparência.
- **Loja de pacotes.** Skins, temas, efeitos, pets e equipes prontas: os oficiais vêm junto e funcionam sem
  internet; os **modelos da comunidade** ([catalogo/](catalogo/)) aparecem quando você pede ([docs/LOJA.md](docs/LOJA.md)).
- **Privado por padrão.** Banco e arquivos cifrados com a sua senha, frase de recuperação de 24 palavras, 2º fator
  opcional (TOTP e passkeys), backup conferido e restauração com desfazer.

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

[Apache-2.0](LICENSE). Componentes de terceiros e as licenças deles: [NOTICE](NOTICE).
Falhas de segurança: [.github/SECURITY.md](.github/SECURITY.md).
