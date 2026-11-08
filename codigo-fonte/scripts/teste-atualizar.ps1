# Teste do "ergon atualizar" (pacote de versão) com Docker, rede e backup simulados: a versão nova só entra se for
# mais nova e conferir; a atual fica guardada; se a nova não responder, volta sozinho; se nem a anterior responder,
# diz qual backup restaurar. Atualizando de um pacote antigo para um com outra imagem do motor: com a nova no ar, as
# imagens antigas dos dois repositórios do Ergon (o do serviço e o -hermes, do motor de IA) saem sem forçar, e ficam a
# atual (mesmo sem contêiner), a de um contêiner e a de outro projeto; das versões guardadas fica só a anterior; os
# backups giram (ficam os 7 mais recentes). Nenhuma instalação real é tocada.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\teste-atualizar.ps1
param([string]$Ergon = (Join-Path (Split-Path $PSScriptRoot -Parent) 'ergon.ps1'))
$ErrorActionPreference = 'Stop'
$T = Join-Path ([IO.Path]::GetTempPath()) 'ergon-atualizar-teste'
if (Test-Path $T) { Remove-Item -Recurse -Force $T }
New-Item -ItemType Directory -Force -Path "$T\pacote", "$T\nova", "$T\local", "$T\backups" | Out-Null
$env:ERGON_LOCAL_DIR = "$T\local"; $env:ERGON_BACKUPS_DIR = "$T\backups"; $env:ERGON_CONFIRMAR = 'sim'

. $Ergon *> $null   # carrega as funções do lançador (sem comando: só mostraria a ajuda)
$Raiz = "$T\pacote"; $Fonte = $false; $Local = "$T\local"; $Backups = "$T\backups"

# Docker simulado: imagens (ID, repositório, etiqueta, digest, tamanho), contêineres (ID, imagem, imagem anterior) e
# as referências do compose. Toda chamada fica registrada; "rmi" sem forçar recusa imagem em uso ou com dois nomes.
$script:imgs = @(); $script:cts = @(); $script:refs = @{}; $script:dcalls = @(); $script:forcou = $false
function FakeDocker {
  $a = @($args); $script:dcalls += ($a -join ' '); $global:LASTEXITCODE = 0
  switch ($a[0]) {
    'ps' { return @($script:cts | ForEach-Object { $_.id }) }
    'inspect' { return @($a[3..($a.Count - 1)] | ForEach-Object { $c = $_; $script:cts | Where-Object { $_.id -eq $c } | ForEach-Object { "$($_.image) $(if ($_.prev) { 'sha256:' + $_.prev })" } }) }
    'image' {
      if ($a[2] -eq '--format') { $f = $a[3]; $x = $a[4] } else { $f = ''; $x = $a[2] }
      $i = if ($script:refs.ContainsKey($x)) { $script:refs[$x] } else { $x }
      $im = @($script:imgs | Where-Object { $_.id -eq $i })
      if (-not $im.Count) { $global:LASTEXITCODE = 1; return }
      if ($f -like '*Size*') { return "$($im[0].size)" } elseif ($f -like '*Id*') { return "sha256:$i" } else { return '[{}]' }
    }
    'images' { return @($script:imgs | ForEach-Object { "sha256:$($_.id) $($_.repo) $($_.tag) $($_.dig)" }) }
    'rmi' {
      if ($a -contains '-f' -or $a -contains '--force') { $script:forcou = $true; $global:LASTEXITCODE = 1; return }
      $x = $a[1]
      if ($x -match '^[0-9a-f]{64}$') {
        if (@($script:cts | Where-Object { $_.image -eq $x }).Count) { $global:LASTEXITCODE = 1; return }
        if (@($script:imgs | Where-Object { $_.id -eq $x -and $_.tag -ne '<none>' }).Count -gt 1) { $global:LASTEXITCODE = 1; return }
        $script:imgs = @($script:imgs | Where-Object { $_.id -ne $x })
      } elseif ($x -match '@') { $r, $d = $x -split '@', 2; $script:imgs = @($script:imgs | Where-Object { -not ($_.repo -eq $r -and $_.dig -eq $d) }) }
      else { $k = $x.LastIndexOf(':'); $r = $x.Substring(0, $k); $tg = $x.Substring($k + 1); $script:imgs = @($script:imgs | Where-Object { -not ($_.repo -eq $r -and $_.tag -eq $tg) }) }
    }
  }
}
$DockerCli = 'FakeDocker'
function HexId([int]$n) { 'a' + $n.ToString().PadLeft(63, '0') }
function Img($id, $repo, $tag, $dig, $size) { [pscustomobject]@{ id = $id; repo = $repo; tag = $tag; dig = $dig; size = $size } }
function Tem($id) { [bool]@($script:imgs | Where-Object { $_.id -eq $id }).Count }

