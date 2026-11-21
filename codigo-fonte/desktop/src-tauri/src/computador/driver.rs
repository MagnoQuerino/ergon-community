//! O mouse, o teclado e a tela do sistema. `Driver` separa o que é do sistema (Nativo: enigo + captura por sistema) do
//! que é regra (executar: escala, ordem das teclas, o que volta ao Ergon), para os testes rodarem sem tela.

use super::protocolo::{self, Acao, Botao, Direcao, Permissoes, Tecla};
use base64::Engine;
use serde_json::{json, Value};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Programa {
    pub nome: String,
    pub pid: Option<u32>,
    pub titulo: Option<String>,
}

pub trait Driver: Send {
    /// tamanho da tela principal, nas coordenadas do mouse
    fn tela(&mut self) -> Result<(u32, u32), String>;
    fn posicao(&mut self) -> Result<(i32, i32), String>;
    fn mover(&mut self, x: i32, y: i32) -> Result<(), String>;
    fn botao(&mut self, b: Botao, baixo: Option<bool>) -> Result<(), String>;
    fn rolar(&mut self, d: Direcao, quanto: i32) -> Result<(), String>;
    fn digitar(&mut self, texto: &str) -> Result<(), String>;
    fn tecla(&mut self, t: &Tecla, baixo: Option<bool>) -> Result<(), String>;
    /// PNG da tela principal, já reduzido a `alvo`
    fn capturar(&mut self, alvo: (u32, u32)) -> Result<Vec<u8>, String>;
    fn programas(&mut self) -> Result<Vec<Programa>, String>;
    fn janelas(&mut self) -> Result<Vec<Programa>, String>;
    /// traz para a frente ou abre
    fn abrir(&mut self, app: &str) -> Result<String, String>;
    fn permissoes(&mut self) -> Permissoes;
}

fn segurar(d: &mut dyn Driver, mods: &[Tecla], baixo: bool) -> Result<(), String> {
    if baixo {
        for m in mods {
            d.tecla(m, Some(true))?;
        }
    } else {
        for m in mods.iter().rev() {
            d.tecla(m, Some(false))?;
        }
    }
    Ok(())
}

fn erro(e: String) -> Value {
    json!({ "ok": false, "code": "falhou", "error": e })
}

