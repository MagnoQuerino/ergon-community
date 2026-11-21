//! O que o Ergon manda ao aparelho e o que volta (puro: sem tela, sem rede). O Ergon já conferiu cada pedido
//! (server/src/services/computador.ts, pedidoParaOAparelho); aqui se confere de novo: o aplicativo só faz o que entende.

use serde_json::{json, Value};

/// Lado maior da captura que vai ao agente: a tela é reduzida a caber em 1280×800 (o tamanho que os modelos leem bem), e
/// as coordenadas que o agente manda são dessa imagem, convertidas de volta para a tela.
pub const CAPTURA_MAX: (f64, f64) = (1280.0, 800.0);
pub const TEXTO_MAX: usize = 4000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Botao {
    Esquerdo,
    Direito,
    Meio,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direcao {
    Cima,
    Baixo,
    Esquerda,
    Direita,
}

/// Uma tecla, sem depender da biblioteca de entrada (driver.rs converte).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Tecla {
    Ctrl,
    Alt,
    Shift,
    /// Cmd no macOS, Windows no Windows, Super no Linux
    Meta,
    Enter,
    Tab,
    Esc,
    Backspace,
    Delete,
    Home,
    End,
    PageUp,
    PageDown,
    Cima,
    Baixo,
    Esquerda,
    Direita,
    Espaco,
    F(u8),
    Letra(char),
}

impl Tecla {
    pub fn modificadora(&self) -> bool {
        matches!(self, Tecla::Ctrl | Tecla::Alt | Tecla::Shift | Tecla::Meta)
    }
}

/// "ctrl+alt+t", "cmd+s", "return", "shift+tab", "f5", "page_down", "a". Nome desconhecido: None.
pub fn teclas(combo: &str) -> Option<Vec<Tecla>> {
    let c = combo.trim();
    if c.is_empty() || c.len() > 60 {
        return None;
    }
    // "+" sozinho como tecla ("ctrl++") não aparece nos pedidos; "-" separa como no cua-driver ("ctrl-alt-t")
    let partes: Vec<&str> = c.split(['+', '-']).map(str::trim).filter(|p| !p.is_empty()).collect();
    if partes.is_empty() || partes.len() > 5 {
        return None;
    }
    partes.into_iter().map(tecla).collect()
}

pub fn tecla(nome: &str) -> Option<Tecla> {
    let n = nome.to_lowercase();
    Some(match n.as_str() {
        "ctrl" | "control" => Tecla::Ctrl,
        "alt" | "option" | "opt" => Tecla::Alt,
        "shift" => Tecla::Shift,
        "cmd" | "command" | "meta" | "win" | "windows" | "super" => Tecla::Meta,
        "return" | "enter" => Tecla::Enter,
        "tab" => Tecla::Tab,
        "esc" | "escape" => Tecla::Esc,
        "backspace" => Tecla::Backspace,
        "delete" | "del" => Tecla::Delete,
        "home" => Tecla::Home,
        "end" => Tecla::End,
        "pageup" | "page_up" | "pgup" => Tecla::PageUp,
        "pagedown" | "page_down" | "pgdn" => Tecla::PageDown,
        "up" | "arrowup" => Tecla::Cima,
        "down" | "arrowdown" => Tecla::Baixo,
        "left" | "arrowleft" => Tecla::Esquerda,
        "right" | "arrowright" => Tecla::Direita,
        "space" | "spacebar" => Tecla::Espaco,
        _ => {
            if let Some(f) = n.strip_prefix('f').and_then(|d| d.parse::<u8>().ok()).filter(|d| (1..=12).contains(d)) {
                return Some(Tecla::F(f));
            }
            let mut cs = nome.chars();
            match (cs.next(), cs.next()) {
                (Some(ch), None) if !ch.is_control() => Tecla::Letra(ch.to_ascii_lowercase()),
                _ => return None,
            }
        }
    })
}

/// Fator entre a tela de verdade e a imagem que o agente vê (>= 1: nunca amplia).
pub fn fator(tela: (u32, u32)) -> f64 {
    let (w, h) = (tela.0.max(1) as f64, tela.1.max(1) as f64);
    (w / CAPTURA_MAX.0).max(h / CAPTURA_MAX.1).max(1.0)
}

