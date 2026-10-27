<#
  Ergon — lançador local (Windows). Use pelo atalho:  .\ergon.cmd <comando>

    instalar                     prepara os segredos, sobe o Ergon e abre o navegador
    iniciar | parar | status     liga, desliga, mostra o estado
    subir                        só liga (abre o Docker Desktop se preciso e sobe os serviços), sem instalar nada no
                                 início do Windows: é o que o aplicativo Ergon Desktop usa
    abrir                        abre http://localhost:8787
    backup                       backup completo e conferido (banco cifrado, keyring, arquivos e conexões) numa
                                 pasta em %USERPROFILE%\.ergon\backups
    restaurar <pasta>            confere o backup, guarda o que está no lugar (nada é apagado) e restaura
    desfazer-restauracao <pre-restore-…>   volta ao que era antes de uma restauração
    atualizar                    backup + versão nova (cópia do código: git pull; pacote: baixa a versão publicada)
    logs                         últimas linhas do Ergon e do motor
    ajudante                     (roda sozinho ao entrar no Windows) guarda a chave do "destrancar sozinho" no
                                 cofre do Windows quando você liga o botão em Configuração › Segurança, e
                                 destranca o Ergon depois de reiniciar
    ajudante remover             tira o ajudante do início do Windows e apaga a chave guardada
    docker                       abre o Docker Desktop; se ele acusar o travamento dos sockets que sobram de um
                                 desligamento, põe as pastas de lado (nada é apagado) e tenta de novo uma vez
    docker instalar | remover    passa a abrir o Docker por aqui ao entrar no Windows, limpando antes de abrir
                                 (para computadores que travam assim); remover volta ao início do Docker

  Nunca exibe segredos. Não altera nada fora da pasta do Ergon, de %USERPROFILE%\.ergon, de %LOCALAPPDATA%\Ergon,
  dos atalhos do Ergon na pasta Inicializar e, com "docker instalar", da entrada do Docker no início do Windows e das
  pastas de sockets do Docker (que ele recria sozinho).
#>
param([Parameter(Position = 0)][string]$Comando = 'ajuda', [Parameter(Position = 1)][string]$Opcao = '')
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

function Say([string]$m) { Write-Host "[ergon] $m" }
function Fail([string]$m) { Write-Host "[ergon] $m" -ForegroundColor Red; exit 1 }

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
  try { & docker compose --profile hermes @a; if ($LASTEXITCODE -ne 0) { Fail "docker compose $($a -join ' ') falhou" } } finally { Pop-Location }
}
function ComposeOut([string[]]$a) {
  Push-Location $Raiz
  try { $out = & docker compose --profile hermes @a 2>$null; if ($LASTEXITCODE -ne 0) { return $null }; return ($out -join "`n").Trim() } finally { Pop-Location }
}
function Test-Docker {
  & docker info --format '{{.ServerVersion}}' 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail 'O Docker não está rodando. Abra o Docker Desktop e tente de novo.' }
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

