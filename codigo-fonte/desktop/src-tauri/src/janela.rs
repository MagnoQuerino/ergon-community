//! A janela do Ergon e a política de navegação. Dentro da janela só carregam a tela de abertura (conteúdo do
//! próprio aplicativo) e o Ergon local na porta confirmada; qualquer outro endereço da web abre no navegador do
//! sistema, e esquemas estranhos (file:, data:, javascript: …) são recusados. Downloads vão para a pasta Downloads.

use crate::Estado;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use tauri::webview::{DownloadEvent, NewWindowFeatures, NewWindowResponse};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, Wry};
use tauri_plugin_window_state::{StateFlags, WindowExt};

pub const PRINCIPAL: &str = "principal";

#[derive(Debug, PartialEq, Eq)]
pub enum Destino {
    /// conteúdo empacotado no aplicativo (tela de abertura)
    Interno,
    /// o Ergon local, na porta confirmada
    Ergon,
    /// páginas da web: abrem no navegador do sistema
    Externo,
    Negado,
}

pub fn destino(url: &Url, porta: u16) -> Destino {
    let host = url.host_str().unwrap_or("");
    match url.scheme() {
        "tauri" if host == "localhost" => Destino::Interno,
        "about" if url.as_str() == "about:blank" => Destino::Interno,
        "http" | "https" if host == "tauri.localhost" => Destino::Interno,
        "http" if (host == "localhost" || host == "127.0.0.1") && url.port_or_known_default() == Some(porta) => Destino::Ergon,
        // outras portas e serviços do próprio computador: nem na janela, nem no navegador
        "http" | "https" if host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host.ends_with(".localhost") => Destino::Negado,
        "http" | "https" | "mailto" => Destino::Externo,
        _ => Destino::Negado,
    }
}

fn porta(app: &AppHandle) -> u16 {
    app.state::<Estado>().porta.load(Ordering::SeqCst)
}

/// Só o esquema e o servidor vão para o registro: endereços de login carregam códigos e estados no meio.
fn resumo(url: &Url) -> String {
    format!("{}://{}", url.scheme(), url.host_str().unwrap_or(""))
}

/// Teste (ERGON_DESKTOP_URL + ERGON_DESKTOP_SEM_NAVEGADOR=1): registra o que abriria no navegador, sem abrir.
fn sem_navegador() -> bool {
    crate::instalacao::localizar().teste && std::env::var("ERGON_DESKTOP_SEM_NAVEGADOR").as_deref() == Ok("1")
}

fn abrir_fora(url: &Url) {
    if sem_navegador() {
        log::info!("abriria no navegador: {}", resumo(url));
        return;
    }
    if let Err(e) = tauri_plugin_opener::open_url(url.as_str(), None::<&str>) {
        log::warn!("não abriu no navegador ({}): {e}", resumo(url));
    }
}

fn navegar(app: &AppHandle, url: &Url) -> bool {
    let d = destino(url, porta(app));
    // a página do Ergon pede a tela de atualizações do aplicativo (botão "Verificar atualizações"): ela não ganha
    // nenhuma permissão; quem confere, mostra e atualiza é a tela de abertura, que vem de dentro do aplicativo
    if d == Destino::Ergon && url.path() == PEDIDO_ATUALIZACOES {
        let a = app.clone();
        std::thread::spawn(move || abrir_atualizacoes(&a));
        return false;
    }
    // "Voltar para esta versão": a página só pede; quem confere, avisa, pede a confirmação e volta é a tela de abertura
    if d == Destino::Ergon && url.path() == PEDIDO_VOLTAR {
        let a = app.clone();
        let versao = versao_pedida(url);
        std::thread::spawn(move || abrir_volta(&a, versao.as_deref()));
        return false;
    }
    match d {
        Destino::Interno | Destino::Ergon => true,
        Destino::Externo => {
            abrir_fora(url);
            false
        }
        Destino::Negado => {
            log::warn!("navegação recusada: {}", resumo(url));
            false
        }
    }
}