# versão nova publicada (o .env dela não pode sobrescrever o do usuário)
Set-Content "$T\nova\VERSAO" '0.3.1'; Set-Content "$T\nova\docker-compose.yml" 'versao nova'; Set-Content "$T\nova\.env" 'ERGON_PORT=999'
Compress-Archive -Path "$T\nova\*" -DestinationPath "$T\nova.zip"
$script:bundle = "$T\nova.zip"
$script:manifest = [pscustomobject]@{ version = '0.3.1'; bundle = 'https://exemplo.invalid/ergon.zip'; sha256 = (Get-FileHash -Algorithm SHA256 "$T\nova.zip").Hash.ToLower() }

# simulações: backup, Docker (Up responde ou não, na ordem dada) e rede
function Backup { New-Item -ItemType Directory -Force "$Backups\ergon-antes-de-atualizar" | Out-Null; return $true }
$script:ups = @(); $script:respostas = @()
function Up([switch]$NoFail) {
  $script:ups += (Get-Content (Join-Path $Raiz 'docker-compose.yml') -Raw).Trim()
  $r = $script:respostas[0]; $script:respostas = @($script:respostas | Select-Object -Skip 1)
  if ($r) { return [pscustomobject]@{ version = 'x' } } else { return $null }
}
function Invoke-RestMethod { param($Uri, $TimeoutSec, $ErrorAction) return $script:manifest }
function Invoke-WebRequest { param($Uri, $OutFile, [switch]$UseBasicParsing, $ErrorAction) Copy-Item $script:bundle $OutFile }
function Fail([string]$m) { throw "FALHOU: $m" }
function Say([string]$m) { $script:said += "$m`n" }
function Pacote { Remove-Item -Recurse -Force "$T\pacote\*", "$T\local\versoes", "$T\backups\*" -ErrorAction SilentlyContinue; Set-Content "$T\pacote\VERSAO" '0.3.0'; Set-Content "$T\pacote\docker-compose.yml" 'versao antiga'; Set-Content "$T\pacote\.env" 'ERGON_PORT=8787'; $script:ups = @(); $script:said = '' }
function Lido([string]$f) { (Get-Content (Join-Path $Raiz $f) -Raw).Trim() }

$ok = 0; $falhas = @()
function Check([bool]$c, [string]$m) { if ($c) { $script:ok++; Write-Host "  ok   $m" } else { $script:falhas += $m; Write-Host "  FALHA $m" -ForegroundColor Red } }

Write-Host 'A) versão nova responde'
Pacote; $script:respostas = @($true)
Update
Check ((Lido 'VERSAO') -eq '0.3.1' -and (Lido 'docker-compose.yml') -eq 'versao nova') 'versão nova aplicada'
Check ((Lido '.env') -eq 'ERGON_PORT=8787') 'o .env do usuário ficou como estava'
Check ((Get-Content "$T\local\versoes\0.3.0\docker-compose.yml" -Raw).Trim() -eq 'versao antiga') 'a versão anterior ficou guardada'
Check ($script:ups.Count -eq 1) 'subiu uma vez'

Write-Host 'B) versão nova não responde: volta sozinho para a anterior'
Pacote; $script:respostas = @($false, $true)
Update
Check (($script:ups -join '|') -eq 'versao nova|versao antiga') 'tentou a nova e voltou para a antiga'
Check ((Lido 'VERSAO') -eq '0.3.0' -and (Lido 'docker-compose.yml') -eq 'versao antiga') 'arquivos da anterior de volta'
Check ($script:said -match 'Voltou para a 0\.3\.0 e está no ar') 'avisou que voltou'

Write-Host 'C) nem a anterior responde: diz qual backup restaurar (não restaura sozinho)'
Pacote; $script:respostas = @($false, $false)
$erro = ''; try { Update } catch { $erro = $_.Exception.Message }
Check ($erro -match 'Nem a versão 0\.3\.0 respondeu' -and $erro -match 'restaurar ".*ergon-antes-de-atualizar"') 'aponta o backup feito antes de atualizar'