function Initialize-Secrets {
  if (In-OneDrive $Segredos) { Fail "Os segredos não podem ficar no OneDrive ($Segredos). Defina ERGON_SECRETS_DIR em outra pasta." }
  New-Item -ItemType Directory -Force -Path $Segredos | Out-Null
  $ergon = Join-Path $Segredos 'ergon.env'; $hermes = Join-Path $Segredos 'hermes.env'
  if ((Test-Path $ergon) -or (Test-Path $hermes)) {
    Say "Segredos já existem em $Segredos (não alterados)."
    # instalações anteriores: acrescenta só o token do ajudante (valor não exibido)
    if ((Test-Path $ergon) -and -not (Select-String -Path $ergon -Pattern '^ERGON_AGENT_TOKEN=' -Quiet)) {
      Add-Content -Encoding ascii -Path $ergon -Value "ERGON_AGENT_TOKEN=$(New-Token)"; Say 'ergon.env: token do ajudante acrescentado.'
    }
  }
  else {
    $api = New-Token; $ponte = New-Token
    Set-Content -Encoding ascii -Path $ergon -Value @('# Ergon — segredos locais (não versionar, não sincronizar)', "ERGON_HERMES_API_KEY=$api", "ERGON_BRIDGE_TOKEN=$ponte", "ERGON_AGENT_TOKEN=$(New-Token)")
    Set-Content -Encoding ascii -Path $hermes -Value @('# Motor de IA do Ergon — segredos locais (não versionar, não sincronizar)', "API_SERVER_KEY=$api", "ERGON_BRIDGE_TOKEN=$ponte", "HERMES_DASHBOARD_SESSION_TOKEN=$(New-Token)")
    Protect-File $ergon; Protect-File $hermes
    Say "Segredos gerados em $Segredos (valores não exibidos)."
  }
  $envf = Join-Path $Raiz '.env'
  $cur = if (Test-Path $envf) { Get-Content $envf -Raw } else { '' }
  $add = @()
  if ($cur -notmatch '(?m)^ERGON_SECRETS_DIR=') { $add += "ERGON_SECRETS_DIR=$($Segredos.Replace('\', '/'))" }
  if ($cur -notmatch '(?m)^ERGON_EXECUTOR=') { $add += 'ERGON_EXECUTOR=hermes' }
  if ($add.Count) { Add-Content -Encoding ascii -Path $envf -Value $add; Say '.env atualizado (só caminhos e opções, nenhum segredo).' }
}

function Up([switch]$NoFail) {
  # a saída do compose vai para a tela, não para o valor de volta (senão 'if (Up)' seria sempre verdadeiro)
  if ($Fonte) { Compose @('up', '-d', '--build') | Out-Host } else { Compose @('pull') | Out-Host; Compose @('up', '-d') | Out-Host }
  $h = Wait-Health 240
  if (-not $h) { if ($NoFail) { return $null }; Fail 'O Ergon não respondeu. Veja: .\ergon.cmd logs' }
  if ($h.sealed) { Say "Ergon $($h.version) no ar e TRANCADO: abra $Url e digite a senha." }
  else { Say "Ergon $($h.version) no ar em $Url" }
  return $h
}
# "0.3.1" > "0.3.0"? (versões que não são números: só "diferente")
function Test-Newer([string]$nova, [string]$atual) {
  if (-not $atual) { return $true }
  try { return ([version]($nova -replace '[^\d.].*$', '')) -gt ([version]($atual -replace '[^\d.].*$', '')) } catch { return $nova -ne $atual }
}

function Backup {
  $h = Get-Health
  if (-not $h) { Say 'Ergon parado: sem backup agora.'; return $false }
  if ($h.sealed) { Say 'Ergon trancado: destranque para fazer o backup (a chave do banco só existe aberto).'; return $false }
  $nome = ComposeOut @('exec', '-T', 'ergon', 'node', 'server/src/backup-cli.ts')
  if (-not $nome) { Fail 'O backup falhou.' }
  $id = ComposeOut @('ps', '-q', 'ergon')
  New-Item -ItemType Directory -Force -Path $Backups | Out-Null
  $dest = Join-Path $Backups $nome
  & docker cp "${id}:/data/backups/$nome" $dest | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "O backup ficou no volume (/data/backups/$nome), mas a cópia para $Backups falhou." }
  if ($nome -match '\.sqlite$') {
    # servidor de uma versão anterior: backup antigo (só o banco e o keyring) — vale, mas não leva arquivos e conexões
    & docker cp "${id}:/data/backups/$nome.keyring.json" (Join-Path $Backups "$nome.keyring.json") 2>$null | Out-Null
    Say "Backup (formato antigo: só o banco e o keyring; atualize o Ergon para o backup completo): $dest"
    return $true
  }
  if (-not (Test-Path -LiteralPath (Join-Path $dest 'manifest.json'))) { Fail "O backup ficou no volume (/data/backups/$nome), mas a cópia para $Backups saiu incompleta." }
  Say "Backup completo e conferido (banco, arquivos e conexões): $dest"
  return $true
}

