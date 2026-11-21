//! A janela do Ergon e a política de navegação. Dentro da janela só carregam a tela de abertura (conteúdo do
//! próprio aplicativo) e o Ergon local na porta confirmada; qualquer outro endereço da web abre no navegador do
//! sistema, e esquemas estranhos (file:, data:, javascript: …) são recusados. Downloads vão para a pasta de downloads do
//! Ergon (rc.33: a pessoa escolhe em Configurações; sem escolha, a Downloads do sistema), e a página recebe o aviso.

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
    // downloads (rc.33): a pasta do Ergon e o aviso do download; a página só pede
    if d == Destino::Ergon && url.path().starts_with(PREFIXO_DOWNLOADS) {
        let (a, u) = (app.clone(), url.clone());
        std::thread::spawn(move || pedido_de_downloads(&a, &u));
        return false;
    }
    // pastas do computador (rc.42): a página pede o seletor; o aplicativo devolve o caminho escolhido por evento, e quem
    // confere e concede é o Ergon (a página não ganha acesso ao disco)
    if d == Destino::Ergon && url.path() == PEDIDO_PASTA_ESCOLHER {
        let a = app.clone();
        std::thread::spawn(move || escolher_pasta_do_computador(&a));
        return false;
    }
    // fechar a janela (rc.40): a resposta da página à pergunta do aplicativo (fechar.rs)
    if d == Destino::Ergon && crate::fechar::resposta(app, url.path()) {
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

/// Onde fica guardada a pasta escolhida em Configurações › "Pasta de downloads do Ergon" (texto puro, um caminho).
fn arquivo_da_pasta(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("pasta-downloads.txt"))
}

/// A pasta escolhida, se ainda existe (pasta apagada ou disco removido: volta ao padrão).
fn pasta_escolhida(app: &AppHandle) -> Option<PathBuf> {
    let texto = std::fs::read_to_string(arquivo_da_pasta(app)?).ok()?;
    pasta_valida(texto.trim())
}

/// Só caminho absoluto de uma pasta que existe.
pub fn pasta_valida(texto: &str) -> Option<PathBuf> {
    let p = PathBuf::from(texto);
    (!texto.is_empty() && p.is_absolute() && p.is_dir()).then_some(p)
}

/// A pasta padrão: a Downloads do sistema (instância de teste: a pasta do aplicativo, não a da pessoa).
fn pasta_padrao(app: &AppHandle) -> Option<PathBuf> {
    if crate::instalacao::localizar().teste {
        app.path().app_local_data_dir().ok().map(|d| d.join("downloads-teste"))
    } else {
        app.path().download_dir().ok()
    }
}

pub fn pasta_downloads(app: &AppHandle) -> Option<PathBuf> {
    pasta_escolhida(app).or_else(|| pasta_padrao(app))
}

/// Grava a escolha (None = volta ao padrão).
fn gravar_pasta(app: &AppHandle, pasta: Option<&Path>) {
    let Some(arq) = arquivo_da_pasta(app) else { return };
    match pasta {
        Some(p) => {
            if let Some(d) = arq.parent() {
                std::fs::create_dir_all(d).ok();
            }
            if let Err(e) = std::fs::write(&arq, p.to_string_lossy().as_bytes()) {
                log::warn!("não gravou a pasta de downloads: {e}");
            }
        }
        None => {
            std::fs::remove_file(&arq).ok();
        }
    }
}

/// Texto JSON seguro para ir dentro de um script na página (serde_json escapa aspas, barras e quebras; "<" e os
/// separadores de linha do JavaScript também saem escapados).
fn json_para_script(v: &serde_json::Value) -> String {
    serde_json::to_string(v).unwrap_or_else(|_| "null".into()).replace('<', "\\u003c").replace('\u{2028}', "\\u2028").replace('\u{2029}', "\\u2029")
}

/// Avisa a página (um evento no window, nada além): o download que terminou, ou a pasta atual.
fn avisar_pagina(w: &tauri::Webview<Wry>, evento: &str, detalhe: serde_json::Value) {
    let js = format!("window.dispatchEvent(new CustomEvent({}, {{ detail: {} }}))", json_para_script(&serde_json::Value::from(evento)), json_para_script(&detalhe));
    if let Err(e) = w.eval(js) {
        log::warn!("não avisou a página: {e}");
    }
}

fn avisar_principal(app: &AppHandle, evento: &str, detalhe: serde_json::Value) {
    if let Some(w) = app.get_webview_window(PRINCIPAL) {
        let js = format!("window.dispatchEvent(new CustomEvent({}, {{ detail: {} }}))", json_para_script(&serde_json::Value::from(evento)), json_para_script(&detalhe));
        let _ = w.eval(js);
    }
}

fn detalhe_da_pasta(app: &AppHandle) -> serde_json::Value {
    serde_json::json!({
        "pasta": pasta_downloads(app).map(|p| p.display().to_string()).unwrap_or_default(),
        "padrao": pasta_escolhida(app).is_none(),
    })
}

