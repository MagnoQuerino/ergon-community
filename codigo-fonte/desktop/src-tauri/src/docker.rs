//! Leitura do Docker com argumentos fixos: a versão do servidor e os contêineres do projeto "ergon". Nada aqui
//! liga, para ou apaga contêineres (isso é do lançador, quando você pede), e nada toca em outros projetos.

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

/// O programa docker: o de dentro do ambiente do Ergon (Windows, instalação própria) ou o do sistema.
fn cli() -> std::process::Command {
    if crate::ambiente::ativo() { crate::ambiente::dentro(&["docker"]) } else { comando("docker") }
}

pub fn situacao() -> Docker {
    let mut c = cli();
    c.args(["version", "--format", "{{.Server.Version}}"]);
    match rodar(c, Duration::from_secs(20)) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Docker::Ausente,
        Err(e) => Docker::Falha(e.to_string()),
        Ok(o) if o.status.success() => {
            let v = linhas(&o.stdout).into_iter().next().unwrap_or_default();
            if v.is_empty() { Docker::Parado("o Docker não informou a versão do serviço".into()) } else { Docker::Pronto(v) }
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
    let mut c = cli();
    c.args([
        "ps",
        "-a",
        "--filter",
        &format!("label=com.docker.compose.project={projeto}"),
        "--format",
        "{{.Label \"com.docker.compose.service\"}}\t{{.State}}\t{{.Ports}}\t{{.Label \"com.docker.compose.project.working_dir\"}}",
    ]);
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