# Ferramenta de restauração (server/src/restore-cli.ts) num contêiner de uso único com o volume de dados: funciona
# com o Ergon parado. Devolve a linha JSON que ela imprime.
function Invoke-Restore([string[]]$a, [string[]]$extra = @()) {
  Push-Location $Raiz
  try { $out = & docker compose --profile hermes run --rm --no-deps -T @extra ergon node server/src/restore-cli.ts @a 2>$null } finally { Pop-Location }
  $linha = @($out) | Where-Object { $_ -match '^\{' } | Select-Object -Last 1
  if (-not $linha) { return [pscustomobject]@{ ok = $false; error = 'a ferramenta de restauração não respondeu' } }
  return ($linha | ConvertFrom-Json)
}
# cofre do motor: arquivos do usuário do motor (10000), com dono e permissões que o gocryptfs usa. O serviço do
# Ergon descarta todas as capacidades; este passo devolve só as de ler, copiar com dono e ajustar permissões.
$MotorRoot = @('--user', '0', '--cap-add', 'DAC_OVERRIDE', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '-v', "${Projeto}_hermes-vault:/vault")
function Confirm-Step([string]$pergunta) {
  if ($env:ERGON_CONFIRMAR -eq 'sim') { return $true }
  return ((Read-Host "$pergunta (s/N)") -eq 's')
}

# Restaurar: confere o backup inteiro antes; para o Ergon; o que estava no lugar vai para
# /data/backups/pre-restore-<data> (nada é apagado); sobe de novo. Backup de outra instalação: o cofre do motor de
# IA desta máquina é de outra chave, então vai inteiro para o pre-restore e o motor começa um novo.
function Restore([string]$origem) {
  if (-not $origem) { Fail "Diga qual backup: .\ergon.cmd restaurar <pasta do backup>   (os backups ficam em $Backups)" }
  if (-not (Test-Path -LiteralPath $origem)) { $c = Join-Path $Backups $origem; if (Test-Path -LiteralPath $c) { $origem = $c } else { Fail "Não achei o backup $origem." } }
  $origem = (Resolve-Path -LiteralPath $origem).Path
  if ((Split-Path $origem -Leaf) -eq 'manifest.json') { $origem = Split-Path $origem -Parent }
  $pasta = Test-Path -LiteralPath $origem -PathType Container
  if ($pasta -and -not (Test-Path -LiteralPath (Join-Path $origem 'manifest.json'))) { Fail 'Essa pasta não é um backup do Ergon (falta o manifest.json).' }
  if (-not $pasta -and $origem -notmatch '\.sqlite$') { Fail 'Indique a pasta do backup (ou um backup antigo .sqlite).' }
  Test-Docker
  $id = ComposeOut @('ps', '-aq', 'ergon')
  if (-not $id) { Fail 'O Ergon não está instalado aqui. Rode .\ergon.cmd instalar e restaure antes de criar a conta.' }
  $carimbo = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fff') + 'Z'
  $entrada = "/data/backups/entrada-$carimbo"
  $p = Invoke-Restore @('preparar')
  if (-not $p.ok) { Fail "Não consegui preparar o volume do Ergon; nada foi alterado. $($p.error)" }
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
  if (-not $copiou) { Fail 'Não consegui copiar o backup para o volume do Ergon; nada foi alterado.' }
  $c = Invoke-Restore @('conferir', $alvo)
  if (-not $c.ok) { Fail "O backup não confere; nada foi alterado. $($c.error) $(@($c.problems) -join '; ')" }
  if ($c.legacy) { Say 'Backup antigo: volta o banco (e o keyring); os arquivos e as conexões atuais ficam como estão.' }
  else { Say "Backup de $($c.createdAt) (versão $($c.version)), conferido: $($c.counts.artifacts) arquivo(s), $($c.counts.secrets) credencial(is) de conexão." }
  if ($c.keyring -eq 'outra') { Say 'É o backup de outra instalação: o motor de IA começa um cofre novo (o atual fica guardado).' }
  if ($c.keyring -and $c.keyring -ne 'sem') { Say 'Depois, o Ergon pode pedir a senha (ou a frase de recuperação) da época do backup.' }
  Say "O que está no lugar agora vai para /data/backups/pre-restore-$carimbo (nada é apagado)."
  if (-not (Confirm-Step 'Restaurar agora?')) { Say 'Nada foi alterado.'; return }
  $motor = ComposeOut @('ps', '-q', 'hermes')
  Compose @('stop', 'ergon')
  $r = Invoke-Restore @('restaurar', $alvo, $carimbo)
  if (-not $r.ok) { Compose @('start', 'ergon'); Fail "A restauração não foi feita; os dados atuais continuam no lugar. $($r.error)" }
  if ($r.keyring -eq 'outra') {
    if ($motor) { Compose @('stop', 'hermes') }
    $m = Invoke-Restore @('motor', '/vault', "/data/backups/pre-restore-$carimbo/motor") $MotorRoot
    if (-not $m.ok) { Say "Atenção: o cofre do motor não foi posto de lado ($($m.error)); o motor pode não abrir com a chave restaurada." }
  }
  Compose @('start', 'ergon')
  if ($motor) { Compose @('start', 'hermes') }
  $h = Wait-Health 240
  if (-not $h) { Fail "O Ergon não respondeu depois de restaurar. Para voltar: .\ergon.cmd desfazer-restauracao pre-restore-$carimbo" }
  Say "Restaurado. $(if ($h.sealed) { "Abra $Url e digite a senha (ou a frase) da época do backup." } else { "No ar em $Url." })"
  Say "Para voltar ao que era antes: .\ergon.cmd desfazer-restauracao pre-restore-$carimbo"
}

