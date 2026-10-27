# Teste do "ergon docker" num ambiente simulado (Windows): Docker falso, pastas falsas, chave de registro só de teste.
# Nada do Docker real, da pasta Inicializar real nem da chave Run real é tocado.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\teste-docker.ps1
param([string]$Ergon = (Join-Path (Split-Path $PSScriptRoot -Parent) 'ergon.ps1'))
$ErrorActionPreference = 'Stop'
$T = Join-Path ([IO.Path]::GetTempPath()) 'ergon-docker-teste'
if (Test-Path $T) { Remove-Item -Recurse -Force $T }
New-Item -ItemType Directory -Force -Path $T, "$T\data\Docker", "$T\startup" | Out-Null
$env:ERGON_LOCAL_DIR = "$T\local"; $env:ERGON_DOCKER_DATA = "$T\data"; $env:ERGON_DOCKER_PROC = 'ergon-docker-falso-inexistente'
$env:ERGON_DOCKER_WAIT = '6'; $env:ERGON_STARTUP_DIR = "$T\startup"; $env:ERGON_RUN_KEY = 'HKCU:\Software\ErgonTesteDocker\Run'
$env:ERGON_DOCKER_CLI = "$T\docker.cmd"; $env:ERGON_DOCKER_EXE = "$T\docker-desktop.cmd"
# CLI falsa: "no ar" quando existe up.flag
Set-Content -Encoding ascii "$T\docker.cmd" "@echo off`r`nif exist `"%~dp0up.flag`" (exit /b 0) else (exit /b 1)"
# Docker Desktop falso: conta as partidas; recria as pastas de sockets (como o real). Modos: "trava1" (a 1ª partida
# trava nos sockets), "trava-com-sobras" (trava sempre que as pastas velhas estão no lugar), "lento" (nunca sobe)
Set-Content -Encoding ascii "$T\docker-desktop.cmd" @"
@echo off
set /a n=0
if exist "%~dp0n.txt" set /p n=<"%~dp0n.txt"
set /a n=n+1
>"%~dp0n.txt" echo %n%
set modo=ok
if exist "%~dp0modo.txt" set /p modo=<"%~dp0modo.txt"
if "%modo%"=="trava-com-sobras" if exist "%~dp0data\Docker\run\dockerInference" (echo {"message":"initializing Inference manager","x":"dockerInference"}>"%~dp0data\Docker\backend.error.json" & exit /b 0)
mkdir "%~dp0data\Docker\run" 2>nul & echo.>"%~dp0data\Docker\run\dockerInference"
mkdir "%~dp0data\docker-secrets-engine" 2>nul & echo.>"%~dp0data\docker-secrets-engine\engine.sock"
if "%modo%"=="trava1" if "%n%"=="1" (echo {"message":"initializing Secrets Engine","x":"engine.sock"}>"%~dp0data\Docker\backend.error.json" & exit /b 0)
if "%modo%"=="lento" exit /b 0
echo.>"%~dp0up.flag"
"@
$ok = 0; $falhas = @()
function Check([bool]$c, [string]$m) { if ($c) { $script:ok++; Write-Host "  ok   $m" } else { $script:falhas += $m; Write-Host "  FALHA $m" -ForegroundColor Red } }
function Sockets { New-Item -ItemType Directory -Force "$T\data\Docker\run", "$T\data\docker-secrets-engine" | Out-Null; Set-Content "$T\data\Docker\run\dockerInference" ''; Set-Content "$T\data\docker-secrets-engine\engine.sock" '' }
function Reset { Remove-Item -Force -ErrorAction SilentlyContinue "$T\up.flag", "$T\n.txt", "$T\modo.txt", "$T\data\Docker\backend.error.json", "$T\startup\Ergon - Docker.vbs"; Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$T\local" }
function Run([string[]]$a) { & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Ergon @a 2>&1 | Out-String }
function Sobras { @(Get-ChildItem "$T\local\docker-sobras" -Directory -ErrorAction SilentlyContinue) }
function Starts { if (Test-Path "$T\n.txt") { [int](Get-Content "$T\n.txt").Trim() } else { 0 } }
function Diag { try { [int](Get-Content "$T\local\docker-diagnostico.json" -Raw | ConvertFrom-Json).travamentos } catch { 0 } }

Write-Host 'A) computador novo, sem histórico: sobras de sockets, mas o Docker abre normal — nada é mexido'
Reset; Sockets
$o = Run @('docker')
Check ($o -match 'diagnóstico primeiro') 'abriu sem mexer (diagnóstico primeiro)'
Check ($o -match 'Docker no ar') 'Docker abriu'
Check ((Sobras).Count -eq 0) 'nenhuma pasta posta de lado'
Check ((Starts) -eq 1 -and (Diag) -eq 0) 'uma partida, nenhum travamento registrado'

Write-Host 'B) sem histórico, trava nos sockets: o próprio Docker acusa, aí sim limpa, registra e abre'
Reset; Sockets; Set-Content -Encoding ascii "$T\modo.txt" 'trava-com-sobras'
$o = Run @('docker')
Check ($o -match 'travou nos sockets \(erro conferido') 'percebeu pela assinatura do erro do Docker'
Check ($o -match 'posto de lado: .*Docker\\run' -and $o -match 'posto de lado: .*docker-secrets-engine') 'pôs as duas pastas de lado'
Check ($o -match 'tentativa 2' -and $o -match 'Docker no ar') 'abriu na segunda'
Check ((Sobras).Count -eq 1 -and (Test-Path "$((Sobras)[0].FullName)\run\dockerInference")) 'nada apagado: as pastas estão em docker-sobras'
Check ((Diag) -eq 1) 'travamento registrado'

Write-Host 'C) com o travamento registrado: o próximo reinício já limpa antes de abrir (uma partida só)'
Remove-Item -Force "$T\up.flag", "$T\n.txt", "$T\data\Docker\backend.error.json" -ErrorAction SilentlyContinue; Sockets
$o = Run @('docker')
Check ($o -notmatch 'diagnóstico primeiro' -and $o -match 'posto de lado') 'limpeza preventiva'
Check ((Starts) -eq 1 -and $o -match 'Docker no ar') 'abriu na primeira'

Write-Host 'D) com "docker instalar" e sem histórico (caso já visto em campo): preventivo como antes'
Reset; Sockets; Set-Content -Encoding ascii "$T\modo.txt" 'trava-com-sobras'
Set-Content -Path "$T\startup\Ergon - Docker.vbs" -Value "' atalho de teste"
$o = Run @('docker')
Check ($o -notmatch 'diagnóstico primeiro' -and $o -match 'posto de lado') 'limpou antes de abrir'
Check ((Starts) -eq 1 -and $o -match 'Docker no ar') 'abriu na primeira, como antes'

Write-Host 'E) Docker já no ar: não mexe em nada'
$antes = (Sobras).Count
$o = Run @('docker')
Check ($o -match 'Docker já está no ar') 'não mexe em nada'
Check ((Sobras).Count -eq $antes -and (Test-Path "$T\data\Docker\run")) 'pastas em uso ficaram onde estavam'

Write-Host 'F) não sobe e não acusa os sockets: não mexe e avisa'
Reset; Sockets; Set-Content -Encoding ascii "$T\modo.txt" 'lento'
$o = Run @('docker')
Check ($o -match 'sem o erro dos sockets\): nada foi mexido') 'avisou sem mexer'
Check ((Sobras).Count -eq 0 -and (Diag) -eq 0) 'nenhuma pasta posta de lado, nada registrado'

Write-Host 'G) instalar e remover (chave de teste e pasta Inicializar de teste)'
Reset; New-Item -Force -Path $env:ERGON_RUN_KEY | Out-Null
Set-ItemProperty -Path $env:ERGON_RUN_KEY -Name 'Docker Desktop' -Value 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$o = Run @('docker', 'instalar')
Check (-not (Get-ItemProperty -Path $env:ERGON_RUN_KEY -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) 'entrada do Docker retirada do início'
Check ((Get-Content "$T\local\docker-inicio-original.txt" -Raw).Trim() -eq 'C:\Program Files\Docker\Docker\Docker Desktop.exe') 'entrada original guardada'
$vbs = Get-Content "$T\startup\Ergon - Docker.vbs" -Raw
Check ($vbs -match 'WScript\.Shell' -and $vbs -match '-WindowStyle Hidden' -and $vbs -match 'ergon\.ps1"" docker"') 'atalho escondido criado'
$o = Run @('docker', 'remover')
Check ((Get-ItemProperty -Path $env:ERGON_RUN_KEY -Name 'Docker Desktop').'Docker Desktop' -eq 'C:\Program Files\Docker\Docker\Docker Desktop.exe') 'remover devolve a entrada original'
Check (-not (Test-Path "$T\startup\Ergon - Docker.vbs") -and -not (Test-Path "$T\local\docker-inicio-original.txt")) 'remover apaga o atalho e a cópia'
Remove-Item -Recurse -Force 'HKCU:\Software\ErgonTesteDocker'

Write-Host ''
Write-Host "$ok verificações ok, $($falhas.Count) falha(s)"
Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
if ($falhas.Count) { exit 1 }
