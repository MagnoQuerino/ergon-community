<#
  Ergon — lançador local (Windows). Depois de instalar, use de qualquer terminal:  ergon <comando>

  Comandos (os nomes em português de antes continuam aceitos para sempre; a ajuda completa: ergon help):
    install (instalar) · uninstall (remover; aceita remove) · uninstall --purge (remover --tudo; aceita --all e --tudo)
    start (iniciar) · up (subir: só liga, é o que o Ergon Desktop usa) · stop (parar) · status · open (abrir)
    backup · restore <pasta> (restaurar) · restore --undo <pre-restore-…> (desfazer-restauracao; aceita undo-restore)
    update (atualizar; aceita upgrade) · clean (limpar) · logs · helper [install|uninstall] (ajudante
    [instalar|remover]) · docker [install|uninstall] (docker [instalar|remover]) · help · version

  Mensagens em português quando o Windows está em português e em inglês nos outros casos; ERGON_LANG=pt|en força.
  Confirmações: ERGON_CONFIRM (ou ERGON_CONFIRMAR). Sem abrir o navegador: ERGON_NO_BROWSER (ou ERGON_SEM_NAVEGADOR).

  Nunca exibe segredos. Não altera nada fora da pasta do Ergon, de %USERPROFILE%\.ergon, de %LOCALAPPDATA%\Ergon,
  de %LOCALAPPDATA%\Programs\Ergon e do PATH do usuário, dos atalhos do Ergon na pasta Inicializar e, com "docker
  install", da entrada do Docker no início do Windows e das pastas de sockets do Docker (que ele recria sozinho).
#>
# Sem bloco param: com ele, o PowerShell lê "--tudo", "--purge" ou "-h" como nomes de parâmetro e recusa o comando.
$Comando = if ($args.Count -ge 1) { [string]$args[0] } else { 'help' }
$Opcao = if ($args.Count -ge 2) { [string]$args[1] } else { '' }
$Opcao2 = if ($args.Count -ge 3) { [string]$args[2] } else { '' }
# "Continue": no Windows PowerShell 5.1, "Stop" transforma qualquer linha de stderr do docker/git em erro fatal.
# Falhas reais são tratadas pelo código de saída ($LASTEXITCODE) e por -ErrorAction Stop onde importa.
$ErrorActionPreference = 'Continue'
$Raiz = $PSScriptRoot
# cópia do código (desenvolvimento: constrói as imagens) ou pacote de versão (baixa as imagens publicadas)
$Fonte = (Test-Path (Join-Path $Raiz 'Dockerfile')) -and (Test-Path (Join-Path $Raiz 'server'))
$Local = if ($env:ERGON_LOCAL_DIR) { $env:ERGON_LOCAL_DIR } else { Join-Path $env:LOCALAPPDATA 'Ergon' }
$Backups = if ($env:ERGON_BACKUPS_DIR) { $env:ERGON_BACKUPS_DIR } else { Join-Path $HOME '.ergon\backups' }   # outra pasta: disco externo, por exemplo
$Manifesto = 'https://github.com/MagnoQuerino/ergon-community/releases/latest/download/latest.json'
$Inicializar = Join-Path ([Environment]::GetFolderPath('Startup')) 'Ergon - ajudante.vbs'
$Antigo = Join-Path ([Environment]::GetFolderPath('Startup')) 'Ergon - destravar.cmd'
$Guardada = Join-Path $Local 'destravar.json'
# onde o pacote fica instalado (o comando "ergon" aponta para cá); ERGON_PROGRAM_DIR: testes isolados
$Programa = if ($env:ERGON_PROGRAM_DIR) { $env:ERGON_PROGRAM_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\Ergon' }
$ArquivosDoPacote = @('ergon.ps1', 'ergon.cmd', 'ergon.sh', 'docker-compose.yml', 'LEIA-ME.md', 'VERSAO')

# ---------------------------------------------------------------- idioma das mensagens
# ERGON_LANG=pt|en força. Senão, o idioma da interface do Windows (e, se ele não disser, o do formato regional):
# português quando está em português; inglês nos outros casos.
function Get-Lingua {
  $f = "$env:ERGON_LANG".Trim()
  if ($f) { if ($f -match '^pt') { return 'pt' } else { return 'en' } }
  foreach ($c in @([Globalization.CultureInfo]::CurrentUICulture, [Globalization.CultureInfo]::CurrentCulture)) {
    $n = "$($c.TwoLetterISOLanguageName)"
    if ($n -and $n -ne 'iv') { if ($n -eq 'pt') { return 'pt' } else { return 'en' } }
  }
  return 'pt'
}
$EmIngles = (Get-Lingua) -eq 'en'
# T 'português' 'english': o texto no idioma das mensagens
function T([string]$pt, [string]$en = '') { if ($script:EmIngles -and $en) { return $en }; return $pt }
function Say([string]$m, [string]$en = '') { Write-Host "[ergon] $(T $m $en)" }
function Fail([string]$m, [string]$en = '') { Write-Host "[ergon] $(T $m $en)" -ForegroundColor Red; exit 1 }

function Read-DotEnv {
  $f = Join-Path $Raiz '.env'; $o = @{}
  if (Test-Path $f) { foreach ($l in Get-Content $f) { if ($l -match '^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$') { $o[$Matches[1]] = $Matches[2].Trim('"', "'") } } }
  return $o
}
$Env0 = Read-DotEnv
$Porta = if ($Env0['ERGON_PORT']) { $Env0['ERGON_PORT'] } else { '8787' }
$Url = "http://localhost:$Porta"
# nome do projeto Compose (volumes: <projeto>_ergon-data e <projeto>_hermes-vault)
$Projeto = if ($env:COMPOSE_PROJECT_NAME) { $env:COMPOSE_PROJECT_NAME } elseif ($Env0['COMPOSE_PROJECT_NAME']) { $Env0['COMPOSE_PROJECT_NAME'] } else { 'ergon' }
$Segredos = if ($Env0['ERGON_SECRETS_DIR']) { $Env0['ERGON_SECRETS_DIR'] } elseif ($env:ERGON_SECRETS_DIR) { $env:ERGON_SECRETS_DIR } else { Join-Path $HOME '.ergon\secrets' }

function Compose([string[]]$a) {
  Push-Location $Raiz
  try { & docker compose --profile hermes @a; if ($LASTEXITCODE -ne 0) { Fail "docker compose $($a -join ' ') falhou" "docker compose $($a -join ' ') failed" } } finally { Pop-Location }
}
function ComposeOut([string[]]$a) {
  Push-Location $Raiz
  try { $out = & docker compose --profile hermes @a 2>$null; if ($LASTEXITCODE -ne 0) { return $null }; return ($out -join "`n").Trim() } finally { Pop-Location }
}
function Test-Docker {
  & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'O Docker não está rodando. Abra o Docker Desktop e tente de novo.' 'Docker is not running. Open Docker Desktop and try again.' }
}
function Get-Health { try { return Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 5 -ErrorAction Stop } catch { return $null } }
function Wait-Health([int]$Segundos = 180) {
  $fim = (Get-Date).AddSeconds($Segundos)
  while ((Get-Date) -lt $fim) { $h = Get-Health; if ($h) { return $h }; Start-Sleep -Seconds 2 }
  return $null
}
function New-Token {
  $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return [Convert]::ToBase64String($b).TrimEnd('=').Replace('+', '-').Replace('/', '_')
}
function Protect-File([string]$f) {
  # só a conta atual lê o arquivo de segredos
  & icacls $f /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
}
function In-OneDrive([string]$p) {
  $r = @($env:OneDrive, $env:OneDriveCommercial, $env:OneDriveConsumer) | Where-Object { $_ }
  foreach ($x in $r) { if ($p.ToLower().StartsWith($x.ToLower())) { return $true } }
  return $p -match '[\\/]OneDrive( - [^\\/]+)?[\\/]'
}

# Onde esta instalação está (lido pelo Ergon Desktop para achar o lançador e a porta). Só caminho e porta.
function Register-Install {
  try {
    # o mesmo arquivo que o aplicativo lê: %USERPROFILE%\.ergon\instalacao.json (ERGON_INSTALACAO: testes isolados)
    $f = if ($env:ERGON_INSTALACAO) { $env:ERGON_INSTALACAO } else { Join-Path $env:USERPROFILE '.ergon\instalacao.json' }
    New-Item -ItemType Directory -Force -Path (Split-Path $f) | Out-Null
    $json = [ordered]@{ raiz = $Raiz; porta = [int]$Porta; atualizado = (Get-Date).ToString('s') } | ConvertTo-Json -Compress
    [IO.File]::WriteAllText($f, $json, (New-Object Text.UTF8Encoding $false))
  } catch { }
}