/// Os downloads desta sessão (o id que a página recebe é a posição aqui): "Abrir pasta" e "Mostrar arquivo" só valem
/// para um arquivo que o próprio aplicativo baixou, nunca para um caminho que a página mande.
fn guardar_download(app: &AppHandle, p: &Path) -> usize {
    let e = app.state::<Estado>();
    let mut lista = e.downloads.lock().unwrap_or_else(|x| x.into_inner());
    lista.push(p.to_path_buf());
    lista.len() - 1
}

fn download_de(app: &AppHandle, url: &Url) -> Option<PathBuf> {
    let id: usize = url.query_pairs().find(|(k, _)| &**k == "id")?.1.parse().ok()?;
    let e = app.state::<Estado>();
    let lista = e.downloads.lock().unwrap_or_else(|x| x.into_inner());
    lista.get(id).cloned()
}

/// Pedidos da página sobre downloads ("/__desktop/downloads/…"), como o de atualizações: a página não ganha nenhuma
/// permissão; o aplicativo decide e responde por evento. Abrir é sempre a PASTA (ou mostrar o arquivo nela), nunca
/// executar o arquivo: um executável baixado continua só um arquivo na pasta.
fn pedido_de_downloads(app: &AppHandle, url: &Url) {
    match url.path() {
        PEDIDO_DL_PASTA => avisar_principal(app, "ergon:downloads-pasta", detalhe_da_pasta(app)),
        PEDIDO_DL_ESCOLHER => {
            use tauri_plugin_dialog::DialogExt;
            let a = app.clone();
            let mut d = app.dialog().file().set_title("Pasta de downloads do Ergon");
            if let Some(p) = pasta_downloads(app) {
                d = d.set_directory(p);
            }
            d.pick_folder(move |escolha| {
                if let Some(p) = escolha.and_then(|f| f.into_path().ok()).and_then(|p| pasta_valida(&p.to_string_lossy())) {
                    gravar_pasta(&a, Some(&p));
                    log::info!("pasta de downloads escolhida");
                }
                avisar_principal(&a, "ergon:downloads-pasta", detalhe_da_pasta(&a));
            });
        }
        PEDIDO_DL_PADRAO => {
            gravar_pasta(app, None);
            avisar_principal(app, "ergon:downloads-pasta", detalhe_da_pasta(app));
        }
        PEDIDO_DL_ABRIR_PASTA => {
            if let Some(pasta) = download_de(app, url).and_then(|p| p.parent().map(Path::to_path_buf)) {
                if let Err(e) = tauri_plugin_opener::open_path(&pasta, None::<&str>) {
                    log::warn!("não abriu a pasta: {e}");
                }
            }
        }
        PEDIDO_DL_MOSTRAR => {
            if let Some(p) = download_de(app, url) {
                if let Err(e) = tauri_plugin_opener::reveal_item_in_dir(&p) {
                    log::warn!("não mostrou o arquivo: {e}");
                }
            }
        }
        _ => {}
    }
}

/// O seletor de pastas do sistema para Conexões › Pastas do computador: só devolve o caminho escolhido à página (evento
/// "ergon:pasta-escolhida"); cancelar devolve vazio. Conceder é com o Ergon, que confere de novo (lib/pastas-seguras.ts).
fn escolher_pasta_do_computador(app: &AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    let a = app.clone();
    app.dialog().file().set_title("Pasta para a equipe do Ergon").pick_folder(move |escolha| {
        let pasta = escolha.and_then(|f| f.into_path().ok()).map(|p| p.display().to_string()).unwrap_or_default();
        avisar_principal(&a, "ergon:pasta-escolhida", serde_json::json!({ "pasta": pasta }));
    });
}

fn baixar(app: &AppHandle, webview: &tauri::Webview<Wry>, evento: DownloadEvent<'_>) -> bool {
    match evento {
        DownloadEvent::Requested { url, destination } => {
            // só baixa do Ergon (a navegação já não deixa chegar a outro lugar; aqui é a segunda trava)
            if destino(&url, porta(app)) != Destino::Ergon {
                log::warn!("download recusado: {}", resumo(&url));
                return false;
            }
            let nome = destination.file_name().map(|n| n.to_owned()).filter(|n| !n.is_empty());
            if let (Some(pasta), Some(nome)) = (pasta_downloads(app), nome) {
                std::fs::create_dir_all(&pasta).ok();
                *destination = nome_livre(pasta.join(nome));
            }
            true
        }
        DownloadEvent::Finished { path, success, .. } => {
            if success {
                if let Some(p) = path {
                    log::info!("download concluído");
                    let id = guardar_download(app, &p);
                    avisar_pagina(webview, "ergon:download", serde_json::json!({
                        "id": id,
                        "nome": p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
                        "pasta": p.parent().map(|d| d.display().to_string()).unwrap_or_default(),
                    }));
                }
            } else {
                log::warn!("download não concluído");
            }
            true
        }
        _ => true,
    }
}

