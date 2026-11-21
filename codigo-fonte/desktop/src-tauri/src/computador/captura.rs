//! A parte de cada sistema: a captura da tela, a lista de programas e janelas, abrir um programa e as permissões.
//! Linux (X11): tudo pelo protocolo X (x11rb), sem programa de fora. macOS: screencapture/sips/open/osascript, que vêm
//! com o sistema, e as duas perguntas de permissão do próprio sistema. Windows: PowerShell, que vem com o sistema.

use super::driver::Programa;
use super::protocolo::Permissoes;

/// Reduz uma imagem RGB (média de cada bloco) a `alvo`.
pub fn reduzir(rgb: &[u8], tam: (u32, u32), alvo: (u32, u32)) -> Vec<u8> {
    let (w, h) = (tam.0 as usize, tam.1 as usize);
    let (aw, ah) = (alvo.0.max(1) as usize, alvo.1.max(1) as usize);
    if (aw, ah) == (w, h) {
        return rgb.to_vec();
    }
    let mut out = vec![0u8; aw * ah * 3];
    for ay in 0..ah {
        let (y0, y1) = (ay * h / ah, ((ay + 1) * h / ah).max(ay * h / ah + 1).min(h));
        for ax in 0..aw {
            let (x0, x1) = (ax * w / aw, ((ax + 1) * w / aw).max(ax * w / aw + 1).min(w));
            let mut s = [0u32; 3];
            let mut n = 0u32;
            for y in y0..y1 {
                for x in x0..x1 {
                    let i = (y * w + x) * 3;
                    s[0] += rgb[i] as u32;
                    s[1] += rgb[i + 1] as u32;
                    s[2] += rgb[i + 2] as u32;
                    n += 1;
                }
            }
            let o = (ay * aw + ax) * 3;
            for c in 0..3 {
                out[o + c] = (s[c] / n.max(1)) as u8;
            }
        }
    }
    out
}

pub fn png_rgb(rgb: &[u8], tam: (u32, u32)) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, tam.0, tam.1);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Fast);
        let mut w = enc.write_header().map_err(|e| e.to_string())?;
        w.write_image_data(rgb).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(not(target_os = "linux"))]
fn temporario(ext: &str) -> std::path::PathBuf {
    let n: u64 = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0);
    std::env::temp_dir().join(format!("ergon-tela-{}-{n}.{ext}", std::process::id()))
}

/// A captura só passa pela memória: o arquivo temporário (macOS e Windows) é apagado na hora.
#[cfg(not(target_os = "linux"))]
fn ler_e_apagar(p: &std::path::Path) -> Result<Vec<u8>, String> {
    let r = std::fs::read(p).map_err(|e| format!("a captura não saiu ({e})"));
    let _ = std::fs::remove_file(p);
    r
}

// ---------------------------------------------------------------------------------------------- Linux (X11)
#[cfg(target_os = "linux")]
mod sistema {
    use super::*;
    use x11rb::connection::Connection;
    use x11rb::protocol::xproto::{self, AtomEnum, ConnectionExt, ImageFormat};
    use x11rb::rust_connection::RustConnection;

    fn conectar() -> Result<(RustConnection, usize), String> {
        x11rb::connect(None).map_err(|e| format!("sem a tela do X11 ({e})"))
    }

    pub fn tela(alvo: (u32, u32)) -> Result<Vec<u8>, String> {
        let (c, n) = conectar()?;
        let s = &c.setup().roots[n];
        let (w, h) = (s.width_in_pixels, s.height_in_pixels);
        let img = c.get_image(ImageFormat::Z_PIXMAP, s.root, 0, 0, w, h, !0).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
        let bpp = c.setup().pixmap_formats.iter().find(|f| f.depth == img.depth).map(|f| f.bits_per_pixel).unwrap_or(32);
        if bpp != 32 && bpp != 24 {
            return Err(format!("formato de tela sem suporte ({bpp} bits)"));
        }
        let passo = (bpp / 8) as usize;
        let linha = img.data.len() / h.max(1) as usize;
        let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
        for y in 0..h as usize {
            for x in 0..w as usize {
                let i = y * linha + x * passo;
                // ZPixmap de 24/32 bits no X: azul, verde, vermelho (ordem da máquina, little-endian)
                rgb.extend_from_slice(&[img.data[i + 2], img.data[i + 1], img.data[i]]);
            }
        }
        png_rgb(&reduzir(&rgb, (w as u32, h as u32), alvo), alvo)
    }