fn nova_janela(app: &AppHandle, url: Url, features: NewWindowFeatures) -> NewWindowResponse<Wry> {
    match destino(&url, porta(app)) {
        // ex.: imagem gerada aberta "em outra aba": outra janela do Ergon, com a mesma política
        Destino::Ergon => {
            static N: AtomicU32 = AtomicU32::new(1);
            let rotulo = format!("ergon-{}", N.fetch_add(1, Ordering::SeqCst));
            let b = politica(app, WebviewWindowBuilder::new(app, rotulo, WebviewUrl::External("about:blank".parse().unwrap())))
                .window_features(features)
                .title("Ergon");
            match b.build() {
                Ok(window) => NewWindowResponse::Create { window },
                Err(e) => {
                    log::warn!("não abriu a nova janela: {e}");
                    NewWindowResponse::Deny
                }
            }
        }
        Destino::Externo => {
            abrir_fora(&url);
            NewWindowResponse::Deny
        }
        _ => NewWindowResponse::Deny,
    }
}

/// Nome livre na pasta: "relatorio.md", "relatorio (1).md", …
fn nome_livre(alvo: PathBuf) -> PathBuf {
    if !alvo.exists() {
        return alvo;
    }
    let pasta = alvo.parent().map(Path::to_path_buf).unwrap_or_default();
    let base = alvo.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "arquivo".into());
    let ext = alvo.extension().map(|e| format!(".{}", e.to_string_lossy())).unwrap_or_default();
    (1..1000).map(|i| pasta.join(format!("{base} ({i}){ext}"))).find(|p| !p.exists()).unwrap_or(alvo)
}

fn baixar(app: &AppHandle, evento: DownloadEvent<'_>) -> bool {
    match evento {
        DownloadEvent::Requested { url, destination } => {
            // só baixa do Ergon (a navegação já não deixa chegar a outro lugar; aqui é a segunda trava)
            if destino(&url, porta(app)) != Destino::Ergon {
                log::warn!("download recusado: {}", resumo(&url));
                return false;
            }
            let nome = destination.file_name().map(|n| n.to_owned()).filter(|n| !n.is_empty());
            // instância de teste: os arquivos vão para a pasta do aplicativo, não para os Downloads da pessoa
            let pasta = if crate::instalacao::localizar().teste {
                app.path().app_local_data_dir().map(|d| d.join("downloads-teste"))
            } else {
                app.path().download_dir()
            };
            if let (Ok(pasta), Some(nome)) = (pasta, nome) {
                std::fs::create_dir_all(&pasta).ok();
                *destination = nome_livre(pasta.join(nome));
            }
            true
        }
        DownloadEvent::Finished { path, success, .. } => {
            if success {
                if let Some(p) = path {
                    log::info!("download concluído");
                    avisar_download(app, &p);
                }
            } else {
                log::warn!("download não concluído");
            }
            true
        }
        _ => true,
    }
}

/// No Windows o próprio WebView2 mostra o download; no Linux, um aviso diz onde o arquivo ficou.
fn avisar_download(app: &AppHandle, caminho: &Path) {
    #[cfg(target_os = "linux")]
    {
        use tauri_plugin_dialog::DialogExt;
        app.dialog().message(format!("Arquivo salvo em:\n{}", caminho.display())).title("Download concluído").show(|_| {});
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (app, caminho);
}

/// Aplica a política de navegação, janelas novas e downloads a uma janela.
fn politica<'a>(app: &AppHandle, b: WebviewWindowBuilder<'a, Wry, AppHandle>) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    let (a1, a2, a3) = (app.clone(), app.clone(), app.clone());
    b.on_navigation(move |url| navegar(&a1, url))
        .on_new_window(move |url, features| nova_janela(&a2, url, features))
        .on_download(move |_webview, evento| baixar(&a3, evento))
        .zoom_hotkeys_enabled(true)
}

