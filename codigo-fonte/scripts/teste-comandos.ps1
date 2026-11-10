# Teste dos comandos do lançador do Windows (ergon.ps1): os nomes novos (em inglês) e os de antes (em português)
# levam à mesma função; "--tudo", "--purge" e "-h" chegam ao lançador (sem bloco param, o PowerShell não os lê como
# nomes de parâmetro); help e version; mensagens em inglês com o Windows em inglês e em português com ele em
# português (ERGON_LANG força); toda mensagem tem as duas versões; o install de um pacote copia para a pasta do
# programa e segue pela cópia instalada. Nada é instalado, ligado ou apagado: os comandos testados de fora param antes
# de tocar no Docker, e os de dentro rodam com as funções trocadas por registros.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\teste-comandos.ps1
param([string]$Ergon = (Join-Path (Split-Path $PSScriptRoot -Parent) 'ergon.ps1'))
$ErrorActionPreference = 'Stop'
$T = Join-Path ([IO.Path]::GetTempPath()) 'ergon-comandos-teste'
if (Test-Path $T) { Remove-Item -Recurse -Force $T }
New-Item -ItemType Directory -Force -Path "$T\pacote", "$T\fonte\server" | Out-Null
Copy-Item $Ergon "$T\pacote\ergon.ps1"; Set-Content "$T\pacote\VERSAO" '1.1.0-rc.26'
Copy-Item $Ergon "$T\fonte\ergon.ps1"; Set-Content "$T\fonte\Dockerfile" ''; Set-Content "$T\fonte\package.json" '{ "name": "x", "version": "1.1.0-rc.27" }'
$env:ERGON_LOCAL_DIR = "$T\local"; $env:ERGON_BACKUPS_DIR = "$T\backups"; $env:ERGON_PROGRAM_DIR = "$T\programa"
Remove-Item Env:\ERGON_CONFIRM, Env:\ERGON_CONFIRMAR -ErrorAction SilentlyContinue

$ok = 0; $falhas = @()
function Check([bool]$c, [string]$m) { if ($c) { $script:ok++; Write-Host "  ok   $m" } else { $script:falhas += $m; Write-Host "  FALHA $m" -ForegroundColor Red } }
# roda o lançador num processo à parte, no idioma pedido; devolve a saída e o código de saída
function Run([string]$lingua, [string[]]$a, [string]$arquivo = "$T\pacote\ergon.ps1") {
  $env:ERGON_LANG = $lingua
  $o = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $arquivo @a 2>&1 | Out-String
  $c = $LASTEXITCODE
  Remove-Item Env:\ERGON_LANG -ErrorAction SilentlyContinue
  return [pscustomobject]@{ out = $o; code = $c }
}

Write-Host 'A) help: em inglês só os nomes novos; em português os novos com o de antes'
$r = Run 'en' @('help')
Check ($r.out -match 'Messages follow the Windows language' -and $r.out -match 'uninstall --purge' -and $r.out -match 'restore --undo' -and $r.out -notmatch 'instalar|remover|atualizar|restaurar|ajudante|antes:') 'help em inglês'
$r = Run 'pt' @('help')
Check ($r.out -match [regex]::Escape('uninstall --purge  (antes: remover --tudo)') -and $r.out -match 'restore --undo <pre-restore-.{1,3}>  \(antes: desfazer-restauracao\)' -and $r.out -match [regex]::Escape('update  (antes: atualizar)')) 'help em português'
foreach ($a in @('-h', '--help', 'ajuda', '/?')) { $r = Run 'pt' @($a); Check ($r.code -eq 0 -and $r.out -match [regex]::Escape('install  (antes: instalar)')) "$a mostra a ajuda" }
$r = Run 'pt' @(); Check ($r.out -match [regex]::Escape('install  (antes: instalar)')) 'sem comando: a ajuda'

