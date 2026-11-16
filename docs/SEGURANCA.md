# Segurança do Ergon (versão local)

O Ergon guarda a vida de trabalho de uma pessoa e tem permissão para agir por ela. O desenho parte daí: quem
tiver o disco (ou um backup) não lê nada sem a senha ou a frase; quem tiver a sessão aberta não troca a segurança
sem confirmar quem é.

## Chaves

```
senha (Argon2id) ─┐
frase de 24 palavras (Argon2id) ─┼─► chave mestra (256 bits, aleatória) ─┬─► chave do banco (SQLCipher)
destrancar sozinho (cofre do SO) ─┤          (keyring.json)               ├─► chave de cada workspace → campos e arquivos (AES-256-GCM)
sem trancamento (unlock.key) ─────┘                                        │
                                                                           └─► chave do cofre do motor (gocryptfs)
```

- `keyring.json` (no volume de dados) guarda só a chave mestra **embrulhada** por cada forma de abrir. Trocar a
  senha reembrulha; nada é recifrado.
- A chave mestra existe só na memória do processo do Ergon enquanto está aberto — e, **sem trancamento**, também
  embrulhada por uma chave que fica em `unlock.key`, ao lado dos dados (ver abaixo).
- Argon2id: 128 MiB, 3 passadas. Senha: mínimo de 12 caracteres e força mínima (zxcvbn com dicionário pt-BR).

## O que fica cifrado

| Dado | Como |
|---|---|
| Banco inteiro | SQLCipher (AES-256), chave derivada da chave mestra |
| Conversas, tarefas, instruções, saídas, auditoria, regras, propostas, contas | AES-256-GCM por workspace (`ev1.`), por cima do banco |
| Arquivos enviados, segredos das conexões, sessão do WhatsApp | AES-256-GCM por workspace (`EF1`) |
| Dados do motor de IA | volume gocryptfs; a vista aberta só existe na memória do contêiner |
| Backups | o banco sai cifrado; o keyring daquele momento vai junto |

## Abrir, trancar, confirmar

- **Trancamento** (Configurações › Segurança): **desligado por padrão no computador**. Desligado, o Ergon abre
  sozinho ao reiniciar: a chave de um embrulho próprio do keyring fica em `unlock.key` (volume de dados, só para o
  servidor, gravação atômica) e a sessão vale 90 dias, renovada com o uso. A proteção do acesso passa a ser a do
  computador (senha ou biometria do Windows, criptografia do disco, não deixar a máquina desbloqueada): quem usar
  este computador ou copiar o volume de dados inteiro abre o Ergon. O banco e os arquivos continuam cifrados — quem
  levar só o banco ou um backup não lê nada (o backup não leva `unlock.key`). Desligar mostra antes um aviso curto
  desses riscos e pede confirmação recente da identidade; ligar apaga a chave e volta a sessão a 7 dias. Tudo fica
  na auditoria (`security.lock.on/off`). Uma instalação já protegida recebe o padrão uma vez, na próxima abertura.
  Na nuvem é sempre ligado.
- **Depois de reiniciar, com o trancamento ligado**: um portão mínimo serve só a tela "Ergon trancado". Senha ou
  frase abrem; passkey e autenticador não (não guardam a chave). O motor de IA espera a chave do Ergon para subir.
- **Destrancar sozinho** (com o trancamento ligado; botão em Configurações › Segurança): o Ergon, no
  Docker, não alcança o cofre do sistema; um ajudante na conta da pessoa (`ergon.sh ajudante`,
  iniciado ao entrar no computador, autenticado por um token próprio em `ergon.env`) busca uma chave aleatória
  quando o botão é ligado, guarda no cofre do sistema e destranca o Ergon quando ele reinicia. Desligar remove a
  chave do keyring e o ajudante apaga a dele.
- **Inatividade**: desligada por padrão; ligada em Configurações › Segurança, a tela tranca depois do tempo que você escolher (1 min a 24 h; só mouse/teclado contam); nada fica visível atrás. Os agentes
  continuam. Destranca com a senha ou a passkey — o autenticador fica só para o login.
