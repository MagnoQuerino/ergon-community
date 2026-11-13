<#
  Ergon — o lançador antigo do Windows (instalações pelo Docker Desktop, da 1.0.0 até a rc.11).

  Desde a rc.12, o Ergon no Windows é o aplicativo Ergon Desktop, com o ambiente próprio dele (sem Docker Desktop), e
  desde a rc.29 este caminho não é mais atendido: os comandos daqui (install, start, update, backup, docker…) saíram.
  Qualquer comando mostra só o aviso abaixo, em português ou em inglês (ERGON_LANG=pt|en força), e não mexe em nada.

  A exceção: os atalhos de início do Windows que as versões antigas deixaram ("Ergon - Docker.vbs" roda "docker" e
  "Ergon - ajudante.vbs" roda "ajudante"). Se este arquivo chegou por cima do antigo (o "update" de antes copia o
  pacote inteiro), esses atalhos rodariam a cada entrada no Windows só para dar o aviso, e o Docker Desktop não abriria
  mais sozinho (a entrada dele foi tirada do início e guardada). Então, para esses comandos, o lançador desfaz o que o
  antigo montou: devolve a entrada do Docker Desktop ao início do Windows e apaga os dois atalhos. Os caminhos podem ser
  trocados nos testes (ERGON_LOCAL_DIR, ERGON_STARTUP_DIR, ERGON_RUN_KEY).
#>
$lingua = "$env:ERGON_LANG".Trim()
if (-not $lingua) { $lingua = "$([Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName)" }
$pt = $lingua -match '^pt'
$paginaDeVersoes = 'https://github.com/MagnoQuerino/ergon-community/releases/latest'
$comando = "$($args | Select-Object -First 1)".Trim().ToLowerInvariant()

$desfeito = @()
if ($comando -in @('docker', 'ajudante', 'helper')) {
  $local = if ($env:ERGON_LOCAL_DIR) { $env:ERGON_LOCAL_DIR } else { Join-Path $env:LOCALAPPDATA 'Ergon' }
  $inicio = if ($env:ERGON_STARTUP_DIR) { $env:ERGON_STARTUP_DIR } else { [Environment]::GetFolderPath('Startup') }
  $runKey = if ($env:ERGON_RUN_KEY) { $env:ERGON_RUN_KEY } else { 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' }
  $guardada = Join-Path $local 'docker-inicio-original.txt'
  try {
    if (Test-Path $guardada) {
      $valor = "$(Get-Content $guardada -Raw)".Trim()
      if ($valor) {
        if (-not (Test-Path $runKey)) { New-Item -Path $runKey -Force | Out-Null }
        Set-ItemProperty -Path $runKey -Name 'Docker Desktop' -Value $valor -ErrorAction Stop
        $desfeito += $(if ($pt) { 'a entrada do Docker Desktop voltou ao início do Windows' } else { 'the Docker Desktop entry is back in Windows startup' })
      }
      Remove-Item -Force $guardada -ErrorAction Stop
    }
  } catch {
    # sem conseguir devolver a entrada, o arquivo guardado fica (nada se perde) e o aviso diz o que fazer
    $desfeito += $(if ($pt) { 'não foi possível devolver a entrada do Docker Desktop ao início do Windows: abra o Docker Desktop e ligue "Start Docker Desktop when you sign in"' } else { 'the Docker Desktop entry could not be put back in Windows startup: open Docker Desktop and turn on "Start Docker Desktop when you sign in"' })
  }
  $atalhos = @('Ergon - Docker.vbs', 'Ergon - ajudante.vbs') | ForEach-Object { Join-Path $inicio $_ } | Where-Object { Test-Path $_ }
  if ($atalhos) {
    Remove-Item -Force -ErrorAction SilentlyContinue $atalhos
    $desfeito += $(if ($pt) { 'os atalhos antigos do Ergon saíram do início do Windows' } else { 'the old Ergon shortcuts were removed from Windows startup' })
  }
}

if ($pt) {
  Write-Host "[ergon] O Ergon no Windows agora é o aplicativo Ergon Desktop: a instalação pelo Docker Desktop não recebe mais comandos nem atualizações por aqui."
  if ($desfeito) {
    Write-Host "[ergon] Baixe e abra o Ergon Desktop para Windows em $paginaDeVersoes. Só o início do Windows foi arrumado ($($desfeito -join '; ')); seus dados ficaram como estavam."
  } else {
    Write-Host "[ergon] Baixe e abra o Ergon Desktop para Windows em $paginaDeVersoes. Nada desta instalação foi alterado ou apagado."
  }
} else {
  Write-Host "[ergon] Ergon on Windows is now the Ergon Desktop app: the Docker Desktop installation no longer takes commands or updates here."
  if ($desfeito) {
    Write-Host "[ergon] Download and open Ergon Desktop for Windows from $paginaDeVersoes. Only Windows startup was tidied up ($($desfeito -join '; ')); your data stayed as it was."
  } else {
    Write-Host "[ergon] Download and open Ergon Desktop for Windows from $paginaDeVersoes. Nothing in this installation was changed or deleted."
  }
}
exit 1
