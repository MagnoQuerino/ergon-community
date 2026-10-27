//! Diagnóstico de abertura: o Ergon responde? É o Ergon desta instalação (o contêiner do projeto "ergon" publica a
//! porta)? A versão serve? O Docker está instalado, ligado e acessível? Nunca trata "algo responde em
//! localhost:8787" como o Ergon sem confirmar — a janela só carrega o endereço depois disso.

use crate::docker::{self, Conteiner, Docker};
use crate::instalacao::{self, Instalacao};
use crate::{bandeja, Estado};
use serde::Serialize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, State};

/// Versão mínima do Ergon (Core) que este aplicativo abre: a primeira com "service" na saúde (/api/health).
pub const CORE_MINIMO: &str = "0.2.0";

#[derive(Debug, Clone, Serialize)]
pub struct Diagnostico {
    /// pronto | parado | iniciando | docker_ausente | docker_parado | docker_sem_permissao | nao_instalado |
    /// porta_ocupada | nao_confirmado | incompativel | com_erro
    pub estado: &'static str,
    pub titulo: String,
    pub explicacao: String,
    /// ações oferecidas na tela: abrir | iniciar | tentar | navegador | diagnostico | ajuda:<tema>
    pub acoes: Vec<String>,
    pub avisos: Vec<String>,
    /// só um diagnóstico confirmado libera abrir o Ergon na janela
    pub confirmado: bool,
    pub url: String,
    pub porta: u16,
    pub versao_app: String,
    pub versao_core: Option<String>,
    pub trancado: bool,
    pub teste: bool,
    pub windows: bool,
    pub detalhes: Vec<String>,
    #[serde(skip)]
    pub raiz: Option<std::path::PathBuf>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Saude {
    pub versao: String,
    pub trancado: bool,
}

/// O que respondeu na porta do Ergon.
#[derive(Debug, Clone, PartialEq)]
pub enum Resposta {
    /// o próprio Ergon ("service": "ergon")
    Ergon(Saude),
    /// algo respondeu (com este código HTTP), mas não como o Ergon: outra aplicação, um Ergon antigo ou com erro
    Outro(u16),
    /// nada respondeu
    Nada(String),
}

/// Lê a saúde e só aceita a resposta do próprio Ergon ("service": "ergon").
pub fn ler_saude(porta: u16) -> Resposta {
    match crate::http::get(porta, "/api/health", Duration::from_secs(4)) {
        Err(m) => Resposta::Nada(m),
        Ok((status, corpo)) => match interpretar_saude(status, &corpo) {
            Ok(s) => Resposta::Ergon(s),
            Err(_) => Resposta::Outro(status),
        },
    }
}

pub fn interpretar_saude(status: u16, corpo: &str) -> Result<Saude, String> {
    if status != 200 {
        return Err(format!("respondeu {status}"));
    }
    let v: serde_json::Value = serde_json::from_str(corpo).map_err(|_| "a resposta não é do Ergon".to_string())?;
    if v.get("service").and_then(|s| s.as_str()) != Some("ergon") {
        return Err("a resposta não é do Ergon".into());
    }
    Ok(Saude {
        versao: v.get("version").and_then(|s| s.as_str()).unwrap_or("?").to_string(),
        trancado: v.get("sealed").and_then(|s| s.as_bool()).unwrap_or(false),
    })
}

/// "0.10.2" >= "0.2.0"? (só os números; sufixos como "-beta" não contam)
pub fn versao_ok(versao: &str, minima: &str) -> bool {
    let n = |s: &str| -> Vec<u64> { s.split(['.', '-', '+']).take(3).map(|p| p.parse().unwrap_or(0)).collect() };
    n(versao) >= n(minima)
}

pub struct Entrada {
    pub inst: Instalacao,
    pub saude: Resposta,
    pub docker: Docker,
    pub conteineres: Vec<Conteiner>,
    pub windows: bool,
}

fn marcar(d: &mut Diagnostico, estado: &'static str, titulo: &str, explicacao: String, acoes: &[&str]) {
    d.estado = estado;
    d.titulo = titulo.into();
    d.explicacao = explicacao;
    d.acoes = acoes.iter().map(|s| s.to_string()).collect();
}

/// Decide o estado a partir do que foi lido (sem efeitos: testável).
pub fn decidir(e: Entrada) -> Diagnostico {
    let porta = e.inst.porta;
    let url = format!("http://localhost:{porta}");
    let ergon = e.conteineres.iter().find(|c| c.servico == "ergon");
    let motor = e.conteineres.iter().find(|c| c.servico == "hermes");
    let raiz = e.inst.raiz.clone().or_else(|| {
        ergon.map(|c| std::path::PathBuf::from(&c.pasta)).filter(|p| instalacao::valida(p))
    });
    let mut detalhes = vec![
        format!("Aplicativo: Ergon Desktop {}", env!("CARGO_PKG_VERSION")),
        format!("Endereço: {url}"),
        match &e.saude {
            Resposta::Ergon(s) => format!("Ergon: {} ({})", s.versao, if s.trancado { "trancado" } else { "aberto" }),
            Resposta::Outro(status) => format!("Ergon: a porta respondeu ({status}), mas não como o Ergon"),
            Resposta::Nada(m) => format!("Ergon: não respondeu ({m})"),
        },
        match &e.docker {
            Docker::Pronto(v) => format!("Docker: {v}"),
            Docker::Ausente => "Docker: não instalado".into(),
            Docker::Parado(m) => format!("Docker: parado ({m})"),
            Docker::SemPermissao(m) => format!("Docker: sem permissão ({m})"),
            Docker::Falha(m) => format!("Docker: erro ({m})"),
        },
    ];
    if !e.conteineres.is_empty() {
        detalhes.push(format!(
            "Serviços: {}",
            e.conteineres.iter().map(|c| format!("{} ({})", if c.servico == "hermes" { "motor de IA" } else { &c.servico }, c.estado)).collect::<Vec<_>>().join(", ")
        ));
    }
    detalhes.push(match (&raiz, e.inst.teste) {
        (_, true) => "Instalação: instância de teste (ERGON_DESKTOP_URL)".into(),
        (Some(r), _) => format!("Instalação: {}", r.display()),
        (None, _) => "Instalação: não encontrada neste computador".into(),
    });

    let mut d = Diagnostico {
        estado: "pronto",
        titulo: String::new(),
        explicacao: String::new(),
        acoes: vec![],
        avisos: vec![],
        confirmado: false,
        url,
        porta,
        versao_app: env!("CARGO_PKG_VERSION").into(),
        versao_core: if let Resposta::Ergon(s) = &e.saude { Some(s.versao.clone()) } else { None },
        trancado: matches!(&e.saude, Resposta::Ergon(s) if s.trancado),
        teste: e.inst.teste,
        windows: e.windows,
        detalhes,
        raiz: raiz.clone(),
    };

    // o contêiner do Ergon desta instalação está ligado e publica a porta?
    let deste = matches!(e.docker, Docker::Pronto(_)) && ergon.map(|c| c.estado == "running" && docker::publica(c, porta)).unwrap_or(false);

    // 1. o Ergon responde: é o desta instalação?
    if let Resposta::Ergon(s) = &e.saude {
        let confirmado = e.inst.teste || deste;
        if !confirmado {
            if matches!(e.docker, Docker::Pronto(_)) {
                marcar(&mut d, "porta_ocupada", &format!("Outra aplicação está usando a porta {porta}"),
                    format!("Algo responde em localhost:{porta}, mas não é o serviço do Ergon desta instalação. Por segurança, esta janela não abre esse endereço. Feche a outra aplicação (ou mude a porta do Ergon) e tente de novo."),
                    &["tentar", "diagnostico"]);
            } else {
                marcar(&mut d, "nao_confirmado", "Não foi possível confirmar a instalação",
                    "O Ergon responde, mas sem acesso ao Docker não dá para confirmar que é o desta instalação. Por segurança, esta janela não abre o endereço até confirmar.".into(),
                    &["tentar", "diagnostico", "ajuda:docker"]);
            }
            return d;
        }
        if !versao_ok(&s.versao, CORE_MINIMO) {
            marcar(&mut d, "incompativel", "O Ergon instalado é antigo para este aplicativo",
                format!("O Ergon instalado é a versão {}; este aplicativo precisa da {CORE_MINIMO} ou mais nova. Atualize o Ergon e abra de novo — até lá, use pelo navegador.", s.versao),
                &["navegador", "tentar", "diagnostico"]);
            return d;
        }
        d.confirmado = true;
        let titulo = if e.inst.teste { "Pronto (instância de teste)" } else { "Pronto" };
        let expl = if s.trancado { format!("Ergon {} no ar e trancado: digite a senha na próxima tela.", s.versao) } else { format!("Ergon {} no ar.", s.versao) };
        marcar(&mut d, "pronto", titulo, expl, &["abrir", "navegador"]);
        if !e.inst.teste && motor.map(|m| m.estado != "running").unwrap_or(false) {
            d.avisos.push("O motor de IA está parado: as conversas e as rotinas esperam até ele voltar. Use \"Iniciar Ergon\" para ligar.".into());
            d.acoes.push("iniciar".into());
        }
        return d;
    }

    // 2. algo responde, mas não como o Ergon: "Iniciar Ergon" não resolveria (a porta está tomada)
    if let Resposta::Outro(status) = e.saude {
        if deste && !e.inst.teste && status == 200 {
            marcar(&mut d, "incompativel", "O Ergon instalado é antigo para este aplicativo",
                format!("O Ergon desta instalação responde, mas é anterior à versão {CORE_MINIMO}, a mínima deste aplicativo. Atualize o Ergon e abra de novo — até lá, use pelo navegador."),
                &["navegador", "tentar", "diagnostico"]);
        } else if deste && !e.inst.teste {
            marcar(&mut d, "com_erro", "O Ergon respondeu com erro",
                format!("O serviço do Ergon desta instalação está ligado, mas respondeu com erro ({status}). Tente de novo em instantes; se continuar, veja o diagnóstico."),
                &["tentar", "diagnostico"]);
        } else {
            marcar(&mut d, "porta_ocupada", &format!("Outra aplicação está usando a porta {porta}"),
                format!("Algo responde em localhost:{porta}, mas não é o serviço do Ergon desta instalação. Por segurança, esta janela não abre esse endereço. Feche a outra aplicação (ou mude a porta do Ergon) e tente de novo."),
                &["tentar", "diagnostico"]);
        }
        return d;
    }

    // 3. o Ergon não responde: por quê?
    if e.inst.teste {
        marcar(&mut d, "parado", "A instância de teste não responde", format!("Nada responde em http://localhost:{porta}."), &["tentar", "diagnostico"]);
        return d;
    }
    match &e.docker {
        Docker::Ausente => marcar(&mut d, "docker_ausente", "O Docker não está instalado",
            "A versão local do Ergon roda no Docker, que guarda os serviços e os dados. Instale o Docker pelo site oficial e volte aqui: nada é instalado sem você pedir.".into(),
            &["ajuda:docker", "tentar"]),
        Docker::SemPermissao(_) => marcar(&mut d, "docker_sem_permissao", "Sem acesso ao Docker",
            "Seu usuário não tem permissão para usar o Docker. O recomendado é o Docker sem root (rootless); a outra saída, entrar no grupo \"docker\", dá a esse usuário poder de administrador sobre o computador. Este aplicativo não muda permissões: a escolha é sua.".into(),
            &["ajuda:docker_rootless", "ajuda:docker_pos_instalacao", "tentar"]),
        Docker::Parado(_) | Docker::Falha(_) => {
            if e.windows && raiz.is_some() {
                marcar(&mut d, "docker_parado", "O Docker está fechado",
                    "O Ergon roda dentro do Docker. Clique em \"Iniciar Ergon\": o Docker Desktop abre e os serviços sobem (leva alguns minutos na primeira vez do dia).".into(),
                    &["iniciar", "tentar", "diagnostico"]);
            } else if e.windows {
                marcar(&mut d, "docker_parado", "O Docker está fechado",
                    "Abra o Docker Desktop e tente de novo.".into(), &["tentar", "diagnostico"]);
            } else {
                marcar(&mut d, "docker_parado", "O serviço do Docker está parado",
                    "Inicie o Docker (o Docker Engine sobe como serviço do sistema: \"sudo systemctl start docker\", ou ative para subir sozinho com \"sudo systemctl enable docker\") e tente de novo.".into(),
                    &["tentar", "ajuda:docker", "diagnostico"]);
            }
        }
        Docker::Pronto(_) => {
            if ergon.map(|c| c.estado == "running").unwrap_or(false) {
                marcar(&mut d, "iniciando", "O Ergon está iniciando", "Os serviços estão ligados, mas o Ergon ainda não responde. Esperando…".into(), &["tentar", "diagnostico"]);
            } else if ergon.is_some() || raiz.is_some() {
                if raiz.is_some() {
                    marcar(&mut d, "parado", "O Ergon está desligado", "Os serviços do Ergon estão instalados, mas parados. Clique em \"Iniciar Ergon\" para ligar.".into(), &["iniciar", "tentar", "diagnostico"]);
                } else {
                    marcar(&mut d, "parado", "O Ergon está desligado", "Os serviços estão parados e a pasta da instalação não foi encontrada: ligue pelo lançador (ergon iniciar) uma vez, para ela ficar registrada.".into(), &["tentar", "diagnostico", "ajuda:instalar_ergon"]);
                }
            } else {
                marcar(&mut d, "nao_instalado", "O Ergon ainda não está instalado neste computador",
                    "Este aplicativo abre o Ergon local, que roda no Docker. Instale os serviços do Ergon (pacote local) e abra o aplicativo de novo.".into(),
                    &["ajuda:instalar_ergon", "tentar"]);
            }
        }
    }
    d
}

pub fn coletar() -> Diagnostico {
    let inst = instalacao::localizar();
    let saude = ler_saude(inst.porta);
    let (docker, conteineres) = if inst.teste && matches!(saude, Resposta::Ergon(_)) {
        (Docker::Falha("não consultado (instância de teste)".into()), vec![])
    } else {
        let d = docker::situacao();
        let c = if matches!(d, Docker::Pronto(_)) { docker::conteineres(&instalacao::projeto(inst.raiz.as_deref())) } else { vec![] };
        (d, c)
    };
    decidir(Entrada { inst, saude, docker, conteineres, windows: cfg!(windows) })
}

#[tauri::command]
pub async fn diagnosticar(app: AppHandle, estado: State<'_, Estado>) -> Result<Diagnostico, String> {
    let d = tauri::async_runtime::spawn_blocking(coletar).await.map_err(|e| e.to_string())?;
    estado.porta.store(d.porta, Ordering::SeqCst);
    *estado.ultimo.lock().map_err(|e| e.to_string())? = Some(d.clone());
    bandeja::atualizar(&app, &d);
    log::info!("diagnóstico: {} (confirmado: {})", d.estado, d.confirmado);
    Ok(d)
}

#[cfg(test)]
mod testes {
    use super::*;