    fn atomo(c: &RustConnection, nome: &str) -> Option<u32> {
        c.intern_atom(false, nome.as_bytes()).ok()?.reply().ok().map(|r| r.atom)
    }

    fn texto(c: &RustConnection, j: u32, prop: u32, tipo: u32) -> Option<String> {
        let r = c.get_property(false, j, prop, tipo, 0, 1024).ok()?.reply().ok()?;
        (!r.value.is_empty()).then(|| String::from_utf8_lossy(&r.value).split('\0').filter(|s| !s.is_empty()).collect::<Vec<_>>().join(" "))
    }

    struct Janela {
        id: u32,
        nome: String,
        classe: String,
        pid: Option<u32>,
    }

    fn listar() -> Result<(RustConnection, usize, Vec<Janela>), String> {
        let (c, n) = conectar()?;
        let raiz = c.setup().roots[n].root;
        let (lista, nome_net, utf8, pid_a) = (atomo(&c, "_NET_CLIENT_LIST"), atomo(&c, "_NET_WM_NAME"), atomo(&c, "UTF8_STRING"), atomo(&c, "_NET_WM_PID"));
        // com gerenciador de janelas: a lista dele; sem (Xvfb puro): as janelas de cima que estão à vista
        let mut ids: Vec<u32> = lista
            .and_then(|l| c.get_property(false, raiz, l, AtomEnum::WINDOW, 0, 4096).ok()?.reply().ok())
            .map(|r| r.value32().map(|v| v.collect()).unwrap_or_default())
            .unwrap_or_default();
        if ids.is_empty() {
            let arvore = c.query_tree(raiz).map_err(|e| e.to_string())?.reply().map_err(|e| e.to_string())?;
            for j in arvore.children {
                let vis = c.get_window_attributes(j).ok().and_then(|x| x.reply().ok()).map(|a| a.map_state == xproto::MapState::VIEWABLE).unwrap_or(false);
                if vis {
                    ids.push(j);
                }
            }
        }
        let mut out = Vec::new();
        for j in ids {
            let nome = nome_net.zip(utf8).and_then(|(p, t)| texto(&c, j, p, t)).or_else(|| texto(&c, j, AtomEnum::WM_NAME.into(), AtomEnum::STRING.into())).unwrap_or_default();
            let classe = texto(&c, j, AtomEnum::WM_CLASS.into(), AtomEnum::STRING.into()).unwrap_or_default();
            if nome.is_empty() && classe.is_empty() {
                continue;
            }
            let pid = pid_a.and_then(|p| c.get_property(false, j, p, AtomEnum::CARDINAL, 0, 1).ok()?.reply().ok()?.value32()?.next());
            out.push(Janela { id: j, nome, classe, pid });
        }
        Ok((c, n, out))
    }

    pub fn janelas() -> Result<Vec<Programa>, String> {
        Ok(listar()?.2.into_iter().map(|j| Programa { nome: j.classe.split(' ').next_back().unwrap_or("").to_string(), pid: j.pid, titulo: Some(j.nome) }).collect())
    }

    pub fn programas() -> Result<Vec<Programa>, String> {
        let mut vistos = std::collections::BTreeMap::new();
        for j in listar()?.2 {
            let nome = j.classe.split(' ').next_back().unwrap_or("").to_string();
            vistos.entry(if nome.is_empty() { j.nome.clone() } else { nome }).or_insert(j.pid);
        }
        Ok(vistos.into_iter().map(|(nome, pid)| Programa { nome, pid, titulo: None }).collect())
    }

    pub fn abrir(app: &str) -> Result<String, String> {
        let alvo = app.to_lowercase();
        if let Ok((c, n, js)) = listar() {
            if let Some(j) = js.iter().find(|j| j.classe.to_lowercase().split(' ').any(|p| p == alvo) || j.nome.to_lowercase().contains(&alvo)) {
                let raiz = c.setup().roots[n].root;
                let _ = c.configure_window(j.id, &xproto::ConfigureWindowAux::new().stack_mode(xproto::StackMode::ABOVE));
                let _ = c.set_input_focus(xproto::InputFocus::PARENT, j.id, x11rb::CURRENT_TIME);
                if let Some(ativa) = atomo(&c, "_NET_ACTIVE_WINDOW") {
                    let ev = xproto::ClientMessageEvent::new(32, j.id, ativa, [1u32, 0, 0, 0, 0]);
                    let _ = c.send_event(false, raiz, xproto::EventMask::SUBSTRUCTURE_REDIRECT | xproto::EventMask::SUBSTRUCTURE_NOTIFY, ev);
                }
                let _ = c.flush();
                return Ok(format!("{app} já estava aberto: veio para a frente"));
            }
        }
        // abrir: o nome de um programa (xterm, gnome-calculator, libreoffice…) ou de um atalho de aplicativo (.desktop)
        let solto = |cmd: &mut std::process::Command| cmd.stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
        if solto(&mut std::process::Command::new(app.trim())).is_ok() || solto(std::process::Command::new("gtk-launch").arg(app.trim())).is_ok() {
            std::thread::sleep(std::time::Duration::from_millis(600));
            return Ok(format!("abriu {app}"));
        }
        Err(format!("não achei o programa {app} neste computador"))
    }

