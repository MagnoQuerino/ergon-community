//! Ações nativas que a tela de abertura pode pedir: ligar os serviços (pelo lançador, comando "subir"), abrir o
//! Ergon na janela, no navegador, as páginas de ajuda e a pasta de registros. Cada uma é fixa: nenhum texto vindo
//! da tela vira comando, caminho ou endereço.

use crate::{instalacao, janela, processo, Estado};
use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

/// Prazo do lançador: abrir o Docker Desktop e subir os serviços pode levar minutos na primeira vez do dia.
const PRAZO_LANCADOR: Duration = Duration::from_secs(15 * 60);

#[derive(Clone, Serialize)]
struct Fim {
    ok: bool,
    mensagem: String,
}

fn raiz_atual(estado: &Estado) -> Option<PathBuf> {
    estado.ultimo.lock().ok().and_then(|d| d.as_ref().and_then(|d| d.raiz.clone())).or_else(|| instalacao::localizar().raiz)
}

/// Liga o Docker (no Windows, o Docker Desktop, com a recuperação de travamento do lançador) e os serviços do
/// Ergon. Usa "subir", que não instala nada no início do sistema. A saída chega à tela de abertura linha a linha.
#[tauri::command]
pub fn subir_servicos(app: AppHandle, estado: State<'_, Estado>) -> Result<(), String> {
    if crate::ambiente::ativo() {
        return em_segundo_plano(app, &estado, |app| crate::ambiente::subir(&mut |e| emitir(app, e)));
    }
    let raiz = raiz_atual(&estado).ok_or("A pasta da instalação do Ergon não foi encontrada.")?;
    if !instalacao::valida(&raiz) {
        return Err("A pasta registrada não tem mais o lançador do Ergon.".into());
    }
    if estado.subindo.swap(true, Ordering::SeqCst) {
        return Err("O Ergon já está iniciando.".into());
    }
    let app2 = app.clone();
    std::thread::spawn(move || {
        let r = rodar_lancador(&app2, &raiz, "subir");
        app2.state::<Estado>().subindo.store(false, Ordering::SeqCst);
        if let Err(e) = &r {
            log::warn!("subir: {e}");
        }
        let _ = app2.emit_to(janela::PRINCIPAL, "servicos:fim", Fim { ok: r.is_ok(), mensagem: r.err().unwrap_or_default() });
    });
    Ok(())
}

/// Para os serviços do Ergon (só pela bandeja, depois de você confirmar). O Docker continua aberto.
pub fn parar_servicos(app: &AppHandle) -> Result<(), String> {
    if crate::ambiente::ativo() {
        return crate::ambiente::parar(&mut |e| emitir(app, e));
    }
    let raiz = raiz_atual(&app.state::<Estado>()).ok_or("A pasta da instalação do Ergon não foi encontrada.")?;
    rodar_lancador(app, &raiz, "parar")
}

/// Instala o Ergon pelo ambiente próprio (Windows): baixa e confere os componentes da versão, cria o ambiente e liga
/// os serviços. Retoma de onde parou. As etapas chegam à tela ("instalacao:etapa"), e as linhas como as do "subir".
#[tauri::command]
pub fn instalar_ergon(app: AppHandle, estado: State<'_, Estado>) -> Result<(), String> {
    em_segundo_plano(app, &estado, |app| match crate::ambiente::instalar(&mut |e| emitir(app, e))? {
        crate::ambiente::Fim::Pronto { .. } => Ok(()),
        crate::ambiente::Fim::Reiniciar => {
            let _ = app.emit_to(janela::PRINCIPAL, "instalacao:reiniciar", ());
            Err("REINICIAR".into())
        }
    })
}

/// Evento da instalação ou do ambiente → tela de abertura.
pub fn emitir(app: &AppHandle, e: crate::ambiente::Evento) {
    use crate::ambiente::Evento;
    match e {
        Evento::Etapa(id) => {
            log::info!("instalação: {id}");
            let _ = app.emit_to(janela::PRINCIPAL, "instalacao:etapa", id);
        }
        Evento::Linha(l) => {
            log::info!("instalação: {l}");
            let _ = app.emit_to(janela::PRINCIPAL, "servicos:linha", l);
        }
        Evento::Progresso { componente, feitos, total } => {
            let _ = app.emit_to(janela::PRINCIPAL, "instalacao:progresso", (componente, feitos, total));
        }
    }
}

/// Uma operação longa por vez, numa thread; o fim chega como "servicos:fim".
fn em_segundo_plano(app: AppHandle, estado: &Estado, f: impl FnOnce(&AppHandle) -> Result<(), String> + Send + 'static) -> Result<(), String> {
    if estado.subindo.swap(true, Ordering::SeqCst) {
        return Err("O Ergon já está iniciando.".into());
    }
    std::thread::spawn(move || {
        let r = f(&app);
        app.state::<Estado>().subindo.store(false, Ordering::SeqCst);
        if let Err(e) = &r {
            log::warn!("{e}");
        }
        let _ = app.emit_to(janela::PRINCIPAL, "servicos:fim", Fim { ok: r.is_ok(), mensagem: r.err().unwrap_or_default() });
    });
    Ok(())
}

