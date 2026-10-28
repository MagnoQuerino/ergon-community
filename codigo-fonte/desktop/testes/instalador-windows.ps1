# Instalador NSIS do Ergon Desktop como uma pessoa usaria: abre o instalador, fotografa cada página e avança pelo botão
# principal (por mensagem à janela do instalador: sem teclado nem mouse, não mexe no que estiver aberto), confere o que
# ficou no computador (programa, atalho no Iniciar, registro de desinstalação, assinatura) e fotografa o aplicativo que
# a última página abre. -Desinstalar faz o caminho de volta pelo desinstalador; -Silencioso usa /S (implantação por TI);
# -PorCima instala sobre uma instalação que já existe (versão nova ou a mesma de novo).
#   powershell -File instalador-windows.ps1 -Instalador Ergon_0.2.0_x64-setup.exe -Saida pasta
#   powershell -File instalador-windows.ps1 -Desinstalar -Saida pasta
param([string]$Instalador, [Parameter(Mandatory = $true)][string]$Saida, [switch]$Desinstalar, [switch]$Silencioso, [switch]$PorCima)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Saida | Out-Null
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System; using System.Text; using System.Drawing; using System.Collections.Generic; using System.Runtime.InteropServices;
public static class Jan {
  delegate bool Cada(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(Cada f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr h, Cada f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr h, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  // sempre com prazo (SMTO_ABORTIFHUNG): uma janela ocupada não trava o teste; o clique vai por PostMessage
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr h, int m, IntPtr w, StringBuilder l, int f, int t, out IntPtr r);
  [DllImport("user32.dll")] static extern IntPtr SendMessageTimeout(IntPtr h, int m, IntPtr w, IntPtr l, int f, int t, out IntPtr r);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, int m, IntPtr w, IntPtr l);
  static long Enviar(IntPtr h, int m) { IntPtr r; SendMessageTimeout(h, m, IntPtr.Zero, IntPtr.Zero, 2, 2000, out r); return (long)r; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out Ret r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  public struct Ret { public int E, C, D, B; }
  static string Classe(IntPtr h) { var s = new StringBuilder(256); GetClassName(h, s, 256); return s.ToString(); }
  // WM_GETTEXT: lê o texto de controles de outro processo (GetWindowText não lê)
  public static string Texto(IntPtr h) { var s = new StringBuilder(1024); IntPtr r; SendMessageTimeout(h, 0x000D, (IntPtr)1024, s, 2, 2000, out r); return s.ToString(); }
  public static IntPtr Achar(string titulo) {
    IntPtr achada = IntPtr.Zero;
    EnumWindows((h, l) => { if (IsWindowVisible(h) && Classe(h) == "#32770" && Texto(h).Contains(titulo)) { achada = h; return false; } return true; }, IntPtr.Zero);
    return achada;
  }
  public static IntPtr DoProcesso(int pid) {
    IntPtr achada = IntPtr.Zero;
    EnumWindows((h, l) => { uint p; GetWindowThreadProcessId(h, out p); if (p == pid && IsWindowVisible(h) && Texto(h).Length > 0) { achada = h; return false; } return true; }, IntPtr.Zero);
    return achada;
  }
  // textos visíveis da página: rótulos, botões e caixas de marcar com o estado ([x] / [ ])
  public static string[] Textos(IntPtr h) {
    var l = new List<string>();
    EnumChildWindows(h, (c, x) => {
      if (!IsWindowVisible(c)) return true;
      var t = Texto(c).Replace("\r\n", " ").Replace("&", "").Trim(); if (t.Length == 0) return true;
      if (Classe(c) == "Button") { long est = Enviar(c, 0x00F0); long estilo = (long)GetWindowLongPtr(c, -16) & 0xF;
        if (estilo == 2 || estilo == 3) t = (est == 1 ? "[x] " : "[ ] ") + t; else t = "<" + t + (IsWindowEnabled(c) ? "" : " (desativado)") + ">"; }
      l.Add(t); return true; }, IntPtr.Zero);
    return l.ToArray();
  }
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr h, int i);
  public static void Foto(IntPtr h, string arquivo) {
    Ret r; GetWindowRect(h, out r);
    using (var b = new Bitmap(Math.Max(1, r.D - r.E), Math.Max(1, r.B - r.C))) using (var g = Graphics.FromImage(b)) {
      var dc = g.GetHdc(); PrintWindow(h, dc, 2); g.ReleaseHdc(dc); b.Save(arquivo, System.Drawing.Imaging.ImageFormat.Png); }
  }
  // o botão principal (id 1: Próximo, Instalar, Concluir, Desinstalar) por WM_COMMAND/BN_CLICKED na janela do assistente
  public static bool Avancar(IntPtr dlg) { var b = GetDlgItem(dlg, 1); if (b == IntPtr.Zero || !IsWindowEnabled(b) || !IsWindowVisible(b)) return false; PostMessage(dlg, 0x0111, (IntPtr)1, b); return true; }
}
'@