Write-Host 'B) version'
$r = Run 'pt' @('version'); Check ($r.out.Trim() -eq 'Ergon 1.1.0-rc.26') 'version lê o VERSAO'
$r = Run 'pt' @('--version'); Check ($r.out.Trim() -eq 'Ergon 1.1.0-rc.26') '--version também'
$r = Run 'pt' @('version') "$T\fonte\ergon.ps1"; Check ($r.out.Trim() -eq 'Ergon 1.1.0-rc.27') 'cópia do código: a do package.json'
Remove-Item "$T\fonte\package.json"
$r = Run 'en' @('version') "$T\fonte\ergon.ps1"; Check ($r.code -eq 1 -and $r.out -match 'Unknown version') 'sem VERSAO: diz que não sabe'

Write-Host 'C) erros nos dois idiomas; --tudo, --purge e --undo chegam ao lançador'
$r = Run 'en' @('xyz'); Check ($r.code -eq 1 -and $r.out -match 'Unknown command: xyz') 'comando desconhecido em inglês'
$r = Run 'pt' @('xyz'); Check ($r.code -eq 1 -and $r.out -match 'Comando desconhecido: xyz') 'comando desconhecido em português'
$r = Run 'en' @('restore'); Check ($r.code -eq 1 -and $r.out -match [regex]::Escape('Say which backup: .\ergon.cmd restore <backup folder>')) 'restore sem pasta: em inglês'
$r = Run 'pt' @('restaurar'); Check ($r.code -eq 1 -and $r.out -match [regex]::Escape('Diga qual backup: .\ergon.cmd restore <pasta do backup>')) 'restaurar sem pasta: em português'
$r = Run 'en' @('restore', '--undo', 'errado'); Check ($r.code -eq 1 -and $r.out -match [regex]::Escape('Say which one: .\ergon.cmd restore --undo pre-restore-<date>')) 'restore --undo sem um nome válido'
$r = Run 'pt' @('desfazer-restauracao', 'errado'); Check ($r.code -eq 1 -and $r.out -match 'Diga qual: ') 'desfazer-restauracao (o de antes) também'
$env:ERGON_CONFIRM = 'nao'
$r = Run 'en' @('uninstall', '--purge'); Check ($r.code -eq 1 -and $r.out -match 'This DELETES everything' -and $r.out -match 'Nothing was deleted\.') 'uninstall --purge pede a confirmação (em inglês)'
$r = Run 'pt' @('remover', '--tudo'); Check ($r.code -eq 1 -and $r.out -match 'Isto APAGA tudo' -and $r.out -match 'Nada foi apagado\.') 'remover --tudo (o de antes) também'
$r = Run 'pt' @('uninstall', '--all'); Check ($r.code -eq 1 -and $r.out -match 'Nada foi apagado\.') 'uninstall --all é o mesmo'
Remove-Item Env:\ERGON_CONFIRM

