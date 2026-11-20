//! Fechar a janela (rc.40). Com a página do Ergon aberta, o aplicativo não fecha direto: pergunta à página
//! (`window.__ergonFechar()`, em web/src/lib/fechar.ts), que pode segurar o fechamento enquanto a sincronia com o Ergon
//! World está mexendo em dados. A página responde por endereços que nunca chegam ao servidor:
//! - "espera": mostrou o aviso (a pessoa decide; o aplicativo espera sem prazo);
//! - "encerrando": a tela "Encerrando" está pondo a sincronia num ponto seguro (o aplicativo espera até 60 s);
//! - "cancelar": a pessoa ficou no Ergon;
//! - "sair": pode fechar.
//!
//! Página que não responde em 4 s (travada, ou de uma versão que não conhece o pedido e não navegou): fecha mesmo assim.
//! Fechar a janela nunca desliga os serviços do Ergon (só "Parar serviços", na bandeja).

use crate::janela::{self, Destino, PRINCIPAL};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const PREFIXO: &str = "/__desktop/fechar/";
pub const ESPERA: &str = "/__desktop/fechar/espera";
pub const ENCERRANDO: &str = "/__desktop/fechar/encerrando";
pub const CANCELAR: &str = "/__desktop/fechar/cancelar";
pub const SAIR: &str = "/__desktop/fechar/sair";

const NADA: u8 = 0;
const PERGUNTADO: u8 = 1;
const AVISO: u8 = 2;
const ENCERRANDO_: u8 = 3;

/// Sem resposta da página em tanto tempo depois de perguntar: fecha.
pub const SEM_RESPOSTA: Duration = Duration::from_secs(4);
/// A tela "Encerrando" tem até tanto para pausar a sincronia (o servidor espera o passo atual até 30 s).
pub const ENCERRANDO_NO_MAXIMO: Duration = Duration::from_secs(60);

static LIBERADO: AtomicBool = AtomicBool::new(false);
static ESTADO: AtomicU8 = AtomicU8::new(NADA);
/// Cada pedido novo invalida os prazos dos anteriores.
static RODADA: AtomicU64 = AtomicU64::new(0);

/// A página do Ergon está na janela? (Na tela de abertura, fecha direto.)
fn com_a_pagina(app: &AppHandle) -> bool {
    let porta = app.state::<crate::Estado>().porta.load(Ordering::SeqCst);
    app.get_webview_window(PRINCIPAL).and_then(|w| w.url().ok()).is_some_and(|u| janela::destino(&u, porta) == Destino::Ergon)
}

/// O script que pergunta à página (página de antes, sem a pergunta: pede para sair na hora).
pub const PERGUNTA: &str = "window.__ergonFechar ? window.__ergonFechar() : location.assign('/__desktop/fechar/sair')";

/// Pedido de fechar (o X da janela, Alt+F4, "Sair do aplicativo" na bandeja). `true`: a página foi perguntada e o
/// fechamento fica para depois da resposta; `false`: pode fechar já.
pub fn perguntar(app: &AppHandle) -> bool {
    if LIBERADO.load(Ordering::SeqCst) || !com_a_pagina(app) {
        return false;
    }
    let Some(w) = app.get_webview_window(PRINCIPAL) else { return false };
    let r = RODADA.fetch_add(1, Ordering::SeqCst) + 1;
    // com o "Encerrando" na tela, segue o prazo dele; senão (inclusive com o aviso aberto: a pessoa insistindo), a página
    // tem 4 s para responder de novo, e uma página que travou depois do aviso não prende o aplicativo
    if ESTADO.load(Ordering::SeqCst) == ENCERRANDO_ {
        prazo(app, r, ENCERRANDO_, ENCERRANDO_NO_MAXIMO);
    } else {
        ESTADO.store(PERGUNTADO, Ordering::SeqCst);
        prazo(app, r, PERGUNTADO, SEM_RESPOSTA);
    }
    if w.eval(PERGUNTA).is_err() {
        return false;
    }
    // "Sair" pela bandeja com a janela minimizada: o aviso aparece à vista
    janela::mostrar(app);
    true
}

fn prazo(app: &AppHandle, rodada: u64, estado: u8, quanto: Duration) {
    let a = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(quanto);
        if RODADA.load(Ordering::SeqCst) == rodada && ESTADO.load(Ordering::SeqCst) == estado {
            log::warn!("a página não respondeu ao fechar a tempo: fechando mesmo assim");
            sair(&a);
        }
    });
}

/// Resposta da página (endereço em PREFIXO). `true` se era um pedido de fechar.
pub fn resposta(app: &AppHandle, caminho: &str) -> bool {
    if !caminho.starts_with(PREFIXO) {
        return false;
    }
    let r = RODADA.fetch_add(1, Ordering::SeqCst) + 1;
    match caminho {
        ESPERA => ESTADO.store(AVISO, Ordering::SeqCst),
        ENCERRANDO => {
            ESTADO.store(ENCERRANDO_, Ordering::SeqCst);
            prazo(app, r, ENCERRANDO_, ENCERRANDO_NO_MAXIMO);
        }
        CANCELAR => ESTADO.store(NADA, Ordering::SeqCst),
        SAIR => {
            // só quando foi o aplicativo que perguntou: a página sozinha não fecha a janela
            if ESTADO.load(Ordering::SeqCst) != NADA {
                let a = app.clone();
                std::thread::spawn(move || sair(&a));
            }
        }
        _ => {}
    }
    true
}

/// Fecha de vez (a janela; sem ela, o aplicativo).
pub fn sair(app: &AppHandle) {
    LIBERADO.store(true, Ordering::SeqCst);
    ESTADO.store(NADA, Ordering::SeqCst);
    match app.get_webview_window(PRINCIPAL) {
        Some(w) => {
            if w.close().is_err() {
                app.exit(0);
            }
        }
        None => app.exit(0),
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn pergunta_cai_para_sair_na_pagina_de_antes() {
        assert!(PERGUNTA.contains("__ergonFechar") && PERGUNTA.contains(SAIR));
        for p in [ESPERA, ENCERRANDO, CANCELAR, SAIR] {
            assert!(p.starts_with(PREFIXO), "{p}");
        }
    }
}
