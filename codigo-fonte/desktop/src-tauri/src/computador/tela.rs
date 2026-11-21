//! A borda acesa e o selo "usando este computador": janelas do próprio aplicativo, sempre no topo, que não roubam o
//! foco e não entram nas capturas (onde o sistema deixa: macOS e Windows). A borda são quatro faixas finas nas
//! beiradas da tela (não uma janela transparente por cima de tudo: sem compositor, no Linux, ela ficaria opaca), que
//! deixam o clique passar. O selo tem "Assumir o controle" / "Conceder o controle". A tecla de pânico (Ctrl+Alt+Esc)
//! só fica registrada enquanto o agente usa o computador.

use super::ponte::Compartilhado;
use serde_json::json;
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

pub const SELO: &str = "computador-selo";
const BORDAS: [&str; 4] = ["computador-borda-cima", "computador-borda-baixo", "computador-borda-esquerda", "computador-borda-direita"];
const ESPESSURA: f64 = 4.0;
const SELO_TAM: (f64, f64) = (380.0, 60.0);
pub const PANICO: &str = "Ctrl+Alt+Escape";

pub fn estado(c: &Compartilhado) -> serde_json::Value {
    json!({
        "ligado": c.ligado.load(Ordering::SeqCst),
        "emUso": c.em_uso.load(Ordering::SeqCst),
        "pausado": c.pausado.load(Ordering::SeqCst),
        "agente": c.agente.lock().map(|a| a.clone()).unwrap_or(None),
        "panico": if cfg!(target_os = "macos") { "Ctrl+Option+Esc" } else { "Ctrl+Alt+Esc" },
    })
}

fn janela(app: &AppHandle, rotulo: &str, pagina: &str, pos: (f64, f64), tam: (f64, f64)) -> Option<tauri::WebviewWindow> {
    if let Some(w) = app.get_webview_window(rotulo) {
        let _ = w.set_position(LogicalPosition::new(pos.0, pos.1));
        let _ = w.set_size(LogicalSize::new(tam.0, tam.1));
        return Some(w);
    }
    let w = WebviewWindowBuilder::new(app, rotulo, WebviewUrl::App(pagina.into()))
        .title("Ergon")
        .decorations(false)
        .resizable(false)
        .always_on_top(true)
        .visible_on_all_workspaces(true)
        .skip_taskbar(true)
        .shadow(false)
        .focused(false)
        .focusable(false)
        .content_protected(true)
        .visible(false)
        .position(pos.0, pos.1)
        .inner_size(tam.0, tam.1)
        .build();
    match w {
        Ok(w) => Some(w),
        Err(e) => {
            log::warn!("computador: não abriu {rotulo} ({e})");
            None
        }
    }
}

/// Mostra ou esconde a borda e o selo conforme o estado (na linha principal do aplicativo).
pub fn atualizar(app: &AppHandle, c: &Compartilhado) {
    let ligado = c.ligado.load(Ordering::SeqCst);
    let em_uso = ligado && c.em_uso.load(Ordering::SeqCst);
    let pausado = ligado && c.pausado.load(Ordering::SeqCst);
    let monitor = app.primary_monitor().ok().flatten();
    let (mx, my, mw, mh) = monitor
        .map(|m| {
            let f = m.scale_factor();
            let p = m.position().to_logical::<f64>(f);
            let s = m.size().to_logical::<f64>(f);
            (p.x, p.y, s.width, s.height)
        })
        .unwrap_or((0.0, 0.0, 1280.0, 800.0));
    let faixas = [((mx, my), (mw, ESPESSURA)), ((mx, my + mh - ESPESSURA), (mw, ESPESSURA)), ((mx, my), (ESPESSURA, mh)), ((mx + mw - ESPESSURA, my), (ESPESSURA, mh))];
    // a borda acesa: só com o agente no controle
    for (i, rotulo) in BORDAS.iter().enumerate() {
        if em_uso && !pausado {
            if let Some(w) = janela(app, rotulo, "computador-borda.html", faixas[i].0, faixas[i].1) {
                let _ = w.set_ignore_cursor_events(true);
                let _ = w.show();
            }
        } else if let Some(w) = app.get_webview_window(rotulo) {
            let _ = w.hide();
        }
    }
    // o selo: com o agente usando ou com a pessoa no controle (para conceder de volta)
    if em_uso || pausado {
        let pos = (mx + (mw - SELO_TAM.0) / 2.0, my + mh - SELO_TAM.1 - 40.0);
        if let Some(w) = janela(app, SELO, "computador-selo.html", pos, SELO_TAM) {
            let _ = w.show();
        }
    } else if let Some(w) = app.get_webview_window(SELO) {
        let _ = w.hide();
    }
    let _ = app.emit_to(SELO, "computador", estado(c));
    // a tecla de pânico: registrada só enquanto o agente usa o computador (não prende a combinação o tempo todo)
    let gs = app.global_shortcut();
    let registrada = gs.is_registered(PANICO);
    if em_uso && !pausado && !registrada {
        let c2 = app.state::<super::EstadoComputador>().c.clone();
        if let Err(e) = gs.on_shortcut(PANICO, move |_a, _s, ev| {
            if ev.state == ShortcutState::Pressed {
                c2.assumir("panico");
            }
        }) {
            log::warn!("computador: tecla de pânico indisponível ({e})");
        }
    } else if !(em_uso && !pausado) && registrada {
        let _ = gs.unregister(PANICO);
    }
}
