# Teste do lançador antigo do Windows (ergon.ps1): desde a rc.29 só mostra o aviso de que a instalação pelo Docker
# Desktop não é mais atendida. Confere que qualquer comando (os de antes, em inglês e em português, e nenhum) dá o aviso
# no idioma do Windows (ERGON_LANG força), sai com erro, aponta para o aplicativo e não chama o Docker nem mexe em nada.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\teste-comandos.ps1
param([string]$Ergon = (Join-Path (Split-Path $PSScriptRoot -Parent) 'ergon.ps1'))
$ErrorActionPreference = 'Stop'
$ok = 0; $falhas = @()
function Check([bool]$c, [string]$m) { if ($c) { $script:ok++; Write-Host "  ok   $m" } else { $script:falhas += $m; Write-Host "  FALHA $m" -ForegroundColor Red } }
# um docker de mentira na frente do PATH: se o lançador o chamar, o arquivo marca
$T = Join-Path ([IO.Path]::GetTempPath()) 'ergon-comandos-teste'
if (Test-Path $T) { Remove-Item -Recurse -Force $T }
New-Item -ItemType Directory -Force -Path $T | Out-Null
Set-Content (Join-Path $T 'docker.cmd') "@echo off`r`necho chamado> `"$(Join-Path $T 'docker-chamado.txt')`""
$env:Path = "$T;$env:Path"
# nada de mexer no início do Windows de verdade: pastas e chave de teste
$env:ERGON_LOCAL_DIR = "$T\local"; $env:ERGON_STARTUP_DIR = "$T\startup"; $env:ERGON_RUN_KEY = 'HKCU:\Software\ErgonTesteComandos\Run'
New-Item -ItemType Directory -Force -Path $env:ERGON_LOCAL_DIR, $env:ERGON_STARTUP_DIR | Out-Null
function Run([string]$lingua, [string[]]$a) {
  $env:ERGON_LANG = $lingua
  $o = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Ergon @a 2>&1 | Out-String
  $c = $LASTEXITCODE
  Remove-Item Env:\ERGON_LANG -ErrorAction SilentlyContinue
  return [pscustomobject]@{ out = $o; code = $c }
}
$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path $Ergon), [ref]$null, [ref]$e)
Check ($e.Count -eq 0) 'o lançador é PowerShell válido'
foreach ($a in @(@('install'), @('instalar'), @('update'), @('atualizar'), @('up'), @('subir'), @('docker', 'install'), @('uninstall', '--purge'), @('help'), @())) {
  $r = Run 'pt' $a
  Check ($r.code -eq 1 -and $r.out -match 'aplicativo Ergon Desktop' -and $r.out -match 'Nada desta instalação foi alterado') "pt: '$($a -join ' ')' só dá o aviso"
}
$r = Run 'en' @('update')
Check ($r.code -eq 1 -and $r.out -match 'Ergon Desktop app' -and $r.out -match 'Nothing in this installation was changed' -and $r.out -notmatch 'aplicativo') 'en: o aviso em inglês'
Check ($r.out -match 'https://github.com/[^/]+/[^/]+/releases/latest') 'aponta para a página de versões'
Check ($r.out -notmatch '(?i)hermes|motor|token') 'sem jargão nem nome do motor'
Check (-not (Test-Path (Join-Path $T 'docker-chamado.txt'))) 'não chama o Docker'

# os atalhos de início que as versões antigas deixaram: "docker" e "ajudante" desfazem o que foi montado
$doDocker = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
foreach ($par in @(@('docker'), @('ajudante'), @('helper'))) {
  if (Test-Path $env:ERGON_RUN_KEY) { Remove-Item -Recurse -Force $env:ERGON_RUN_KEY }
  Set-Content (Join-Path $env:ERGON_LOCAL_DIR 'docker-inicio-original.txt') "`"$doDocker`" -Autostart"
  Set-Content (Join-Path $env:ERGON_STARTUP_DIR 'Ergon - Docker.vbs') 'x'
  Set-Content (Join-Path $env:ERGON_STARTUP_DIR 'Ergon - ajudante.vbs') 'x'
  Set-Content (Join-Path $env:ERGON_STARTUP_DIR 'outro.lnk') 'x'
  $r = Run 'pt' $par
  $entrada = (Get-ItemProperty -Path $env:ERGON_RUN_KEY -Name 'Docker Desktop' -ErrorAction SilentlyContinue).'Docker Desktop'
  Check ($entrada -eq "`"$doDocker`" -Autostart") "$($par[0]): a entrada do Docker Desktop volta ao início do Windows"
  Check (-not (Test-Path (Join-Path $env:ERGON_LOCAL_DIR 'docker-inicio-original.txt'))) "$($par[0]): o arquivo guardado sai"
  Check (-not (Test-Path (Join-Path $env:ERGON_STARTUP_DIR 'Ergon - Docker.vbs')) -and -not (Test-Path (Join-Path $env:ERGON_STARTUP_DIR 'Ergon - ajudante.vbs'))) "$($par[0]): os dois atalhos saem"
  Check (Test-Path (Join-Path $env:ERGON_STARTUP_DIR 'outro.lnk')) "$($par[0]): o resto do início do Windows fica"
  Check ($r.code -eq 1 -and $r.out -match 'aplicativo Ergon Desktop' -and $r.out -match 'Só o início do Windows foi arrumado' -and $r.out -notmatch 'Nada desta instalação') "$($par[0]): o aviso diz o que foi arrumado"
}
# de novo, sem nada a desfazer: o aviso de sempre
$r = Run 'en' @('docker')
Check ($r.out -match 'Nothing in this installation was changed') 'docker sem nada a desfazer: o aviso de sempre'
if (Test-Path 'HKCU:\Software\ErgonTesteComandos') { Remove-Item -Recurse -Force 'HKCU:\Software\ErgonTesteComandos' }
Remove-Item -Recurse -Force $T
Write-Host ''
if ($falhas.Count) { Write-Host "FALHOU: $($falhas.Count) ($($falhas -join '; '))" -ForegroundColor Red; exit 1 }
Write-Host "OK: $ok conferências"