Write-Host 'D) publicada é mais antiga ou igual: não mexe'
Pacote; $script:manifest.version = '0.2.9'
Update
Check ($script:ups.Count -eq 0 -and (Lido 'VERSAO') -eq '0.3.0') 'não rebaixa'
$script:manifest.version = '0.3.0'; Update
Check ($script:ups.Count -eq 0) 'mesma versão: nada a fazer'
$script:manifest.version = '0.3.1'

Write-Host 'E) pacote que não confere (SHA-256): nada muda'
Pacote; $sha = $script:manifest.sha256; $script:manifest.sha256 = '0' * 64
$erro = ''; try { Update } catch { $erro = $_.Exception.Message }
Check ($erro -match 'não confere' -and (Lido 'VERSAO') -eq '0.3.0' -and $script:ups.Count -eq 0) 'recusou sem tocar em nada'
$script:manifest.sha256 = $sha

Write-Host 'F) comparação de versões'
Check ((Test-Newer '0.10.0' '0.9.0') -and -not (Test-Newer '0.3.0' '0.3.0') -and -not (Test-Newer '0.2.9' '0.3.0') -and (Test-Newer '0.3.0' '')) 'números, não texto (0.10 > 0.9)'

# de um pacote antigo para um com outra imagem do motor (os dois repositórios do Ergon, presos a digests)
$C = 'ghcr.io/dono/ergon-community'; $M = 'ghcr.io/dono/ergon-community-hermes'
function ComposeDe([string]$dc, [string]$dm) { "services:`n  ergon:`n    image: $C@sha256:$dc`n  hermes:`n    image: $M@sha256:$dm`n  motores:`n    image: $C@sha256:$dc`n    environment:`n      ERGON_MOTOR_IMAGE: $M@sha256:$dm`n" }
New-Item -ItemType Directory -Force "$T\nova2" | Out-Null
Set-Content "$T\nova2\VERSAO" '0.3.1'; Set-Content "$T\nova2\docker-compose.yml" (ComposeDe 'dcorenovo' 'dmotornovo')
Compress-Archive -Path "$T\nova2\*" -DestinationPath "$T\nova2.zip"
$CoreNovo = HexId 1; $CoreVelho = HexId 2; $MotorNovo = HexId 3; $MotorUsado = HexId 4; $MotorAntigo = HexId 5; $Terceiro = HexId 6
function Estado {
  $script:refs = @{ "$C@sha256:dcorenovo" = $CoreNovo; "$M@sha256:dmotornovo" = $MotorNovo }
  $script:imgs = @((Img $CoreNovo $C '<none>' 'sha256:dcorenovo' 400000000), (Img $CoreVelho $C '<none>' 'sha256:dcorevelho' 390000000),
    (Img $MotorNovo $M '<none>' 'sha256:dmotornovo' 3000000000), (Img $MotorUsado $M '<none>' 'sha256:dmotorusado' 3000000000),
    (Img $MotorAntigo $M '0.2.0' 'sha256:dmotorantigo' 2900000000), (Img $Terceiro 'docker.io/library/postgres' '16' 'sha256:dpg' 400000000))
  # o Ergon e o gerente já na imagem nova; o motor da pessoa ainda na de antes (o gerente troca quando ele estiver livre)
  $script:cts = @([pscustomobject]@{ id = 'c1'; image = $CoreNovo; prev = '' }, [pscustomobject]@{ id = 'c2'; image = $CoreNovo; prev = '' }, [pscustomobject]@{ id = 'm1'; image = $MotorUsado; prev = '' })
  $script:dcalls = @(); $script:forcou = $false
}

