//! Leitura do motor de contêineres com argumentos fixos: a versão e os contêineres do projeto "ergon". No ambiente
//! próprio do Ergon é o Podman (o de uma instalação antiga, ainda não migrada, é o Docker de dentro dele); fora dele, o
//! Docker do sistema. Nada aqui liga, para ou apaga contêineres (isso é do lançador, quando você pede), e nada toca em
//! outros projetos.

use crate::processo::{comando, linhas, rodar};
use std::time::Duration;

/// Projeto do Docker Compose do Ergon quando a instalação não diz outro ("name: ergon" no docker-compose.yml).
pub const PROJETO_PADRAO: &str = "ergon";

#[derive(Debug, Clone, PartialEq)]
pub enum Docker {
    Pronto(String),
    /// o programa docker não existe neste computador
    Ausente,
    /// existe, mas o serviço não responde (Docker Desktop fechado, serviço parado)
    Parado(String),
    /// Linux: o usuário não tem acesso ao socket do Docker
    SemPermissao(String),
    Falha(String),
}

/// Dentro do ambiente próprio: o Podman, se ele estiver lá (ambiente novo ou já migrado). Uma vez visto, fica.
fn ambiente_com_podman() -> bool {
    static VISTO: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if VISTO.load(std::sync::atomic::Ordering::Relaxed) {
        return true;
    }
    let tem = rodar(crate::ambiente::dentro(&["sh", "-c", "command -v podman"]), Duration::from_secs(20)).map(|o| o.status.success()).unwrap_or(false);
    if tem {
        VISTO.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    tem
}

/// Linux: o Podman da conta, a não ser numa instalação de antes dele, feita com o Docker (o lançador grava a escolha no
/// .env da instalação; sem ela, a instalação registrada com o docker no computador é dessas).
pub fn linux_usa_podman() -> bool {
    let Some(raiz) = crate::instalacao::localizar().raiz else { return true };
    let env = std::fs::read_to_string(raiz.join(".env")).unwrap_or_default();
    match env.lines().rev().find_map(|l| l.strip_prefix("ERGON_MOTOR=")).map(|v| v.trim().trim_matches('"')) {
        Some(m) => m != "docker",
        None => {
            let mut d = comando("docker");
            d.arg("--version");
            !(env.lines().any(|l| l.starts_with("ERGON_SECRETS_DIR=")) && rodar(d, Duration::from_secs(10)).is_ok_and(|o| o.status.success()))
        }
    }
}

/// O programa: o de dentro do ambiente do Ergon (Windows, instalação própria), o do Linux (Podman, ou o Docker de uma
/// instalação antiga) ou o docker do sistema (Windows com uma instalação antiga pelo Docker Desktop); e se é o Podman.
fn cli() -> (std::process::Command, bool) {
    if crate::ambiente::ativo() {
        let podman = ambiente_com_podman();
        (crate::ambiente::dentro(&[if podman { "podman" } else { "docker" }]), podman)
    } else if !cfg!(windows) && linux_usa_podman() {
        (comando("podman"), true)
    } else {
        (comando("docker"), false)
    }
}

pub fn situacao() -> Docker {
    let (mut c, podman) = cli();
    // o Podman não tem serviço residente: a versão dele responde sempre que o ambiente está de pé
    if podman { c.args(["info", "--format", "{{.Version.Version}}"]) } else { c.args(["version", "--format", "{{.Server.Version}}"]) };
    match rodar(c, Duration::from_secs(20)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Docker::Ausente,
        Err(e) => Docker::Falha(e.to_string()),
        Ok(o) if o.status.success() => {
            let v = linhas(&o.stdout).into_iter().next().unwrap_or_default();
            if v.is_empty() { Docker::Parado("o motor de contêineres não informou a versão".into()) } else { Docker::Pronto(v) }
        }
        Ok(o) => classificar(&linhas(&o.stderr).join(" ")),
    }
}

/// Erro do "docker version" → situação (as mensagens variam entre Windows, Docker Desktop e Docker Engine).
pub fn classificar(erro: &str) -> Docker {
    let e = erro.to_lowercase();
    let curto: String = erro.chars().take(240).collect();
    if e.contains("permission denied") {
        Docker::SemPermissao(curto)
    } else if e.contains("cannot connect to the docker daemon")
        || e.contains("error during connect")
        || e.contains("is the docker daemon running")
        || e.contains("dockerdesktoplinuxengine")
        || e.contains("the system cannot find the file specified")
    {
        Docker::Parado(curto)
    } else {
        Docker::Falha(curto)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Conteiner {
    pub servico: String,
    pub estado: String,
    pub portas: String,
    pub pasta: String,
}

/// Contêineres do projeto (parados também), com o serviço, o estado, as portas e a pasta do Compose.
pub fn conteineres(projeto: &str) -> Vec<Conteiner> {
    let (mut c, podman) = cli();
    // os rótulos do Compose são os mesmos nos dois (o podman-compose também os põe); o modelo de leitura muda
    let formato = if podman {
        "{{index .Labels \"com.docker.compose.service\"}}\t{{.State}}\t{{.Ports}}\t{{index .Labels \"com.docker.compose.project.working_dir\"}}"
    } else {
        "{{.Label \"com.docker.compose.service\"}}\t{{.State}}\t{{.Ports}}\t{{.Label \"com.docker.compose.project.working_dir\"}}"
    };
    c.args(["ps", "-a", "--filter", &format!("label=com.docker.compose.project={projeto}"), "--format", formato]);
    match rodar(c, Duration::from_secs(20)) {
        Ok(o) if o.status.success() => ler_conteineres(&String::from_utf8_lossy(&o.stdout)),
        _ => Vec::new(),
    }
}

pub fn ler_conteineres(texto: &str) -> Vec<Conteiner> {
    texto
        .lines()
        .filter_map(|l| {
            let mut p = l.split('\t');
            let servico = p.next()?.trim().to_string();
            if servico.is_empty() {
                return None;
            }
            Some(Conteiner {
                servico,
                estado: p.next().unwrap_or("").trim().to_string(),
                portas: p.next().unwrap_or("").trim().to_string(),
                pasta: p.next().unwrap_or("").trim().to_string(),
            })
        })
        .collect()
}

/// A porta do computador está publicada por este contêiner? ("127.0.0.1:8787->8787/tcp")
pub fn publica(c: &Conteiner, porta: u16) -> bool {
    c.portas.split(',').any(|p| {
        let p = p.trim();
        p.starts_with(&format!("127.0.0.1:{porta}->")) || p.starts_with(&format!("0.0.0.0:{porta}->")) || p.starts_with(&format!("[::]:{porta}->"))
    })
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn classifica_os_erros_do_docker() {
        assert!(matches!(classificar("permission denied while trying to connect to the Docker daemon socket"), Docker::SemPermissao(_)));
        assert!(matches!(classificar("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?"), Docker::Parado(_)));
        assert!(matches!(
            classificar("error during connect: Get \"http://%2F%2F.%2Fpipe%2FdockerDesktopLinuxEngine/v1.47/version\": open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified."),
            Docker::Parado(_)
        ));
        assert!(matches!(classificar("algo inesperado"), Docker::Falha(_)));
    }

    #[test]
    fn le_os_conteineres_e_a_porta() {
        let v = ler_conteineres("ergon\trunning\t127.0.0.1:8787->8787/tcp\t/home/a/ergon\nhermes\texited\t\t/home/a/ergon\n\n");
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].servico, "ergon");
        assert!(publica(&v[0], 8787));
        assert!(!publica(&v[0], 8788));
        assert!(!publica(&v[1], 8787));
    }
}
