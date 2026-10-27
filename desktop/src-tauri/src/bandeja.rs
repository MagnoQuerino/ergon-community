//! Bandeja do sistema (quando o ambiente oferece): estado do Ergon e atalhos. "Sair" fecha só o aplicativo;
//! "Parar serviços do Ergon" é o único caminho que desliga os agentes, e pede confirmação.

use crate::diag::Diagnostico;
use crate::{janela, servicos};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

struct Itens {
    estado: MenuItem<Wry>,
}

pub fn criar(app: &AppHandle) -> tauri::Result<()> {
    let estado = MenuItem::with_id(app, "estado", "Estado: verificando…", false, None::<&str>)?;
    let abrir = MenuItem::with_id(app, "abrir", "Abrir Ergon", true, None::<&str>)?;
    let iniciar = MenuItem::with_id(app, "iniciar", "Iniciar Ergon", true, None::<&str>)?;
    let parar = MenuItem::with_id(app, "parar", "Parar serviços do Ergon…", true, None::<&str>)?;
    let navegador = MenuItem::with_id(app, "navegador", "Abrir no navegador", true, None::<&str>)?;
    let sair = MenuItem::with_id(app, "sair", "Sair do aplicativo", true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[
            &abrir,
            &estado,
            &PredefinedMenuItem::separator(app)?,
            &iniciar,
            &parar,
            &PredefinedMenuItem::separator(app)?,
            &navegador,
            &PredefinedMenuItem::separator(app)?,
            &sair,
        ],
    )?;
    let icone = app.default_window_icon().cloned().ok_or(tauri::Error::InvalidIcon(std::io::Error::other("sem ícone")))?;
    TrayIconBuilder::with_id("ergon")
        .icon(icone)
        .tooltip("Ergon")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "abrir" => janela::mostrar(app),
            "iniciar" => janela::voltar_abertura(app, true),
            "parar" => confirmar_parar(app.clone()),
            "navegador" => {
                let porta = app.state::<crate::Estado>().porta.load(std::sync::atomic::Ordering::SeqCst);
                let _ = tauri_plugin_opener::open_url(format!("http://localhost:{porta}/"), None::<&str>);
            }
            "sair" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                janela::mostrar(tray.app_handle());
            }
        })
        .build(app)?;
    app.manage(Itens { estado });
    Ok(())
}

fn confirmar_parar(app: AppHandle) {
    std::thread::spawn(move || {
        let sim = app
            .dialog()
            .message("Os agentes e as rotinas param até você iniciar o Ergon de novo. Os dados ficam como estão, e o Docker continua aberto.")
            .title("Parar os serviços do Ergon?")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Parar o Ergon".into(), "Cancelar".into()))
            .blocking_show();
        if !sim {
            return;
        }
        if let Err(e) = servicos::parar_servicos(&app) {
            app.dialog().message(e).title("Não foi possível parar o Ergon").kind(MessageDialogKind::Error).blocking_show();
        }
        janela::voltar_abertura(&app, false);
    });
}

/// Mostra o último diagnóstico no menu da bandeja.
pub fn atualizar(app: &AppHandle, d: &Diagnostico) {
    if let Some(i) = app.try_state::<Itens>() {
        let _ = i.estado.set_text(format!("Estado: {}", d.titulo));
    }
}
