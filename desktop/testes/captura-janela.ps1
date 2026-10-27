<#
  Captura a janela de um processo (com a moldura do sistema), sem precisar que ela esteja na frente.
  Uso: powershell -File captura-janela.ps1 -Pid 1234 -Saida janela.png
#>
param([Parameter(Mandatory)][int]$ProcessId, [Parameter(Mandatory)][string]$Saida)
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class Janela {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr h, IntPtr dc, uint f);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
}
'@
[void][Janela]::SetProcessDPIAware()
$alvo = [IntPtr]::Zero
[Janela]::EnumWindows({ param($h, $l)
  $p = 0; [void][Janela]::GetWindowThreadProcessId($h, [ref]$p)
  $t = New-Object Text.StringBuilder 256; [void][Janela]::GetWindowText($h, $t, 256)
  if ($p -eq $ProcessId -and [Janela]::IsWindowVisible($h) -and $t.ToString() -eq 'Ergon') { $script:alvo = $h; return $false }
  return $true }, [IntPtr]::Zero) | Out-Null
if ($alvo -eq [IntPtr]::Zero) { Write-Error 'janela "Ergon" não encontrada'; exit 1 }
$r = New-Object Janela+RECT; [void][Janela]::GetWindowRect($alvo, [ref]$r)
$bmp = New-Object Drawing.Bitmap ($r.R - $r.L), ($r.B - $r.T)
$g = [Drawing.Graphics]::FromImage($bmp); $dc = $g.GetHdc()
[void][Janela]::PrintWindow($alvo, $dc, 2)   # PW_RENDERFULLCONTENT: inclui o conteúdo do WebView2
$g.ReleaseHdc($dc); $bmp.Save($Saida, [Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
"$($r.R - $r.L)x$($r.B - $r.T) -> $Saida"