$R = 0
function Ok($nome, $detalhe) { "ok   $nome — $detalhe" }
function Falha($nome, $detalhe) { "FALHA $nome — $detalhe"; $script:R = 1 }
$chaves = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
function Registro { Get-ItemProperty $chaves -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Ergon*' } | Select-Object -First 1 }
$atalho = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Ergon.lnk'
$atalhoMesa = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Ergon.lnk'

# percorre o assistente: fotografa cada página nova e avança; termina quando a janela some de vez
function Assistente($titulo, $prefixo) {
  $ultima = ''; $n = 0; $sem = 0; $paginas = @()
  for ($i = 0; $i -lt 240 -and $sem -lt 12; $i++) {
    Start-Sleep -Milliseconds 500
    $j = [Jan]::Achar($titulo)
    if ($j -eq [IntPtr]::Zero) { $sem++; continue }
    $sem = 0
    $textos = [Jan]::Textos($j); $assinatura = ($textos -join ' | ')
    if ($assinatura -ne $ultima) {
      Start-Sleep -Milliseconds 1200; $textos = [Jan]::Textos($j); $assinatura = ($textos -join ' | ')
      $n++; $arq = Join-Path $Saida ('{0}{1:d2}.png' -f $prefixo, $n); [Jan]::Foto($j, $arq)
      "  página $n ($([Jan]::Texto($j))): $assinatura"
      $paginas += $assinatura; $ultima = $assinatura
    }
    if ([Jan]::Avancar($j)) { Start-Sleep -Milliseconds 1500 }
  }
  $script:paginas = $paginas
}

if (-not $Desinstalar) {
  $antes = Registro
  if ($PorCima) {
    if (-not $antes) { Falha 'instalação anterior' 'não há: -PorCima precisa do aplicativo instalado'; exit 1 }
    $exeAntes = Join-Path $antes.InstallLocation.Trim('"') 'ergon-desktop.exe'
    Ok 'instalação anterior' "$($antes.DisplayName) $($antes.DisplayVersion), programa gravado às $((Get-Item $exeAntes).LastWriteTime.ToString('HH:mm:ss'))"
  } elseif ($antes) { Falha 'computador sem o aplicativo antes' "já instalado: $($antes.DisplayName) $($antes.DisplayVersion)"; exit 1 }
  else { Ok 'computador sem o aplicativo antes' 'nenhum registro de instalação do Ergon Desktop' }
  $sig = Get-AuthenticodeSignature $Instalador
  "     assinatura do instalador: $($sig.Status)$(if ($sig.SignerCertificate) { ' — ' + $sig.SignerCertificate.Subject })"
  $t0 = Get-Date
  if ($Silencioso) {
    $p = Start-Process $Instalador -ArgumentList '/S' -PassThru -Wait
    "  instalação silenciosa: saída $($p.ExitCode) em $([int]((Get-Date) - $t0).TotalSeconds) s"
  } else {
    $p = Start-Process $Instalador -PassThru
    Assistente 'Ergon' 'instalador-'
    "  assistente: $($paginas.Count) páginas em $([int]((Get-Date) - $t0).TotalSeconds) s"
  }
  $reg = Registro
  if ($reg) { Ok 'registro de desinstalação' "$($reg.DisplayName) $($reg.DisplayVersion), $($reg.Publisher), em $($reg.InstallLocation)" } else { Falha 'registro de desinstalação' 'não encontrado' }
  $pasta = if ($reg.InstallLocation) { $reg.InstallLocation.Trim('"') } else { Join-Path $env:LOCALAPPDATA 'Ergon' }
  $exe = Join-Path $pasta 'ergon-desktop.exe'
  if (Test-Path $exe) {
    $v = (Get-Item $exe).VersionInfo
    Ok 'programa instalado para este usuário (sem administrador)' "$exe — $($v.ProductName) $($v.ProductVersion), $([math]::Round((Get-Item $exe).Length / 1MB, 1)) MB, gravado às $((Get-Item $exe).LastWriteTime.ToString('HH:mm:ss'))"
    "     arquivos: $((Get-ChildItem $pasta -Recurse -File | ForEach-Object { $_.FullName.Substring($pasta.Length + 1) }) -join ', ')"
    "     assinatura do programa: $((Get-AuthenticodeSignature $exe).Status)"
  } else { Falha 'programa instalado' "não há $exe" }
  if (Test-Path $atalho) { $l = (New-Object -ComObject WScript.Shell).CreateShortcut($atalho); Ok 'atalho no menu Iniciar' "$atalho → $($l.TargetPath)" } else { Falha 'atalho no menu Iniciar' "não há $atalho" }
  "     atalho na área de trabalho: $(if (Test-Path $atalhoMesa) { 'sim' } else { 'não' })"
  # a última página do assistente abre o aplicativo: fotografa a janela dele
  if (-not $Silencioso) {
    $app = $null; for ($i = 0; $i -lt 30 -and -not $app; $i++) { Start-Sleep -Milliseconds 500; $app = Get-Process -Name ergon-desktop -ErrorAction SilentlyContinue | Select-Object -First 1 }
    if ($app) {
      Start-Sleep -Seconds 8
      $j = [Jan]::DoProcesso($app.Id)
      if ($j -ne [IntPtr]::Zero) { [Jan]::Foto($j, (Join-Path $Saida 'aplicativo-aberto.png')) }
      Ok 'o assistente abre o aplicativo no fim' "janela '$([Jan]::Texto($j))' (pid $($app.Id))"
      $app.CloseMainWindow() | Out-Null; Start-Sleep -Seconds 3
      if (Get-Process -Id $app.Id -ErrorAction SilentlyContinue) { Falha 'fechar a janela encerra o aplicativo' 'continuou aberto' } else { Ok 'fechar a janela encerra o aplicativo' 'encerrado' }
    } else { "     o assistente não abriu o aplicativo no fim (caixa desmarcada?)" }
  }
} else {
  $reg = Registro
  if (-not $reg) { Falha 'desinstalar' 'o aplicativo não está instalado'; exit 1 }
  $pasta = $reg.InstallLocation.Trim('"'); $desinst = ($reg.UninstallString -replace '^"([^"]+)".*$', '$1')
  $t0 = Get-Date
  if ($Silencioso) { $p = Start-Process $desinst -ArgumentList '/S' -PassThru -Wait; Start-Sleep -Seconds 3; "  desinstalação silenciosa: saída $($p.ExitCode)" }
  else { Start-Process $desinst | Out-Null; Assistente 'Ergon' 'desinstalador-'; "  assistente: $($paginas.Count) páginas em $([int]((Get-Date) - $t0).TotalSeconds) s" }
  if (Registro) { Falha 'registro de desinstalação removido' 'continua lá' } else { Ok 'registro de desinstalação removido' 'sem registro do Ergon Desktop' }
  if (Test-Path (Join-Path $pasta 'ergon-desktop.exe')) { Falha 'programa removido' "continua em $pasta" } else { Ok 'programa removido' "$pasta $(if (Test-Path $pasta) { 'existe (vazia: ' + ((Get-ChildItem $pasta -Recurse | Measure-Object).Count -eq 0) + ')' } else { 'removida' })" }
  if ((Test-Path $atalho) -or (Test-Path $atalhoMesa)) { Falha 'atalhos removidos' 'algum atalho ficou' } else { Ok 'atalhos removidos' 'menu Iniciar e área de trabalho' }
  "     dados do aplicativo (perfil da janela, registros): $(if (Test-Path (Join-Path $env:LOCALAPPDATA 'io.github.magnoquerino.ergon')) { 'mantidos em ' + (Join-Path $env:LOCALAPPDATA 'io.github.magnoquerino.ergon') } else { 'não há' })"
}
exit $R