- **Confirmação de identidade** (5 min): frase nova, autenticador, passkeys, destrancar sozinho, ferramentas que executam código — com a senha ou a passkey.
- **2º fator** opcional neste computador (autenticador TOTP, passkeys WebAuthn), pedido no login; obrigatório na nuvem. Depois de entrar, destrancar a tela e confirmar ações pedem só a senha ou a passkey (pedido do fundador: o código a cada trava era incômodo demais).
- **Freio de tentativas**: 5 erros → espera crescente (30 s, 1 min, … até 1 h).
- Passkeys valem para `localhost` (quem abre por `127.0.0.1` é levado para `localhost`).

## Modelo de ameaça (Operação Robustez, 25/10/2026)

Três jeitos de abrir depois de reiniciar, do mais conveniente ao mais protegido. Os dados ficam cifrados no disco
nos três; muda **onde está a chave** e, portanto, quem consegue abrir sem você.

| Modo | Onde fica o que abre | Abre sozinho e as rotinas rodam depois de reiniciar? |
|---|---|---|
| **Sem trancamento** (padrão das instalações novas) | `unlock.key`, no mesmo volume dos dados | sim |
| **Trancado + destrancar sozinho** | no cofre do sistema (DPAPI no Windows, Chaves no macOS, libsecret no Linux), preso à sua conta do computador; o ajudante entrega ao Ergon | sim, quando você entra no computador |
| **Trancado** | só na sua cabeça (senha) e no papel (frase) | não: espera a senha |

| Ameaça | Sem trancamento | Trancado + destrancar sozinho | Trancado |
|---|---|---|---|
| Alguém leva **só o banco** ou **um backup** | protegido (backup não leva `unlock.key`) | protegido | protegido |
| Alguém copia **o volume de dados inteiro** (outro usuário com admin, cópia do disco do Docker, imagem da VM) | **exposto**: a chave vai junto | protegido (a chave não está no volume) | protegido |
| Disco do computador roubado **sem** BitLocker/FileVault | **exposto** | protegido enquanto a conta do Windows tiver senha (DPAPI) | protegido |
| Disco roubado **com** BitLocker/FileVault | protegido pelo disco | protegido | protegido |
| Alguém usa o computador **desbloqueado**, na sua conta | **exposto** (o Ergon está aberto) | **exposto** | exposto enquanto o Ergon estiver aberto; a trava por inatividade ajuda |
| Outra conta do Windows no mesmo computador | exposto se tiver admin (lê o volume) | protegido (DPAPI é por conta) | protegido |
| Código de agente no motor (Terminal, Executar código) | não lê a chave do Ergon (contêiner separado, sem o volume do Ergon); sem privilégio de montagem desde a Operação Robustez | igual | igual |

Recomendação por cenário:
- **Computador pessoal, só seu, com senha e BitLocker/FileVault**: qualquer um serve; *sem trancamento* é aceitável.
- **Computador pessoal sem criptografia de disco**: *trancado + destrancar sozinho*.
- **Computador compartilhado ou corporativo (outras pessoas com admin, backup da empresa, imagem gerenciada)**:
  *trancado + destrancar sozinho* ou *trancado*. Nunca *sem trancamento*.

Regras: escolher fica com o usuário, na tela de Segurança, com o aviso; **atualizar o Ergon nunca afrouxa** o modo
(instalação que chega protegida a uma versão nova continua trancada até a pessoa escolher outra coisa); desligar o
trancamento pede confirmação recente da identidade. Ferramentas que executam código só são liberadas com a senha —
também quando a proposta vem da coordenação (antes, um clique bastava; corrigido nesta operação).

## Rede e contêineres