function Undo-Restore([string]$pre) {
  if ($pre -notmatch '^pre-restore-[\w-]+$') { Fail 'Diga qual: .\ergon.cmd desfazer-restauracao pre-restore-<data>  (o nome aparece ao restaurar)' }
  Test-Docker
  if (-not (Confirm-Step "Voltar ao que era antes da restauração $pre?")) { Say 'Nada foi alterado.'; return }
  $carimbo = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH-mm-ss-fff') + 'Z'
  $motor = ComposeOut @('ps', '-q', 'hermes')
  Compose @('stop', 'ergon')
  $r = Invoke-Restore @('desfazer', "/data/backups/$pre")
  if (-not $r.ok) { Compose @('start', 'ergon'); Fail "Não deu para desfazer: $($r.error)" }
  if ($r.motor) {
    if ($motor) { Compose @('stop', 'hermes') }
    $m = Invoke-Restore @('motor-volta', '/vault', "/data/backups/$pre/motor", "$($r.aside)/motor") $MotorRoot
    if (-not $m.ok) { Say "Atenção: o cofre do motor não voltou ($($m.error))." }
  }
  Compose @('start', 'ergon')
  if ($motor) { Compose @('start', 'hermes') }
  Say "Voltou ao que era antes da restauração. O restaurado ficou guardado em $($r.aside)."
}

<#
  Atualizar: backup antes; versão nova só se for mais nova; a atual fica guardada; se a nova não responder, volta
  sozinho para a anterior. O banco não volta sozinho (a versão nova pode ter migrado): se nem a anterior responder,
  o lançador diz qual backup restaurar — restaurar é decisão de quem usa.