    fn c(servico: &str, estado: &str, portas: &str) -> Conteiner {
        Conteiner { servico: servico.into(), estado: estado.into(), portas: portas.into(), pasta: String::new() }
    }
    fn entrada(saude: Resposta, docker: Docker, conteineres: Vec<Conteiner>) -> Entrada {
        Entrada { inst: Instalacao { raiz: None, porta: 8787, teste: false }, saude, docker, conteineres, windows: true }
    }
    fn ok() -> Resposta {
        Resposta::Ergon(Saude { versao: "0.2.0".into(), trancado: false })
    }

    #[test]
    fn so_confirma_o_conteiner_do_ergon_na_porta() {
        let d = decidir(entrada(ok(), Docker::Pronto("27".into()), vec![c("ergon", "running", "127.0.0.1:8787->8787/tcp"), c("hermes", "running", "")]));
        assert_eq!(d.estado, "pronto");
        assert!(d.confirmado);
        // algo responde na porta, mas o contêiner do Ergon não a publica: outra aplicação
        let d = decidir(entrada(ok(), Docker::Pronto("27".into()), vec![c("ergon", "exited", "")]));
        assert_eq!(d.estado, "porta_ocupada");
        assert!(!d.confirmado);
        // sem Docker não dá para confirmar
        let d = decidir(entrada(ok(), Docker::SemPermissao("x".into()), vec![]));
        assert_eq!(d.estado, "nao_confirmado");
        assert!(!d.confirmado);
    }