/// Aplica a política de navegação, janelas novas e downloads a uma janela.
fn politica<'a>(app: &AppHandle, b: WebviewWindowBuilder<'a, Wry, AppHandle>) -> WebviewWindowBuilder<'a, Wry, AppHandle> {
    let (a1, a2, a3) = (app.clone(), app.clone(), app.clone());
    b.on_navigation(move |url| navegar(&a1, url))
        .on_new_window(move |url, features| nova_janela(&a2, url, features))
        .on_download(move |webview, evento| baixar(&a3, &webview, evento))
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
    // fechar com a página do Ergon aberta: pergunta a ela antes (fechar.rs)
    let a = app.clone();
    w.on_window_event(move |ev| {
        if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
            if crate::fechar::perguntar(&a) {
                api.prevent_close();
            }
        }
    });
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
/// Pedidos da página sobre downloads (nunca chegam ao servidor): a pasta atual, escolher outra, voltar ao padrão, e
/// abrir a pasta ou mostrar um arquivo baixado nesta sessão ("?id=N").
pub const PREFIXO_DOWNLOADS: &str = "/__desktop/downloads/";
pub const PEDIDO_DL_PASTA: &str = "/__desktop/downloads/pasta";
pub const PEDIDO_DL_ESCOLHER: &str = "/__desktop/downloads/escolher";
pub const PEDIDO_DL_PADRAO: &str = "/__desktop/downloads/padrao";
pub const PEDIDO_DL_ABRIR_PASTA: &str = "/__desktop/downloads/abrir-pasta";
pub const PEDIDO_DL_MOSTRAR: &str = "/__desktop/downloads/mostrar";
/// Endereço que a página do Ergon usa para pedir a volta a uma versão anterior ("?versao=X"; nunca chega ao servidor).
pub const PEDIDO_VOLTAR: &str = "/__desktop/voltar";
/// rc.42: o seletor de pastas do computador (Conexões › Pastas do computador)
pub const PEDIDO_PASTA_ESCOLHER: &str = "/__desktop/pastas/escolher";

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
/// atualizações leva à tela dele). "fechar=1" (rc.40): fechar a janela pergunta à página antes (fechar.rs). "pastas=1" (rc.42): o seletor de pastas do computador. "downloads=1": este aplicativo atende os pedidos de downloads (rc.33: a pasta do
/// Ergon e o aviso com "Abrir pasta"); sem ele (aplicativo de antes), a página não os faz. "volta=1": voltar de versão pelo aplicativo vale aqui (Windows com o ambiente
/// próprio, como em atualizacao.rs); sem ele (Linux, ou Windows sem o ambiente), a página mostra só a página de cada
/// versão.
pub fn endereco_do_ergon(porta: u16, volta: bool) -> String {
    format!("http://localhost:{porta}/?app=desktop&downloads=1&fechar=1&pastas=1{}", if volta { "&volta=1" } else { "" })
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
        assert_eq!(endereco_do_ergon(8787, true), "http://localhost:8787/?app=desktop&downloads=1&fechar=1&pastas=1&volta=1");
        assert_eq!(endereco_do_ergon(8787, false), "http://localhost:8787/?app=desktop&downloads=1&fechar=1&pastas=1", "Linux ou sem o ambiente: sem o botão");
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
    fn pedidos_de_downloads_ficam_no_aplicativo() {
        for u in ["/__desktop/downloads/pasta", "/__desktop/downloads/escolher", "/__desktop/downloads/abrir-pasta?id=0"] {
            let url = Url::parse(&format!("http://localhost:8787{u}")).unwrap();
            assert_eq!(destino(&url, 8787), Destino::Ergon);
            assert!(url.path().starts_with(PREFIXO_DOWNLOADS), "{u}");
        }
    }

    #[test]
    fn pasta_de_downloads_so_absoluta_e_existente() {
        let pasta = std::env::temp_dir().join(format!("ergon-desktop-pasta-{}", std::process::id()));
        std::fs::create_dir_all(&pasta).unwrap();
        assert_eq!(pasta_valida(&pasta.to_string_lossy()), Some(pasta.clone()));
        assert_eq!(pasta_valida(""), None);
        assert_eq!(pasta_valida("relativa/pasta"), None);
        assert_eq!(pasta_valida(&pasta.join("nao-existe").to_string_lossy()), None);
        let arquivo = pasta.join("a.txt");
        std::fs::write(&arquivo, "x").unwrap();
        assert_eq!(pasta_valida(&arquivo.to_string_lossy()), None, "arquivo não é pasta");
        std::fs::remove_dir_all(&pasta).ok();
    }

    #[test]
    fn aviso_para_a_pagina_nao_quebra_o_script() {
        let s = json_para_script(&serde_json::json!({ "nome": "a\"</script><b>\u{2028}.txt" }));
        assert!(!s.contains('<') && !s.contains('\u{2028}'), "{s}");
        assert_eq!(serde_json::from_str::<serde_json::Value>(&s).unwrap()["nome"], "a\"</script><b>\u{2028}.txt");
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