/// Roda o lançador desta plataforma (ergon.ps1 no Windows, ergon.sh no Linux) com um comando fixo.
pub fn rodar_lancador(app: &AppHandle, raiz: &Path, comando: &'static str) -> Result<(), String> {
    let lancador = instalacao::lancador(raiz);
    let mut c = if cfg!(windows) {
        // caminho completo: nunca um "powershell.exe" achado no PATH ou na pasta atual
        let ps = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows"));
        let mut c = processo::comando(ps.join(r"System32\WindowsPowerShell\v1.0\powershell.exe"));
        c.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]).arg(&lancador).arg(comando);
        c
    } else {
        let mut c = processo::comando("/bin/bash");
        c.arg(&lancador).arg(comando);
        c
    };
    c.current_dir(raiz).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    log::info!("lançador: {comando}");
    let mut filho = c.spawn().map_err(|e| format!("Não foi possível rodar o lançador do Ergon ({e})."))?;
    let ultima = Arc::new(Mutex::new(String::new()));
    let leitor = |fonte: Box<dyn Read + Send>| {
        let app = app.clone();
        let ultima = ultima.clone();
        std::thread::spawn(move || {
            for l in BufReader::new(fonte).lines().map_while(Result::ok) {
                let l = processo::sem_cores(&l).trim().chars().take(300).collect::<String>();
                if l.is_empty() {
                    continue;
                }
                *ultima.lock().unwrap() = l.clone();
                let _ = app.emit_to(janela::PRINCIPAL, "servicos:linha", l);
            }
        })
    };
    let t1 = leitor(Box::new(filho.stdout.take().expect("stdout")));
    let t2 = leitor(Box::new(filho.stderr.take().expect("stderr")));
    let fim = Instant::now() + PRAZO_LANCADOR;
    let status = loop {
        match filho.try_wait() {
            Ok(Some(s)) => break s,
            Ok(None) if Instant::now() < fim => std::thread::sleep(Duration::from_millis(200)),
            Ok(None) => {
                let _ = filho.kill();
                return Err("O lançador não terminou em 15 minutos.".into());
            }
            Err(e) => return Err(e.to_string()),
        }
    };
    let _ = t1.join();
    let _ = t2.join();
    if status.success() {
        Ok(())
    } else {
        let u = ultima.lock().unwrap().trim_start_matches("[ergon]").trim().to_string();
        Err(if u.is_empty() { "O lançador terminou com erro.".into() } else { u })
    }
}

/// Abre o Ergon na janela — só depois de um diagnóstico que confirmou a identidade do serviço.
#[tauri::command]
pub fn abrir_ergon(app: AppHandle, estado: State<'_, Estado>) -> Result<(), String> {
    let ultimo = estado.ultimo.lock().map_err(|e| e.to_string())?.clone();
    match ultimo {
        Some(d) if d.confirmado => janela::abrir_ergon(&app, d.porta).map_err(|e| e.to_string()),
        _ => Err("O serviço ainda não foi confirmado como o Ergon desta instalação.".into()),
    }
}

#[tauri::command]
pub fn abrir_no_navegador(estado: State<'_, Estado>) -> Result<(), String> {
    let porta = estado.porta.load(Ordering::SeqCst);
    tauri_plugin_opener::open_url(format!("http://localhost:{porta}/"), None::<&str>).map_err(|e| e.to_string())
}

/// Páginas oficiais de ajuda (lista fechada: a tela pede pelo tema, nunca pelo endereço).
pub fn pagina_de_ajuda(tema: &str) -> Option<&'static str> {
    Some(match tema {
        "docker" if cfg!(windows) => "https://docs.docker.com/desktop/setup/install/windows-install/",
        "docker" => "https://docs.docker.com/engine/install/",
        "docker_rootless" => "https://docs.docker.com/engine/security/rootless/",
        "docker_pos_instalacao" => "https://docs.docker.com/engine/install/linux-postinstall/",
        "instalar_ergon" => "https://github.com/MagnoQuerino/ergon-community/blob/main/docs/INSTALAR.md",
        _ => return None,
    })
}

#[tauri::command]
pub fn abrir_ajuda(tema: String) -> Result<(), String> {
    let url = pagina_de_ajuda(&tema).ok_or("tema de ajuda desconhecido")?;
    tauri_plugin_opener::open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// A pasta dos registros do aplicativo (sem senhas nem tokens: só estados e erros).
#[tauri::command]
pub fn abrir_registros(app: AppHandle) -> Result<(), String> {
    let pasta = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&pasta).ok();
    tauri_plugin_opener::open_path(&pasta, None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn ajuda_so_por_tema_conhecido() {
        assert!(pagina_de_ajuda("docker").unwrap().starts_with("https://docs.docker.com/"));
        assert!(pagina_de_ajuda("https://exemplo.com").is_none());
        assert!(pagina_de_ajuda("").is_none());
    }
}
