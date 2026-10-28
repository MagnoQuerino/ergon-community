//! Onde está a instalação do Ergon neste computador (a pasta com o lançador e o docker-compose.yml) e em que porta
//! ele responde. O lançador registra a pasta em ~/.ergon/instalacao.json a cada "instalar", "iniciar" ou "subir";
//! sem o registro, o diagnóstico ainda acha a pasta pelos rótulos do Docker Compose.

use std::fs;
use std::path::{Path, PathBuf};

pub const PORTA_PADRAO: u16 = 8787;

#[derive(Debug, Clone)]
pub struct Instalacao {
    /// pasta do lançador (None: ainda não registrada)
    pub raiz: Option<PathBuf>,
    pub porta: u16,
    /// instância de teste apontada por ERGON_DESKTOP_URL (só endereços do próprio computador)
    pub teste: bool,
}

pub fn localizar() -> Instalacao {
    if let Ok(u) = std::env::var("ERGON_DESKTOP_URL") {
        if let Some(porta) = porta_de_teste(&u) {
            return Instalacao { raiz: None, porta, teste: true };
        }
        log::warn!("ERGON_DESKTOP_URL ignorada: só http://localhost:<porta> ou http://127.0.0.1:<porta>");
    }
    let registro = arquivo_de_registro();
    let lido = registro.as_deref().and_then(|f| fs::read_to_string(f).ok()).and_then(|t| serde_json::from_str::<serde_json::Value>(t.trim_start_matches('\u{feff}')).ok());
    let raiz = lido.as_ref().and_then(|v| v.get("raiz")).and_then(|r| r.as_str()).map(PathBuf::from).filter(|r| valida(r));
    let porta = lido
        .as_ref()
        .and_then(|v| v.get("porta"))
        .and_then(|p| p.as_u64())
        .and_then(|p| u16::try_from(p).ok())
        .or_else(|| raiz.as_deref().and_then(porta_do_env))
        .unwrap_or(PORTA_PADRAO);
    Instalacao { raiz, porta, teste: false }
}

/// ~/.ergon/instalacao.json (ERGON_INSTALACAO troca o arquivo: testes com uma instalação isolada).
pub fn arquivo_de_registro() -> Option<PathBuf> {
    std::env::var_os("ERGON_INSTALACAO").map(PathBuf::from).or_else(|| pasta_pessoal().map(|h| h.join(".ergon").join("instalacao.json")))
}

pub fn pasta_pessoal() -> Option<PathBuf> {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    std::env::var_os(var).map(PathBuf::from).filter(|p| p.is_dir())
}

/// O lançador desta plataforma dentro da pasta da instalação.
pub fn lancador(raiz: &Path) -> PathBuf {
    raiz.join(if cfg!(windows) { "ergon.ps1" } else { "ergon.sh" })
}

/// Uma pasta só vale como instalação se tiver o lançador e o docker-compose.yml.
pub fn valida(raiz: &Path) -> bool {
    raiz.is_absolute() && lancador(raiz).is_file() && raiz.join("docker-compose.yml").is_file()
}

/// ERGON_PORT do .env da instalação (o mesmo que o lançador lê).
pub fn porta_do_env(raiz: &Path) -> Option<u16> {
    let texto = fs::read_to_string(raiz.join(".env")).ok()?;
    texto.lines().rev().find_map(|l| {
        let l = l.trim();
        let v = l.strip_prefix("ERGON_PORT=")?;
        v.trim_matches(['"', '\'']).trim().parse().ok()
    })
}

/// Projeto do Docker Compose da instalação ("name:" do docker-compose.yml); sem pasta ou sem nome, "ergon".
pub fn projeto(raiz: Option<&Path>) -> String {
    raiz.and_then(|r| fs::read_to_string(r.join("docker-compose.yml")).ok())
        .and_then(|t| t.lines().find_map(|l| l.strip_prefix("name:").map(|v| v.trim().trim_matches(['"', '\'']).to_string())))
        .filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_'))
        .unwrap_or_else(|| crate::docker::PROJETO_PADRAO.to_string())
}

/// Só aceita http://localhost:<porta> ou http://127.0.0.1:<porta> (com ou sem "/" no fim).
pub fn porta_de_teste(url: &str) -> Option<u16> {
    let resto = url.trim().strip_prefix("http://")?.trim_end_matches('/');
    let (host, porta) = resto.rsplit_once(':')?;
    if host != "localhost" && host != "127.0.0.1" {
        return None;
    }
    porta.parse().ok().filter(|p| *p > 0)
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn so_aceita_o_proprio_computador() {
        assert_eq!(porta_de_teste("http://127.0.0.1:18790"), Some(18790));
        assert_eq!(porta_de_teste("http://localhost:8787/"), Some(8787));
        assert_eq!(porta_de_teste("http://exemplo.com:8787"), None);
        assert_eq!(porta_de_teste("https://localhost:8787"), None);
        assert_eq!(porta_de_teste("http://localhost:8787/caminho"), None);
        assert_eq!(porta_de_teste("http://localhost"), None);
    }

    #[test]
    fn nome_do_projeto() {
        let d = std::env::temp_dir().join(format!("ergon-desktop-projeto-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        assert_eq!(projeto(Some(&d)), "ergon");
        fs::write(d.join("docker-compose.yml"), "# x\nname: ergon-teste\nservices: {}\n").unwrap();
        assert_eq!(projeto(Some(&d)), "ergon-teste");
        fs::write(d.join("docker-compose.yml"), "name: \"Nome Ruim; rm\"\n").unwrap();
        assert_eq!(projeto(Some(&d)), "ergon");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn porta_do_env_le_a_ultima() {
        let d = std::env::temp_dir().join(format!("ergon-desktop-teste-{}", std::process::id()));
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(".env"), "ERGON_PORT=9000\nX=1\nERGON_PORT=\"9100\"\n").unwrap();
        assert_eq!(porta_do_env(&d), Some(9100));
        fs::remove_dir_all(&d).ok();
    }
}
