//! Migração do ambiente antigo (com o Docker Engine por dentro) para o ambiente com o Podman, feita na atualização pelo
//! aplicativo. Nada se perde no caminho:
//!   1. o ambiente novo é baixado, conferido e importado AO LADO do antigo ("Ergon-novo");
//!   2. o antigo para (contêineres desligados, ambiente desligado) e fica intacto;
//!   3. os segredos, a configuração e os volumes (dados do Ergon e cofres dos motores) passam para o novo, com donos e
//!      permissões, e a contagem de arquivos de cada volume é conferida;
//!   4. o novo liga com o pacote da versão nova e só é aceito se responder nessa versão com as mesmas contas;
//!   5. aí o antigo sai e o novo assume o nome "Ergon".
//! Qualquer falha antes do passo 5 descarta o novo e religa o antigo como estava.

use crate::ambiente::{self, Evento};
use crate::baixar;
use crate::processo::comando;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const LANCADOR: &str = "/root/.local/share/ergon/ergon.sh";
const VOLUMES_DOCKER: &str = "/var/lib/docker/volumes";

/// Nome gravado quando o Windows não deixa o ambiente novo assumir o nome de antes (ver `assumir_nome`).
pub fn arq_nome() -> PathBuf {
    ambiente::pasta().join("nome-do-ambiente")
}

/// O ambiente instalado ainda é o antigo (com o Docker por dentro, sem o Podman)?
pub fn precisa() -> bool {
    ambiente::ativo()
        && ambiente::rodar_wsl(ambiente::dentro(&["sh", "-c", "command -v docker"]), Duration::from_secs(60)).is_ok()
        && ambiente::rodar_wsl(ambiente::dentro(&["sh", "-c", "command -v podman"]), Duration::from_secs(60)).is_err()
}

/// Nome de volume aceito na cópia (os do projeto "ergon" e os cofres dos motores): sem nada que vire caminho.
fn volume_valido(v: &str) -> bool {
    v.starts_with("ergon_") && v.len() < 128 && v.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
}

fn rodar_em(nome: &str, script: &str, prazo: u64) -> Result<String, String> {
    ambiente::rodar_wsl(ambiente::dentro_de(nome, &["sh", "-c", script]), Duration::from_secs(prazo))
}

