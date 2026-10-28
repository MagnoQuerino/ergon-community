// Ergon Desktop: a mesma interface do Ergon (servida pelo Ergon local, em http://localhost:8787) numa janela
// própria, com uma tela de abertura que confere os serviços e os liga quando você pede. Nada da interface é
// duplicado aqui; esta camada só conhece a saúde do Ergon, o Docker e os lançadores (ergon.ps1 / ergon.sh).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ambiente;
mod baixar;
mod bandeja;
mod confianca;
mod diag;
mod docker;
mod http;
mod instalacao;
mod janela;
mod processo;
mod registro;
mod servicos;

use std::sync::atomic::{AtomicBool, AtomicU16};
use std::sync::Mutex;
use tauri::Manager;

/// Estado compartilhado entre a janela, a bandeja e os comandos.
pub struct Estado {
    /// último diagnóstico: só um diagnóstico com a identidade confirmada libera abrir o Ergon na janela
    pub ultimo: Mutex<Option<diag::Diagnostico>>,
    /// porta do Ergon que a janela pode carregar (a política de navegação lê daqui)
    pub porta: AtomicU16,
    /// um "subir" por vez
    pub subindo: AtomicBool,
}

fn main() {
    registro::iniciar();
    // sem janela: a mesma instalação, com as etapas no terminal (testes e suporte). Código de saída: 0 pronto,
    // 3 precisa reiniciar o Windows, 1 erro.
    if std::env::args().any(|a| a == "--instalar-sem-janela") {
        std::process::exit(instalar_sem_janela());
    }
    let estado = Estado { ultimo: Mutex::new(None), porta: AtomicU16::new(instalacao::localizar().porta), subindo: AtomicBool::new(false) };
    tauri::Builder::default()
        // abrir de novo (menu, atalho) traz a janela que já está aberta, em vez de uma segunda cópia
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| janela::mostrar(app)))
        // tamanho, posição e "maximizada" voltam como estavam (o plugin confere se o monitor ainda existe)
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(tauri_plugin_window_state::StateFlags::all() & !tauri_plugin_window_state::StateFlags::VISIBLE)
                .build(),
        )
        // sem o script do plugin que intercepta cliques em links "_blank": ele abriria pelo IPC, que a página do Ergon não
        // tem (permissões só para a tela de abertura), e o link morria. O pedido de janela nova segue o caminho nativo e
        // passa pela política (janela::nova_janela): web no navegador do sistema, o resto recusado.
        .plugin(tauri_plugin_opener::Builder::default().open_js_links_on_click(false).build())
        .plugin(tauri_plugin_dialog::init())
        .manage(estado)
        .invoke_handler(tauri::generate_handler![
            diag::diagnosticar,
            servicos::subir_servicos,
            servicos::abrir_ergon,
            servicos::abrir_no_navegador,
            servicos::abrir_ajuda,
            servicos::abrir_registros,
            servicos::instalar_ergon,
        ])
        .setup(|app| {
            if let Ok(pasta) = app.path().app_log_dir() {
                registro::gravar_em(&pasta);
            }
            janela::criar_principal(app.handle())?;
            // bandeja é um extra: sem suporte (alguns ambientes Linux), a janela funciona igual
            if let Err(e) = bandeja::criar(app.handle()) {
                log::warn!("bandeja do sistema indisponível: {e}");
            }
            log::info!("Ergon Desktop {} iniciado", env!("CARGO_PKG_VERSION"));
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("falha ao iniciar o Ergon Desktop");
}

fn instalar_sem_janela() -> i32 {
    let mut ev = |e: ambiente::Evento| match e {
        ambiente::Evento::Etapa(id) => println!("ETAPA {id}"),
        ambiente::Evento::Linha(l) => println!("      {l}"),
        ambiente::Evento::Progresso { componente, feitos, total } => {
            if feitos == total || feitos % (16 << 20) < (1 << 16) {
                println!("BAIXANDO {componente} {feitos}/{total}");
            }
        }
    };
    match ambiente::instalar(&mut ev) {
        Ok(ambiente::Fim::Pronto { versao }) => {
            println!("PRONTO {versao}");
            0
        }
        Ok(ambiente::Fim::Reiniciar) => {
            println!("REINICIAR");
            3
        }
        Err(e) => {
            println!("ERRO {e}");
            1
        }
    }
}