- Porta só em `127.0.0.1`. Motor sem porta publicada, sem socket Docker, sem pasta pessoal.
- Ergon: sistema de arquivos só leitura, sem capacidades, `no-new-privileges`.
- Motor: só `/dev/fuse` + `SYS_ADMIN` (montar o cofre); a chave chega pela rede interna com o token da ponte. Logo
  depois de montar, o processo 1 tira `CAP_SYS_ADMIN` do conjunto-limite: o motor e os programas dos agentes nascem
  sem ele (só o gocryptfs, que serve o cofre, mantém). `no-new-privileges` ligado; sem `NET_RAW`, `MKNOD`,
  `AUDIT_WRITE` e `SETFCAP`. AppArmor continua desligado no motor (o perfil padrão do Docker proíbe montar FUSE);
  próximo passo possível: cofre num contêiner próprio, se a propagação de montagem entre contêineres funcionar no
  Podman.

## Migração de instalações antigas

"Proteger o Ergon" (pedido no primeiro acesso depois de atualizar): confere a senha (troca se for fraca), cifra
o banco no lugar, cifra campos e arquivos existentes e mostra a frase. O motor copiou os dados antigos para o
cofre na primeira abertura com o cofre (o volume antigo era montado só para leitura em `/legacy`; esse passo saiu do
`ergon-vault.py` na rc.29, porque nenhuma versão que ainda atualiza pelo app monta o volume; a marca e a limpeza abaixo
ficam, para os cofres que fizeram a cópia).

**O volume antigo `<projeto>_hermes-data` (em texto aberto) sai sozinho** (rc.25), sem comando nenhum, quando é
seguro. O Ergon só pede ao gerente de motores (`POST /v1/maintenance/dados-antigos`) depois que o cofre herdado
(`<projeto>_hermes-vault`, para onde a cópia foi feita) abriu com a chave da pessoa que o herdou
(`motor_legacy_rekeyed`), a equipe dela está aberta naquele momento e o próprio cofre prova que recebeu a cópia: a
marca `.ergon-vault` que `ergon-vault.py` grava ao criar o cofre (`{"migrated_from_legacy": true}`), lida pelo plugin
e informada na saúde da ponte (`dados_antigos`). Sem a prova (plugin de antes), pergunta de novo na próxima abertura;
com `false` (cofre criado sem a cópia), o volume antigo nunca sai sozinho. O gerente confere de novo, com a operação dessa
pessoa travada: o cofre herdado existe e é o montado em `/vault` no motor dela (desta instalação); o volume antigo
não tem a marca de outra instalação nem rótulos de outro projeto do Compose; e nenhum contêiner, nem parado, o usa.
Só então apaga — esse volume, pelo nome exato derivado do cofre herdado (nunca um nome vindo do pedido), sem força.
Feito (ou se ele não existe), a marca `motor_dados_antigos_apagados` impede novas perguntas, e a Atividade registra
"a cópia antiga dos dados da equipe… foi apagada". Instalação sem cofre herdado (a primeira conta criou o próprio
cofre) não apaga nada: ali a cópia antiga nunca foi para dentro de um cofre. O `docker-compose.yml` não declara mais
o volume, para nenhuma atualização recriá-lo. Sem gerente (um motor só para todos), nada muda: o volume fica.

## O que sai deste computador

Sem o Ergon World, nada: tudo roda aqui. Com o Ergon World conectado (opcional, por escolha sua):

- **Só o workspace que você ligar** sincroniza, cifrado neste aparelho antes de sair. O World guarda o que não consegue ler. Os outros workspaces continuam só aqui.
- **Rodar na nuvem** leva só o card escolhido (tarefa, anexos de texto, perfil do agente e modelo), nunca arquivos do computador, conversas não relacionadas ou o cofre.
- A chave do seu provedor de IA fica cifrada no cofre deste computador, para continuar seus trabalhos na nuvem com o seu modelo. Ela vai para o World só junto de um trabalho que vai para a nuvem e é apagada lá quando ele termina. Login de assinatura (conta Claude, ChatGPT) nunca sai daqui.
- Relato de problema: só sai quando você clica em Enviar relato, depois de ver exatamente o que vai.