pub fn criar_principal(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let mut b = politica(app, WebviewWindowBuilder::new(app, PRINCIPAL, WebviewUrl::App("index.html".into())));
    // cookies valem por endereço ("localhost"), não por porta: instância de teste ou instalação em outra porta usam
    // um perfil do WebView próprio, para a sessão de uma nunca chegar à outra
    let inst = crate::instalacao::localizar();
    let perfil = if inst.teste {
        Some("webview-teste".to_string())
    } else if inst.porta != crate::instalacao::PORTA_PADRAO {
        Some(format!("webview-{}", inst.porta))
    } else {
        None
    };
    if let (Some(p), Ok(d)) = (perfil, app.path().app_local_data_dir()) {
        b = b.data_directory(d.join(p));
    }
    let w = b
        .title("Ergon")
        .inner_size(1280.0, 820.0)
        .min_inner_size(380.0, 520.0)
        .center()
        .visible(false)
        // arquivo arrastado do computador vai para a tela (conversa, Documentos): sem isto, no Windows o WebView
        // entrega o arquivo ao aplicativo e o "soltar" da página nunca acontece
        .disable_drag_drop_handler()
        .build()?;
    // tamanho, posição e "maximizada" da última vez (o plugin descarta posição de monitor que não existe mais)
    let _ = w.restore_state(StateFlags::all() & !StateFlags::VISIBLE);
    w.show()?;
    Ok(w)
}

/// Traz a janela para a frente (abrir de novo, clique na bandeja).
pub fn mostrar(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PRINCIPAL) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Endereço que a página do Ergon usa para pedir a tela de atualizações (nunca chega ao servidor).
pub const PEDIDO_ATUALIZACOES: &str = "/__desktop/atualizacoes";
/// Endereço que a página do Ergon usa para pedir a volta a uma versão anterior ("?versao=X"; nunca chega ao servidor).
pub const PEDIDO_VOLTAR: &str = "/__desktop/voltar";

/// A versão pedida em "/__desktop/voltar?versao=X". Só passa uma versão bem formada (x.y.z[-pre], letras, números,
/// ponto e hífen): ela vai para o endereço da tela de abertura e, depois da confirmação da pessoa, para o endereço do
/// manifesto assinado dela.
pub fn versao_pedida(url: &Url) -> Option<String> {
    let v = url.query_pairs().find(|(k, _)| &**k == "versao").map(|(_, v)| v.into_owned())?;
    (v.len() <= 40 && crate::confianca::comparar_versoes(&v, &v).is_ok()).then_some(v)
}

/// Tela de abertura em "#voltar=<versão>": confere a versão escolhida, avisa e só volta com a confirmação da pessoa.
/// Versão mal formada: a tela diz que não reconheceu (nada muda).
pub fn abrir_volta(app: &AppHandle, versao: Option<&str>) {
    if let Some(w) = app.get_webview_window(PRINCIPAL) {
        let base = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
        let _ = w.navigate(Url::parse(&format!("{base}#voltar={}", versao.unwrap_or(""))).expect("endereço fixo"));
        mostrar(app);
    }
}

pub fn abrir_ergon(app: &AppHandle, porta: u16) -> tauri::Result<()> {
    let w = app.get_webview_window(PRINCIPAL).ok_or(tauri::Error::WindowNotFound)?;
    w.navigate(Url::parse(&endereco_do_ergon(porta, crate::ambiente::ativo())).expect("endereço fixo"))
}

/// Endereço da página do Ergon no aplicativo. "app=desktop": a página sabe que está no aplicativo (o botão de
/// atualizações leva à tela dele). "volta=1": voltar de versão pelo aplicativo vale aqui (Windows com o ambiente
/// próprio, como em atualizacao.rs); sem ele (Linux, ou Windows sem o ambiente), a página mostra só a página de cada
/// versão.
pub fn endereco_do_ergon(porta: u16, volta: bool) -> String {
    format!("http://localhost:{porta}/?app=desktop{}", if volta { "&volta=1" } else { "" })
}

/// Tela de atualizações do aplicativo (a de abertura, em "#atualizacoes"): verifica e, se a pessoa pedir, atualiza.
pub fn abrir_atualizacoes(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(PRINCIPAL) {
        let base = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
        let _ = w.navigate(Url::parse(&format!("{base}#atualizacoes")).expect("endereço fixo"));
        mostrar(app);
    }
}

