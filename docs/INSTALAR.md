# Instalar o Ergon neste computador

O Ergon roda em dois contêineres Docker (o Ergon e o motor de IA) e só aparece para este computador
(`http://localhost:8787`). Tudo o que ele guarda fica cifrado com a sua senha.

## Antes

- **Docker Desktop** (Windows e macOS) ou **Docker Engine** (Linux), ligado.
- Linux: o motor usa FUSE para o volume cifrado (`/dev/fuse`, presente nas distribuições comuns).
- Recomendado: criptografia do disco do sistema (BitLocker, FileVault ou LUKS). Não é obrigatória — os dados do
  Ergon já são cifrados por ele —, mas protege o resto do computador.

## Instalar

1. Baixe `ergon-local-<versão>.zip` na [página de versões](https://github.com/MagnoQuerino/ergon-community/releases/latest)
   e descompacte numa pasta sua, fora de pastas sincronizadas (OneDrive, Dropbox, Google Drive).
2. Na pasta do Ergon:

```
Windows:       .\ergon.cmd instalar
macOS/Linux:   ./ergon.sh instalar
```

O lançador instala o Ergon numa pasta sua (Windows: `%LOCALAPPDATA%ProgramsErgon`; macOS/Linux:
`~/.local/share/ergon`) e põe o comando `ergon` no PATH: depois disso, use `ergon` de qualquer terminal novo e
apague a pasta do zip se quiser. Ele também gera os segredos internos em `~/.ergon/secrets` (nunca no OneDrive), sobe os
contêineres, deixa o ajudante do computador pronto (ele começa sozinho ao entrar no computador) e abre o
navegador. No primeiro acesso:

1. Crie a conta (usuário e senha — uma frase de 3 ou 4 palavras é forte e fácil de lembrar).
2. O Ergon mostra **uma vez** a frase de recuperação de 24 palavras. Anote em papel e confirme 3 delas.
   Sem a senha e sem a frase, ninguém abre os dados — nem nós.
3. O Ergon pergunta se deve **destrancar sozinho ao ligar o computador** (explicado abaixo).
4. Em **Configurações › IA da equipe**, conecte uma conta de IA para os agentes trabalharem.
5. Em **Conexões**, conecte seus apps de tarefas (Trello, Jira, Asana, monday.com, ClickUp, Notion…).

Quer uma janela própria em vez do navegador? Instale também o [Ergon Desktop](DESKTOP.md).

## No dia a dia

| Comando | O que faz |
|---|---|
| `ergon iniciar` / `ergon parar` | liga e desliga |
| `ergon status` | estado e versão |
| `ergon backup` | backup completo e conferido (banco, arquivos, conexões) numa pasta em `~/.ergon/backups` |
| `ergon restaurar <pasta>` | volta a um backup (veja abaixo) |
| `ergon atualizar` | backup + versão nova (o Ergon avisa quando sai uma); a atual fica guardada e, se a nova não responder, volta sozinho para ela |
| `ergon logs` | últimas linhas, para diagnóstico |
| `ergon remover` | tira o Ergon do computador e **guarda os dados** (conversas, tarefas, arquivos, conexões, segredos e backups): instalar de novo volta de onde parou |
| `ergon remover --tudo` | tira o Ergon e **apaga** os dados, os segredos e os backups (pede para digitar APAGAR) |

## Backup e restauração

O backup é uma pasta `ergon-<data>` com o banco, os arquivos (anexos e entregas), as credenciais das conexões
(inclusive a sessão do WhatsApp) e um manifesto com a impressão digital (SHA-256) de cada arquivo. Com o Ergon
protegido, tudo sai cifrado: o backup só abre com a **senha ou a frase de recuperação daquela época** — guarde as
duas. A chave do "sem trancamento" não vai junto (é só deste computador).

`ergon restaurar <pasta>` confere o backup inteiro antes de mexer em qualquer coisa, mostra a data e o que tem,
pergunta, e só então troca. O que estava no lugar **não é apagado**: vai para `/data/backups/pre-restore-<data>`
no volume, e `ergon desfazer-restauracao pre-restore-<data>` volta ao que era.

**Em outro computador**: `ergon instalar`, **não crie a conta**, e rode `ergon restaurar <pasta>`. Depois, entre
com a senha (ou a frase) da época do backup. Ficam de fora e precisam ser refeitos: a conta de IA dos agentes
(**Configurações › IA da equipe**, a memória do motor de IA fica no computador antigo) e os segredos desta
instalação em `~/.ergon/secrets` (copie a pasta junto se usa o app Google próprio). Se você já tinha criado uma
conta no computador novo, o Ergon avisa que o backup é de outra instalação e guarda o motor de IA de lá antes de
começar um novo.

## Depois de reiniciar o computador

Desligado, os dados ficam trancados até alguém digitar a senha em `http://localhost:8787` — e só então os
agentes voltam a trabalhar. Ligado (botão em **Configurações › Segurança**, ou no aviso do primeiro acesso), o
Ergon destranca sozinho ao ligar o computador e os agentes seguem trabalhando.

Quem guarda a chave é o ajudante do Ergon, que roda na sua conta do computador: ela fica no cofre do sistema
(proteção de dados do Windows, Chaves do macOS, libsecret no Linux), presa à sua conta — quem entrar nela abre o
Ergon sem a senha. Recomendado se o computador é só seu e tem senha, PIN ou biometria. Desligar pelo mesmo botão
invalida a chave na hora. Para tirar o ajudante do computador: `ergon ajudante remover`.

## Esqueceu a senha?

Na tela de entrada, **Esqueci a senha**: usuário, as 24 palavras e uma senha nova.