# ---------------------------------------------------------------- instalação fixa e "ergon" em qualquer terminal
# PATH do usuário (ERGON_PATH_FILE: testes guardam num arquivo em vez do registro)
function Get-UserPathRaw { if ($env:ERGON_PATH_FILE) { if (Test-Path $env:ERGON_PATH_FILE) { return (Get-Content $env:ERGON_PATH_FILE -Raw).Trim() }; return '' }; return [Environment]::GetEnvironmentVariable('Path', 'User') }
function Set-UserPathRaw([string]$v) { if ($env:ERGON_PATH_FILE) { Set-Content -Path $env:ERGON_PATH_FILE -Value $v; return }; [Environment]::SetEnvironmentVariable('Path', $v, 'User') }
function Get-UserPath { return @(((Get-UserPathRaw) -split ';') | Where-Object { $_ }) }
function Add-UserPath([string]$d) {
  $p = Get-UserPath
  if ($p | Where-Object { $_.TrimEnd('\') -ieq $d.TrimEnd('\') }) { return }
  Set-UserPathRaw (($p + $d) -join ';')
  Say "Comando ergon disponível em qualquer terminal novo (a pasta $d entrou no PATH do usuário)." "The ergon command is available in any new terminal (the folder $d was added to the user PATH)."
}
function Remove-UserPath([string]$d) {
  $p = Get-UserPath; $q = @($p | Where-Object { $_.TrimEnd('\') -ine $d.TrimEnd('\') })
  if ($q.Count -ne $p.Count) { Set-UserPathRaw ($q -join ';'); Say "A pasta $d saiu do PATH do usuário." "The folder $d was removed from the user PATH." }
}
function Same-Dir([string]$a, [string]$b) { return ([IO.Path]::GetFullPath($a).TrimEnd('\') -ieq [IO.Path]::GetFullPath($b).TrimEnd('\')) }
# Pacote de versão: copia o lançador e o compose para a pasta do programa e devolve essa pasta. Cópia do código
# (desenvolvimento): fica onde está, e o "ergon" passa a apontar para ela.
function Install-Program {
  if ($Fonte) { Add-UserPath $Raiz; Say "Cópia do código: o comando ergon usa esta pasta ($Raiz). Não a apague." "Source copy: the ergon command uses this folder ($Raiz). Do not delete it."; return $Raiz }
  if (Same-Dir $Raiz $Programa) { Add-UserPath $Programa; return $Programa }
  New-Item -ItemType Directory -Force -Path $Programa | Out-Null
  foreach ($a in $ArquivosDoPacote) { $o = Join-Path $Raiz $a; if (Test-Path $o) { Copy-Item -LiteralPath $o -Destination (Join-Path $Programa $a) -Force } }
  # o .env de uma instalação anterior (porta, opções) fica; o do zip só entra se não houver nenhum
  if ((Test-Path (Join-Path $Raiz '.env')) -and -not (Test-Path (Join-Path $Programa '.env'))) { Copy-Item (Join-Path $Raiz '.env') (Join-Path $Programa '.env') }
  Add-UserPath $Programa
  Say "Ergon instalado em $Programa." "Ergon installed in $Programa."
  return $Programa
}

# Tira o Ergon do computador. Sem -Tudo (uninstall --purge; ou --all, ou o --tudo de antes), os dados ficam (volumes
# do Docker, segredos e backups em ~/.ergon). Com ele, pede para digitar APAGAR (ou DELETE).
function Remove-Ergon([switch]$Tudo) {
  if ($Tudo) {
    Say 'Isto APAGA tudo o que o Ergon guardou neste computador: conversas, tarefas, agentes, conexões, arquivos, a memória do motor, os segredos e os backups. Não tem volta.' `
      'This DELETES everything Ergon kept on this computer: conversations, tasks, agents, connections, files, the engine memory, the secrets and the backups. It cannot be undone.'
    $r = if ($env:ERGON_CONFIRM) { $env:ERGON_CONFIRM } elseif ($env:ERGON_CONFIRMAR) { $env:ERGON_CONFIRMAR } else { Read-Host (T 'Para confirmar, digite APAGAR' 'To confirm, type DELETE') }
    if (-not (@('APAGAR', 'DELETE') -ccontains "$r".Trim())) { Fail 'Nada foi apagado.' 'Nothing was deleted.' }
  }
  if (Test-DockerUp) {
    # motores por pessoa (criados pelo gerente): os contêineres saem; os cofres deles são dados
    $motores = @(& $DockerCli ps -aq --filter 'label=ergon.motor' 2>$null)
    $cofres = @($motores | ForEach-Object { & $DockerCli inspect --format '{{ index .Config.Labels "ergon.motor.volume" }}' $_ 2>$null } | Where-Object { $_ })
    if ($motores.Count) { & $DockerCli rm -f @motores 2>$null | Out-Null }
    $down = @('down', '--remove-orphans', '--rmi', 'all'); if ($Tudo) { $down += '-v' }
    Push-Location $Raiz; try { & $DockerCli compose --profile hermes @down 2>$null | Out-Null } finally { Pop-Location }
    # as imagens dos dois repositórios do Ergon (o do serviço e o do motor de IA), de todas as versões, sem forçar
    Clear-Images -Tudo
    if ($Tudo) {
      $vols = @(& $DockerCli volume ls -q 2>$null | Where-Object { $_ -like "$($Projeto)_*" -or $cofres -contains $_ })
      if ($vols.Count) { & $DockerCli volume rm -f @vols 2>$null | Out-Null }
      Say 'Contêineres, imagens e volumes do Ergon apagados.' 'Ergon containers, images and volumes deleted.'
    } else { Say "Contêineres e imagens do Ergon removidos. Os dados ficaram guardados no Docker (volumes $($Projeto)_*)." "Ergon containers and images removed. The data was kept in Docker (volumes $($Projeto)_*)." }
  } else { Say 'O Docker não está rodando: contêineres, imagens e volumes ficam até você abrir o Docker e rodar "ergon uninstall" de novo.' 'Docker is not running: containers, images and volumes stay until you open Docker and run "ergon uninstall" again.' }
  Remove-Helper
  if (Test-Path $DockerAtalho) { Remove-DockerStart }
  $reg = if ($env:ERGON_INSTALACAO) { $env:ERGON_INSTALACAO } else { Join-Path $env:USERPROFILE '.ergon\instalacao.json' }
  Remove-Item -Force -ErrorAction SilentlyContinue $reg
  if ($Tudo) {
    foreach ($d in @($Segredos, $Backups, $Local, (Join-Path $env:USERPROFILE '.ergon'))) { if ($d -and (Test-Path $d)) { Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction SilentlyContinue } }
    Say 'Segredos, backups e registros do Ergon apagados.' 'Ergon secrets, backups and records deleted.'
  } else { Say "Segredos e backups guardados em $(Split-Path $Segredos)." "Secrets and backups kept in $(Split-Path $Segredos)." }
  Remove-UserPath $Programa; if (-not (Same-Dir $Raiz $Programa)) { Remove-UserPath $Raiz }
  if (-not $Fonte -and (Same-Dir $Raiz $Programa)) {
    # o próprio lançador está nesta pasta: ela sai alguns segundos depois de este comando terminar
    Start-Process -FilePath 'cmd.exe' -ArgumentList "/c ping -n 4 127.0.0.1 >nul & rd /s /q `"$Programa`"" -WindowStyle Hidden
    Say "A pasta $Programa sai em alguns segundos." "The folder $Programa will be removed in a few seconds."
  }
  if ($Tudo) { Say 'Pronto: o Ergon saiu deste computador, com os dados.' 'Done: Ergon was removed from this computer, along with its data.' }
  else { Say 'Pronto: o Ergon saiu deste computador. Para voltar com os mesmos dados: baixe o pacote e rode "ergon install".' 'Done: Ergon was removed from this computer. To come back with the same data: download the package and run "ergon install".' }
}

function Initialize-Secrets {
  if (In-OneDrive $Segredos) { Fail "Os segredos não podem ficar no OneDrive ($Segredos). Defina ERGON_SECRETS_DIR em outra pasta." "The secrets cannot be kept in OneDrive ($Segredos). Set ERGON_SECRETS_DIR to another folder." }
  New-Item -ItemType Directory -Force -Path $Segredos | Out-Null
  $ergon = Join-Path $Segredos 'ergon.env'; $hermes = Join-Path $Segredos 'hermes.env'
  if ((Test-Path $ergon) -or (Test-Path $hermes)) {
    Say "Segredos já existem em $Segredos (não alterados)." "Secrets already exist in $Segredos (left unchanged)."
    # instalações anteriores: acrescenta só o token do ajudante (valor não exibido)
    if ((Test-Path $ergon) -and -not (Select-String -Path $ergon -Pattern '^ERGON_AGENT_TOKEN=' -Quiet)) {
      Add-Content -Encoding ascii -Path $ergon -Value "ERGON_AGENT_TOKEN=$(New-Token)"; Say 'ergon.env: token do ajudante acrescentado.' 'ergon.env: helper token added.'
    }
  }
  else {
    $api = New-Token; $ponte = New-Token
    Set-Content -Encoding ascii -Path $ergon -Value @('# Ergon — segredos locais (não versionar, não sincronizar)', "ERGON_HERMES_API_KEY=$api", "ERGON_BRIDGE_TOKEN=$ponte", "ERGON_AGENT_TOKEN=$(New-Token)")
    Set-Content -Encoding ascii -Path $hermes -Value @('# Motor de IA do Ergon — segredos locais (não versionar, não sincronizar)', "API_SERVER_KEY=$api", "ERGON_BRIDGE_TOKEN=$ponte", "HERMES_DASHBOARD_SESSION_TOKEN=$(New-Token)")
    Protect-File $ergon; Protect-File $hermes
    Say "Segredos gerados em $Segredos (valores não exibidos)." "Secrets created in $Segredos (values not shown)."
  }
  $envf = Join-Path $Raiz '.env'
  $cur = if (Test-Path $envf) { Get-Content $envf -Raw } else { '' }
  $add = @()
  if ($cur -notmatch '(?m)^ERGON_SECRETS_DIR=') { $add += "ERGON_SECRETS_DIR=$($Segredos.Replace('\', '/'))" }
  if ($cur -notmatch '(?m)^ERGON_EXECUTOR=') { $add += 'ERGON_EXECUTOR=hermes' }
  if ($add.Count) { Add-Content -Encoding ascii -Path $envf -Value $add; Say '.env atualizado (só caminhos e opções, nenhum segredo).' '.env updated (only paths and options, no secrets).' }
}

function Up([switch]$NoFail) {
  # a saída do compose vai para a tela, não para o valor de volta (senão 'if (Up)' seria sempre verdadeiro)
  if ($Fonte) { Compose @('up', '-d', '--build') | Out-Host } else { Compose @('pull') | Out-Host; Compose @('up', '-d') | Out-Host }
  $h = Wait-Health 240
  if (-not $h) { if ($NoFail) { return $null }; Fail 'O Ergon não respondeu. Veja: .\ergon.cmd logs' 'Ergon did not respond. See: .\ergon.cmd logs' }
  if ($h.sealed) { Say "Ergon $($h.version) no ar e TRANCADO: abra $Url e digite a senha." "Ergon $($h.version) is running and LOCKED: open $Url and type the password." }
  else { Say "Ergon $($h.version) no ar em $Url" "Ergon $($h.version) is running at $Url" }
  return $h
}
# "0.3.1" > "0.3.0"? (versões que não são números: só "diferente")
function Test-Newer([string]$nova, [string]$atual) {
  if (-not $atual) { return $true }
  try { return ([version]($nova -replace '[^\d.].*$', '')) -gt ([version]($atual -replace '[^\d.].*$', '')) } catch { return $nova -ne $atual }
}

function Backup {
  $h = Get-Health
  if (-not $h) { Say 'Ergon parado: sem backup agora.' 'Ergon is stopped: no backup now.'; return $false }
  if ($h.sealed) { Say 'Ergon trancado: destranque para fazer o backup (a chave do banco só existe aberto).' 'Ergon is locked: unlock it to make the backup (the database key only exists while it is open).'; return $false }
  $nome = ComposeOut @('exec', '-T', 'ergon', 'node', 'server/src/backup-cli.ts')
  if (-not $nome) { Fail 'O backup falhou.' 'The backup failed.' }
  $id = ComposeOut @('ps', '-q', 'ergon')
  New-Item -ItemType Directory -Force -Path $Backups | Out-Null
  $dest = Join-Path $Backups $nome
  & docker cp "${id}:/data/backups/$nome" $dest | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "O backup ficou no volume (/data/backups/$nome), mas a cópia para $Backups falhou." "The backup is in the volume (/data/backups/$nome), but copying it to $Backups failed." }
  if ($nome -match '\.sqlite$') {
    # servidor de uma versão anterior: backup antigo (só o banco e o keyring) — vale, mas não leva arquivos e conexões
    & docker cp "${id}:/data/backups/$nome.keyring.json" (Join-Path $Backups "$nome.keyring.json") 2>$null | Out-Null
    Say "Backup (formato antigo: só o banco e o keyring; atualize o Ergon para o backup completo): $dest" "Backup (old format: only the database and the keyring; update Ergon for the full backup): $dest"
    Limit-Backups $nome
    return $true
  }
  if (-not (Test-Path -LiteralPath (Join-Path $dest 'manifest.json'))) { Fail "O backup ficou no volume (/data/backups/$nome), mas a cópia para $Backups saiu incompleta." "The backup is in the volume (/data/backups/$nome), but the copy to $Backups came out incomplete." }
  Say "Backup completo e conferido (banco, arquivos e conexões): $dest" "Full backup, checked (database, files and connections): $dest"
  Limit-Backups $nome
  return $true
}

# Ferramenta de restauração (server/src/restore-cli.ts) num contêiner de uso único com o volume de dados: funciona
# com o Ergon parado. Devolve a linha JSON que ela imprime.
function Invoke-Restore([string[]]$a, [string[]]$extra = @()) {
  Push-Location $Raiz
  try { $out = & docker compose --profile hermes run --rm --no-deps -T @extra ergon node server/src/restore-cli.ts @a 2>$null } finally { Pop-Location }
  $linha = @($out) | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
  if (-not $linha) { return [pscustomobject]@{ ok = $false; error = (T 'a ferramenta de restauração não respondeu' 'the restore tool did not respond') } }
  return ($linha | ConvertFrom-Json)
}
# cofre do motor: arquivos do usuário do motor (10000), com dono e permissões que o gocryptfs usa. O serviço do
# Ergon descarta todas as capacidades; este passo devolve só as de ler, copiar com dono e ajustar permissões.
$MotorRoot = @('--user', '0', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '-v', "${Projeto}_hermes-vault:/vault")
# sim? (s, sim, y, yes; maiúsculas também)
function Test-Yes([string]$r) { return "$r".Trim() -match '^(s|sim|y|yes)$' }
# confirmação: ERGON_CONFIRM (ou ERGON_CONFIRMAR) com sim/yes responde sem perguntar
function Confirm-Step([string]$pergunta) {
  $c = if ($env:ERGON_CONFIRM) { $env:ERGON_CONFIRM } else { $env:ERGON_CONFIRMAR }
  if (Test-Yes $c) { return $true }
  return (Test-Yes (Read-Host "$pergunta $(T '(s/N)' '(y/N)')"))
}

# Restaurar: confere o backup inteiro antes; para o Ergon; o que estava no lugar vai para
# /data/backups/pre-restore-<data> (nada é apagado); sobe de novo. Backup de outra instalação: o cofre do motor de
# IA desta máquina é de outra chave, então vai inteiro para o pre-restore e o motor começa um novo.
function Restore([string]$origem) {
  if (-not $origem) { Fail "Diga qual backup: .\ergon.cmd restore <pasta do backup>   (os backups ficam em $Backups)" "Say which backup: .\ergon.cmd restore <backup folder>   (backups are in $Backups)" }
  if (-not (Test-Path -LiteralPath $origem)) { $c = Join-Path $Backups $origem; if (Test-Path -LiteralPath $c) { $origem = $c } else { Fail "Não achei o backup $origem." "Backup not found: $origem." } }
  $origem = (Resolve-Path -LiteralPath $origem).Path
  if ((Split-Path $origem -Leaf) -eq 'manifest.json') { $origem = Split-Path $origem -Parent }
  $pasta = Test-Path -LiteralPath $origem -PathType Container
  if ($pasta -and -not (Test-Path -LiteralPath (Join-Path $origem 'manifest.json'))) { Fail 'Essa pasta não é um backup do Ergon (falta o manifest.json).' 'This folder is not an Ergon backup (manifest.json is missing).' }
  if (-not $pasta -and $origem -notmatch '\.sqlite$') { Fail 'Indique a pasta do backup (ou um backup antigo .sqlite).' 'Give the backup folder (or an old .sqlite backup).' }
  Test-Docker
  $id = ComposeOut @('ps', '-aq', 'ergon')
  if (-not $id) { Fail 'O Ergon não está instalado aqui. Rode .\ergon.cmd install e restaure antes de criar a conta.' 'Ergon is not installed here. Run .\ergon.cmd install and restore before creating the account.' }
  $carimbo = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fff') + 'Z'
  $entrada = "/data/backups/entrada-$carimbo"
  $p = Invoke-Restore @('preparar')
  if (-not $p.ok) { Fail "Não consegui preparar o volume do Ergon; nada foi alterado. $($p.error)" "Could not prepare the Ergon volume; nothing was changed. $($p.error)" }
  # o backup entra no volume como cópia (o original fica onde está)
  if ($pasta) { $alvo = $entrada; & docker cp $origem "${id}:$entrada" | Out-Null; $copiou = ($LASTEXITCODE -eq 0) }
  else {
    $tmp = Join-Path ([IO.Path]::GetTempPath()) "ergon-entrada-$carimbo"
    New-Item -ItemType Directory -Force -Path $tmp | Out-Null
    Copy-Item -LiteralPath $origem -Destination $tmp
    if (Test-Path -LiteralPath "$origem.keyring.json") { Copy-Item -LiteralPath "$origem.keyring.json" -Destination $tmp }
    & docker cp $tmp "${id}:$entrada" | Out-Null; $copiou = ($LASTEXITCODE -eq 0)
    Remove-Item -Recurse -Force -LiteralPath $tmp
    $alvo = "$entrada/$(Split-Path $origem -Leaf)"
  }
  if (-not $copiou) { Fail 'Não consegui copiar o backup para o volume do Ergon; nada foi alterado.' 'Could not copy the backup into the Ergon volume; nothing was changed.' }
  $c = Invoke-Restore @('conferir', $alvo)
  if (-not $c.ok) { Fail "O backup não confere; nada foi alterado. $($c.error) $(@($c.problems) -join '; ')" "The backup does not check out; nothing was changed. $($c.error) $(@($c.problems) -join '; ')" }
  if ($c.legacy) { Say 'Backup antigo: volta o banco (e o keyring); os arquivos e as conexões atuais ficam como estão.' 'Old backup: the database (and the keyring) come back; current files and connections stay as they are.' }
  else { Say "Backup de $($c.createdAt) (versão $($c.version)), conferido: $($c.counts.artifacts) arquivo(s), $($c.counts.secrets) credencial(is) de conexão." "Backup from $($c.createdAt) (version $($c.version)), checked: $($c.counts.artifacts) file(s), $($c.counts.secrets) connection credential(s)." }
  if ($c.keyring -eq 'outra') { Say 'É o backup de outra instalação: o motor de IA começa um cofre novo (o atual fica guardado).' 'This backup is from another installation: the AI engine starts a new vault (the current one is kept).' }
  if ($c.keyring -and $c.keyring -ne 'sem') { Say 'Depois, o Ergon pode pedir a senha (ou a frase de recuperação) da época do backup.' 'Afterwards, Ergon may ask for the password (or the recovery phrase) from the time of the backup.' }
  Say "O que está no lugar agora vai para /data/backups/pre-restore-$carimbo (nada é apagado)." "What is in place now goes to /data/backups/pre-restore-$carimbo (nothing is deleted)."
  if (-not (Confirm-Step (T 'Restaurar agora?' 'Restore now?'))) { Say 'Nada foi alterado.' 'Nothing was changed.'; return }
  $motor = ComposeOut @('ps', '-q', 'hermes')
  Compose @('stop', 'ergon')
  $r = Invoke-Restore @('restaurar', $alvo, $carimbo)
  if (-not $r.ok) { Compose @('start', 'ergon'); Fail "A restauração não foi feita; os dados atuais continuam no lugar. $($r.error)" "The restore was not done; the current data is still in place. $($r.error)" }
  if ($r.keyring -eq 'outra') {
    if ($motor) { Compose @('stop', 'hermes') }
    $m = Invoke-Restore @('motor', '/vault', "/data/backups/pre-restore-$carimbo/motor") $MotorRoot
    if (-not $m.ok) { Say "Atenção: o cofre do motor não foi posto de lado ($($m.error)); o motor pode não abrir com a chave restaurada." "Warning: the engine vault was not set aside ($($m.error)); the engine may not open with the restored key." }
  }
  Compose @('start', 'ergon')
  if ($motor) { Compose @('start', 'hermes') }
  $h = Wait-Health 240
  if (-not $h) { Fail "O Ergon não respondeu depois de restaurar. Para voltar: .\ergon.cmd restore --undo pre-restore-$carimbo" "Ergon did not respond after the restore. To go back: .\ergon.cmd restore --undo pre-restore-$carimbo" }
  if ($h.sealed) { Say "Restaurado. Abra $Url e digite a senha (ou a frase) da época do backup." "Restored. Open $Url and type the password (or the phrase) from the time of the backup." }
  else { Say "Restaurado. No ar em $Url." "Restored. Running at $Url." }
  Say "Para voltar ao que era antes: .\ergon.cmd restore --undo pre-restore-$carimbo" "To go back to how it was before: .\ergon.cmd restore --undo pre-restore-$carimbo"
}

function Undo-Restore([string]$pre) {
  if ($pre -notmatch '^pre-restore-[\w-]+$') { Fail 'Diga qual: .\ergon.cmd restore --undo pre-restore-<data>  (o nome aparece ao restaurar)' 'Say which one: .\ergon.cmd restore --undo pre-restore-<date>  (the name is shown when restoring)' }
  Test-Docker
  if (-not (Confirm-Step (T "Voltar ao que era antes da restauração $pre?" "Go back to how it was before the restore $pre?"))) { Say 'Nada foi alterado.' 'Nothing was changed.'; return }
  $carimbo = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fff') + 'Z'
  $motor = ComposeOut @('ps', '-q', 'hermes')
  Compose @('stop', 'ergon')
  $r = Invoke-Restore @('desfazer', "/data/backups/$pre")
  if (-not $r.ok) { Compose @('start', 'ergon'); Fail "Não deu para desfazer: $($r.error)" "Could not undo: $($r.error)" }
  if ($r.motor) {
    if ($motor) { Compose @('stop', 'hermes') }
    $m = Invoke-Restore @('motor-volta', '/vault', "/data/backups/$pre/motor", "$($r.aside)/motor") $MotorRoot
    if (-not $m.ok) { Say "Atenção: o cofre do motor não voltou ($($m.error))." "Warning: the engine vault did not come back ($($m.error))." }
  }
  Compose @('start', 'ergon')
  if ($motor) { Compose @('start', 'hermes') }
  Say "Voltou ao que era antes da restauração. O restaurado ficou guardado em $($r.aside)." "Back to how it was before the restore. The restored data was kept in $($r.aside)."
}

<#
  Atualizar: backup antes; versão nova só se for mais nova; a atual fica guardada; se a nova não responder, volta
  sozinho para a anterior. O banco não volta sozinho (a versão nova pode ter migrado): se nem a anterior responder,
  o lançador diz qual backup restaurar — restaurar é decisão de quem usa.
#>
function Update {
  $antesBackup = @(Get-ChildItem -Path $Backups -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  if (-not (Backup)) { if (-not (Confirm-Step (T 'Continuar sem backup?' 'Continue without a backup?'))) { exit 1 } }
  $feito = @(Get-ChildItem -Path $Backups -ErrorAction SilentlyContinue | Where-Object { $antesBackup -notcontains $_.Name } | Select-Object -ExpandProperty FullName) | Select-Object -First 1
  $voltar = if ($feito) { T "restaure o backup de antes: .\ergon.cmd restore `"$feito`"" "restore the backup made before: .\ergon.cmd restore `"$feito`"" } else { T 'restaure o backup mais recente: .\ergon.cmd restore <pasta>' 'restore the most recent backup: .\ergon.cmd restore <folder>' }
  if ($Fonte) {
    Push-Location $Raiz
    try {
      $antes = (& git rev-parse --short HEAD 2>$null)
      & git pull --ff-only; if ($LASTEXITCODE -ne 0) { Fail 'git pull falhou (há mudanças locais, ou a branch não acompanha uma remota). Nada foi alterado.' 'git pull failed (there are local changes, or the branch does not track a remote). Nothing was changed.' }
    } finally { Pop-Location }
    if (Up -NoFail) { Clear-Images; return }
    Fail "A versão nova não respondeu. Para voltar: git checkout $antes e .\ergon.cmd start; se ainda assim não subir, $voltar" "The new version did not respond. To go back: git checkout $antes and .\ergon.cmd start; if it still does not start, $voltar"
  }
  $url = if ($env:ERGON_UPDATE_URL) { $env:ERGON_UPDATE_URL } else { $Manifesto }
  try { $m = Invoke-RestMethod -Uri $url -TimeoutSec 20 -ErrorAction Stop } catch { Fail "Não consegui ler a versão publicada ($url)." "Could not read the published version ($url)." }
  $atual = (Get-Content (Join-Path $Raiz 'VERSAO') -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not (Test-Newer $m.version $atual)) { Say "Já está na versão $atual (publicada: $($m.version))." "Already on version $atual (published: $($m.version))."; return }
  if (-not ($m.bundle -and $m.sha256)) { Fail 'Manifesto da versão sem pacote.' 'The version manifest has no package.' }
  $tmp = Join-Path $env:TEMP "ergon-$($m.version)"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'ergon.zip'
  try { Invoke-WebRequest -Uri $m.bundle -OutFile $zip -UseBasicParsing -ErrorAction Stop } catch { Fail 'Não consegui baixar o pacote. Nada foi alterado.' 'Could not download the package. Nothing was changed.' }
  if ((Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower() -ne $m.sha256.ToLower()) { Fail 'Pacote baixado não confere (SHA-256). Nada foi alterado.' 'The downloaded package does not match (SHA-256). Nothing was changed.' }
  Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x') -Force -ErrorAction Stop
  # a versão atual fica guardada (arquivos do pacote; o .env e os dados não mudam)
  $guardada = Join-Path $Local "versoes\$(if ($atual) { $atual } else { 'anterior' })"
  Remove-Item -Recurse -Force -LiteralPath $guardada -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $guardada | Out-Null
  Get-ChildItem $Raiz | Where-Object { $_.Name -ne '.env' } | Copy-Item -Destination $guardada -Recurse -Force -ErrorAction Stop
  Get-ChildItem (Join-Path $tmp 'x') | Where-Object { $_.Name -ne '.env' } | Copy-Item -Destination $Raiz -Recurse -Force -ErrorAction Stop
  Say "Pacote $($m.version) aplicado (a $atual ficou guardada em $guardada)." "Package $($m.version) applied ($atual was kept in $guardada)."
  # no ar: as imagens antigas sem uso saem; das versões guardadas, fica só esta (a anterior)
  if (Up -NoFail) { Clear-Images; Clear-Versions $guardada; return }
  Say "A versão $($m.version) não respondeu: voltando para a $atual." "Version $($m.version) did not respond: going back to $atual."
  Get-ChildItem $guardada | Copy-Item -Destination $Raiz -Recurse -Force -ErrorAction Stop
  if (Up -NoFail) { Say "Voltou para a $atual e está no ar. A $($m.version) fica para depois (veja .\ergon.cmd logs)." "Back on $atual and running. $($m.version) is left for later (see .\ergon.cmd logs)."; return }
  Fail "Nem a versão $atual respondeu (a nova pode ter mudado o banco): $voltar" "Not even version $atual responded (the new one may have changed the database): $voltar"
}

# ---------------------------------------------------------------- limpeza: imagens, backups e versões guardadas
# Imagens: só as dos repositórios do Ergon (o do serviço e o do motor de IA, lidos do docker-compose.yml desta pasta),
# sem forçar (rmi sem -f: imagem em uso por um contêiner, parado também, nunca sai) e nunca volume. Ficam a imagem de
# qualquer contêiner, a atual de cada repositório e a anterior anotada no motor (rótulo ergon.motor.prev-image: enquanto
# a troca não é confirmada ela fica no disco; depois de confirmar, o gerente já a apagou e o rótulo só fica de registro). Nada de "prune": ele apagaria justamente a imagem atual que ainda não tem contêiner.
# -Tudo (no remover, com os contêineres já fora): também as atuais.
function Get-ErgonRefs {
  $f = Join-Path $Raiz 'docker-compose.yml'
  if (-not (Test-Path -LiteralPath $f)) { return @() }
  return @(Get-Content -LiteralPath $f | ForEach-Object { if ($_ -match '^\s*(image|ERGON_MOTOR_IMAGE):\s*"?([^"\s#$]+)') { $Matches[2] } } | Sort-Object -Unique)
}
# repositório de uma referência: sem o digest (@…) e sem a etiqueta (o ":" depois da última "/")
function Get-RepoOf([string]$ref) { $r = ($ref -split '@')[0]; if ((($r -split '/')[-1]) -match ':') { $r = $r.Substring(0, $r.LastIndexOf(':')) }; return $r }
# ID completo sem o "sha256:" (o Docker põe, o Podman não); nada, se não for um ID
function Get-PureId([string]$i) { $i = "$i".Trim() -replace '^sha256:', ''; if ($i -match '^[0-9a-f]{64}$') { return $i }; return $null }
function Clear-Images([switch]$Tudo) {
  $repos = @(Get-ErgonRefs | ForEach-Object { Get-RepoOf $_ } | Sort-Object -Unique)
  if (-not $repos.Count) { return }
  # em uso: a imagem de cada contêiner (parado também, de qualquer projeto) e a anterior de um motor ainda não confirmada
  $guardar = @{}
  $cs = @(& $DockerCli ps -aq 2>$null | Where-Object { $_ })
  if ($cs.Count) {
    foreach ($l in @(& $DockerCli inspect --format '{{.Image}} {{ index .Config.Labels "ergon.motor.prev-image" }}' @cs 2>$null)) {
      foreach ($w in ("$l" -split '\s+')) { $i = Get-PureId $w; if ($i) { $guardar[$i] = $true } }
    }
  }
  # as atuais (a do serviço e a do motor de IA) ficam, a não ser no remover
  if (-not $Tudo) { foreach ($ref in Get-ErgonRefs) { $i = Get-PureId "$(& $DockerCli image inspect --format '{{.Id}}' $ref 2>$null | Select-Object -First 1)"; if ($i) { $guardar[$i] = $true } } }
  # candidatas: as dos repositórios do Ergon que não ficam (o Podman chama "localhost/x" a imagem x construída aqui)
  $filas = @(); $cand = [ordered]@{}
  foreach ($l in @(& $DockerCli images --no-trunc --digests --format '{{.ID}} {{.Repository}} {{.Tag}} {{.Digest}}' 2>$null)) {
    $p = @("$l".Trim() -split '\s+'); if ($p.Count -lt 2) { continue }
    $i = Get-PureId $p[0]; if (-not $i) { continue }
    if (-not (($repos -contains $p[1]) -or ($repos -contains ($p[1] -replace '^localhost/', '')))) { continue }
    if ($guardar.ContainsKey($i)) { continue }
    $filas += , @($i, $p[1], $(if ($p.Count -gt 2) { $p[2] } else { '' }), $(if ($p.Count -gt 3) { $p[3] } else { '' }))
    $cand[$i] = $true
  }
  $n = 0; $bytes = [long]0; $ficaram = 0
  foreach ($i in @($cand.Keys)) {
    $t = [long]0; [void][long]::TryParse("$(& $DockerCli image inspect --format '{{.Size}}' $i 2>$null | Select-Object -First 1)", [ref]$t)
    & $DockerCli rmi $i 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      # com mais de um nome, o ID sozinho não sai sem forçar: tira os nomes do Ergon, um a um (os de fora ficam)
      foreach ($f in $filas) {
        if ($f[0] -ne $i) { continue }
        if ($f[2] -and $f[2] -ne '<none>') { & $DockerCli rmi "$($f[1]):$($f[2])" 2>$null | Out-Null }
        elseif ($f[3] -like 'sha256:*') { & $DockerCli rmi "$($f[1])@$($f[3])" 2>$null | Out-Null }
      }
    }
    & $DockerCli image inspect $i 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { $ficaram++ } else { $n++; $bytes += $t }
  }
  if ($n) { Say "Limpeza: $n imagem(ns) antiga(s) do Ergon removida(s), $([math]::Floor($bytes / 1MB)) MB liberados." "Cleanup: $n old Ergon image(s) removed, $([math]::Floor($bytes / 1MB)) MB freed." }
  if ($ficaram) { Say "$ficaram imagem(ns) antiga(s) do Ergon ficaram (em uso, ou com um nome de fora do Ergon)." "$ficaram old Ergon image(s) were kept (in use, or with a name from outside Ergon)." }
}
# Backups: ficam os 7 mais recentes (ERGON_BACKUPS_MANTER muda o número; 0 guarda todos). Só os do próprio Ergon, pelo
# nome (a pasta ergon-<data>, ou o antigo ergon-<data>.sqlite com o .keyring.json dele): a data no nome dá a ordem. O
# que acabou de ser feito conta como o mais novo e nunca sai. Outros arquivos da pasta não são tocados.
function Limit-Backups([string]$Feito) {
  $manter = 7; if ("$env:ERGON_BACKUPS_MANTER" -match '^\d+$') { $manter = [int]$env:ERGON_BACKUPS_MANTER }
  if ($manter -le 0 -or -not (Test-Path -LiteralPath $Backups)) { return }
  [string[]]$nomes = @(Get-ChildItem -LiteralPath $Backups -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -cmatch '^ergon-\d{4}-\d{2}-\d{2}T[0-9A-Za-z-]+(\.sqlite)?$' -and $_.Name -ne $Feito } | ForEach-Object { $_.Name })
  [Array]::Sort($nomes, [StringComparer]::Ordinal); [Array]::Reverse($nomes)
  if ($Feito -and (Test-Path -LiteralPath (Join-Path $Backups $Feito))) { $nomes = @($Feito) + $nomes }
  $sairam = 0
  for ($k = $manter; $k -lt $nomes.Count; $k++) {
    Remove-Item -LiteralPath (Join-Path $Backups $nomes[$k]) -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $Backups "$($nomes[$k]).keyring.json") -Force -ErrorAction SilentlyContinue
    $sairam++
  }
  if ($sairam) { Say "Backups: ficaram os $manter mais recentes ($sairam antigo(s) apagado(s) em $Backups)." "Backups: the $manter most recent were kept ($sairam old one(s) deleted in $Backups)." }
}
# Versões guardadas pelo atualizar (%LOCALAPPDATA%\Ergon\versoes): fica só a anterior, a que ele usa para voltar.
function Clear-Versions([string]$Guardada) {
  $d = Join-Path $Local 'versoes'
  if (-not (Test-Path -LiteralPath $d)) { return }
  Get-ChildItem -LiteralPath $d -Directory -ErrorAction SilentlyContinue | Where-Object { -not (Same-Dir $_.FullName $Guardada) } |
    ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}

# ---------------------------------------------------------------- ajudante (destrancar sozinho)
# O Ergon roda no Docker e não alcança o cofre do Windows. O ajudante roda na sua conta, sem janela, desde que
# você entra no Windows: avisa o Ergon que está ali; quando você liga "Destrancar sozinho" na tela, busca a chave
# e a guarda com DPAPI (só esta conta, neste computador, decifra); se o Ergon reiniciar trancado, destranca.
# Desligar na tela invalida a chave, e o ajudante apaga a dele.
function Write-HelperLog([string]$m, [string]$en = '') {
  New-Item -ItemType Directory -Force -Path $Local | Out-Null
  $f = Join-Path $Local 'ajudante.log'
  if ((Test-Path $f) -and (Get-Item $f).Length -gt 200KB) { Remove-Item -Force $f }
  Add-Content -Path $f -Value "$(Get-Date -Format s) $(T $m $en)"
}
function Get-AgentToken {
  $f = Join-Path $Segredos 'ergon.env'
  if (-not (Test-Path $f)) { return $null }
  $l = Select-String -Path $f -Pattern '^ERGON_AGENT_TOKEN=(.+)$' | Select-Object -First 1
  if ($l) { return $l.Matches[0].Groups[1].Value.Trim() } else { return $null }
}
# Várias pessoas no computador: uma chave por pessoa que ligou "abrir sozinho" nesta conta do Windows (cada uma
# cifrada com DPAPI). Arquivo de antes (uma chave só, {id, blob}) continua valendo.
function Read-SavedEntries {
  if (-not (Test-Path $Guardada)) { return @() }
  try { $j = Get-Content $Guardada -Raw | ConvertFrom-Json } catch { return @() }
  if ($j.keys) { return @($j.keys) } elseif ($j.id) { return @([pscustomobject]@{ id = $j.id; blob = $j.blob }) } else { return @() }
}
function Read-SavedKeys {
  $out = @()
  foreach ($e in Read-SavedEntries) {
    try {
      $s = $e.blob | ConvertTo-SecureString -ErrorAction Stop
      $out += @{ id = [string]$e.id; key = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) }
    } catch { }
  }
  return $out
}
function Write-SavedEntries($entries) {
  New-Item -ItemType Directory -Force -Path $Local | Out-Null
  if (-not @($entries).Count) { Remove-Item -Force -ErrorAction SilentlyContinue $Guardada; return }
  @{ keys = @($entries) } | ConvertTo-Json -Depth 4 | Set-Content -Encoding ascii -Path $Guardada -ErrorAction Stop
  Protect-File $Guardada
}
function Save-Key([string]$id, [string]$key) {
  $blob = ConvertTo-SecureString $key -AsPlainText -Force | ConvertFrom-SecureString
  Write-SavedEntries (@(Read-SavedEntries | Where-Object { $_.id -ne $id }) + @([pscustomobject]@{ id = $id; blob = $blob }))
}
function Remove-SavedKey([string]$id) { Write-SavedEntries @(Read-SavedEntries | Where-Object { $_.id -ne $id }) }
function Status-Of($err) { try { return [int]$err.Exception.Response.StatusCode } catch { return 0 } }
function Run-Helper {
  $mutex = New-Object Threading.Mutex($false, 'Local\ErgonAjudante')
  if (-not $mutex.WaitOne(0)) { return }   # já há um ajudante rodando nesta sessão
  $tok = Get-AgentToken
  if (-not $tok) { Write-HelperLog 'sem ERGON_AGENT_TOKEN em ergon.env (rode "ergon install")' 'no ERGON_AGENT_TOKEN in ergon.env (run "ergon install")'; return }
  $h = @{ 'X-Ergon-Agent-Token' = $tok }
  $label = "$env:COMPUTERNAME ($env:USERNAME)"
  Write-HelperLog 'ajudante iniciado' 'helper started'
  $ultimoErro = ''
  while ($true) {
    $saved = @(Read-SavedKeys)
    $body = @{ label = $label; platform = 'windows' }
    if ($saved.Count) { $body.keyId = $saved[0].id; $body.keyIds = @($saved | ForEach-Object { $_.id }) }
    try {
      $r = Invoke-RestMethod -Method Post -Uri "$Url/api/agent/hello" -Headers $h -ContentType 'application/json' -Body ($body | ConvertTo-Json) -TimeoutSec 5 -ErrorAction Stop
      foreach ($id in @($r.invalid)) { if ($id) { Remove-SavedKey $id; Write-HelperLog 'abrir sozinho desligado na tela: uma chave apagada' 'automatic unlock turned off on screen: one key deleted' } }
      if ($r.keyValid -eq $false -and $null -eq $r.invalid) { Remove-SavedKey $saved[0].id; Write-HelperLog 'destrancar sozinho desligado na tela: chave apagada' 'automatic unlock turned off on screen: key deleted' }
      # várias pessoas: a parte de quem ligou "abrir sozinho" ainda está fechada → abre com a chave dela
      foreach ($id in @($r.closed)) {
        $k = $saved | Where-Object { $_.id -eq $id } | Select-Object -First 1
        if ($k) {
          try { Invoke-RestMethod -Method Post -Uri "$Url/api/agent/open" -Headers $h -ContentType 'application/json' -Body (@{ key = $k.key } | ConvertTo-Json) -TimeoutSec 30 -ErrorAction Stop | Out-Null; Write-HelperLog 'parte de uma pessoa aberta' "one person's part opened" }
          catch { if ((Status-Of $_) -eq 401) { Remove-SavedKey $id; Write-HelperLog 'chave recusada (foi desligada): apagada' 'key refused (it was turned off): deleted' } }
        }
      }
      if ($r.enroll) {
        # corpo JSON explícito: sem ele, o Windows PowerShell manda "formulário" e o Ergon recusa (415)
        $c = Invoke-RestMethod -Method Post -Uri "$Url/api/agent/auto-unlock/claim" -Headers $h -ContentType 'application/json' -Body '{}' -TimeoutSec 10 -ErrorAction Stop
        Save-Key $c.id $c.key; $c = $null
        Write-HelperLog 'destrancar sozinho ligado: chave guardada no cofre do Windows' 'automatic unlock turned on: key kept in the Windows vault'
      }
    } catch {
      $st = Status-Of $_
      # erro novo vai para o log (uma vez); "sem resposta" (Docker subindo) e 423 são normais
      if ($st -ne 0 -and $st -ne 423 -and "$st" -ne $ultimoErro) { Write-HelperLog "o Ergon respondeu $st" "Ergon answered $st"; $ultimoErro = "$st" }
      # 423: o Ergon reiniciou e está trancado → destranca com a chave guardada (se houver)
      if ($st -eq 423 -and $saved.Count) {
        foreach ($k in $saved) {
          try {
            Invoke-RestMethod -Method Post -Uri "$Url/api/unseal/auto" -ContentType 'application/json' -Body (@{ key = $k.key } | ConvertTo-Json) -TimeoutSec 30 -ErrorAction Stop | Out-Null
            Write-HelperLog 'Ergon destrancado' 'Ergon unlocked'; break
          } catch {
            if ((Status-Of $_) -eq 401) { Remove-SavedKey $k.id; Write-HelperLog 'chave recusada (foi desligada): apagada' 'key refused (it was turned off): deleted' }
          }
        }
      }
    }
    $saved = $null
    Start-Sleep -Seconds 5
  }
}
# O atalho do início chama "ajudante" (o nome de antes): assim ele funciona também se a pessoa voltar a uma versão
# anterior do lançador.
function Install-Helper {
  # sem janela: o atalho .vbs chama o PowerShell escondido ao entrar no Windows
  $cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"`"$PSCommandPath`"`" ajudante"
  Set-Content -Encoding Default -Path $Inicializar -Value "CreateObject(`"WScript.Shell`").Run `"$cmd`", 0, False"
  Remove-Item -Force -ErrorAction SilentlyContinue $Antigo
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$Inicializar`"" -WindowStyle Hidden
  Say 'Ajudante do computador ativo (começa sozinho ao entrar no Windows).' 'Computer helper active (starts on its own when you sign in to Windows).'
}
function Remove-Helper {
  Remove-Item -Force -ErrorAction SilentlyContinue $Inicializar, $Antigo, $Guardada
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -match 'ergon\.ps1.*(ajudante|helper)' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }
  Say 'Ajudante removido e chave apagada deste computador. O destrancar sozinho fica desligado.' 'Helper removed and key deleted from this computer. Automatic unlock is now off.'
}

# ---------------------------------------------------------------- partida do Docker Desktop
# Depois de um desligamento sem aviso (reinício, falta de luz), o Docker Desktop deixa dois sockets órfãos e trava ao
# abrir ("initializing Inference manager" / "initializing Secrets Engine" — "não é possível o acesso ao arquivo").
# A correção é sempre a mesma: com o Docker fechado, pôr de lado as duas pastas (ele as recria) e abrir de novo.
# Aqui isso vira a partida normal: ao entrar no Windows, o Ergon abre o Docker nessa ordem. Nada é apagado: as
# pastas vão para %LOCALAPPDATA%\Ergon\docker-sobras\<data>. Os caminhos podem ser trocados (testes).
$DockerExe = if ($env:ERGON_DOCKER_EXE) { $env:ERGON_DOCKER_EXE } else { Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe' }
$DockerCli = if ($env:ERGON_DOCKER_CLI) { $env:ERGON_DOCKER_CLI } else { 'docker' }
$DockerBase = if ($env:ERGON_DOCKER_DATA) { $env:ERGON_DOCKER_DATA } else { $env:LOCALAPPDATA }
$DockerProc = if ($env:ERGON_DOCKER_PROC) { $env:ERGON_DOCKER_PROC -split ',' } else { @('Docker Desktop', 'com.docker.backend', 'com.docker.build', 'com.docker.dev-envs') }
$DockerAtalho = Join-Path $(if ($env:ERGON_STARTUP_DIR) { $env:ERGON_STARTUP_DIR } else { [Environment]::GetFolderPath('Startup') }) 'Ergon - Docker.vbs'
$RunKey = if ($env:ERGON_RUN_KEY) { $env:ERGON_RUN_KEY } else { 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' }
$DockerEspera = if ($env:ERGON_DOCKER_WAIT) { [int]$env:ERGON_DOCKER_WAIT } else { 240 }
$RunGuardada = Join-Path $Local 'docker-inicio-original.txt'

function Write-DockerLog([string]$m, [string]$en = '') {
  $t = T $m $en
  New-Item -ItemType Directory -Force -Path $Local | Out-Null
  $f = Join-Path $Local 'docker.log'
  if ((Test-Path $f) -and (Get-Item $f).Length -gt 200KB) { Remove-Item -Force $f }
  Add-Content -Path $f -Value "$(Get-Date -Format s) $t"
  Say $t
}
function Test-DockerUp { & $DockerCli info --format '{{.ServerVersion}}' 2>$null | Out-Null; return $LASTEXITCODE -eq 0 }
function Get-DockerProcs { return @(Get-Process -Name $DockerProc -ErrorAction SilentlyContinue) }
function Wait-DockerUp([int]$Segundos) {
  $fim = (Get-Date).AddSeconds($Segundos)
  while ((Get-Date) -lt $fim) { if (Test-DockerUp) { return $true }; Start-Sleep -Seconds 3 }
  return $false
}
# o Docker travou nos sockets? (o erro que ele grava ao fechar)
function Test-SocketCrash([datetime]$Desde) {
  $e = Join-Path $DockerBase 'Docker\backend.error.json'
  if (-not (Test-Path $e) -or (Get-Item $e).LastWriteTime -lt $Desde) { return $false }
  return (Get-Content $e -Raw) -match 'dockerInference|engine\.sock|Secrets Engine|Inference manager'
}
function Move-DockerSockets {
  # só com o Docker fechado: com ele aberto, as pastas estão em uso
  if ((Get-DockerProcs).Count) { return }
  $destino = Join-Path $Local "docker-sobras\$(Get-Date -Format 'yyyyMMdd-HHmmss')"
  foreach ($p in @((Join-Path $DockerBase 'Docker\run'), (Join-Path $DockerBase 'docker-secrets-engine'))) {
    if (-not (Test-Path $p)) { continue }
    New-Item -ItemType Directory -Force -Path $destino | Out-Null
    try { Move-Item -Path $p -Destination (Join-Path $destino (Split-Path $p -Leaf)) -ErrorAction Stop; Write-DockerLog "posto de lado: $p" "set aside: $p" }
    catch { Write-DockerLog "não consegui pôr de lado $p ($($_.Exception.Message))" "could not set aside $p ($($_.Exception.Message))" }
  }
}
function Stop-DockerDesktop {
  Get-DockerProcs | ForEach-Object { try { Stop-Process -Id $_.Id -Force -Confirm:$false -ErrorAction Stop } catch {} }
  $fim = (Get-Date).AddSeconds(20)
  while ((Get-DockerProcs).Count -and (Get-Date) -lt $fim) { Start-Sleep -Seconds 1 }
}
# Diagnóstico registrado: quantas vezes este computador travou nos sockets (só o Ergon lê e grava, em $Local).
$DockerDiag = Join-Path $Local 'docker-diagnostico.json'
function Get-DockerCrashes {
  if (-not (Test-Path $DockerDiag)) { return 0 }
  try { return [int](Get-Content $DockerDiag -Raw -ErrorAction Stop | ConvertFrom-Json).travamentos } catch { return 0 }
}
function Add-DockerCrash {
  New-Item -ItemType Directory -Force -Path $Local | Out-Null
  Set-Content -Encoding UTF8 -Path $DockerDiag -Value (@{ travamentos = (Get-DockerCrashes) + 1; ultimo = (Get-Date -Format s) } | ConvertTo-Json -Compress)
}
# espera o Docker subir; volta cedo se a assinatura do travamento dos sockets aparecer
function Wait-DockerUpOrCrash([int]$Segundos, [datetime]$Desde) {
  $fim = (Get-Date).AddSeconds($Segundos)
  while ((Get-Date) -lt $fim) {
    if (Test-DockerUp) { return 'up' }
    if (Test-SocketCrash $Desde) { return 'sockets' }
    Start-Sleep -Seconds 3
  }
  if (Test-SocketCrash $Desde) { return 'sockets' }
  return 'timeout'
}

<#
  Abrir o Docker com diagnóstico primeiro: abre do jeito normal e só põe as pastas de sockets de lado (nada é
  apagado: vão para docker-sobras) se o próprio Docker gravar o erro dos sockets. Limpeza preventiva, antes de
  abrir, só onde o travamento já foi visto: computador com "ergon docker install" (foi a resposta a esse
  travamento) ou com um travamento registrado. Nunca para contêineres: só fecha o Docker Desktop quando o motor
  dele não está respondendo (contêiner nenhum está rodando nessa hora).
#>
function Start-DockerSafe {
  $mutex = New-Object Threading.Mutex($false, 'Local\ErgonDocker')
  if (-not $mutex.WaitOne(0)) { return }   # já há uma partida em andamento nesta sessão
  if (Test-DockerUp) { Write-DockerLog 'Docker já está no ar' 'Docker is already running'; return }
  if (-not (Test-Path $DockerExe)) { Write-DockerLog "Docker Desktop não encontrado em $DockerExe" "Docker Desktop not found at $DockerExe"; return }
  $preventivo = (Test-Path $DockerAtalho) -or ((Get-DockerCrashes) -gt 0)
  for ($tentativa = 1; $tentativa -le 2; $tentativa++) {
    $inicio = Get-Date
    if ((Get-DockerProcs).Count) {
      # já está abrindo (por outro atalho): espera; se travou nos sockets, fecha para limpar
      if (Wait-DockerUp ([Math]::Min(60, $DockerEspera))) { Write-DockerLog 'Docker no ar' 'Docker is running'; return }
      if (-not (Test-SocketCrash $inicio.AddMinutes(-5))) { Write-DockerLog 'Docker ainda abrindo (sem o erro dos sockets): deixo seguir' 'Docker still opening (without the socket error): letting it continue'; return }
      Write-DockerLog 'Docker travou nos sockets: fechando para limpar' 'Docker got stuck on the sockets: closing it to clean up'
      Add-DockerCrash; $preventivo = $true
      Stop-DockerDesktop
    }
    if ($preventivo) { Move-DockerSockets }
    else { Write-DockerLog 'abrindo sem mexer em nada (diagnóstico primeiro: só limpo se o Docker acusar o travamento dos sockets)' 'opening without touching anything (diagnosis first: cleaning only if Docker reports the socket lockup)' }
    Write-DockerLog "abrindo o Docker Desktop (tentativa $tentativa)" "opening Docker Desktop (attempt $tentativa)"
    Start-Process -FilePath $DockerExe
    $r = Wait-DockerUpOrCrash $DockerEspera $inicio
    if ($r -eq 'up') { Write-DockerLog 'Docker no ar' 'Docker is running'; return }
    if ($r -ne 'sockets') { Write-DockerLog "o Docker não respondeu em $DockerEspera s (sem o erro dos sockets): nada foi mexido; veja o Docker Desktop" "Docker did not respond in $DockerEspera s (without the socket error): nothing was touched; check Docker Desktop"; return }
    Write-DockerLog "o Docker travou nos sockets (erro conferido em backend.error.json)$(if ($preventivo) { ' de novo' }): fechando para limpar" "Docker got stuck on the sockets (error checked in backend.error.json)$(if ($preventivo) { ' again' }): closing it to clean up"
    Add-DockerCrash; $preventivo = $true
    Stop-DockerDesktop
  }
  Write-DockerLog 'o Docker não abriu depois de duas tentativas: abra o Docker Desktop e veja a mensagem' 'Docker did not open after two attempts: open Docker Desktop and read the message'
}
function Install-DockerStart {
  # a entrada do próprio Docker no início do Windows abriria antes da limpeza: guardada e tirada (volta com "uninstall")
  $v = (Get-ItemProperty -Path $RunKey -Name 'Docker Desktop' -ErrorAction SilentlyContinue).'Docker Desktop'
  if ($v) {
    New-Item -ItemType Directory -Force -Path $Local | Out-Null
    Set-Content -Encoding UTF8 -Path $RunGuardada -Value $v
    Remove-ItemProperty -Path $RunKey -Name 'Docker Desktop' -ErrorAction Stop
    Say "Entrada do Docker no início do Windows guardada em $RunGuardada e retirada." "The Docker entry in Windows startup was saved in $RunGuardada and removed."
  }
  $cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"`"$PSCommandPath`"`" docker"
  Set-Content -Encoding Default -Path $DockerAtalho -Value "CreateObject(`"WScript.Shell`").Run `"$cmd`", 0, False"
  Say "Ao entrar no Windows, o Ergon abre o Docker (atalho: $DockerAtalho). Registro: $(Join-Path $Local 'docker.log')" "When you sign in to Windows, Ergon opens Docker (shortcut: $DockerAtalho). Log: $(Join-Path $Local 'docker.log')"
}
function Remove-DockerStart {
  Remove-Item -Force -ErrorAction SilentlyContinue $DockerAtalho
  if (Test-Path $RunGuardada) {
    Set-ItemProperty -Path $RunKey -Name 'Docker Desktop' -Value ((Get-Content $RunGuardada -Raw).Trim()) -ErrorAction Stop
    Remove-Item -Force $RunGuardada
    Say 'Entrada original do Docker devolvida ao início do Windows.' 'The original Docker entry was returned to Windows startup.'
  }
  Say 'O Ergon não abre mais o Docker ao entrar no Windows.' 'Ergon no longer opens Docker when you sign in to Windows.'
}

# ---------------------------------------------------------------- ajuda, versão e os nomes dos comandos
# A versão: o arquivo VERSAO do pacote; numa cópia do código, a do package.json.
function Show-Version {
  $v = "$(Get-Content (Join-Path $Raiz 'VERSAO') -ErrorAction SilentlyContinue | Select-Object -First 1)".Trim()
  if (-not $v) { try { $v = "$((Get-Content (Join-Path $Raiz 'package.json') -Raw -ErrorAction Stop | ConvertFrom-Json).version)" } catch { $v = '' } }
  if (-not $v) { Fail 'Versão desconhecida (falta o arquivo VERSAO).' 'Unknown version (the VERSAO file is missing).' }
  Write-Host "Ergon $v"
}
function Show-Help {
  if ($script:EmIngles) {
    Write-Host @'
Ergon launcher. Usage: ergon <command>

  install                 installs Ergon in a folder of yours (%LOCALAPPDATA%\Programs\Ergon), puts the "ergon"
                          command in the PATH, prepares the secrets, starts Ergon and opens the browser; the zip
                          folder can be deleted afterwards
  uninstall               removes Ergon from this computer and KEEPS the data (conversations, tasks, files,
                          connections, secrets and backups): installing again picks up where you left off
  uninstall --purge       removes Ergon and DELETES the data, the secrets and the backups (asks for confirmation)
  start | stop | status   starts, stops, shows the state
  up                      only starts (opens Docker Desktop if needed and starts the services), installs nothing at
                          Windows startup: what the Ergon Desktop app uses
  open                    opens http://localhost:8787
  backup                  full, checked backup (encrypted database, keyring, files and connections) in a folder in
                          %USERPROFILE%\.ergon\backups (the 7 most recent are kept)
  restore <folder>        checks the backup, keeps what is in place (nothing is deleted) and restores
  restore --undo <pre-restore-…>   goes back to how it was before a restore
  update                  backup + new version (source copy: git pull; package: downloads the published version)
  clean                   removes old Ergon images nothing uses (runs on its own after updating)
  logs                    last lines from Ergon and the engine
  helper                  (runs on its own at Windows sign-in) keeps the "unlock automatically" key in the Windows
                          vault when you turn it on in Settings › Security, and unlocks Ergon after a restart
  helper uninstall        removes the helper from Windows startup and deletes the stored key
  docker                  opens Docker Desktop; if it reports the lockup of the sockets left by a shutdown, sets the
                          folders aside (nothing is deleted) and tries once more
  docker install | uninstall   opens Docker from here at Windows sign-in, cleaning up before opening (for
                          computers that lock up this way); uninstall goes back to Docker's own startup
  help                    shows this help
  version                 shows the version

Messages follow the Windows language; ERGON_LANG=pt|en forces one.
'@
  } else {
    Write-Host @'
Lançador do Ergon. Uso: ergon <comando>

  install  (antes: instalar)
      instala o Ergon numa pasta sua (%LOCALAPPDATA%\Programs\Ergon), põe o comando "ergon" no PATH, prepara os
      segredos, sobe o Ergon e abre o navegador; a pasta do zip pode ser apagada depois
  uninstall  (antes: remover)
      tira o Ergon do computador e GUARDA os dados (conversas, tarefas, arquivos, conexões, segredos e backups):
      instalar de novo volta de onde parou
  uninstall --purge  (antes: remover --tudo)
      tira o Ergon e APAGA os dados, os segredos e os backups (pede confirmação)
  start | stop | status  (antes: iniciar | parar | status)
      liga, desliga, mostra o estado
  up  (antes: subir)
      só liga (abre o Docker Desktop se preciso e sobe os serviços), sem instalar nada no início do Windows: é o
      que o aplicativo Ergon Desktop usa
  open  (antes: abrir)
      abre http://localhost:8787
  backup
      backup completo e conferido (banco cifrado, keyring, arquivos e conexões) numa pasta em
      %USERPROFILE%\.ergon\backups (ficam os 7 mais recentes)
  restore <pasta>  (antes: restaurar)
      confere o backup, guarda o que está no lugar (nada é apagado) e restaura
  restore --undo <pre-restore-…>  (antes: desfazer-restauracao)
      volta ao que era antes de uma restauração
  update  (antes: atualizar)
      backup + versão nova (cópia do código: git pull; pacote: baixa a versão publicada)
  clean  (antes: limpar)
      tira as imagens antigas do Ergon que nada usa (roda sozinho depois de atualizar)
  logs
      últimas linhas do Ergon e do motor
  helper  (antes: ajudante)
      (roda sozinho ao entrar no Windows) guarda a chave do "destrancar sozinho" no cofre do Windows quando você
      liga o botão em Configuração › Segurança, e destranca o Ergon depois de reiniciar
  helper uninstall  (antes: ajudante remover)
      tira o ajudante do início do Windows e apaga a chave guardada
  docker
      abre o Docker Desktop; se ele acusar o travamento dos sockets que sobram de um desligamento, põe as pastas
      de lado (nada é apagado) e tenta de novo uma vez
  docker install | uninstall  (antes: docker instalar | remover)
      passa a abrir o Docker por aqui ao entrar no Windows, limpando antes de abrir (para computadores que travam
      assim); uninstall volta ao início do Docker
  help · version
      esta ajuda · a versão

Os nomes de antes continuam valendo. As mensagens seguem o idioma do Windows; ERGON_LANG=pt|en escolhe um.
'@
  }
}
# o nome novo (em inglês) de cada comando; os de antes, em português, continuam aceitos para sempre
$Nomes = @{
  'install' = 'install'; 'instalar' = 'install'; 'uninstall' = 'uninstall'; 'remove' = 'uninstall'; 'remover' = 'uninstall'
  'start' = 'start'; 'iniciar' = 'start'; 'up' = 'up'; 'subir' = 'up'; 'stop' = 'stop'; 'parar' = 'stop'; 'status' = 'status'
  'open' = 'open'; 'abrir' = 'open'; 'logs' = 'logs'; 'backup' = 'backup'; 'restore' = 'restore'; 'restaurar' = 'restore'
  'undo-restore' = 'undo-restore'; 'desfazer-restauracao' = 'undo-restore'; 'update' = 'update'; 'upgrade' = 'update'
  'atualizar' = 'update'; 'clean' = 'clean'; 'limpar' = 'clean'; 'helper' = 'helper'; 'ajudante' = 'helper'; 'docker' = 'docker'
  'help' = 'help'; '--help' = 'help'; '-h' = 'help'; '/?' = 'help'; 'ajuda' = 'help'; 'version' = 'version'; '--version' = 'version'; 'versao' = 'version'
}
function Get-Canonical([string]$c) { if ($Nomes.ContainsKey($c)) { return $Nomes[$c] }; return $null }
function Test-Install([string]$o) { return @('install', 'instalar') -contains $o }
function Test-Uninstall([string]$o) { return @('uninstall', 'remove', 'remover') -contains $o }

$Cmd = Get-Canonical $Comando
if (-not $Cmd) { Say "Comando desconhecido: $Comando" "Unknown command: $Comando"; Show-Help; exit 1 }
switch ($Cmd) {
  'install' {
    $destino = Install-Program
    if (-not (Same-Dir $destino $Raiz)) {
      # continua pela cópia instalada: o registro, o ajudante e o Docker passam a usar a pasta do programa
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $destino 'ergon.ps1') install
      if ($LASTEXITCODE -eq 0) { Say "Pode apagar a pasta do zip ($Raiz). Abra um terminal novo e use: ergon status" "You can delete the zip folder ($Raiz). Open a new terminal and use: ergon status" }
      exit $LASTEXITCODE
    }
    Test-Docker; Initialize-Secrets; Register-Install; Up | Out-Null; Install-Helper
    if (-not ($env:ERGON_NO_BROWSER -or $env:ERGON_SEM_NAVEGADOR)) { Start-Process $Url }
  }
  'uninstall' { Remove-Ergon -Tudo:(@('--purge', '--all', '--tudo') -contains $Opcao) }
  'start' { Test-Docker; Register-Install; Compose @('up', '-d'); Install-Helper; $h = Wait-Health 240; if ($h) { Say "No ar em $Url$(if ($h.sealed) { ' (trancado: digite a senha)' })" "Running at $Url$(if ($h.sealed) { ' (locked: type the password)' })" } else { Fail 'Não respondeu.' 'Did not respond.' } }
  'up' {
    if (-not (Test-DockerUp)) { Say 'Abrindo o Docker Desktop…' 'Opening Docker Desktop…'; Start-DockerSafe }
    Test-Docker; Register-Install
    Say 'Ligando os serviços do Ergon e o motor de IA…' 'Starting the Ergon services and the AI engine…'
    Compose @('up', '-d')
    $h = Wait-Health 240
    if ($h) { Say "No ar em $Url$(if ($h.sealed) { ' (trancado: digite a senha)' })" "Running at $Url$(if ($h.sealed) { ' (locked: type the password)' })" } else { Fail 'O Ergon não respondeu. Veja: .\ergon.cmd logs' 'Ergon did not respond. See: .\ergon.cmd logs' }
  }
  'stop' { Compose @('stop') }
  'status' { Compose @('ps'); $h = Get-Health; if ($h) { Say "Ergon $($h.version) · $(if ($h.sealed) { 'trancado' } else { 'aberto' }) · $Url" "Ergon $($h.version) · $(if ($h.sealed) { 'locked' } else { 'open' }) · $Url" } else { Say 'Ergon não responde.' 'Ergon is not responding.' } }
  'open' { Start-Process $Url }
  'logs' { Compose @('logs', '--tail', '80', 'ergon', 'motores') }
  'backup' { if (-not (Backup)) { exit 1 } }
  'restore' { if ($Opcao -eq '--undo') { Undo-Restore $Opcao2 } else { Restore $Opcao } }
  'undo-restore' { Undo-Restore $Opcao }
  'update' { Test-Docker; Update }
  'clean' { Test-Docker; Clear-Images }
  'helper' { if (Test-Uninstall $Opcao) { Remove-Helper } elseif (Test-Install $Opcao) { Install-Helper } else { Run-Helper } }
  'docker' { if (Test-Uninstall $Opcao) { Remove-DockerStart } elseif (Test-Install $Opcao) { Install-DockerStart } else { Start-DockerSafe } }
  'help' { Show-Help }
  'version' { Show-Version }
}