/// O tamanho da imagem que o agente vê para esta tela.
pub fn tamanho_da_captura(tela: (u32, u32)) -> (u32, u32) {
    let f = fator(tela);
    (((tela.0 as f64) / f).round().max(1.0) as u32, ((tela.1 as f64) / f).round().max(1.0) as u32)
}

/// Um ponto da imagem do agente na tela de verdade (preso à tela).
pub fn para_a_tela(p: (i64, i64), tela: (u32, u32)) -> (i32, i32) {
    let f = fator(tela);
    let x = ((p.0.max(0) as f64) * f).round().min(tela.0.saturating_sub(1) as f64);
    let y = ((p.1.max(0) as f64) * f).round().min(tela.1.saturating_sub(1) as f64);
    (x as i32, y as i32)
}

/// Uma ação pedida pelo Ergon, já conferida.
#[derive(Debug, Clone, PartialEq)]
pub enum Acao {
    Capturar,
    Clicar { em: (i64, i64), botao: Botao, vezes: u32, mods: Vec<Tecla> },
    Arrastar { de: (i64, i64), para: (i64, i64) },
    Rolar { direcao: Direcao, quanto: i32, em: Option<(i64, i64)> },
    Digitar(String),
    Teclas(Vec<Tecla>),
    Esperar(f64),
    Programas,
    Janelas,
    Abrir(String),
}

fn ponto(v: &Value) -> Option<(i64, i64)> {
    let a = v.as_array()?;
    if a.len() != 2 {
        return None;
    }
    let (x, y) = (a[0].as_i64()?, a[1].as_i64()?);
    ((0..=100_000).contains(&x) && (0..=100_000).contains(&y)).then_some((x, y))
}

/// Nome de programa aceito: sem caminho de shell, sem aspas, sem controle (o Ergon já recusa; aqui de novo).
pub fn nome_de_programa(s: &str) -> bool {
    let t = s.trim();
    !t.is_empty() && t.len() <= 120 && !t.chars().any(|c| c.is_control() || "\"'`$;&|<>\\".contains(c))
}

pub fn acao(nome: &str, args: &Value) -> Result<Acao, String> {
    let mods = || -> Result<Vec<Tecla>, String> {
        match args.get("modifiers") {
            None | Some(Value::Null) => Ok(vec![]),
            Some(Value::Array(a)) if a.len() <= 4 => a
                .iter()
                .map(|m| m.as_str().and_then(tecla).filter(Tecla::modificadora).ok_or_else(|| "modifiers inválido".to_string()))
                .collect(),
            _ => Err("modifiers inválido".into()),
        }
    };
    let em = || args.get("coordinate").and_then(ponto).ok_or_else(|| format!("{nome} precisa de coordinate [x, y]"));
    Ok(match nome {
        "capture" => Acao::Capturar,
        "click" => Acao::Clicar { em: em()?, botao: Botao::Esquerdo, vezes: 1, mods: mods()? },
        "double_click" => Acao::Clicar { em: em()?, botao: Botao::Esquerdo, vezes: 2, mods: mods()? },
        "right_click" => Acao::Clicar { em: em()?, botao: Botao::Direito, vezes: 1, mods: mods()? },
        "middle_click" => Acao::Clicar { em: em()?, botao: Botao::Meio, vezes: 1, mods: mods()? },
        "drag" => Acao::Arrastar {
            de: args.get("from_coordinate").and_then(ponto).ok_or("drag precisa de from_coordinate")?,
            para: args.get("to_coordinate").and_then(ponto).ok_or("drag precisa de to_coordinate")?,
        },
        "scroll" => Acao::Rolar {
            direcao: match args.get("direction").and_then(Value::as_str).unwrap_or("down") {
                "up" => Direcao::Cima,
                "left" => Direcao::Esquerda,
                "right" => Direcao::Direita,
                _ => Direcao::Baixo,
            },
            quanto: args.get("amount").and_then(Value::as_i64).unwrap_or(3).clamp(1, 50) as i32,
            em: args.get("coordinate").and_then(ponto),
        },
        "type" | "set_value" => {
            let t = args.get("text").and_then(Value::as_str).unwrap_or("");
            if t.is_empty() || t.chars().count() > TEXTO_MAX {
                return Err("texto vazio ou longo demais".into());
            }
            Acao::Digitar(t.to_string())
        }
        "key" => Acao::Teclas(args.get("keys").and_then(Value::as_str).and_then(teclas).ok_or("keys inválido")?),
        "wait" => Acao::Esperar(args.get("seconds").and_then(Value::as_f64).unwrap_or(1.0).clamp(0.0, 10.0)),
        "list_apps" => Acao::Programas,
        "list_windows" => Acao::Janelas,
        "focus_app" => {
            let a = args.get("app").and_then(Value::as_str).unwrap_or("");
            if !nome_de_programa(a) {
                return Err("app inválido".into());
            }
            Acao::Abrir(a.trim().to_string())
        }
        outro => return Err(format!("ação desconhecida: {}", outro.chars().take(30).collect::<String>())),
    })
}

