# Teste do "ergon atualizar" (pacote de versão) com Docker, rede e backup simulados: a versão nova só entra se for
# mais nova e conferir; a atual fica guardada; se a nova não responder, volta sozinho; se nem a anterior responder,
# diz qual backup restaurar. Nenhuma instalação real é tocada.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\teste-atualizar.ps1
param([string]$Ergon = (Join-Path (Split-Path $PSScriptRoot -Parent) 'ergon.ps1'))
$ErrorActionPreference = 'Stop'
$T = Join-Path ([IO.Path]::GetTempPath()) 'ergon-atualizar-teste'
if (Test-Path $T) { Remove-Item -Recurse -Force $T }
New-Item -ItemType Directory -Force -Path "$T\pacote", "$T\nova", "$T\local", "$T\backups" | Out-Null
$env:ERGON_LOCAL_DIR = "$T\local"; $env:ERGON_BACKUPS_DIR = "$T\backups"; $env:ERGON_CONFIRMAR = 'sim'

. $Ergon *> $null   # carrega as funções do lançador (sem comando: só mostraria a ajuda)
$Raiz = "$T\pacote"; $Fonte = $false; $Local = "$T\local"; $Backups = "$T\backups"

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

Write-Host ''
Write-Host "$ok verificações ok, $($falhas.Count) falha(s)"
Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
if ($falhas.Count) { exit 1 }