/// A saída de um programa vira a entrada de outro (de um ambiente para o outro, sem passar pelo disco do Windows).
fn tubo(mut origem: Command, mut destino: Command, prazo: Duration) -> Result<(), String> {
    origem.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut o = origem.spawn().map_err(|e| e.to_string())?;
    let saida = o.stdout.take().ok_or("sem saída")?;
    destino.stdin(Stdio::from(saida)).stdout(Stdio::null()).stderr(Stdio::null());
    let mut d = match destino.spawn() {
        Ok(d) => d,
        Err(e) => {
            let _ = o.kill();
            return Err(e.to_string());
        }
    };
    let fim = Instant::now() + prazo;
    loop {
        let a = o.try_wait().map_err(|e| e.to_string())?;
        let b = d.try_wait().map_err(|e| e.to_string())?;
        if let (Some(a), Some(b)) = (a, b) {
            return if a.success() && b.success() { Ok(()) } else { Err(format!("cópia interrompida (origem {a}, destino {b})")) };
        }
        if Instant::now() > fim {
            let _ = o.kill();
            let _ = d.kill();
            return Err("a cópia passou do prazo".into());
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn desligar(nome: &str) {
    let mut t = ambiente::wsl_cmd();
    t.arg("--terminate").arg(nome);
    let _ = ambiente::rodar_wsl(t, Duration::from_secs(60));
}
fn descartar(nome: &str) {
    if ambiente::distribuicoes().iter().any(|d| d.eq_ignore_ascii_case(nome)) {
        desligar(nome);
        let mut u = ambiente::wsl_cmd();
        u.arg("--unregister").arg(nome);
        let _ = ambiente::rodar_wsl(u, Duration::from_secs(180));
    }
}

/// Há conta criada no Ergon que está no ar? (para conferir que as contas continuam lá depois de migrar)
fn tem_conta() -> Option<bool> {
    let (st, corpo) = crate::http::get(crate::instalacao::PORTA_PADRAO, "/api/auth/state", Duration::from_secs(10)).ok()?;
    if st != 200 {
        return None;
    }
    let v: Value = serde_json::from_str(&corpo).ok()?;
    v["needsSetup"].as_bool().map(|n| !n)
}

/// Migra e, no fim, deixa o ambiente novo (já na versão nova) com o nome do antigo. `pacote`: o pacote da versão nova,
/// já conferido. Em erro, o antigo está de volta no ar (ou, se nem ele voltar, a mensagem diz).
pub fn migrar(m: &Value, versao: &str, pacote: &Path, ev: &mut dyn FnMut(Evento)) -> Result<(), String> {
    let antigo = ambiente::nome();
    let novo = format!("{antigo}-novo");
    let conta_antes = tem_conta();

    // 1. o ambiente novo, conferido pelo manifesto
    ev(Evento::Etapa("baixar"));
    let c = ambiente::componente(m, "ambiente-wsl")?;
    let (url, sha, tam) = (c["url"].as_str().unwrap_or_default(), c["sha256"].as_str().unwrap_or_default(), c["tamanho"].as_u64().unwrap_or(0));
    let r = baixar::componente(url, sha, tam, &ambiente::pasta().join("cache"), &mut |f, t| ev(Evento::Progresso { componente: "ambiente-wsl".into(), feitos: f, total: t }))
        .map_err(|e| format!("ambiente-wsl: {e}"))?;

    ev(Evento::Etapa("configurar"));
    ev(Evento::Linha("Preparando o ambiente novo do Ergon (com o Podman) ao lado do atual, que fica como está até o novo responder.".into()));
    descartar(&novo); // sobra de uma tentativa anterior
    let disco = ambiente::pasta().join("wsl-novo");
    let _ = std::fs::remove_dir_all(&disco);
    std::fs::create_dir_all(&disco).map_err(|e| e.to_string())?;
    let mut imp = ambiente::wsl_cmd();
    imp.arg("--import").arg(&novo).arg(&disco).arg(&r.caminho).args(["--version", "2"]);
    ambiente::rodar_wsl(imp, Duration::from_secs(15 * 60)).map_err(|e| ambiente::explicar_erro_wsl(&e))?;
    ambiente::sem_boas_vindas_do_wsl();

    let passou = passar(&antigo, &novo, m, versao, pacote, conta_antes, ev);
    ambiente::usar_nome(None);
    match passou {
        // daqui em diante o antigo já saiu: um erro ao religar não volta atrás (os dados estão no novo, conferidos)
        Ok(()) => assumir_nome(&antigo, &novo, ev).map_err(|e| format!("A versão {versao} está instalada com os dados de antes, mas não religou depois da troca ({e}); abra o Ergon de novo.")),
        Err(e) => {
            ev(Evento::Linha(format!("A migração não terminou ({e}); o ambiente de antes volta como estava.")));
            descartar(&novo);
            let _ = std::fs::remove_dir_all(&disco);
            let volta = ambiente::subir(ev);
            Err(if volta.is_ok() {
                format!("A versão {versao} não ficou pronta ({e}); o Ergon de antes voltou e está no ar. Nada se perdeu.")
            } else {
                format!("A versão {versao} não ficou pronta ({e}) e o Ergon de antes não religou sozinho. Os dados estão no ambiente de antes, intactos; veja o diagnóstico.")
            })
        }
    }
}

fn passar(antigo: &str, novo: &str, m: &Value, versao: &str, pacote: &Path, conta_antes: Option<bool>, ev: &mut dyn FnMut(Evento)) -> Result<(), String> {
    // 2. o antigo para: contêineres desligados (se o motor dele estiver ligado) e o ambiente desligado, para a cópia
    // ler os dados quietos
    let _ = rodar_em(antigo, &format!("if docker info >/dev/null 2>&1; then /bin/bash {LANCADOR} parar >/dev/null 2>&1; docker ps -q | xargs -r docker stop >/dev/null 2>&1; fi; true"), 5 * 60);
    desligar(antigo);

    // 3a. segredos, registro, backups e configuração do Ergon
    let mut origem = ambiente::dentro_de(antigo, &["sh", "-c", "cd / && tar -cf - $(for p in root/.ergon root/.local/share/ergon; do [ -e \"$p\" ] && echo \"$p\"; done)"]);
    origem.env("WSL_UTF8", "1");
    tubo(origem, ambiente::dentro_de(novo, &["tar", "--numeric-owner", "-C", "/", "-xpf", "-"]), Duration::from_secs(20 * 60)).map_err(|e| format!("segredos e configuração: {e}"))?;
    rodar_em(novo, "f=/root/.local/share/ergon/.env; touch \"$f\"; sed -i '/^ERGON_MOTOR=/d' \"$f\"; echo ERGON_MOTOR=podman >> \"$f\"", 60)?;
    ev(Evento::Linha("Segredos, backups e configuração copiados para o ambiente novo.".into()));

    // 3b. volumes: dados do Ergon e cofres dos motores (cifrados), com donos, permissões e a contagem conferida
    let lista = rodar_em(antigo, &format!("cd {VOLUMES_DOCKER} 2>/dev/null && for v in ergon_*; do [ -d \"$v/_data\" ] && echo \"$v\"; done; true"), 120)?;
    let volumes: Vec<&str> = lista.lines().map(str::trim).filter(|v| volume_valido(v)).collect();
    for v in &volumes {
        rodar_em(novo, &format!("podman volume create --ignore {v} >/dev/null"), 120)?;
        let destino = rodar_em(novo, &format!("podman volume inspect --format '{{{{.Mountpoint}}}}' {v}"), 60)?.trim().to_string();
        if !destino.starts_with('/') || destino.contains(char::is_whitespace) {
            return Err(format!("volume {v}: lugar inesperado no ambiente novo"));
        }
        let fonte = format!("{VOLUMES_DOCKER}/{v}/_data");
        tubo(ambiente::dentro_de(antigo, &["tar", "-C", &fonte, "-cf", "-", "."]), ambiente::dentro_de(novo, &["tar", "--numeric-owner", "-C", &destino, "-xpf", "-"]), Duration::from_secs(60 * 60))
            .map_err(|e| format!("volume {v}: {e}"))?;
        let conta = |nome: &str, pasta: &str| rodar_em(nome, &format!("find '{pasta}' | wc -l"), 600).map(|t| t.trim().to_string());
        let (a, b) = (conta(antigo, &fonte)?, conta(novo, &destino)?);
        if a != b {
            return Err(format!("volume {v}: {a} arquivo(s) no antigo e {b} no novo"));
        }
        ev(Evento::Linha(format!("Volume {v} copiado e conferido ({a} itens).")));
    }
    desligar(antigo);

    // 4. o novo liga com o pacote da versão nova (os comandos "dentro" passam a ir para ele)
    ambiente::usar_nome(Some(novo.to_string()));
    ambiente::entregar_pacote(pacote)?;
    ambiente::fixar_imagens(m, versao)?;
    ev(Evento::Etapa("ligar"));
    ambiente::ligar_motor_de_conteineres(ev)?;
    let mut c = ambiente::dentro(&["env", "ERGON_SEM_NAVEGADOR=1", "/bin/bash", "/opt/ergon-pacote/ergon.sh", "instalar"]);
    ambiente::transmitir(&mut c, Duration::from_secs(40 * 60), ev).map_err(|e| format!("a versão nova não ligou: {e}"))?;

    ev(Evento::Etapa("conferir"));
    let fim = Instant::now() + Duration::from_secs(300);
    loop {
        match crate::diag::ler_saude(crate::instalacao::PORTA_PADRAO) {
            crate::diag::Resposta::Ergon(s) if s.versao == versao => break,
            r if Instant::now() > fim => return Err(format!("o Ergon novo não respondeu ({r:?})")),
            _ => std::thread::sleep(Duration::from_secs(3)),
        }
    }
    // trancado depois de reiniciar, o estado das contas ainda responde
    if conta_antes == Some(true) && tem_conta() != Some(true) {
        return Err("o Ergon novo respondeu sem as contas de antes".into());
    }
    ev(Evento::Linha(format!("Ergon {versao} no ar no ambiente novo, com os dados de antes.")));
    Ok(())
}

/// O antigo sai e o novo passa a se chamar como ele (o aplicativo, o desinstalador e os atalhos usam esse nome). A troca
/// do nome é a da própria lista de distribuições do WSL (no registro da conta, sem administrador); se ela não pegar, o
/// nome novo fica gravado e o aplicativo passa a usá-lo.
fn assumir_nome(antigo: &str, novo: &str, ev: &mut dyn FnMut(Evento)) -> Result<(), String> {
    desligar(novo);
    descartar(antigo);
    let _ = std::fs::remove_dir_all(ambiente::pasta().join("wsl"));
    if renomear(novo, antigo) && ambiente::distribuicoes().iter().any(|d| d.eq_ignore_ascii_case(antigo)) {
        let _ = std::fs::remove_file(arq_nome());
        ev(Evento::Linha("Ambiente de antes removido; o novo assumiu o lugar dele.".into()));
    } else {
        let _ = std::fs::write(arq_nome(), novo);
        ev(Evento::Linha(format!("Ambiente de antes removido; o novo segue com o nome \"{novo}\".")));
    }
    // desligar o novo acima parou os serviços: o Ergon liga de novo, já pelo nome final
    ambiente::subir(ev)
}

fn renomear(de: &str, para: &str) -> bool {
    let raiz = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss";
    let mut q = comando(ambiente::reg_exe());
    q.args(["query", raiz, "/s", "/f", de, "/d", "/e"]);
    let Ok(o) = crate::processo::rodar(q, Duration::from_secs(30)) else { return false };
    let texto = String::from_utf8_lossy(&o.stdout).to_string();
    let mut chave = None;
    let mut atual = None;
    for l in texto.lines() {
        let l = l.trim();
        if l.starts_with("HKEY_") {
            atual = Some(l.to_string());
        } else if l.starts_with("DistributionName") && l.split_whitespace().last() == Some(de) {
            chave = atual.clone();
        }
    }
    let Some(chave) = chave else { return false };
    let mut a = comando(ambiente::reg_exe());
    a.args(["add", &chave, "/v", "DistributionName", "/t", "REG_SZ", "/d", para, "/f"]);
    crate::processo::rodar(a, Duration::from_secs(30)).map(|o| o.status.success()).unwrap_or(false)
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn so_copia_volumes_do_ergon_com_nome_simples() {
        assert!(volume_valido("ergon_ergon-data"));
        assert!(volume_valido("ergon_motor-0f3a"));
        assert!(!volume_valido("outro_dados"));
        assert!(!volume_valido("ergon_../etc"));
        assert!(!volume_valido("ergon_a b"));
        assert!(!volume_valido("ergon_$(x)"));
    }
}