    pub fn permissoes() -> Permissoes {
        let wayland = std::env::var("XDG_SESSION_TYPE").map(|v| v.eq_ignore_ascii_case("wayland")).unwrap_or(false) || std::env::var_os("WAYLAND_DISPLAY").is_some();
        if wayland && std::env::var("ERGON_COMPUTADOR_WAYLAND").as_deref() != Ok("1") {
            // no Wayland, o sistema não deixa um aplicativo mover o mouse nem ver a tela dos outros: a sessão X11 (Xorg) deixa
            return Permissoes { entrada: false, tela: false, passo: Some("linux_wayland") };
        }
        match conectar() {
            Ok(_) => Permissoes { entrada: true, tela: true, passo: None },
            Err(_) => Permissoes { entrada: false, tela: false, passo: Some("linux_sem_tela") },
        }
    }
}

// ---------------------------------------------------------------------------------------------- macOS
#[cfg(target_os = "macos")]
mod sistema {
    use super::*;
    use std::process::Command;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> bool;
    }
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" {
        fn CGPreflightScreenCaptureAccess() -> bool;
        fn CGRequestScreenCaptureAccess() -> bool;
    }

    pub fn tela(alvo: (u32, u32)) -> Result<Vec<u8>, String> {
        let p = temporario("png");
        let ok = Command::new("/usr/sbin/screencapture").args(["-x", "-C", "-m", "-t", "png"]).arg(&p).status().map(|s| s.success()).unwrap_or(false);
        if !ok {
            let _ = std::fs::remove_file(&p);
            return Err("o macOS não deixou capturar a tela (Gravação de tela)".into());
        }
        // a captura vem em pixels da tela Retina; reduz ao tamanho que o agente vê (em pontos, os do mouse)
        let _ = Command::new("/usr/bin/sips").args(["-z", &alvo.1.to_string(), &alvo.0.to_string()]).arg(&p).output();
        ler_e_apagar(&p)
    }

    pub fn programas() -> Result<Vec<Programa>, String> {
        let o = Command::new("/usr/bin/osascript")
            .args(["-e", "tell application \"System Events\" to get name of every process whose background only is false"])
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&o.stdout).split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).map(|nome| Programa { nome, pid: None, titulo: None }).collect())
    }

    pub fn janelas() -> Result<Vec<Programa>, String> {
        programas()
    }

    pub fn abrir(app: &str) -> Result<String, String> {
        let s = Command::new("/usr/bin/open").args(["-a", app]).status().map_err(|e| e.to_string())?;
        if s.success() {
            std::thread::sleep(std::time::Duration::from_millis(600));
            Ok(format!("abriu {app}"))
        } else {
            Err(format!("não achei o programa {app} neste Mac"))
        }
    }

    pub fn permissoes() -> Permissoes {
        // as duas listas de Privacidade e Segurança: Acessibilidade (mouse e teclado) e Gravação de tela
        let entrada = unsafe { AXIsProcessTrusted() };
        let tela = unsafe { CGPreflightScreenCaptureAccess() };
        if !tela {
            // faz o macOS pôr o Ergon na lista (desligado), para a pessoa só ligar
            unsafe { CGRequestScreenCaptureAccess() };
        }
        let passo = if !entrada { Some("macos_acessibilidade") } else if !tela { Some("macos_gravacao") } else { None };
        Permissoes { entrada, tela, passo }
    }
}

// ---------------------------------------------------------------------------------------------- Windows
#[cfg(target_os = "windows")]
mod sistema {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const SEM_JANELA: u32 = 0x0800_0000;