Write-Host 'D) os nomes novos e os de antes levam à mesma função'
. $Ergon *> $null   # carrega as funções (sem comando: só mostraria a ajuda)
$script:passos = @()
function Reg([string]$p) { $script:passos += $p }
function Install-Program { Reg 'Install-Program'; return $Raiz }
function Test-Docker { Reg 'Test-Docker' }; function Initialize-Secrets { Reg 'Initialize-Secrets' }; function Register-Install { Reg 'Register-Install' }
function Up { Reg 'Up' }; function Install-Helper { Reg 'Install-Helper' }; function Remove-Helper { Reg 'Remove-Helper' }; function Run-Helper { Reg 'Run-Helper' }
function Start-Process { Reg 'abrir' }; function Compose([string[]]$a) { Reg "Compose $($a -join ' ')" }; function Wait-Health { return [pscustomobject]@{ sealed = $false } }
function Get-Health { return [pscustomobject]@{ version = '9.9.9'; sealed = $false } }; function Test-DockerUp { return $true }
function Backup { Reg 'Backup'; return $true }; function Restore([string]$o) { Reg "Restore $o" }; function Undo-Restore([string]$o) { Reg "Undo-Restore $o" }
function Update { Reg 'Update' }; function Clear-Images { Reg 'Clear-Images' }; function Remove-Ergon([switch]$Tudo) { Reg "Remove-Ergon $([bool]$Tudo)" }
function Start-DockerSafe { Reg 'Start-DockerSafe' }; function Install-DockerStart { Reg 'Install-DockerStart' }; function Remove-DockerStart { Reg 'Remove-DockerStart' }
function Say([string]$m) { }
# o mesmo "switch" do lançador, lido do próprio arquivo: roda com estas funções no lugar das de verdade
$fonte = Get-Content $Ergon -Raw
$despacho = [scriptblock]::Create($fonte.Substring($fonte.IndexOf('$Cmd = Get-Canonical $Comando')))
function Passos([string[]]$a) {
  $script:passos = @()
  $Comando = if ($a.Count -ge 1) { $a[0] } else { 'help' }; $Opcao = if ($a.Count -ge 2) { $a[1] } else { '' }; $Opcao2 = if ($a.Count -ge 3) { $a[2] } else { '' }
  . $despacho *> $null
  return ($script:passos -join ';')
}
function Mesmo([string]$esperado, [string[]]$novo, [string[]]$antigo) {
  $a = Passos $novo; $b = Passos $antigo
  Check ($a -eq $esperado -and $b -eq $esperado) "$($novo -join ' ') = $($antigo -join ' ')$(if ($a -ne $esperado -or $b -ne $esperado) { " (novo: $a | antes: $b | esperado: $esperado)" })"
}
$env:ERGON_NO_BROWSER = ''; $env:ERGON_SEM_NAVEGADOR = ''
Mesmo 'Install-Program;Test-Docker;Initialize-Secrets;Register-Install;Up;Install-Helper;abrir' @('install') @('instalar')
Mesmo 'Remove-Ergon False' @('uninstall') @('remover')
Mesmo 'Remove-Ergon False' @('remove') @('remover')
Mesmo 'Remove-Ergon True' @('uninstall', '--purge') @('remover', '--tudo')
Mesmo 'Remove-Ergon True' @('uninstall', '--all') @('remover', '--purge')
Mesmo 'Test-Docker;Register-Install;Compose up -d;Install-Helper' @('start') @('iniciar')
Mesmo 'Test-Docker;Register-Install;Compose up -d' @('up') @('subir')
Mesmo 'Compose stop' @('stop') @('parar')
Mesmo 'abrir' @('open') @('abrir')
Mesmo 'Restore C:\b\ergon-x' @('restore', 'C:\b\ergon-x') @('restaurar', 'C:\b\ergon-x')
Mesmo 'Undo-Restore pre-restore-1' @('restore', '--undo', 'pre-restore-1') @('desfazer-restauracao', 'pre-restore-1')
Mesmo 'Undo-Restore pre-restore-1' @('undo-restore', 'pre-restore-1') @('desfazer-restauracao', 'pre-restore-1')
Mesmo 'Test-Docker;Update' @('update') @('atualizar')
Mesmo 'Test-Docker;Update' @('upgrade') @('atualizar')
Mesmo 'Test-Docker;Clear-Images' @('clean') @('limpar')
Mesmo 'Run-Helper' @('helper') @('ajudante')
Mesmo 'Install-Helper' @('helper', 'install') @('ajudante', 'instalar')
Mesmo 'Remove-Helper' @('helper', 'uninstall') @('ajudante', 'remover')
Mesmo 'Install-DockerStart' @('docker', 'install') @('docker', 'instalar')
Mesmo 'Remove-DockerStart' @('docker', 'uninstall') @('docker', 'remover')
Mesmo 'Backup' @('backup') @('backup')
Mesmo 'Compose ps' @('status') @('status')
$env:ERGON_NO_BROWSER = '1'; $a = Passos @('install'); $env:ERGON_NO_BROWSER = ''
$env:ERGON_SEM_NAVEGADOR = '1'; $b = Passos @('instalar'); $env:ERGON_SEM_NAVEGADOR = ''
Check ($a -notmatch 'abrir' -and $b -notmatch 'abrir' -and $a -match 'Install-Helper') 'sem navegador: ERGON_NO_BROWSER e o ERGON_SEM_NAVEGADOR de antes'