/// Volta para a tela de abertura (que confere tudo de novo); "#iniciar" já liga os serviços.
pub fn voltar_abertura(app: &AppHandle, iniciar: bool) {
    if let Some(w) = app.get_webview_window(PRINCIPAL) {
        let base = if cfg!(windows) { "http://tauri.localhost/index.html" } else { "tauri://localhost/index.html" };
        let url = Url::parse(&format!("{base}{}", if iniciar { "#iniciar" } else { "" })).expect("endereço fixo");
        let _ = w.navigate(url);
        mostrar(app);
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    fn d(u: &str) -> Destino {
        destino(&Url::parse(u).unwrap(), 8787)
    }

    #[test]
    fn so_o_aplicativo_e_o_ergon_ficam_na_janela() {
        assert_eq!(d("tauri://localhost/index.html"), Destino::Interno);
        assert_eq!(d("http://tauri.localhost/index.html"), Destino::Interno);
        assert_eq!(d("http://localhost:8787/#tarefas"), Destino::Ergon);
        assert_eq!(d("http://127.0.0.1:8787/api/artifacts/x/download"), Destino::Ergon);
        assert_eq!(d("about:blank"), Destino::Interno);
    }

    #[test]
    fn web_vai_para_o_navegador_e_o_resto_e_recusado() {
        assert_eq!(d("https://login.microsoftonline.com/common/oauth2/v2.0/authorize?state=x"), Destino::Externo);
        assert_eq!(d("https://docs.docker.com/"), Destino::Externo);
        assert_eq!(d("mailto:contato@exemplo.com"), Destino::Externo);
        // outras portas do próprio computador, https no Ergon, arquivos e scripts: não
        assert_eq!(d("http://localhost:9000/"), Destino::Negado);
        assert_eq!(d("https://localhost:8787/"), Destino::Negado);
        assert_eq!(d("http://evil.localhost:8787/"), Destino::Negado);
        assert_eq!(d("file:///etc/passwd"), Destino::Negado);
        assert_eq!(d("javascript:alert(1)"), Destino::Negado);
        assert_eq!(d("data:text/html,oi"), Destino::Negado);
        assert_eq!(d("about:config"), Destino::Negado);
    }

    #[test]
    fn pagina_do_ergon_sabe_se_a_volta_vale_aqui() {
        assert_eq!(endereco_do_ergon(8787, true), "http://localhost:8787/?app=desktop&volta=1");
        assert_eq!(endereco_do_ergon(8787, false), "http://localhost:8787/?app=desktop", "Linux ou sem o ambiente: sem o botão");
        assert!(Url::parse(&endereco_do_ergon(18787, true)).is_ok());
    }

    #[test]
    fn pedido_de_voltar_so_com_versao_bem_formada() {
        let v = |u: &str| versao_pedida(&Url::parse(u).unwrap());
        assert_eq!(d("http://localhost:8787/__desktop/voltar?versao=1.1.0-rc.20"), Destino::Ergon, "o pedido vem do Ergon");
        assert_eq!(v("http://localhost:8787/__desktop/voltar?versao=1.1.0-rc.20").as_deref(), Some("1.1.0-rc.20"));
        assert_eq!(v("http://localhost:8787/__desktop/voltar?outra=1&versao=1.1.0").as_deref(), Some("1.1.0"));
        for u in [
            "http://localhost:8787/__desktop/voltar",
            "http://localhost:8787/__desktop/voltar?versao=",
            "http://localhost:8787/__desktop/voltar?versao=1.1.0%23atualizacoes",
            "http://localhost:8787/__desktop/voltar?versao=..%2F..%2Fx",
            "http://localhost:8787/__desktop/voltar?versao=1.1.0-rc.20%2F..%2F..%2Fsegredo",
            "http://localhost:8787/__desktop/voltar?versao=javascript:alert(1)",
        ] {
            assert_eq!(v(u), None, "{u}");
        }
    }

    #[test]
    fn nome_livre_nao_sobrescreve() {
        let pasta = std::env::temp_dir().join(format!("ergon-desktop-dl-{}", std::process::id()));
        std::fs::create_dir_all(&pasta).unwrap();
        let a = pasta.join("relatorio.md");
        assert_eq!(nome_livre(a.clone()), a);
        std::fs::write(&a, "x").unwrap();
        assert_eq!(nome_livre(a.clone()), pasta.join("relatorio (1).md"));
        std::fs::remove_dir_all(&pasta).ok();
    }
}
