//! A ligação com o Ergon local: um WebSocket que ESTE aplicativo abre para 127.0.0.1 (nenhuma porta é aberta no
//! computador), com a sessão da pessoa (o cookie da janela do Ergon) e a origem do Ergon, como a tela faria. O Ergon
//! manda cada ação já decidida e registrada; daqui volta o resultado. Cai, volta sozinha.

use super::driver::{self, Driver};
use super::protocolo::{self, DoErgon};
use serde_json::json;
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tungstenite::client::IntoClientRequest;
use tungstenite::Message;

pub const CAMINHO: &str = "/api/computador/aparelho";
const PERMISSOES_A_CADA: Duration = Duration::from_secs(5);

/// O que a ligação, o selo da tela, a tecla de pânico e o vigia do mouse dividem.
pub struct Compartilhado {
    /// a pessoa está com o controle: nenhuma ação do agente chega ao sistema
    pub pausado: AtomicBool,
    /// um agente usou o computador há pouco (o Ergon diz): a borda e o selo acendem
    pub em_uso: AtomicBool,
    pub ligado: AtomicBool,
    pub agente: Mutex<Option<String>>,
    saida: Mutex<Option<Sender<String>>>,
    ao_mudar: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
    /// onde o agente deixou o mouse, e quando
    pub do_agente: Mutex<(Option<(i32, i32)>, Instant)>,
}

impl Default for Compartilhado {
    fn default() -> Self {
        Compartilhado {
            pausado: AtomicBool::new(false),
            em_uso: AtomicBool::new(false),
            ligado: AtomicBool::new(false),
            agente: Mutex::new(None),
            saida: Mutex::new(None),
            ao_mudar: Mutex::new(None),
            do_agente: Mutex::new((None, Instant::now())),
        }
    }
}

impl Compartilhado {
    pub fn ao_mudar(&self, f: Box<dyn Fn() + Send + Sync>) {
        *self.ao_mudar.lock().unwrap_or_else(|e| e.into_inner()) = Some(f);
    }
    fn mudou(&self) {
        if let Some(f) = self.ao_mudar.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            f();
        }
    }
    fn mandar(&self, m: String) {
        if let Some(tx) = self.saida.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            let _ = tx.send(m);
        }
    }
    /// "Assumir o controle": para na hora aqui (sem esperar o Ergon) e avisa o Ergon.
    pub fn assumir(&self, motivo: &str) {
        let antes = self.pausado.swap(true, Ordering::SeqCst);
        self.mandar(protocolo::assumir(motivo));
        if !antes {
            log::info!("computador: a pessoa assumiu o controle ({motivo})");
        }
        self.mudou();
    }
    /// "Conceder o controle": o Ergon confirma e o agente segue.
    pub fn conceder(&self) {
        self.pausado.store(false, Ordering::SeqCst);
        *self.do_agente.lock().unwrap_or_else(|e| e.into_inner()) = (None, Instant::now());
        self.mandar(protocolo::conceder());
        log::info!("computador: a pessoa concedeu o controle");
        self.mudou();
    }
}

pub struct Ligacao {
    pub porta: u16,
    /// "http://localhost:<porta>": a origem que o Ergon aceita
    pub origem: String,
    /// o cabeçalho Cookie da sessão da pessoa, lido da janela do Ergon na hora de ligar
    pub cookie: Box<dyn Fn() -> Option<String> + Send>,
}