#>
function Update {
  $antesBackup = @(Get-ChildItem -Path $Backups -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  if (-not (Backup)) { if (-not (Confirm-Step 'Continuar sem backup?')) { exit 1 } }
  $feito = @(Get-ChildItem -Path $Backups -ErrorAction SilentlyContinue | Where-Object { $antesBackup -notcontains $_.Name } | Select-Object -ExpandProperty FullName) | Select-Object -First 1
  $voltar = if ($feito) { "restaure o backup de antes: .\ergon.cmd restaurar `"$feito`"" } else { 'restaure o backup mais recente: .\ergon.cmd restaurar <pasta>' }
  if ($Fonte) {
    Push-Location $Raiz
    try {
      $antes = (& git rev-parse --short HEAD 2>$null)
      & git pull --ff-only; if ($LASTEXITCODE -ne 0) { Fail 'git pull falhou (há mudanças locais, ou a branch não acompanha uma remota). Nada foi alterado.' }
    } finally { Pop-Location }
    if (Up -NoFail) { return }
    Fail "A versão nova não respondeu. Para voltar: git checkout $antes e .\ergon.cmd iniciar; se ainda assim não subir, $voltar"
  }
  $url = if ($env:ERGON_UPDATE_URL) { $env:ERGON_UPDATE_URL } else { $Manifesto }
  try { $m = Invoke-RestMethod -Uri $url -TimeoutSec 20 -ErrorAction Stop } catch { Fail "Não consegui ler a versão publicada ($url)." }
  $atual = (Get-Content (Join-Path $Raiz 'VERSAO') -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not (Test-Newer $m.version $atual)) { Say "Já está na versão $atual (publicada: $($m.version))."; return }
  if (-not ($m.bundle -and $m.sha256)) { Fail 'Manifesto da versão sem pacote.' }
  $tmp = Join-Path $env:TEMP "ergon-$($m.version)"
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  $zip = Join-Path $tmp 'ergon.zip'
  try { Invoke-WebRequest -Uri $m.bundle -OutFile $zip -UseBasicParsing -ErrorAction Stop } catch { Fail 'Não consegui baixar o pacote. Nada foi alterado.' }
  if ((Get-FileHash -Algorithm SHA256 $zip).Hash.ToLower() -ne $m.sha256.ToLower()) { Fail 'Pacote baixado não confere (SHA-256). Nada foi alterado.' }
  Expand-Archive -Path $zip -DestinationPath (Join-Path $tmp 'x') -Force -ErrorAction Stop
  # a versão atual fica guardada (arquivos do pacote; o .env e os dados não mudam)
  $guardada = Join-Path $Local "versoes\$(if ($atual) { $atual } else { 'anterior' })"
  Remove-Item -Recurse -Force -LiteralPath $guardada -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $guardada | Out-Null
  Get-ChildItem $Raiz | Where-Object { $_.Name -ne '.env' } | Copy-Item -Destination $guardada -Recurse -Force -ErrorAction Stop
  Get-ChildItem (Join-Path $tmp 'x') | Where-Object { $_.Name -ne '.env' } | Copy-Item -Destination $Raiz -Recurse -Force -ErrorAction Stop
  Say "Pacote $($m.version) aplicado (a $atual ficou guardada em $guardada)."
  if (Up -NoFail) { return }
  Say "A versão $($m.version) não respondeu: voltando para a $atual."
  Get-ChildItem $guardada | Copy-Item -Destination $Raiz -Recurse -Force -ErrorAction Stop
  if (Up -NoFail) { Say "Voltou para a $atual e está no ar. A $($m.version) fica para depois (veja .\ergon.cmd logs)."; return }
  Fail "Nem a versão $atual respondeu (a nova pode ter mudado o banco): $voltar"
}

# ---------------------------------------------------------------- ajudante (destrancar sozinho)
# O Ergon roda no Docker e não alcança o cofre do Windows. O ajudante roda na sua conta, sem janela, desde que
# você entra no Windows: avisa o Ergon que está ali; quando você liga "Destrancar sozinho" na tela, busca a chave
# e a guarda com DPAPI (só esta conta, neste computador, decifra); se o Ergon reiniciar trancado, destranca.
# Desligar na tela invalida a chave, e o ajudante apaga a dele.
function Write-HelperLog([string]$m) {
  New-Item -ItemType Directory -Force -Path $Local | Out-Null
  $f = Join-Path $Local 'ajudante.log'
  if ((Test-Path $f) -and (Get-Item $f).Length -gt 200KB) { Remove-Item -Force $f }
  Add-Content -Path $f -Value "$(Get-Date -Format s) $m"
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
  if (-not $tok) { Write-HelperLog 'sem ERGON_AGENT_TOKEN em ergon.env (rode "ergon instalar")'; return }
  $h = @{ 'X-Ergon-Agent-Token' = $tok }
  $label = "$env:COMPUTERNAME ($env:USERNAME)"
  Write-HelperLog 'ajudante iniciado'
  $ultimoErro = ''
  while ($true) {
    $saved = @(Read-SavedKeys)
    $body = @{ label = $label; platform = 'windows' }
    if ($saved.Count) { $body.keyId = $saved[0].id; $body.keyIds = @($saved | ForEach-Object { $_.id }) }
    try {
      $r = Invoke-RestMethod -Method Post -Uri "$Url/api/agent/hello" -Headers $h -ContentType 'application/json' -Body ($body | ConvertTo-Json) -TimeoutSec 5 -ErrorAction Stop
      foreach ($id in @($r.invalid)) { if ($id) { Remove-SavedKey $id; Write-HelperLog 'abrir sozinho desligado na tela: uma chave apagada' } }
      if ($r.keyValid -eq $false -and $null -eq $r.invalid) { Remove-SavedKey $saved[0].id; Write-HelperLog 'destrancar sozinho desligado na tela: chave apagada' }
      # várias pessoas: a parte de quem ligou "abrir sozinho" ainda está fechada → abre com a chave dela
      foreach ($id in @($r.closed)) {
        $k = $saved | Where-Object { $_.id -eq $id } | Select-Object -First 1
        if ($k) {
          try { Invoke-RestMethod -Method Post -Uri "$Url/api/agent/open" -Headers $h -ContentType 'application/json' -Body (@{ key = $k.key } | ConvertTo-Json) -TimeoutSec 30 -ErrorAction Stop | Out-Null; Write-HelperLog 'parte de uma pessoa aberta' }
          catch { if ((Status-Of $_) -eq 401) { Remove-SavedKey $id; Write-HelperLog 'chave recusada (foi desligada): apagada' } }
        }
      }
      if ($r.enroll) {
        # corpo JSON explícito: sem ele, o Windows PowerShell manda "formulário" e o Ergon recusa (415)
        $c = Invoke-RestMethod -Method Post -Uri "$Url/api/agent/auto-unlock/claim" -Headers $h -ContentType 'application/json' -Body '{}' -TimeoutSec 10 -ErrorAction Stop
        Save-Key $c.id $c.key; $c = $null
        Write-HelperLog 'destrancar sozinho ligado: chave guardada no cofre do Windows'
      }
    } catch {
      $st = Status-Of $_
      # erro novo vai para o log (uma vez); "sem resposta" (Docker subindo) e 423 são normais
      if ($st -ne 0 -and $st -ne 423 -and "$st" -ne $ultimoErro) { Write-HelperLog "o Ergon respondeu $st"; $ultimoErro = "$st" }
      # 423: o Ergon reiniciou e está trancado → destranca com a chave guardada (se houver)
      if ($st -eq 423 -and $saved.Count) {
        foreach ($k in $saved) {
          try {
            Invoke-RestMethod -Method Post -Uri "$Url/api/unseal/auto" -ContentType 'application/json' -Body (@{ key = $k.key } | ConvertTo-Json) -TimeoutSec 30 -ErrorAction Stop | Out-Null
            Write-HelperLog 'Ergon destrancado'; break
          } catch {
            if ((Status-Of $_) -eq 401) { Remove-SavedKey $k.id; Write-HelperLog 'chave recusada (foi desligada): apagada' }
          }
        }
      }
    }
    $saved = $null
    Start-Sleep -Seconds 5
  }
}
function Install-Helper {
  # sem janela: o atalho .vbs chama o PowerShell escondido ao entrar no Windows
  $cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"`"$PSCommandPath`"`" ajudante"
  Set-Content -Encoding Default -Path $Inicializar -Value "CreateObject(`"WScript.Shell`").Run `"$cmd`", 0, False"
  Remove-Item -Force -ErrorAction SilentlyContinue $Antigo
  Start-Process -FilePath 'wscript.exe' -ArgumentList "`"$Inicializar`"" -WindowStyle Hidden
  Say 'Ajudante do computador ativo (começa sozinho ao entrar no Windows).'
}
function Remove-Helper {
  Remove-Item -Force -ErrorAction SilentlyContinue $Inicializar, $Antigo, $Guardada
  Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" | Where-Object { $_.CommandLine -match 'ergon\.ps1.*ajudante' -and $_.ProcessId -ne $PID } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -Confirm:$false }
  Say 'Ajudante removido e chave apagada deste computador. O destrancar sozinho fica desligado.'
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

function Write-DockerLog([string]$m) {
  New-Item -ItemType Directory -Force -Path $Local | Out-Null
  $f = Join-Path $Local 'docker.log'
  if ((Test-Path $f) -and (Get-Item $f).Length -gt 200KB) { Remove-Item -Force $f }
  Add-Content -Path $f -Value "$(Get-Date -Format s) $m"
  Say $m
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
    try { Move-Item -Path $p -Destination (Join-Path $destino (Split-Path $p -Leaf)) -ErrorAction Stop; Write-DockerLog "posto de lado: $p" }
    catch { Write-DockerLog "não consegui pôr de lado $p ($($_.Exception.Message))" }
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
  abrir, só onde o travamento já foi visto: computador com "ergon docker instalar" (foi a resposta a esse
  travamento) ou com um travamento registrado. Nunca para contêineres: só fecha o Docker Desktop quando o motor
  dele não está respondendo (contêiner nenhum está rodando nessa hora).
#>
function Start-DockerSafe {
  $mutex = New-Object Threading.Mutex($false, 'Local\ErgonDocker')
  if (-not $mutex.WaitOne(0)) { return }   # já há uma partida em andamento nesta sessão
  if (Test-DockerUp) { Write-DockerLog 'Docker já está no ar'; return }
  if (-not (Test-Path $DockerExe)) { Write-DockerLog "Docker Desktop não encontrado em $DockerExe"; return }
  $preventivo = (Test-Path $DockerAtalho) -or ((Get-DockerCrashes) -gt 0)
  for ($tentativa = 1; $tentativa -le 2; $tentativa++) {
    $inicio = Get-Date
    if ((Get-DockerProcs).Count) {
      # já está abrindo (por outro atalho): espera; se travou nos sockets, fecha para limpar
      if (Wait-DockerUp ([Math]::Min(60, $DockerEspera))) { Write-DockerLog 'Docker no ar'; return }
      if (-not (Test-SocketCrash $inicio.AddMinutes(-5))) { Write-DockerLog 'Docker ainda abrindo (sem o erro dos sockets): deixo seguir'; return }
      Write-DockerLog 'Docker travou nos sockets: fechando para limpar'
      Add-DockerCrash; $preventivo = $true
      Stop-DockerDesktop
    }
    if ($preventivo) { Move-DockerSockets }
    else { Write-DockerLog 'abrindo sem mexer em nada (diagnóstico primeiro: só limpo se o Docker acusar o travamento dos sockets)' }
    Write-DockerLog "abrindo o Docker Desktop (tentativa $tentativa)"
    Start-Process -FilePath $DockerExe
    $r = Wait-DockerUpOrCrash $DockerEspera $inicio
    if ($r -eq 'up') { Write-DockerLog 'Docker no ar'; return }
    if ($r -ne 'sockets') { Write-DockerLog "o Docker não respondeu em $DockerEspera s (sem o erro dos sockets): nada foi mexido; veja o Docker Desktop"; return }
    Write-DockerLog "o Docker travou nos sockets (erro conferido em backend.error.json)$(if ($preventivo) { ' de novo' }): fechando para limpar"
    Add-DockerCrash; $preventivo = $true
    Stop-DockerDesktop
  }
  Write-DockerLog 'o Docker não abriu depois de duas tentativas: abra o Docker Desktop e veja a mensagem'
}
function Install-DockerStart {
  # a entrada do próprio Docker no início do Windows abriria antes da limpeza: guardada e tirada (volta com "remover")
  $v = (Get-ItemProperty -Path $RunKey -Name 'Docker Desktop' -ErrorAction SilentlyContinue).'Docker Desktop'
  if ($v) {
    New-Item -ItemType Directory -Force -Path $Local | Out-Null
    Set-Content -Encoding UTF8 -Path $RunGuardada -Value $v
    Remove-ItemProperty -Path $RunKey -Name 'Docker Desktop' -ErrorAction Stop
    Say "Entrada do Docker no início do Windows guardada em $RunGuardada e retirada."
  }
  $cmd = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"`"$PSCommandPath`"`" docker"
  Set-Content -Encoding Default -Path $DockerAtalho -Value "CreateObject(`"WScript.Shell`").Run `"$cmd`", 0, False"
  Say "Ao entrar no Windows, o Ergon abre o Docker (atalho: $DockerAtalho). Registro: $(Join-Path $Local 'docker.log')"
}
function Remove-DockerStart {
  Remove-Item -Force -ErrorAction SilentlyContinue $DockerAtalho
  if (Test-Path $RunGuardada) {
    Set-ItemProperty -Path $RunKey -Name 'Docker Desktop' -Value ((Get-Content $RunGuardada -Raw).Trim()) -ErrorAction Stop
    Remove-Item -Force $RunGuardada
    Say 'Entrada original do Docker devolvida ao início do Windows.'
  }
  Say 'O Ergon não abre mais o Docker ao entrar no Windows.'
}