/// Do Ergon para o aparelho.
#[derive(Debug, Clone, PartialEq)]
pub enum DoErgon {
    /// em uso por um agente agora, e com quem está o controle
    Estado { em_uso: bool, agente: Option<String>, pessoa: bool },
    Acao { id: String, nome: String, args: Value },
    Parar,
}

pub fn do_ergon(texto: &str) -> Option<DoErgon> {
    let v: Value = serde_json::from_str(texto).ok()?;
    match v.get("t")?.as_str()? {
        "ola" | "estado" => Some(DoErgon::Estado {
            em_uso: v.get("emUso").and_then(Value::as_bool).unwrap_or(false),
            agente: v.get("agente").and_then(Value::as_str).map(|s| s.chars().filter(|c| !c.is_control()).take(60).collect()),
            pessoa: v.get("controle").and_then(Value::as_str) == Some("pessoa"),
        }),
        "acao" => {
            let id = v.get("id")?.as_str()?;
            if id.is_empty() || id.len() > 64 {
                return None;
            }
            Some(DoErgon::Acao { id: id.to_string(), nome: v.get("acao")?.as_str()?.to_string(), args: v.get("args").cloned().unwrap_or(json!({})) })
        }
        "parar" => Some(DoErgon::Parar),
        _ => None,
    }
}

/// Permissões do sistema que faltam; `passo` é a única instrução que a tela do Ergon mostra.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Permissoes {
    pub entrada: bool,
    pub tela: bool,
    pub passo: Option<&'static str>,
}

pub fn ola(so: &str, permissoes: &Permissoes, tela: (u32, u32)) -> String {
    json!({ "t": "ola", "so": so, "versao": env!("CARGO_PKG_VERSION"),
        "permissoes": { "entrada": permissoes.entrada, "tela": permissoes.tela, "passo": permissoes.passo },
        "tela": { "largura": tela.0, "altura": tela.1 } })
    .to_string()
}

pub fn resposta(id: &str, r: Value) -> String {
    json!({ "t": "resposta", "id": id, "r": r }).to_string()
}

pub fn assumir(motivo: &str) -> String {
    json!({ "t": "assumir", "motivo": motivo }).to_string()
}

pub fn conceder() -> String {
    json!({ "t": "conceder" }).to_string()
}

