# Teste do "ergon instalar" (pasta fixa e PATH) e do "ergon remover" (guarda os dados; --tudo apaga), com Docker,
# PATH e pastas simulados. Nenhuma instalação real, nem o PATH do usuário, é tocada.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\teste-instalar.ps1
param([string]$Ergon = (Join-Path (Split-Path $PSScriptRoot -Parent) 'ergon.ps1'))
$ErrorActionPreference = 'Stop'
$T = Join-Path ([IO.Path]::GetTempPath()) 'ergon-instalar-teste'
if (Test-Path $T) { Remove-Item -Recurse -Force $T }
New-Item -ItemType Directory -Force -Path "$T\zip", "$T\local", "$T\home\.ergon\secrets", "$T\home\.ergon\backups" | Out-Null
$env:ERGON_LOCAL_DIR = "$T\local"; $env:ERGON_BACKUPS_DIR = "$T\home\.ergon\backups"; $env:ERGON_PROGRAM_DIR = "$T\programa"
$env:ERGON_PATH_FILE = "$T\path.txt"; $env:ERGON_INSTALACAO = "$T\home\.ergon\instalacao.json"; $env:ERGON_STARTUP_DIR = "$T\inicio"
Set-Content $env:ERGON_PATH_FILE 'C:\Windows;C:\Outra'

. $Ergon *> $null   # carrega as funções do lançador (sem comando: só mostraria a ajuda)
$Fonte = $false; $Local = "$T\local"; $Backups = "$T\home\.ergon\backups"; $Segredos = "$T\home\.ergon\secrets"; $Projeto = 'ergon'
$Programa = "$T\programa"

# pacote de versão no "zip"
foreach ($a in @('ergon.ps1', 'ergon.cmd', 'ergon.sh', 'docker-compose.yml', 'LEIA-ME.md', 'VERSAO')) { Set-Content "$T\zip\$a" "conteudo $a" }
Set-Content "$T\zip\.env" 'ERGON_PORT=8787'

# simulações: Docker (registra cada chamada), ajudante, saída e o "rd" da pasta do programa
$script:calls = @(); $script:said = ''
function FakeDocker {
  $script:calls += ($args -join ' ')
  $a = $args -join ' '
  if ($a -like 'ps -aq*') { return 'motor1' }
  if ($a -like 'inspect*') { return 'ergon_motor-pessoa1' }
  if ($a -like 'volume ls*') { return @('ergon_ergon-data', 'ergon_hermes-vault', 'ergon_motor-pessoa1', 'outro_dados') }
}
$DockerCli = 'FakeDocker'
function Test-DockerUp { return $true }
function Remove-Helper { $script:said += "ajudante removido`n" }
function Remove-DockerStart { $script:said += "docker devolvido`n" }
function Fail([string]$m) { throw "FALHOU: $m" }
function Say([string]$m) { $script:said += "$m`n" }
function Start-Process { param($FilePath, $ArgumentList, $WindowStyle) $script:agendado = "$FilePath $ArgumentList" }

$ok = 0; $falhas = @()
function Check([bool]$c, [string]$m) { if ($c) { $script:ok++; Write-Host "  ok   $m" } else { $script:falhas += $m; Write-Host "  FALHA $m" -ForegroundColor Red } }
function PathAtual { (Get-Content $env:ERGON_PATH_FILE -Raw).Trim() }

Write-Host 'A) instalar a partir da pasta do zip: copia para a pasta do programa e põe no PATH'
$Raiz = "$T\zip"
$d = Install-Program
Check (Same-Dir $d $Programa) 'devolve a pasta do programa'
$faltam = @(@('ergon.ps1', 'ergon.cmd', 'docker-compose.yml', 'VERSAO', '.env') | Where-Object { -not (Test-Path "$Programa\$_") })
Check ($faltam.Count -eq 0) "lançador, compose, versão e .env copiados$(if ($faltam.Count) { ' (faltam: ' + ($faltam -join ', ') + ')' })"
Check ((PathAtual) -eq "C:\Windows;C:\Outra;$Programa") 'pasta do programa no fim do PATH do usuário, o resto intacto'