    #[test]
    fn resposta_que_nao_e_do_ergon() {
        assert!(interpretar_saude(200, "{\"ok\":true}").is_err());
        assert!(interpretar_saude(200, "<html>").is_err());
        assert!(interpretar_saude(500, "{\"service\":\"ergon\"}").is_err());
        assert_eq!(interpretar_saude(200, "{\"ok\":true,\"service\":\"ergon\",\"version\":\"0.2.0\",\"sealed\":true}").unwrap().trancado, true);
    }

    #[test]
    fn versoes() {
        assert!(versao_ok("0.2.0", "0.2.0"));
        assert!(versao_ok("0.10.1", "0.2.0"));
        assert!(versao_ok("1.0.0-beta", "0.2.0"));
        assert!(!versao_ok("0.1.9", "0.2.0"));
        let d = decidir(entrada(Resposta::Ergon(Saude { versao: "0.1.0".into(), trancado: false }), Docker::Pronto("27".into()), vec![c("ergon", "running", "127.0.0.1:8787->8787/tcp")]));
        assert_eq!(d.estado, "incompativel");
        assert!(!d.confirmado);
    }

    #[test]
    fn motivos_de_nao_responder() {
        assert_eq!(decidir(entrada(Resposta::Nada("x".into()), Docker::Ausente, vec![])).estado, "docker_ausente");
        assert_eq!(decidir(entrada(Resposta::Nada("x".into()), Docker::Parado("x".into()), vec![])).estado, "docker_parado");
        assert_eq!(decidir(entrada(Resposta::Nada("x".into()), Docker::SemPermissao("x".into()), vec![])).estado, "docker_sem_permissao");
        assert_eq!(decidir(entrada(Resposta::Nada("x".into()), Docker::Pronto("27".into()), vec![])).estado, "nao_instalado");
        assert_eq!(decidir(entrada(Resposta::Nada("x".into()), Docker::Pronto("27".into()), vec![c("ergon", "exited", "")])).estado, "parado");
        assert_eq!(decidir(entrada(Resposta::Nada("x".into()), Docker::Pronto("27".into()), vec![c("ergon", "running", "127.0.0.1:8787->8787/tcp")])).estado, "iniciando");
    }