Write-Host 'E) confirmações: s/sim/y/yes; ERGON_CONFIRM e o ERGON_CONFIRMAR de antes'
Check ((Test-Yes 's') -and (Test-Yes 'sim') -and (Test-Yes 'y') -and (Test-Yes 'YES') -and (Test-Yes ' Sim ')) 'aceita s, sim, y, yes'
Check (-not (Test-Yes 'n') -and -not (Test-Yes '') -and -not (Test-Yes 'no') -and -not (Test-Yes 'talvez')) 'recusa n, no, vazio e outra coisa'
$env:ERGON_CONFIRM = 'yes'; $c1 = Confirm-Step 'x?'; Remove-Item Env:\ERGON_CONFIRM
$env:ERGON_CONFIRMAR = 'sim'; $c2 = Confirm-Step 'x?'; Remove-Item Env:\ERGON_CONFIRMAR
Check ($c1 -and $c2) 'ERGON_CONFIRM=yes e ERGON_CONFIRMAR=sim respondem sem perguntar'
function Read-Host([string]$p) { $script:pergunta = $p; return 'y' }
# (nomes curtos e distintos: o PowerShell não distingue maiúsculas, e um $en aqui mexeria em variáveis do lançador)
$script:EmIngles = $false; $c3 = Confirm-Step 'Seguir?'; $perguntaPt = $script:pergunta
$script:EmIngles = $true; $c4 = Confirm-Step 'Go?'; $perguntaEn = $script:pergunta; $script:EmIngles = $false
Check ($c3 -and $c4 -and $perguntaPt -eq 'Seguir? (s/N)' -and $perguntaEn -eq 'Go? (y/N)') 'pergunta (s/N) em português e (y/N) em inglês; y vale nos dois'

Write-Host 'F) idioma: o da interface do Windows; ERGON_LANG força'
$antes = [Threading.Thread]::CurrentThread.CurrentUICulture
function Com([string]$cultura) { & { [Threading.Thread]::CurrentThread.CurrentUICulture = [Globalization.CultureInfo]$cultura; Get-Lingua } }
Remove-Item Env:\ERGON_LANG -ErrorAction SilentlyContinue
Check ((Com 'pt-BR') -eq 'pt' -and (Com 'pt-PT') -eq 'pt') 'Windows em português: português'
Check ((Com 'en-US') -eq 'en' -and (Com 'es-ES') -eq 'en' -and (Com 'fr-FR') -eq 'en') 'em inglês ou outro idioma: inglês'
$env:ERGON_LANG = 'pt'; $x = Com 'en-US'; $env:ERGON_LANG = 'en'; $y = Com 'pt-BR'; Remove-Item Env:\ERGON_LANG
Check ($x -eq 'pt' -and $y -eq 'en') 'ERGON_LANG vence o Windows'
[Threading.Thread]::CurrentThread.CurrentUICulture = $antes

Write-Host 'G) toda mensagem tem as duas versões'
# nenhuma chamada de Say/Fail/Write-HelperLog/Write-DockerLog com um texto só (as aspas escapadas saem antes)
$uma = '\b(Say|Fail|Write-HelperLog|Write-DockerLog) (''[^'']*''|"[^"]*")\s*($|;|\}|\))'
$linhas = @((Get-Content $Ergon) | ForEach-Object { $_ -replace '`"', '' } | Select-String -Pattern $uma -CaseSensitive)
Check ($linhas.Count -eq 0) "nenhuma mensagem só em um idioma$(if ($linhas.Count) { ': ' + (($linhas | ForEach-Object { $_.Line.Trim() }) -join ' | ') })"
$amostra = @("  if (x) { Say 'só um' }", '  Fail "um `"dois`" três"', "  Say 'pt' 'en'") | ForEach-Object { $_ -replace '`"', '' }
Check (@($amostra | Select-String -Pattern $uma -CaseSensitive).Count -eq 2) 'a conferência acha uma mensagem só em um idioma'