Write-Host 'G) pacote antigo → novo com outra imagem do motor: no ar, as antigas sem uso saem, sem forçar'
Pacote; Set-Content "$T\pacote\docker-compose.yml" (ComposeDe 'dcorevelho' 'dmotorusado'); New-Item -ItemType Directory -Force "$T\local\versoes\0.2.0" | Out-Null
$script:bundle = "$T\nova2.zip"; $script:manifest = [pscustomobject]@{ version = '0.3.1'; bundle = 'https://exemplo.invalid/ergon.zip'; sha256 = (Get-FileHash -Algorithm SHA256 "$T\nova2.zip").Hash.ToLower() }
Estado; $script:respostas = @($true)
Update
Check ((Lido 'docker-compose.yml') -match 'dmotornovo') 'versão nova aplicada (outra imagem do motor)'
Check (-not (Tem $CoreVelho)) 'a imagem antiga do serviço saiu'
Check (-not (Tem $MotorAntigo)) 'a imagem antiga do motor de IA (repositório -hermes) saiu'
Check ((Tem $CoreNovo) -and (Tem $MotorNovo)) 'as atuais ficam (a do motor mesmo sem contêiner)'
Check (Tem $MotorUsado) 'a do motor ainda ligado na versão de antes fica'
Check ((Tem $Terceiro) -and -not ($script:dcalls -match $Terceiro)) 'a de outro projeto não é tocada'
Check (-not $script:forcou -and -not ($script:dcalls -match '^volume|prune')) 'sem forçar, sem volume e sem prune'
Check ($script:said -match 'Limpeza: 2 imagem') 'diz o que liberou'
Check (((@(Get-ChildItem "$T\local\versoes" -Directory | ForEach-Object { $_.Name })) -join ',') -eq '0.3.0') 'das versões guardadas, fica só a anterior (0.3.0)'

Write-Host 'H) a nova não responde: volta para a anterior e não limpa nada'
Pacote; Set-Content "$T\pacote\docker-compose.yml" (ComposeDe 'dcorevelho' 'dmotorusado')
Estado; $script:respostas = @($false, $true)
Update
Check ((Tem $CoreVelho) -and (Tem $MotorAntigo) -and -not ($script:dcalls -match '^images')) 'nenhuma imagem tirada (a anterior pode precisar das dela)'

Write-Host 'I) remover: todas as imagens do Ergon, as do motor de IA também (contêineres já fora)'
Estado; $script:cts = @(); $Raiz = "$T\nova2"
Clear-Images -Tudo
Check (-not @($script:imgs | Where-Object { $_.repo -eq $C -or $_.repo -eq $M }).Count) 'nenhuma imagem dos dois repositórios do Ergon fica'
Check ((Tem $Terceiro) -and -not $script:forcou) 'a de outro projeto fica; nada forçado'
$Raiz = "$T\pacote"

Write-Host 'J) backups: ficam os 7 mais recentes; o recém-feito sempre; o resto da pasta não é tocado'
Remove-Item -Recurse -Force "$T\backups\*" -ErrorAction SilentlyContinue
1..9 | ForEach-Object { New-Item -ItemType Directory -Force "$T\backups\ergon-2026-11-0$($_)T10-00-00-000Z" | Out-Null }
Set-Content "$T\backups\ergon-2026-10-01T10-00-00-000Z.sqlite" 'x'; Set-Content "$T\backups\ergon-2026-10-01T10-00-00-000Z.sqlite.keyring.json" 'x'; Set-Content "$T\backups\minhas-notas.txt" 'x'
New-Item -ItemType Directory -Force "$T\backups\ergon-2026-01-01T00-00-00-000Z" | Out-Null   # relógio atrasado
Limit-Backups 'ergon-2026-01-01T00-00-00-000Z'
Check (Test-Path "$T\backups\ergon-2026-01-01T00-00-00-000Z") 'o recém-feito fica (mesmo com a data atrasada)'
Check (@(Get-ChildItem "$T\backups" -Directory -Filter 'ergon-2026-11-0*').Count -eq 6 -and (Test-Path "$T\backups\ergon-2026-11-04T10-00-00-000Z") -and -not (Test-Path "$T\backups\ergon-2026-11-03T10-00-00-000Z")) 'mais os 6 mais novos'
Check (-not (Test-Path "$T\backups\ergon-2026-10-01T10-00-00-000Z.sqlite") -and -not (Test-Path "$T\backups\ergon-2026-10-01T10-00-00-000Z.sqlite.keyring.json")) 'o backup antigo (.sqlite) sai com o keyring dele'
Check (Test-Path "$T\backups\minhas-notas.txt") 'arquivo que não é backup do Ergon fica'
$env:ERGON_BACKUPS_MANTER = '0'; New-Item -ItemType Directory -Force "$T\backups\ergon-2026-11-01T10-00-00-000Z" | Out-Null; Limit-Backups ''
Check (Test-Path "$T\backups\ergon-2026-11-01T10-00-00-000Z") 'ERGON_BACKUPS_MANTER=0 guarda todos'
Remove-Item Env:\ERGON_BACKUPS_MANTER

Write-Host ''
Write-Host "$ok verificações ok, $($falhas.Count) falha(s)"
Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
if ($falhas.Count) { exit 1 }
