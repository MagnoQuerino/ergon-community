//! Download de um componente do manifesto: só de origem permitida (conferida a cada redirecionamento), sem nenhuma
//! credencial, em área de preparo, com retomada (Range) depois de queda de rede ou de o computador desligar, e
//! conferido por tamanho e SHA-256 antes de sair do preparo. Um componente que já está no cache e confere não é
//! baixado de novo; o que não confere é apagado, nunca executado.

use crate::confianca::{origem_permitida, Recusa};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

const REDIRECIONAMENTOS: usize = 5;
const TENTATIVAS: u32 = 6;

#[derive(Debug, Clone, Default)]
pub struct Resultado {
    pub caminho: PathBuf,
    /// bytes baixados nesta chamada (0: já estava no cache)
    pub baixados: u64,
    pub retomado: bool,
}

fn agente() -> ureq::Agent {
    ureq::AgentBuilder::new()
        .redirects(0) // cada salto é conferido aqui
        .timeout_connect(Duration::from_secs(20))
        .timeout_read(Duration::from_secs(60))
        .user_agent(concat!("ErgonDesktop/", env!("CARGO_PKG_VERSION")))
        .build()
}

fn erro(codigo: &'static str, m: impl Into<String>) -> Recusa {
    Recusa { codigo, mensagem: m.into() }
}

/// GET seguindo redirecionamentos só entre origens permitidas.
fn pedir(ag: &ureq::Agent, url: &str, desde: u64) -> Result<ureq::Response, Recusa> {
    let mut atual = url.to_string();
    for _ in 0..=REDIRECIONAMENTOS {
        if !origem_permitida(&atual) {
            return Err(erro("ORIGEM", format!("{} fora das origens permitidas", host(&atual))));
        }
        let mut p = ag.get(&atual);
        if desde > 0 {
            p = p.set("Range", &format!("bytes={desde}-"));
        }
        let r = match p.call() {
            Ok(r) => r,
            Err(ureq::Error::Status(c, r)) if c == 416 => return Ok(r),
            Err(ureq::Error::Status(c, _)) => return Err(erro("REDE", format!("{c} em {}", host(&atual)))),
            Err(e) => return Err(erro("REDE", e.to_string())),
        };
        if (300..400).contains(&r.status()) {
            let Some(l) = r.header("location") else { return Err(erro("REDE", "redirecionamento sem destino")) };
            atual = juntar(&atual, l);
            continue;
        }
        return Ok(r);
    }
    Err(erro("ORIGEM", "redirecionamentos demais"))
}

fn host(url: &str) -> &str {
    url.split("://").nth(1).and_then(|r| r.split(['/', '?']).next()).unwrap_or(url)
}

/// Location absoluto ou relativo ao host atual.
fn juntar(base: &str, l: &str) -> String {
    if l.contains("://") {
        return l.to_string();
    }
    let origem = base.split_once("://").map(|(e, r)| format!("{e}://{}", r.split('/').next().unwrap_or(""))).unwrap_or_default();
    if l.starts_with('/') { format!("{origem}{l}") } else { format!("{origem}/{l}") }
}

pub fn sha256_arquivo(p: &Path) -> io::Result<String> {
    let mut f = File::open(p)?;
    let mut h = Sha256::new();
    let mut b = vec![0u8; 1 << 16];
    loop {
        let n = f.read(&mut b)?;
        if n == 0 {
            break;
        }
        h.update(&b[..n]);
    }
    Ok(h.finalize().iter().map(|x| format!("{x:02x}")).collect())
}

/// Pequeno (manifesto, assinatura): para a memória, com limite.
pub fn baixar_para_memoria(url: &str, limite: u64) -> Result<Vec<u8>, Recusa> {
    let r = pedir(&agente(), url, 0)?;
    let mut v = Vec::new();
    r.into_reader().take(limite + 1).read_to_end(&mut v).map_err(|e| erro("REDE", e.to_string()))?;
    if v.len() as u64 > limite {
        return Err(erro("TAMANHO", "resposta maior que o limite"));
    }
    Ok(v)
}