    fn ps(script: &str, env: &[(&str, &str)]) -> Result<String, String> {
        let mut c = Command::new("powershell.exe");
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script]).creation_flags(SEM_JANELA);
        for (k, v) in env {
            c.env(k, v);
        }
        let o = c.output().map_err(|e| e.to_string())?;
        if !o.status.success() {
            return Err(String::from_utf8_lossy(&o.stderr).lines().next().unwrap_or("o PowerShell falhou").to_string());
        }
        Ok(String::from_utf8_lossy(&o.stdout).to_string())
    }

    pub fn tela(alvo: (u32, u32)) -> Result<Vec<u8>, String> {
        let p = temporario("png");
        let script = "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; \
            Add-Type -Namespace E -Name D -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetProcessDPIAware();'; [E.D]::SetProcessDPIAware() | Out-Null; \
            $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; \
            $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); \
            $r=New-Object System.Drawing.Bitmap $i,([int]$env:ERGON_W),([int]$env:ERGON_H); $r.Save($env:ERGON_ARQ,[System.Drawing.Imaging.ImageFormat]::Png)";
        ps(script, &[("ERGON_W", &alvo.0.to_string()), ("ERGON_H", &alvo.1.to_string()), ("ERGON_ARQ", &p.to_string_lossy())])?;
        ler_e_apagar(&p)
    }

    fn processos() -> Result<Vec<Programa>, String> {
        let j = ps("Get-Process | Where-Object { $_.MainWindowTitle } | Select-Object Name,Id,MainWindowTitle | ConvertTo-Json -Compress", &[])?;
        let v: serde_json::Value = serde_json::from_str(j.trim()).unwrap_or(serde_json::Value::Null);
        let itens = if v.is_array() { v.as_array().cloned().unwrap_or_default() } else if v.is_object() { vec![v] } else { vec![] };
        Ok(itens
            .iter()
            .map(|p| Programa {
                nome: p["Name"].as_str().unwrap_or("").to_string(),
                pid: p["Id"].as_u64().map(|x| x as u32),
                titulo: p["MainWindowTitle"].as_str().map(str::to_string),
            })
            .collect())
    }

    pub fn programas() -> Result<Vec<Programa>, String> {
        Ok(processos()?.into_iter().map(|p| Programa { titulo: None, ..p }).collect())
    }

    pub fn janelas() -> Result<Vec<Programa>, String> {
        processos()
    }

    pub fn abrir(app: &str) -> Result<String, String> {
        // o nome vai por variável de ambiente: nunca é montado dentro do comando
        let script = "$a=$env:ERGON_APP; $p=Get-Process -Name $a -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; \
            if ($p) { (New-Object -ComObject WScript.Shell).AppActivate($p.Id) | Out-Null; 'frente' } else { Start-Process -FilePath $a; 'abriu' }";
        let r = ps(script, &[("ERGON_APP", app)])?;
        std::thread::sleep(std::time::Duration::from_millis(600));
        Ok(if r.trim() == "frente" { format!("{app} já estava aberto: veio para a frente") } else { format!("abriu {app}") })
    }

    pub fn permissoes() -> Permissoes {
        // o Windows não pede permissão para mouse e teclado; janelas de administrador (UAC) não recebem a entrada de um
        // aplicativo comum: o agente vê a janela, mas não mexe nela
        Permissoes { entrada: true, tela: true, passo: None }
    }
}

pub use sistema::{abrir, janelas, permissoes, programas, tela};

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn reduzir_faz_a_media_de_cada_bloco() {
        // 4×2: duas metades (preto e branco) viram 2×1
        let mut rgb = Vec::new();
        for _y in 0..2 {
            rgb.extend_from_slice(&[0, 0, 0, 0, 0, 0, 255, 255, 255, 255, 255, 255]);
        }
        assert_eq!(reduzir(&rgb, (4, 2), (2, 1)), vec![0, 0, 0, 255, 255, 255]);
        assert_eq!(reduzir(&rgb, (4, 2), (4, 2)), rgb, "mesmo tamanho: igual");
    }

    #[test]
    fn png_valido() {
        let p = png_rgb(&[10, 20, 30, 40, 50, 60], (2, 1)).unwrap();
        assert_eq!(&p[..8], b"\x89PNG\r\n\x1a\n");
        let d = png::Decoder::new(std::io::Cursor::new(p));
        let r = d.read_info().unwrap();
        assert_eq!((r.info().width, r.info().height), (2, 1));
    }
}