/// Liga e mantém ligado até `parar`. Sem sessão (a pessoa ainda não entrou): tenta de novo em instantes.
pub fn rodar(lig: Ligacao, mut d: Box<dyn Driver>, c: Arc<Compartilhado>, parar: Arc<AtomicBool>) {
    let mut espera = Duration::from_secs(2);
    while !parar.load(Ordering::SeqCst) {
        if let Some(cookie) = (lig.cookie)() {
            match sessao(&lig, &cookie, d.as_mut(), &c, &parar) {
                Ok(()) => espera = Duration::from_secs(2),
                Err(e) => {
                    log::debug!("computador: sem ligação com o Ergon ({e})");
                    espera = (espera * 2).min(Duration::from_secs(20));
                }
            }
            c.ligado.store(false, Ordering::SeqCst);
            c.em_uso.store(false, Ordering::SeqCst);
            *c.saida.lock().unwrap_or_else(|e| e.into_inner()) = None;
            c.mudou();
        }
        let fim = Instant::now() + espera;
        while Instant::now() < fim && !parar.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// Uma ligação, do começo ao fim.
pub fn sessao(lig: &Ligacao, cookie: &str, d: &mut dyn Driver, c: &Compartilhado, parar: &AtomicBool) -> Result<(), String> {
    let tcp = TcpStream::connect_timeout(&SocketAddr::from((Ipv4Addr::LOCALHOST, lig.porta)), Duration::from_secs(3)).map_err(|e| e.to_string())?;
    let mut pedido = format!("ws://127.0.0.1:{}{CAMINHO}", lig.porta).into_client_request().map_err(|e| e.to_string())?;
    let h = pedido.headers_mut();
    h.insert("Origin", lig.origem.parse().map_err(|_| "origem inválida")?);
    h.insert("Cookie", cookie.parse().map_err(|_| "cookie inválido")?);
    h.insert("User-Agent", format!("ErgonDesktop/{}", env!("CARGO_PKG_VERSION")).parse().map_err(|_| "agente inválido")?);
    let (mut ws, _) = tungstenite::client::client(pedido, tcp).map_err(|e| format!("o Ergon recusou a ligação ({e})"))?;
    ws.get_mut().set_read_timeout(Some(Duration::from_millis(120))).map_err(|e| e.to_string())?;
    let mut perm = d.permissoes();
    let tela = d.tela().unwrap_or((0, 0));
    ws.send(Message::text(protocolo::ola(super::SO, &perm, tela))).map_err(|e| e.to_string())?;
    let (tx, rx) = channel::<String>();
    *c.saida.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    c.ligado.store(true, Ordering::SeqCst);
    c.mudou();
    log::info!("computador: ligado ao Ergon");
    let mut conferiu = Instant::now();
    loop {
        if parar.load(Ordering::SeqCst) {
            let _ = ws.close(None);
            return Ok(());
        }
        match ws.read() {
            Ok(Message::Text(t)) => {
                if let Some(m) = protocolo::do_ergon(t.as_str()) {
                    if let Some(r) = tratar(m, d, c) {
                        ws.send(Message::text(r)).map_err(|e| e.to_string())?;
                    }
                }
            }
            Ok(Message::Close(_)) => return Ok(()),
            Ok(_) => {}
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => {}
            Err(tungstenite::Error::ConnectionClosed) | Err(tungstenite::Error::AlreadyClosed) => return Ok(()),
            Err(e) => return Err(e.to_string()),
        }
        while let Ok(m) = rx.try_recv() {
            ws.send(Message::text(m)).map_err(|e| e.to_string())?;
        }
        // a pessoa liberou (ou tirou) a permissão do sistema: o Ergon fica sabendo sem precisar religar
        if conferiu.elapsed() > PERMISSOES_A_CADA {
            conferiu = Instant::now();
            let agora = d.permissoes();
            if agora != perm {
                perm = agora;
                let mut v: serde_json::Value = serde_json::from_str(&protocolo::ola(super::SO, &perm, tela)).unwrap_or_default();
                v["t"] = json!("permissoes");
                ws.send(Message::text(v.to_string())).map_err(|e| e.to_string())?;
            }
        }
    }
}

/// Uma mensagem do Ergon; devolve a resposta a mandar, se houver.
pub fn tratar(m: DoErgon, d: &mut dyn Driver, c: &Compartilhado) -> Option<String> {
    match m {
        DoErgon::Estado { em_uso, agente, pessoa } => {
            c.em_uso.store(em_uso, Ordering::SeqCst);
            *c.agente.lock().unwrap_or_else(|e| e.into_inner()) = agente;
            // a pessoa concedeu (por aqui ou pela tela do Ergon): o mouse está onde ela deixou, não onde o agente deixou
            if c.pausado.swap(pessoa, Ordering::SeqCst) && !pessoa {
                *c.do_agente.lock().unwrap_or_else(|e| e.into_inner()) = (None, Instant::now());
            }
            c.mudou();
            None
        }
        DoErgon::Parar => {
            c.pausado.store(true, Ordering::SeqCst);
            c.mudou();
            None
        }
        DoErgon::Acao { id, nome, args } => {
            // a pessoa assumiu (o selo, a tecla de pânico, o mouse): nada chega ao sistema, mesmo antes de o Ergon saber
            if c.pausado.load(Ordering::SeqCst) {
                return Some(protocolo::resposta(&id, json!({ "ok": false, "code": "human_has_control", "error": "A pessoa assumiu o controle do computador." })));
            }
            let r = match protocolo::acao(&nome, &args) {
                Ok(a) => {
                    let mut ultimo = None;
                    let r = driver::executar(d, a, &mut ultimo);
                    if ultimo.is_some() {
                        *c.do_agente.lock().unwrap_or_else(|e| e.into_inner()) = (ultimo, Instant::now());
                    }
                    if !c.em_uso.swap(true, Ordering::SeqCst) {
                        c.mudou();
                    }
                    r
                }
                Err(e) => json!({ "ok": false, "code": "invalid", "error": e }),
            };
            Some(protocolo::resposta(&id, r))
        }
    }
}

/// O vigia do mouse: com o agente usando o computador, mexer o mouse de verdade assume o controle.
pub fn vigiar(posicao: &mut dyn FnMut() -> Option<(i32, i32)>, c: &Compartilhado, parar: &AtomicBool) {
    while !parar.load(Ordering::SeqCst) {
        std::thread::sleep(Duration::from_millis(150));
        if !c.em_uso.load(Ordering::SeqCst) || c.pausado.load(Ordering::SeqCst) {
            continue;
        }
        let (onde, quando) = *c.do_agente.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(agora) = posicao() {
            if protocolo::pessoa_mexeu(onde, agora, quando.elapsed().as_millis()) {
                c.assumir("mouse");
            }
        }
    }
}

#[cfg(test)]
mod testes {
    use super::*;
    use crate::computador::driver::testes::Falso;
    use std::net::TcpListener;
    use tungstenite::handshake::server::{Request, Response};

    /// Um Ergon falso: confere a origem e o cookie como o de verdade, manda o roteiro e guarda o que voltou.
    fn ergon_falso(roteiro: Vec<String>) -> (u16, std::thread::JoinHandle<(Vec<String>, Option<String>, Option<String>)>) {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let porta = l.local_addr().unwrap().port();
        let h = std::thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut origem = None;
            let mut cookie = None;
            let mut ws = tungstenite::accept_hdr(s, |r: &Request, resp: Response| {
                origem = r.headers().get("origin").map(|v| v.to_str().unwrap().to_string());
                cookie = r.headers().get("cookie").map(|v| v.to_str().unwrap().to_string());
                Ok(resp)
            })
            .unwrap();
            let mut recebidas = vec![ws.read().unwrap().to_text().unwrap().to_string()];
            for m in roteiro {
                let espera = m.contains("\"acao\"");
                ws.send(Message::text(m)).unwrap();
                if espera {
                    recebidas.push(ws.read().unwrap().to_text().unwrap().to_string());
                }
            }
            std::thread::sleep(Duration::from_millis(300));
            let _ = ws.close(None);
            let _ = ws.flush();
            (recebidas, origem, cookie)
        });
        (porta, h)
    }

    #[test]
    fn liga_com_a_sessao_faz_a_acao_e_para_quando_a_pessoa_assume() {
        let (porta, h) = ergon_falso(vec![
            r#"{"t":"ola","emUso":false,"agente":null,"controle":"agente"}"#.into(),
            r#"{"t":"acao","id":"a1","acao":"click","args":{"coordinate":[640,360]}}"#.into(),
            r#"{"t":"estado","emUso":true,"agente":"Hipátia","controle":"pessoa"}"#.into(),
            r#"{"t":"acao","id":"a2","acao":"type","args":{"text":"não deve chegar"}}"#.into(),
            r#"{"t":"estado","emUso":true,"agente":"Hipátia","controle":"agente"}"#.into(),
            r#"{"t":"acao","id":"a3","acao":"explodir","args":{}}"#.into(),
        ]);
        let lig = Ligacao { porta, origem: format!("http://localhost:{porta}"), cookie: Box::new(|| Some("ergon_session=abc".into())) };
        let mut d = Falso::default();
        let c = Compartilhado::default();
        let parar = AtomicBool::new(false);
        sessao(&lig, "ergon_session=abc", &mut d, &c, &parar).unwrap();
        let (recebidas, origem, cookie) = h.join().unwrap();
        assert_eq!(origem.as_deref(), Some(format!("http://localhost:{porta}").as_str()));
        assert_eq!(cookie.as_deref(), Some("ergon_session=abc"));
        let ola: serde_json::Value = serde_json::from_str(&recebidas[0]).unwrap();
        assert_eq!(ola["t"], "ola");
        assert_eq!(ola["tela"]["largura"], 1920);
        let r1: serde_json::Value = serde_json::from_str(&recebidas[1]).unwrap();
        assert_eq!((r1["id"].as_str(), r1["r"]["ok"].as_bool()), (Some("a1"), Some(true)));
        let r2: serde_json::Value = serde_json::from_str(&recebidas[2]).unwrap();
        assert_eq!(r2["r"]["code"], "human_has_control");
        let r3: serde_json::Value = serde_json::from_str(&recebidas[3]).unwrap();
        assert_eq!(r3["r"]["code"], "invalid");
        assert_eq!(d.feito, vec!["mover 960,540", "botao Esquerdo None"], "o texto não chegou ao teclado");
        assert_eq!(c.agente.lock().unwrap().as_deref(), Some("Hipátia"));
    }

    #[test]
    fn assumir_avisa_o_ergon_e_para_na_hora() {
        let c = Compartilhado::default();
        let (tx, rx) = channel();
        *c.saida.lock().unwrap() = Some(tx);
        c.assumir("panico");
        assert!(c.pausado.load(Ordering::SeqCst));
        assert_eq!(rx.try_recv().unwrap(), r#"{"motivo":"panico","t":"assumir"}"#);
        let mut d = Falso::default();
        let r = tratar(DoErgon::Acao { id: "x".into(), nome: "click".into(), args: json!({"coordinate": [1, 1]}) }, &mut d, &c).unwrap();
        assert!(r.contains("human_has_control") && d.feito.is_empty());
        // concedido pela tela do Ergon: o vigia não toma de volta pelo mouse que ficou onde a pessoa deixou
        *c.do_agente.lock().unwrap() = (Some((5, 5)), Instant::now() - Duration::from_secs(5));
        tratar(DoErgon::Estado { em_uso: true, agente: None, pessoa: false }, &mut d, &c);
        assert_eq!(c.do_agente.lock().unwrap().0, None);
        c.pausado.store(true, Ordering::SeqCst);
        c.conceder();
        assert!(!c.pausado.load(Ordering::SeqCst));
        assert_eq!(rx.try_recv().unwrap(), r#"{"t":"conceder"}"#);
    }

    #[test]
    fn mexer_o_mouse_assume() {
        let c = Arc::new(Compartilhado::default());
        c.em_uso.store(true, Ordering::SeqCst);
        *c.do_agente.lock().unwrap() = (Some((100, 100)), Instant::now() - Duration::from_secs(2));
        let parar = Arc::new(AtomicBool::new(false));
        let (c2, p2) = (c.clone(), parar.clone());
        let t = std::thread::spawn(move || vigiar(&mut || Some((400, 300)), &c2, &p2));
        let fim = Instant::now() + Duration::from_secs(2);
        while !c.pausado.load(Ordering::SeqCst) && Instant::now() < fim {
            std::thread::sleep(Duration::from_millis(20));
        }
        parar.store(true, Ordering::SeqCst);
        t.join().unwrap();
        assert!(c.pausado.load(Ordering::SeqCst));
    }

    #[test]
    fn sem_ergon_nao_trava() {
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let porta = l.local_addr().unwrap().port();
        drop(l);
        let lig = Ligacao { porta, origem: "http://localhost:1".into(), cookie: Box::new(|| None) };
        let mut d = Falso::default();
        assert!(sessao(&lig, "x=y", &mut d, &Compartilhado::default(), &AtomicBool::new(false)).is_err());
    }
}
