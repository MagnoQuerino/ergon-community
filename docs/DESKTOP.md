# Ergon Desktop

O Ergon Desktop é o mesmo Ergon numa janela própria. A interface é a do Ergon local (`http://localhost:8787`),
servida pelos mesmos serviços. No Windows o aplicativo também instala o Ergon, num ambiente próprio (sem Docker
Desktop). O aplicativo acrescenta:

- uma janela com o nome e o ícone do Ergon;
- uma tela de abertura que confere o ambiente e, quando você pede, liga os serviços;
- atalho, menu de aplicativos, bandeja e navegador padrão para links externos.

O navegador continua sendo uma alternativa: tudo o que a janela mostra também abre em `http://localhost:8787`.

## Antes

No Windows, nada antes: o aplicativo instala o Ergon. No Linux, ele abre o Ergon instalado neste computador:
instale o Ergon primeiro ([INSTALAR.md](INSTALAR.md)); sem ele, a tela de abertura explica o que falta.

## Windows 10 e 11

1. Baixe `Ergon_X.Y.Z_x64-setup.exe` na [página de versões](https://github.com/MagnoQuerino/ergon-community/releases/latest)
   e, se quiser, confira a soma em `SHA256SUMS-windows.txt`.
2. Abra o instalador. Ele instala só para a sua conta, sem pedir administrador.
   - O instalador não tem certificado de assinatura de código: o SmartScreen avisa na primeira vez. Clique em
     "Mais informações" › "Executar assim mesmo".
   - Sem o WebView2 no computador (raro no Windows 11), o instalador baixa o oficial da Microsoft.
3. Abra "Ergon" pelo menu Iniciar. Na primeira vez ele instala o ambiente próprio do Ergon (se o Windows pedir,
   reinicie: a instalação continua sozinha). Não precisa instalar Docker.
4. Crie a conta, anote a frase de recuperação e conecte uma conta de IA.

Atualizar: Configurações › Verificar atualizações (seus dados ganham uma cópia antes). Remover: Configurações ›
Aplicativos › Ergon › Desinstalar; o desinstalador pergunta se apaga também os dados.

## Linux (Ubuntu 24.04 ou mais novo, Debian 12)

**Pacote .deb (recomendado).** Baixe `Ergon_X.Y.Z_amd64.deb` (ou o `Ergon Desktop para Linux.deb` da raiz do
repositório), confira a soma em `SHA256SUMS-linux.txt` se quiser e abra o arquivo com o instalador de aplicativos do
sistema. O pacote traz o que o Ergon precisa: o Podman (motor de contêineres de código aberto, sem serviço de
administrador) e as peças de rede dele; **não instala Docker**. Na primeira vez, a tela de abertura instala o Ergon na
sua conta (`~/.local/share/ergon`, segredos em `~/.ergon`), sem pedir administrador, e abre a janela.

Uma instalação antiga feita com o Docker continua funcionando com ele, sem ser alterada.

**AppImage (alternativa).** `Ergon_X.Y.Z_amd64.AppImage` roda sem instalar: marque como executável e abra. Precisa do
FUSE 2 (`libfuse2`, ou `libfuse2t64` no Ubuntu 24.04) e do Podman e do podman-compose do sistema. Não entra no menu
sozinho e não se atualiza.

Remover: pelo instalador de aplicativos. Os dados ficam nos volumes do Podman da sua conta.

## Registros

Botão "Abrir a pasta de registros" no diagnóstico da tela de abertura. Windows:
`%LOCALAPPDATA%\io.github.magnoquerino.ergon\logs`; Linux: `~/.local/share/io.github.magnoquerino.ergon/logs`.

## Versões

- **Uma versão só.** Cada versão publica, juntos e com o mesmo número: as imagens Docker, o pacote local, o
  instalador Windows, o `.deb` e o AppImage, com as somas `SHA256SUMS-*.txt`.
- **Atualizar a janela não atualiza os serviços.** Os serviços são atualizados por `ergon atualizar` (com backup
  antes). O aplicativo confere se o Ergon instalado é compatível e, se não for, avisa e oferece o navegador.
- **Sem atualização automática do aplicativo nesta versão.** A versão nova se instala por cima com o instalador
  novo; os dados ficam, porque estão no Docker.

## Compilar

```bash
cd desktop
npm ci
npx tauri build
```

Precisa do Rust (1.98) e, no Linux, das bibliotecas do WebKitGTK (`libwebkit2gtk-4.1-dev` e afins). A CI compila e
testa no Windows e no Linux a cada mudança em `desktop/` (`.github/workflows/desktop.yml`).
