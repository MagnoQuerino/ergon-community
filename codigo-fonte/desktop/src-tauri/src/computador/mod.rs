//! Controle do computador (rc.42): o agente do Ergon usa a área de trabalho desta pessoa — vê a tela, move o mouse,
//! clica, digita, abre programas.
//!
//! O motor de IA roda num contêiner, sem tela. Quem mexe no computador é este aplicativo, no próprio computador: ele
//! abre um WebSocket para o Ergon local (127.0.0.1, a mesma sessão e a mesma origem da janela do Ergon; nenhuma porta é
//! aberta aqui) e executa as ações que o Ergon manda — o Ergon já decidiu (ligado? bloqueado? protegida?), perguntou à
//! pessoa quando era o caso e registrou (server/src/services/computador.ts).
//!
//! Enquanto um agente usa o computador: uma borda acesa nas beiradas da tela e um selo "usando este computador" com
//! "Assumir o controle" (sempre no topo, sem roubar o foco); mexer o mouse de verdade ou a tecla de pânico
//! (Ctrl+Alt+Esc) também assumem. Com a pessoa no controle, nada do agente chega ao sistema até ela conceder.

pub mod captura;
pub mod driver;
pub mod ponte;
pub mod protocolo;
mod tela;

use ponte::{Compartilhado, Ligacao};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

pub const SO: &str = if cfg!(target_os = "macos") {
    "macos"
} else if cfg!(target_os = "windows") {
    "windows"
} else {
    "linux"
};

pub struct EstadoComputador {
    pub c: Arc<Compartilhado>,
}

/// O cabeçalho Cookie da sessão da pessoa na janela do Ergon (o WebView guarda; inclusive o HttpOnly).
fn cookie_da_janela(app: &AppHandle, porta: u16) -> Option<String> {
    let w = app.get_webview_window(crate::janela::PRINCIPAL)?;
    let mut partes = Vec::new();
    for host in ["localhost", "127.0.0.1"] {
        let url = tauri::Url::parse(&format!("http://{host}:{porta}/")).ok()?;
        for c in w.cookies_for_url(url).unwrap_or_default() {
            let p = format!("{}={}", c.name(), c.value());
            if !partes.contains(&p) {
                partes.push(p);
            }
        }
    }
    (!partes.is_empty()).then(|| partes.join("; "))
}

/// Liga a ponte e o vigia do mouse; a borda, o selo e a tecla de pânico seguem o estado.
pub fn iniciar(app: &AppHandle) {
    let c = Arc::new(Compartilhado::default());
    app.manage(EstadoComputador { c: c.clone() });
    let porta = app.state::<crate::Estado>().porta.load(Ordering::SeqCst);
    let parar = Arc::new(AtomicBool::new(false));
    {
        let a = app.clone();
        let c2 = c.clone();
        c.ao_mudar(Box::new(move || {
            let (a2, c3) = (a.clone(), c2.clone());
            let _ = a.run_on_main_thread(move || tela::atualizar(&a2, &c3));
        }));
    }
    let a = app.clone();
    let (c2, p2) = (c.clone(), parar.clone());
    std::thread::spawn(move || {
        let lig = Ligacao { porta, origem: format!("http://localhost:{porta}"), cookie: Box::new(move || cookie_da_janela(&a, porta)) };
        ponte::rodar(lig, Box::new(driver::Nativo::novo()), c2, p2);
    });
    let (c3, p3) = (c.clone(), parar);
    std::thread::spawn(move || {
        let mut d = driver::Nativo::novo();
        ponte::vigiar(&mut || driver::Driver::posicao(&mut d).ok(), &c3, &p3);
    });
}

/// Sem janela (testes e suporte, só com uma instância de teste em ERGON_DESKTOP_URL): a ponte e o vigia, com o cookie de
/// ERGON_COMPUTADOR_COOKIE. É o que o teste sob Xvfb usa para conferir o mouse e o teclado de verdade.
pub fn sem_janela() -> i32 {
    let inst = crate::instalacao::localizar();
    let cookie = std::env::var("ERGON_COMPUTADOR_COOKIE").unwrap_or_default();
    if !inst.teste || cookie.is_empty() {
        eprintln!("ERRO só com ERGON_DESKTOP_URL=http://127.0.0.1:<porta> e ERGON_COMPUTADOR_COOKIE");
        return 1;
    }
    let c = Arc::new(Compartilhado::default());
    let c2 = c.clone();
    c.ao_mudar(Box::new(move || {
        println!(
            "ESTADO ligado={} em_uso={} pausado={} agente={}",
            c2.ligado.load(Ordering::SeqCst),
            c2.em_uso.load(Ordering::SeqCst),
            c2.pausado.load(Ordering::SeqCst),
            c2.agente.lock().map(|a| a.clone().unwrap_or_default()).unwrap_or_default()
        );
    }));
    let parar = Arc::new(AtomicBool::new(false));
    let (c3, p3) = (c.clone(), parar.clone());
    std::thread::spawn(move || {
        let mut d = driver::Nativo::novo();
        ponte::vigiar(&mut || driver::Driver::posicao(&mut d).ok(), &c3, &p3);
    });
    let porta = inst.porta;
    let lig = Ligacao { porta, origem: format!("http://localhost:{porta}"), cookie: Box::new(move || Some(cookie.clone())) };
    ponte::rodar(lig, Box::new(driver::Nativo::novo()), c, parar);
    0
}

/// "Assumir o controle" (o selo da área de trabalho)
#[tauri::command]
pub fn computador_assumir(estado: tauri::State<'_, EstadoComputador>) {
    estado.c.assumir("botao");
}

/// "Conceder o controle"
#[tauri::command]
pub fn computador_conceder(estado: tauri::State<'_, EstadoComputador>) {
    estado.c.conceder();
}

/// O que o selo mostra (ao abrir; depois, pelo evento "computador")
#[tauri::command]
pub fn computador_estado(estado: tauri::State<'_, EstadoComputador>) -> serde_json::Value {
    tela::estado(&estado.c)
}