Write-Host 'H) install de um pacote de verdade: copia para a pasta do programa e segue pela cópia instalada'
# o pacote com o lançador deste teste; antes do despacho, um arquivo troca os passos que ligariam algo de verdade
# (e o PATH do usuário) por registros. A cópia para a pasta do programa e a chamada da cópia instalada são as do
# lançador.
New-Item -ItemType Directory -Force -Path "$T\pacote-real" | Out-Null
$marca = '$Cmd = Get-Canonical $Comando'
$texto = (Get-Content $Ergon -Raw -Encoding UTF8).Replace($marca, "if (`$env:ERGON_STUB) { . `$env:ERGON_STUB }`r`n$marca")
[IO.File]::WriteAllText("$T\pacote-real\ergon.ps1", $texto, (New-Object Text.UTF8Encoding $true))
foreach ($a in @('ergon.cmd', 'docker-compose.yml', 'LEIA-ME.md')) { Set-Content "$T\pacote-real\$a" '' }
Set-Content "$T\pacote-real\VERSAO" '1.1.0-rc.26'
Set-Content "$T\stub.ps1" -Encoding UTF8 -Value @'
function Passo([string]$p) { Add-Content -LiteralPath $env:ERGON_PASSOS -Value "$(Split-Path $Raiz -Leaf) $p" }
Passo "lancador $Comando"
function Add-UserPath([string]$d) { Passo "Add-UserPath $(Split-Path $d -Leaf)" }
function Test-Docker { Passo 'Test-Docker' }; function Initialize-Secrets { Passo 'Initialize-Secrets' }; function Register-Install { Passo 'Register-Install' }
function Up { Passo 'Up' }; function Install-Helper { Passo 'Install-Helper' }
'@
foreach ($nome in @('install', 'instalar')) {
  if (Test-Path "$T\programa") { Remove-Item -Recurse -Force "$T\programa" }
  Set-Content "$T\passos.txt" ''
  $env:ERGON_STUB = "$T\stub.ps1"; $env:ERGON_PASSOS = "$T\passos.txt"; $env:ERGON_NO_BROWSER = '1'
  $r = Run 'pt' @($nome) "$T\pacote-real\ergon.ps1"
  Remove-Item Env:\ERGON_STUB, Env:\ERGON_PASSOS; $env:ERGON_NO_BROWSER = ''
  $p = (@(Get-Content "$T\passos.txt" | Where-Object { $_ }) -join ';')
  $faltam = @('ergon.ps1', 'ergon.cmd', 'docker-compose.yml', 'LEIA-ME.md', 'VERSAO') | Where-Object { -not (Test-Path "$T\programa\$_") }
  Check ($r.code -eq 0 -and -not $faltam) "${nome}: o pacote vai para a pasta do programa$(if ($r.code -ne 0 -or $faltam) { " (saída $($r.code), faltam: $faltam) $($r.out)" })"
  $esperado = "pacote-real lancador $nome;pacote-real Add-UserPath programa;programa lancador install;programa Add-UserPath programa;programa Test-Docker;programa Initialize-Secrets;programa Register-Install;programa Up;programa Install-Helper"
  Check ($p -eq $esperado) "${nome}: a cópia instalada recebe install e chega aos segredos e ao registro$(if ($p -ne $esperado) { " ($p)" })"
  Check ($r.out -match 'Pode apagar a pasta do zip') "${nome}: diz que a pasta do zip pode ser apagada"
}

Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue   # o teste não deixa nada no disco
Write-Host ''
Write-Host "$ok ok, $($falhas.Count) falha(s)"
if ($falhas.Count) { exit 1 }
