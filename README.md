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

### Linux e macOS

Por enquanto o caminho é o pacote com contêineres:

1. Baixe esta pasta: botão verde **Code › Download ZIP**, no topo desta página. Descompacte numa pasta sua, fora
   do OneDrive, Dropbox ou Google Drive.
2. Num terminal, dentro da pasta: `bash "Instalar Ergon no Linux e macOS.sh"`.
3. No fim, o navegador abre o Ergon. Crie a conta, anote a frase de recuperação e conecte uma conta de IA em
   **Configurações › IA da equipe**.

Passo a passo completo e o que fazer se esquecer a senha: [docs/INSTALAR.md](docs/INSTALAR.md). No Linux, o
**`Ergon Desktop para Linux.deb`** abre o mesmo Ergon numa janela ([docs/DESKTOP.md](docs/DESKTOP.md)).

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
| `Instalar Ergon no Linux e macOS.sh`, `Ergon Desktop para Linux.deb` | instalam o Ergon no Linux e macOS |
| `docs/` | guias: instalar, desktop, loja, rotinas, conexões, novidades ([CHANGELOG](docs/CHANGELOG.md)) |
| `catalogo/` | modelos da comunidade que a loja lista |
| `codigo-fonte/` | o código do Ergon, para quem quer estudar ou contribuir ([como](.github/CONTRIBUTING.md)) |

## Licença

[Apache-2.0](LICENSE). Componentes de terceiros e as licenças deles: [NOTICE](NOTICE).
Falhas de segurança: [.github/SECURITY.md](.github/SECURITY.md).