/// Faz a ação e diz o que volta ao Ergon. `ultimo` recebe onde o agente deixou o mouse (para saber se a pessoa mexeu).
pub fn executar(d: &mut dyn Driver, a: Acao, ultimo: &mut Option<(i32, i32)>) -> Value {
    let tela = match d.tela() {
        Ok(t) => t,
        Err(e) => return erro(e),
    };
    let r: Result<Value, String> = (|| match a {
        Acao::Capturar => {
            let alvo = protocolo::tamanho_da_captura(tela);
            let png = d.capturar(alvo)?;
            Ok(json!({ "ok": true, "png_b64": base64::engine::general_purpose::STANDARD.encode(png), "mime": "image/png", "width": alvo.0, "height": alvo.1 }))
        }
        Acao::Clicar { em, botao, vezes, mods } => {
            let (x, y) = protocolo::para_a_tela(em, tela);
            d.mover(x, y)?;
            *ultimo = Some((x, y));
            segurar(d, &mods, true)?;
            let mut r = Ok(());
            for _ in 0..vezes {
                r = d.botao(botao, None);
                if r.is_err() {
                    break;
                }
            }
            segurar(d, &mods, false)?;
            r?;
            Ok(json!({ "ok": true, "message": format!("clicou em {}, {}", em.0, em.1) }))
        }
        Acao::Arrastar { de, para } => {
            let (x0, y0) = protocolo::para_a_tela(de, tela);
            let (x1, y1) = protocolo::para_a_tela(para, tela);
            d.mover(x0, y0)?;
            d.botao(Botao::Esquerdo, Some(true))?;
            // em passos: alguns programas só entendem arrastar com movimento no meio
            for i in 1..=8 {
                d.mover(x0 + (x1 - x0) * i / 8, y0 + (y1 - y0) * i / 8)?;
                std::thread::sleep(std::time::Duration::from_millis(12));
            }
            d.botao(Botao::Esquerdo, Some(false))?;
            *ultimo = Some((x1, y1));
            Ok(json!({ "ok": true, "message": "arrastou" }))
        }
        Acao::Rolar { direcao, quanto, em } => {
            if let Some(p) = em {
                let (x, y) = protocolo::para_a_tela(p, tela);
                d.mover(x, y)?;
                *ultimo = Some((x, y));
            }
            d.rolar(direcao, quanto)?;
            Ok(json!({ "ok": true, "message": "rolou" }))
        }
        Acao::Digitar(t) => {
            d.digitar(&t)?;
            Ok(json!({ "ok": true, "message": format!("digitou {} caracteres", t.chars().count()) }))
        }
        Acao::Teclas(ts) => {
            let (mods, resto): (Vec<Tecla>, Vec<Tecla>) = ts.into_iter().partition(Tecla::modificadora);
            segurar(d, &mods, true)?;
            let mut r = Ok(());
            for t in &resto {
                r = d.tecla(t, None);
                if r.is_err() {
                    break;
                }
            }
            // só modificadoras ("shift"): um toque
            if resto.is_empty() {
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            segurar(d, &mods, false)?;
            r?;
            Ok(json!({ "ok": true, "message": "teclas enviadas" }))
        }
        Acao::Esperar(s) => {
            std::thread::sleep(std::time::Duration::from_secs_f64(s));
            Ok(json!({ "ok": true, "message": format!("esperou {s:.1} s") }))
        }
        Acao::Programas => Ok(json!({ "ok": true, "apps": lista(d.programas()?) })),
        Acao::Janelas => Ok(json!({ "ok": true, "windows": lista(d.janelas()?) })),
        Acao::Abrir(app) => {
            let m = d.abrir(&app)?;
            Ok(json!({ "ok": true, "message": m }))
        }
    })();
    r.unwrap_or_else(erro)
}

fn lista(ps: Vec<Programa>) -> Value {
    Value::Array(
        ps.into_iter()
            .take(200)
            .map(|p| {
                let mut o = json!({ "name": p.nome });
                if let Some(pid) = p.pid {
                    o["pid"] = json!(pid);
                }
                if let Some(t) = p.titulo {
                    o["title"] = json!(t);
                }
                o
            })
            .collect(),
    )
}

// ---------------------------------------------------------------------------------------------- o sistema

pub struct Nativo {
    enigo: Option<enigo::Enigo>,
}

impl Nativo {
    pub fn novo() -> Self {
        Nativo { enigo: None }
    }

    fn e(&mut self) -> Result<&mut enigo::Enigo, String> {
        if self.enigo.is_none() {
            let s = enigo::Settings { open_prompt_to_get_permissions: false, ..Default::default() };
            self.enigo = Some(enigo::Enigo::new(&s).map_err(|e| format!("sem acesso ao mouse e ao teclado ({e})"))?);
        }
        Ok(self.enigo.as_mut().expect("acabou de criar"))
    }
}

fn dir(baixo: Option<bool>) -> enigo::Direction {
    match baixo {
        Some(true) => enigo::Direction::Press,
        Some(false) => enigo::Direction::Release,
        None => enigo::Direction::Click,
    }
}

fn chave(t: &Tecla) -> enigo::Key {
    use enigo::Key as K;
    match t {
        Tecla::Ctrl => K::Control,
        Tecla::Alt => K::Alt,
        Tecla::Shift => K::Shift,
        Tecla::Meta => K::Meta,
        Tecla::Enter => K::Return,
        Tecla::Tab => K::Tab,
        Tecla::Esc => K::Escape,
        Tecla::Backspace => K::Backspace,
        Tecla::Delete => K::Delete,
        Tecla::Home => K::Home,
        Tecla::End => K::End,
        Tecla::PageUp => K::PageUp,
        Tecla::PageDown => K::PageDown,
        Tecla::Cima => K::UpArrow,
        Tecla::Baixo => K::DownArrow,
        Tecla::Esquerda => K::LeftArrow,
        Tecla::Direita => K::RightArrow,
        Tecla::Espaco => K::Space,
        Tecla::F(n) => [K::F1, K::F2, K::F3, K::F4, K::F5, K::F6, K::F7, K::F8, K::F9, K::F10, K::F11, K::F12][(*n as usize).clamp(1, 12) - 1],
        Tecla::Letra(c) => K::Unicode(*c),
    }
}

impl Driver for Nativo {
    fn tela(&mut self) -> Result<(u32, u32), String> {
        use enigo::Mouse;
        let (w, h) = self.e()?.main_display().map_err(|e| e.to_string())?;
        Ok((w.max(1) as u32, h.max(1) as u32))
    }
    fn posicao(&mut self) -> Result<(i32, i32), String> {
        use enigo::Mouse;
        self.e()?.location().map_err(|e| e.to_string())
    }
    fn mover(&mut self, x: i32, y: i32) -> Result<(), String> {
        use enigo::Mouse;
        self.e()?.move_mouse(x, y, enigo::Coordinate::Abs).map_err(|e| e.to_string())
    }
    fn botao(&mut self, b: Botao, baixo: Option<bool>) -> Result<(), String> {
        use enigo::Mouse;
        let b = match b {
            Botao::Esquerdo => enigo::Button::Left,
            Botao::Direito => enigo::Button::Right,
            Botao::Meio => enigo::Button::Middle,
        };
        self.e()?.button(b, dir(baixo)).map_err(|e| e.to_string())
    }
    fn rolar(&mut self, d: Direcao, quanto: i32) -> Result<(), String> {
        use enigo::Mouse;
        let (n, eixo) = match d {
            Direcao::Cima => (-quanto, enigo::Axis::Vertical),
            Direcao::Baixo => (quanto, enigo::Axis::Vertical),
            Direcao::Esquerda => (-quanto, enigo::Axis::Horizontal),
            Direcao::Direita => (quanto, enigo::Axis::Horizontal),
        };
        self.e()?.scroll(n, eixo).map_err(|e| e.to_string())
    }
    fn digitar(&mut self, texto: &str) -> Result<(), String> {
        use enigo::Keyboard;
        self.e()?.text(texto).map_err(|e| e.to_string())
    }
    fn tecla(&mut self, t: &Tecla, baixo: Option<bool>) -> Result<(), String> {
        use enigo::Keyboard;
        let k = chave(t);
        self.e()?.key(k, dir(baixo)).map_err(|e| e.to_string())
    }
    fn capturar(&mut self, alvo: (u32, u32)) -> Result<Vec<u8>, String> {
        super::captura::tela(alvo)
    }
    fn programas(&mut self) -> Result<Vec<Programa>, String> {
        super::captura::programas()
    }
    fn janelas(&mut self) -> Result<Vec<Programa>, String> {
        super::captura::janelas()
    }
    fn abrir(&mut self, app: &str) -> Result<String, String> {
        super::captura::abrir(app)
    }
    fn permissoes(&mut self) -> Permissoes {
        super::captura::permissoes()
    }
}

#[cfg(test)]
pub mod testes {
    use super::*;

    /// Um sistema de mentira: registra o que o agente faria, na ordem.
    #[derive(Default)]
    pub struct Falso {
        pub feito: Vec<String>,
        pub pos: (i32, i32),
        pub tela: (u32, u32),
    }
    impl Driver for Falso {
        fn tela(&mut self) -> Result<(u32, u32), String> {
            Ok(if self.tela.0 == 0 { (1920, 1080) } else { self.tela })
        }
        fn posicao(&mut self) -> Result<(i32, i32), String> {
            Ok(self.pos)
        }
        fn mover(&mut self, x: i32, y: i32) -> Result<(), String> {
            self.pos = (x, y);
            self.feito.push(format!("mover {x},{y}"));
            Ok(())
        }
        fn botao(&mut self, b: Botao, baixo: Option<bool>) -> Result<(), String> {
            self.feito.push(format!("botao {b:?} {baixo:?}"));
            Ok(())
        }
        fn rolar(&mut self, d: Direcao, q: i32) -> Result<(), String> {
            self.feito.push(format!("rolar {d:?} {q}"));
            Ok(())
        }
        fn digitar(&mut self, t: &str) -> Result<(), String> {
            self.feito.push(format!("digitar {t}"));
            Ok(())
        }
        fn tecla(&mut self, t: &Tecla, baixo: Option<bool>) -> Result<(), String> {
            self.feito.push(format!("tecla {t:?} {baixo:?}"));
            Ok(())
        }
        fn capturar(&mut self, alvo: (u32, u32)) -> Result<Vec<u8>, String> {
            self.feito.push(format!("capturar {}x{}", alvo.0, alvo.1));
            Ok(vec![0x89, b'P', b'N', b'G'])
        }
        fn programas(&mut self) -> Result<Vec<Programa>, String> {
            Ok(vec![Programa { nome: "xterm".into(), pid: Some(42), titulo: None }])
        }
        fn janelas(&mut self) -> Result<Vec<Programa>, String> {
            Ok(vec![])
        }
        fn abrir(&mut self, app: &str) -> Result<String, String> {
            self.feito.push(format!("abrir {app}"));
            Ok(format!("abriu {app}"))
        }
        fn permissoes(&mut self) -> Permissoes {
            Permissoes { entrada: true, tela: true, passo: None }
        }
    }

    #[test]
    fn clique_na_escala_e_com_modificadoras_na_ordem() {
        let mut d = Falso::default();
        let mut ultimo = None;
        let r = executar(&mut d, protocolo::acao("double_click", &json!({"coordinate": [640, 360], "modifiers": ["ctrl", "shift"]})).unwrap(), &mut ultimo);
        assert_eq!(r["ok"], true);
        assert_eq!(ultimo, Some((960, 540)), "a imagem de 1280×720 vale para a tela de 1920×1080");
        assert_eq!(d.feito, vec!["mover 960,540", "tecla Ctrl Some(true)", "tecla Shift Some(true)", "botao Esquerdo None", "botao Esquerdo None", "tecla Shift Some(false)", "tecla Ctrl Some(false)"]);
    }

    #[test]
    fn teclas_seguram_as_modificadoras_e_soltam_ao_contrario() {
        let mut d = Falso::default();
        executar(&mut d, protocolo::acao("key", &json!({"keys": "ctrl+alt+t"})).unwrap(), &mut None);
        assert_eq!(d.feito, vec!["tecla Ctrl Some(true)", "tecla Alt Some(true)", "tecla Letra('t') None", "tecla Alt Some(false)", "tecla Ctrl Some(false)"]);
    }

    #[test]
    fn captura_no_tamanho_do_agente_e_em_base64() {
        let mut d = Falso { tela: (2560, 1600), ..Default::default() };
        let r = executar(&mut d, protocolo::Acao::Capturar, &mut None);
        assert_eq!((r["width"].as_u64(), r["height"].as_u64()), (Some(1280), Some(800)));
        assert_eq!(r["png_b64"], "iVBORw==");
        assert_eq!(d.feito, vec!["capturar 1280x800"]);
    }

    #[test]
    fn arrastar_em_passos_e_listar() {
        let mut d = Falso { tela: (1280, 800), ..Default::default() };
        let mut u = None;
        executar(&mut d, protocolo::acao("drag", &json!({"from_coordinate": [0, 0], "to_coordinate": [80, 80]})).unwrap(), &mut u);
        assert_eq!(d.feito.first().unwrap(), "mover 0,0");
        assert_eq!(d.feito.last().unwrap(), "botao Esquerdo Some(false)");
        assert_eq!(u, Some((80, 80)));
        let r = executar(&mut d, protocolo::Acao::Programas, &mut u);
        assert_eq!(r["apps"], json!([{ "name": "xterm", "pid": 42 }]));
    }
}