/// Baixa (ou reaproveita) o componente para <pasta>/componentes/<sha256>. progresso(feitos, total).
pub fn componente(url: &str, sha256: &str, tamanho: u64, pasta: &Path, progresso: &mut dyn FnMut(u64, u64)) -> Result<Resultado, Recusa> {
    if sha256.len() != 64 || !sha256.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err(erro("FORMATO", "SHA-256 inválido"));
    }
    let io_ = |e: io::Error| erro("DISCO", e.to_string());
    let (comps, preparo) = (pasta.join("componentes"), pasta.join("preparo"));
    fs::create_dir_all(&comps).map_err(io_)?;
    fs::create_dir_all(&preparo).map_err(io_)?;
    let fim = comps.join(sha256);
    if fim.is_file() {
        if fs::metadata(&fim).map(|m| m.len()).unwrap_or(0) == tamanho && sha256_arquivo(&fim).map_err(io_)? == sha256 {
            progresso(tamanho, tamanho);
            return Ok(Resultado { caminho: fim, baixados: 0, retomado: false });
        }
        fs::remove_file(&fim).map_err(io_)?; // estragado no cache: baixa de novo
    }
    let parcial = preparo.join(format!("{sha256}.parcial"));
    let ag = agente();
    let mut baixados = 0u64;
    let mut retomado = false;
    let mut tentativa = 0u32;
    loop {
        let ja = fs::metadata(&parcial).map(|m| m.len()).unwrap_or(0);
        if ja > tamanho {
            fs::remove_file(&parcial).map_err(io_)?;
            continue;
        }
        if ja < tamanho {
            if ja > 0 {
                retomado = true;
            }
            match receber(&ag, url, &parcial, ja, tamanho, &mut baixados, progresso) {
                Ok(()) => {}
                Err(e) if e.codigo == "REDE" && tentativa + 1 < TENTATIVAS => {
                    tentativa += 1;
                    log::warn!("download interrompido ({e}); tentativa {tentativa}");
                    std::thread::sleep(Duration::from_secs(u64::from(2u32.pow(tentativa.min(5)))));
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
        // completo: confere antes de sair do preparo
        let n = fs::metadata(&parcial).map(|m| m.len()).unwrap_or(0);
        if n != tamanho {
            continue;
        }
        let h = sha256_arquivo(&parcial).map_err(io_)?;
        if h != sha256 {
            fs::remove_file(&parcial).ok();
            return Err(erro("HASH", "o arquivo baixado não confere com o manifesto (apagado)"));
        }
        fs::rename(&parcial, &fim).map_err(io_)?;
        return Ok(Resultado { caminho: fim, baixados, retomado });
    }
}

fn receber(ag: &ureq::Agent, url: &str, parcial: &Path, ja: u64, tamanho: u64, baixados: &mut u64, progresso: &mut dyn FnMut(u64, u64)) -> Result<(), Recusa> {
    let r = pedir(ag, url, ja)?;
    let status = r.status();
    let (mut f, mut feitos) = match status {
        206 => (OpenOptions::new().append(true).open(parcial).map_err(|e| erro("DISCO", e.to_string()))?, ja),
        200 => (File::create(parcial).map_err(|e| erro("DISCO", e.to_string()))?, 0), // o servidor não retomou: do começo
        416 if ja == tamanho => return Ok(()),
        c => return Err(erro("REDE", format!("resposta {c}"))),
    };
    let mut leitor = r.into_reader();
    let mut b = vec![0u8; 1 << 16];
    loop {
        let n = match leitor.read(&mut b) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => return Err(erro("REDE", e.to_string())),
        };
        if feitos + n as u64 > tamanho {
            drop(f);
            fs::remove_file(parcial).ok();
            return Err(erro("TAMANHO", "o servidor mandou mais que o tamanho do manifesto (apagado)"));
        }
        f.write_all(&b[..n]).map_err(|e| erro("DISCO", e.to_string()))?;
        feitos += n as u64;
        *baixados += n as u64;
        progresso(feitos, tamanho);
    }
    f.sync_all().map_err(|e| erro("DISCO", e.to_string()))?;
    if feitos < tamanho {
        return Err(erro("REDE", "conexão encerrada antes do fim"));
    }
    Ok(())
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn juntar_redirecionamentos() {
        assert_eq!(juntar("https://github.com/a/b", "https://objects.githubusercontent.com/x"), "https://objects.githubusercontent.com/x");
        assert_eq!(juntar("https://github.com/a/b", "/c/d"), "https://github.com/c/d");
        assert_eq!(host("https://github.com/a?b"), "github.com");
    }

    #[test]
    fn origem_proibida_nem_conecta() {
        let d = std::env::temp_dir().join(format!("ergon-baixar-{}", std::process::id()));
        let r = componente("https://exemplo.com/a.zip", &"0".repeat(64), 1, &d, &mut |_, _| {});
        assert_eq!(r.unwrap_err().codigo, "ORIGEM");
        fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn cache_que_confere_nao_baixa() {
        let d = std::env::temp_dir().join(format!("ergon-baixar-cache-{}", std::process::id()));
        fs::create_dir_all(d.join("componentes")).unwrap();
        let dados = b"componente";
        let h = crate::confianca::sha256_hex(dados);
        fs::write(d.join("componentes").join(&h), dados).unwrap();
        // URL proibida de propósito: se tentasse baixar, recusaria
        let r = componente("https://exemplo.com/x", &h, dados.len() as u64, &d, &mut |_, _| {}).unwrap();
        assert_eq!(r.baixados, 0);
        fs::remove_dir_all(&d).ok();
    }
}