Write-Host 'B) instalar de novo (de dentro da pasta do programa, ou com outro zip): não duplica, guarda o .env'
Set-Content "$Programa\.env" 'ERGON_PORT=9999'
$d = Install-Program
Check ((PathAtual) -eq "C:\Windows;C:\Outra;$Programa") 'PATH sem duplicar'
Check ((Get-Content "$Programa\.env" -Raw).Trim() -eq 'ERGON_PORT=9999') 'o .env da instalação ficou como estava'
$Raiz = $Programa
$d = Install-Program
Check (Same-Dir $d $Programa) 'de dentro da pasta do programa, continua nela'

Write-Host 'C) remover: tira contêineres, imagens, ajudante, registro e PATH; GUARDA dados, segredos e backups'
Set-Content "$Segredos\ergon.env" 'X=1'; New-Item -ItemType Directory -Force "$Backups\ergon-1" | Out-Null; Set-Content $env:ERGON_INSTALACAO '{}'
$script:calls = @(); $script:agendado = ''
Remove-Ergon
Check ($script:calls -contains 'rm -f motor1') 'contêiner do motor da pessoa removido'
Check (($script:calls | Where-Object { $_ -like 'compose*down*' }) -match '--rmi all' -and -not (($script:calls | Where-Object { $_ -like 'compose*down*' }) -match ' -v')) 'compose down com as imagens e SEM os volumes'
Check (-not ($script:calls | Where-Object { $_ -like 'volume rm*' })) 'nenhum volume apagado'
Check ((Test-Path "$Segredos\ergon.env") -and (Test-Path "$Backups\ergon-1")) 'segredos e backups guardados'
Check (-not (Test-Path $env:ERGON_INSTALACAO)) 'registro da instalação apagado'
Check ((PathAtual) -eq 'C:\Windows;C:\Outra') 'pasta do programa saiu do PATH'
Check ($script:agendado -match 'rd /s /q' -and $script:agendado -match [regex]::Escape($Programa)) 'pasta do programa agendada para sair'
Check ($script:said -match 'ajudante removido') 'ajudante removido'

Write-Host 'D) remover --tudo sem a confirmação certa: nada é apagado'
$script:calls = @(); $env:ERGON_CONFIRMAR = 'sim'
$erro = ''; try { Remove-Ergon -Tudo } catch { $erro = $_.Exception.Message }
Check ($erro -match 'Nada foi apagado' -and $script:calls.Count -eq 0 -and (Test-Path "$Segredos\ergon.env")) 'pede APAGAR; com outra resposta não mexe em nada'

Write-Host 'E) remover --tudo confirmado: apaga volumes do Ergon (e o cofre do motor), segredos e backups; o resto do Docker fica'
$env:ERGON_CONFIRMAR = 'APAGAR'; $script:calls = @()
Remove-Ergon -Tudo
$rm = ($script:calls | Where-Object { $_ -like 'volume rm*' }) -join ' '
Check ((($script:calls | Where-Object { $_ -like 'compose*down*' }) -match ' -v')) 'compose down com os volumes'
Check ($rm -match 'ergon_ergon-data' -and $rm -match 'ergon_hermes-vault' -and $rm -match 'ergon_motor-pessoa1') 'volumes do Ergon e o cofre do motor apagados'
Check ($rm -notmatch 'outro_dados') 'volume de outro projeto não é tocado'
Check (-not (Test-Path "$T\home\.ergon\secrets") -and -not (Test-Path $Backups) -and -not (Test-Path $Local)) 'segredos, backups e registros apagados'

Remove-Item Env:\ERGON_CONFIRMAR
Write-Host ''
Write-Host "$ok ok, $($falhas.Count) falha(s)"
if ($falhas.Count) { exit 1 }