/// A pessoa mexeu o mouse de verdade? O cursor saiu de onde o agente deixou (mais que uma folga) e o agente não agiu há
/// pouco (o próprio movimento do agente ainda pode estar chegando).
pub fn pessoa_mexeu(do_agente: Option<(i32, i32)>, agora: (i32, i32), ms_desde_o_agente: u128) -> bool {
    match do_agente {
        Some((x, y)) => ms_desde_o_agente > 400 && ((agora.0 - x).abs() > 6 || (agora.1 - y).abs() > 6),
        None => false,
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn teclas_conhecidas_e_recusadas() {
        assert_eq!(teclas("ctrl+alt+t"), Some(vec![Tecla::Ctrl, Tecla::Alt, Tecla::Letra('t')]));
        assert_eq!(teclas("cmd+S"), Some(vec![Tecla::Meta, Tecla::Letra('s')]));
        assert_eq!(teclas("return"), Some(vec![Tecla::Enter]));
        assert_eq!(teclas("shift-tab"), Some(vec![Tecla::Shift, Tecla::Tab]));
        assert_eq!(teclas("F5"), Some(vec![Tecla::F(5)]));
        assert_eq!(teclas("page_down"), Some(vec![Tecla::PageDown]));
        assert_eq!(teclas("f13"), None);
        assert_eq!(teclas("ctrl+banana"), None);
        assert_eq!(teclas(""), None);
        assert_eq!(teclas("a+b+c+d+e+f"), None);
    }

    #[test]
    fn escala_entre_a_imagem_e_a_tela() {
        assert_eq!(tamanho_da_captura((1280, 800)), (1280, 800));
        assert_eq!(tamanho_da_captura((1024, 768)), (1024, 768), "tela menor: nunca amplia");
        assert_eq!(tamanho_da_captura((2560, 1600)), (1280, 800));
        assert_eq!(tamanho_da_captura((1920, 1080)), (1280, 720));
        assert_eq!(para_a_tela((640, 360), (1920, 1080)), (960, 540));
        assert_eq!(para_a_tela((5000, 5000), (1920, 1080)), (1919, 1079), "preso à tela");
        assert_eq!(para_a_tela((-3, 10), (1024, 768)), (0, 10));
    }

    #[test]
    fn acoes_conferidas() {
        assert_eq!(acao("click", &json!({"coordinate": [10, 20]})), Ok(Acao::Clicar { em: (10, 20), botao: Botao::Esquerdo, vezes: 1, mods: vec![] }));
        assert_eq!(
            acao("double_click", &json!({"coordinate": [1, 2], "modifiers": ["shift"]})),
            Ok(Acao::Clicar { em: (1, 2), botao: Botao::Esquerdo, vezes: 2, mods: vec![Tecla::Shift] })
        );
        assert!(acao("click", &json!({"coordinate": [1, 2], "modifiers": ["a"]})).is_err(), "só modificadoras");
        assert!(acao("click", &json!({})).is_err());
        assert!(acao("click", &json!({"coordinate": [1]})).is_err());
        assert!(acao("type", &json!({"text": ""})).is_err());
        assert!(acao("type", &json!({"text": "x".repeat(4001)})).is_err());
        assert_eq!(acao("type", &json!({"text": "olá"})), Ok(Acao::Digitar("olá".into())));
        assert!(acao("focus_app", &json!({"app": "calc; rm -rf /"})).is_err());
        assert_eq!(acao("focus_app", &json!({"app": " xterm "})), Ok(Acao::Abrir("xterm".into())));
        assert_eq!(acao("scroll", &json!({"direction": "up", "amount": 999})), Ok(Acao::Rolar { direcao: Direcao::Cima, quanto: 50, em: None }));
        assert_eq!(acao("wait", &json!({"seconds": 60})), Ok(Acao::Esperar(10.0)));
        assert!(acao("rm", &json!({})).is_err());
    }

    #[test]
    fn mensagens_do_ergon() {
        assert_eq!(
            do_ergon(r#"{"t":"estado","emUso":true,"agente":"Hipátia\u0007","controle":"agente"}"#),
            Some(DoErgon::Estado { em_uso: true, agente: Some("Hipátia".into()), pessoa: false })
        );
        assert_eq!(do_ergon(r#"{"t":"ola","emUso":false,"agente":null,"controle":"pessoa"}"#), Some(DoErgon::Estado { em_uso: false, agente: None, pessoa: true }));
        assert_eq!(do_ergon(r#"{"t":"parar"}"#), Some(DoErgon::Parar));
        assert!(matches!(do_ergon(r#"{"t":"acao","id":"a1","acao":"click","args":{"coordinate":[1,2]}}"#), Some(DoErgon::Acao { .. })));
        assert_eq!(do_ergon(r#"{"t":"acao","id":"","acao":"click"}"#), None);
        assert_eq!(do_ergon("lixo"), None);
        assert_eq!(do_ergon(r#"{"t":"outra"}"#), None);
    }

    #[test]
    fn mexer_o_mouse_de_verdade() {
        assert!(!pessoa_mexeu(None, (500, 500), 9999), "sem o agente ter mexido, nada a comparar");
        assert!(!pessoa_mexeu(Some((100, 100)), (103, 98), 9999), "folga de poucos pixels");
        assert!(!pessoa_mexeu(Some((100, 100)), (300, 300), 100), "o movimento do agente ainda chegando");
        assert!(pessoa_mexeu(Some((100, 100)), (300, 300), 1000));
    }
}
