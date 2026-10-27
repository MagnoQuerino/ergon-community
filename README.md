# Ergon Community

**Uma equipe de agentes de IA que trabalha no seu computador.** Doze personagens históricos — Aristóteles na
coordenação, Hipátia na pesquisa, Arquimedes nos números, Fídias no design e outros — dividem as tarefas, conversam
com você, montam planos, entregam resultados e mostram o trabalho numa cidade em pixel art inspirada em Alexandria.

O Ergon Community roda inteiro na sua máquina, em Docker. Não precisa de conta e não envia seus dados para servidores
do projeto. A interface e os seus dados funcionam sem internet; a IA dos agentes usa a conta de IA que você conectar.

- **Conversa e quadro de tarefas.** Peça na conversa ou crie cards; a coordenação distribui, acompanha e entrega.
  Uma tarefa só é dada como concluída com evidência.
- **Rotinas.** Briefing do dia, guardião de prazos, radar de compromissos, revisão de contratos, conferência
  financeira e outras — com o que foi lido e conferido sempre à vista.
- **Treinar.** Ensine uma competência a um agente com texto, documentos e links; você revisa e aprova antes do uso.
- **Conexões.** Trello, Jira, Asana, monday.com, ClickUp, Notion, Pipefy, Todoist, Linear e GitHub Projects;
  Microsoft 365 e Google em leitura, com um app registrado por você ([Microsoft](docs/MICROSOFT.md),
  [Google](docs/GOOGLE.md)); WhatsApp experimental, somente leitura.
- **Seis skins da cidade.** Distrito Platina (corporativa), Reino de Brumaverde (fantasia), Base Siroco (militar),
  Enseada Coral (praia), Vila Ronrom (tranquila, com gatos) e Cromo-9 (néon): prédios, roupas, paisagem e até 10
  personagens com nome e bio. Só aparência.
- **Loja de pacotes.** Skins, temas, efeitos, pets e equipes prontas por área: os oficiais vêm junto e funcionam
  sem internet; os **modelos da comunidade** aparecem quando você pede.
- **Privado por padrão.** Banco e arquivos cifrados com a sua senha, frase de recuperação de 24 palavras, 2º fator
  opcional (TOTP e passkeys), backup conferido e restauração com desfazer.

## Instalar

Você precisa do **Docker Desktop** (Windows e macOS) ou do **Docker Engine** (Linux).

1. Baixe `ergon-local-<versão>.zip` na [página de versões](https://github.com/MagnoQuerino/ergon-community/releases/latest)
   e descompacte numa pasta sua (fora de pastas sincronizadas, como OneDrive ou Dropbox).
2. Na pasta:

   ```
   Windows:       .\ergon.cmd instalar
   macOS/Linux:   ./ergon.sh instalar
   ```

3. O navegador abre em `http://localhost:8787`. Crie a conta, anote a frase de recuperação e conecte uma conta de IA
   em **Configurações › IA da equipe**.

Detalhes, backup, atualização e o que fazer se esquecer a senha: [docs/INSTALAR.md](docs/INSTALAR.md).

### Aplicativo desktop (opcional)

O **Ergon Desktop** abre o mesmo Ergon numa janela própria, confere o Docker e liga os serviços quando você pede.
Na mesma página de versões: instalador `.exe` para Windows, `.deb` e `.AppImage` para Linux. Ele usa a instalação
acima; veja [docs/DESKTOP.md](docs/DESKTOP.md).

## Atualizar

`ergon atualizar` faz um backup, baixa a versão nova e volta sozinho para a anterior se a nova não responder. As
imagens Docker, o pacote local e os instaladores do desktop saem juntos, sempre com o mesmo número de versão.

## Loja e modelos da comunidade

Em **Configurações › Pacotes**, a aba **Oficiais** traz os pacotes assinados que vêm com o Ergon. A aba **Modelos da
comunidade** lê o catálogo público deste repositório ([catalogo/](catalogo/)) só quando você abre a aba; sem
internet, nada muda no que já está instalado. Cada modelo baixado é conferido (tamanho e SHA-256) e aparece como
"não verificado". Para criar e enviar um modelo, veja [docs/LOJA.md](docs/LOJA.md) e [CONTRIBUTING.md](CONTRIBUTING.md).

## WhatsApp (experimental)

A leitura do WhatsApp por QR code usa uma biblioteca não oficial e pode levar à restrição do número. Ela fica
desligada até você ler as informações e os riscos e confirmar, em **Conexões**. Veja [docs/WHATSAPP.md](docs/WHATSAPP.md).

## Desenvolvimento

```
npm ci
npm test            # servidor e interface
docker build --target test .
```

O servidor é Node.js (TypeScript, Fastify, SQLite), a interface é React com a cidade em Canvas 2D, e o motor dos
agentes é o [Hermes Agent](https://github.com/NousResearch/hermes-agent) com um plugin próprio (`hermes/`). O
aplicativo desktop é Tauri 2 (`desktop/`).

## Licença

[Apache-2.0](LICENSE). Componentes de terceiros e as licenças deles: [NOTICE](NOTICE).