    #[test]
    fn porta_tomada_por_outro() {
        let ergon = || vec![c("ergon", "running", "127.0.0.1:8787->8787/tcp")];
        // outra aplicação na porta, com o Ergon parado (ou sem Docker): não oferece "Iniciar Ergon"
        let d = decidir(entrada(Resposta::Outro(200), Docker::Pronto("27".into()), vec![c("ergon", "exited", "")]));
        assert_eq!(d.estado, "porta_ocupada");
        assert!(!d.acoes.contains(&"iniciar".to_string()));
        assert_eq!(decidir(entrada(Resposta::Outro(404), Docker::Parado("x".into()), vec![])).estado, "porta_ocupada");
        // o contêiner desta instalação publica a porta: Ergon antigo (sem "service") ou com erro
        assert_eq!(decidir(entrada(Resposta::Outro(200), Docker::Pronto("27".into()), ergon())).estado, "incompativel");
        assert_eq!(decidir(entrada(Resposta::Outro(500), Docker::Pronto("27".into()), ergon())).estado, "com_erro");
        assert!(!decidir(entrada(Resposta::Outro(200), Docker::Pronto("27".into()), ergon())).confirmado);
    }

    #[test]
    fn motor_parado_avisa_mas_abre() {
        let d = decidir(entrada(ok(), Docker::Pronto("27".into()), vec![c("ergon", "running", "127.0.0.1:8787->8787/tcp"), c("hermes", "exited", "")]));
        assert_eq!(d.estado, "pronto");
        assert_eq!(d.avisos.len(), 1);
        assert!(d.acoes.contains(&"iniciar".to_string()));
    }
}