switch ($Comando) {
  'instalar' { Test-Docker; Initialize-Secrets; Register-Install; Up | Out-Null; Install-Helper; Start-Process $Url }
  'iniciar' { Test-Docker; Register-Install; Compose @('up', '-d'); Install-Helper; $h = Wait-Health 240; if ($h) { Say "No ar em $Url$(if ($h.sealed) { ' (trancado: digite a senha)' })" } else { Fail 'Não respondeu.' } }
  'subir' {
    if (-not (Test-DockerUp)) { Say 'Abrindo o Docker Desktop…'; Start-DockerSafe }
    Test-Docker; Register-Install
    Say 'Ligando os serviços do Ergon e o motor de IA…'
    Compose @('up', '-d')
    $h = Wait-Health 240
    if ($h) { Say "No ar em $Url$(if ($h.sealed) { ' (trancado: digite a senha)' })" } else { Fail 'O Ergon não respondeu. Veja: .\ergon.cmd logs' }
  }
  'parar' { Compose @('stop') }
  'status' { Compose @('ps'); $h = Get-Health; if ($h) { Say "Ergon $($h.version) · $(if ($h.sealed) { 'trancado' } else { 'aberto' }) · $Url" } else { Say 'Ergon não responde.' } }
  'abrir' { Start-Process $Url }
  'logs' { Compose @('logs', '--tail', '80', 'ergon', 'motores') }
  'backup' { if (-not (Backup)) { exit 1 } }
  'restaurar' { Restore $Opcao }
  'desfazer-restauracao' { Undo-Restore $Opcao }
  'atualizar' { Test-Docker; Update }
  'ajudante' { if ($Opcao -eq 'remover') { Remove-Helper } elseif ($Opcao -eq 'instalar') { Install-Helper } else { Run-Helper } }
  'docker' { if ($Opcao -eq 'remover') { Remove-DockerStart } elseif ($Opcao -eq 'instalar') { Install-DockerStart } else { Start-DockerSafe } }
  default { Get-Content $PSCommandPath -TotalCount 25 | Select-Object -Skip 1 | ForEach-Object { $_ -replace '^#>?\s?', '' } }
}
