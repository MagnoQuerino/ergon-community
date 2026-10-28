//! GET mínimo em HTTP/1.1 para o próprio computador (127.0.0.1). Só lê a saúde do Ergon: nada de cookies, senhas
//! ou tokens passa por aqui, e nenhum endereço fora do computador é aceito.

use std::io::{Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpStream};
use std::time::Duration;

const LIMITE: usize = 64 * 1024;

/// Resposta: código HTTP e corpo em texto.
pub fn get(porta: u16, caminho: &str, prazo: Duration) -> Result<(u16, String), String> {
    if !caminho.starts_with('/') || caminho.contains(['\r', '\n', ' ']) {
        return Err("caminho inválido".into());
    }
    let endereco = SocketAddr::from((Ipv4Addr::LOCALHOST, porta));
    let mut s = TcpStream::connect_timeout(&endereco, prazo).map_err(|e| format!("sem resposta em 127.0.0.1:{porta} ({e})"))?;
    s.set_read_timeout(Some(prazo)).ok();
    s.set_write_timeout(Some(prazo)).ok();
    let pedido = format!(
        "GET {caminho} HTTP/1.1\r\nHost: localhost:{porta}\r\nAccept: application/json\r\nUser-Agent: ErgonDesktop/{}\r\nConnection: close\r\n\r\n",
        env!("CARGO_PKG_VERSION")
    );
    s.write_all(pedido.as_bytes()).map_err(|e| e.to_string())?;
    let mut bruto = Vec::new();
    s.take(LIMITE as u64).read_to_end(&mut bruto).map_err(|e| format!("resposta interrompida ({e})"))?;
    interpretar(&bruto)
}

/// Separa status, cabeçalhos e corpo (com "Transfer-Encoding: chunked" ou não).
pub fn interpretar(bruto: &[u8]) -> Result<(u16, String), String> {
    let fim = bruto.windows(4).position(|w| w == b"\r\n\r\n").ok_or("resposta sem cabeçalho")?;
    let cab = String::from_utf8_lossy(&bruto[..fim]);
    let mut l = cab.lines();
    let status: u16 = l
        .next()
        .and_then(|s| s.split_whitespace().nth(1))
        .and_then(|c| c.parse().ok())
        .ok_or("linha de status inválida")?;
    let chunked = l.any(|h| {
        let h = h.to_ascii_lowercase();
        h.starts_with("transfer-encoding:") && h.contains("chunked")
    });
    let corpo = &bruto[fim + 4..];
    let corpo = if chunked { desfazer_chunks(corpo)? } else { corpo.to_vec() };
    Ok((status, String::from_utf8_lossy(&corpo).into_owned()))
}

fn desfazer_chunks(mut b: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    loop {
        let nl = b.windows(2).position(|w| w == b"\r\n").ok_or("pedaço sem tamanho")?;
        let tam_txt = String::from_utf8_lossy(&b[..nl]);
        let tam = usize::from_str_radix(tam_txt.split(';').next().unwrap_or("").trim(), 16).map_err(|_| "tamanho de pedaço inválido")?;
        b = &b[nl + 2..];
        if tam == 0 {
            return Ok(out);
        }
        if b.len() < tam {
            return Err("pedaço incompleto".into());
        }
        out.extend_from_slice(&b[..tam]);
        b = b.get(tam + 2..).unwrap_or(&[]);
    }
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn corpo_simples() {
        let r = interpretar(b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{\"ok\":true}").unwrap();
        assert_eq!(r, (200, "{\"ok\":true}".to_string()));
    }

    #[test]
    fn corpo_em_pedacos() {
        let r = interpretar(b"HTTP/1.1 200 OK\r\ntransfer-encoding: chunked\r\n\r\n4\r\n{\"ok\r\n7\r\n\":true}\r\n0\r\n\r\n").unwrap();
        assert_eq!(r.1, "{\"ok\":true}");
    }

    #[test]
    fn recusa_lixo() {
        assert!(interpretar(b"isto nao e http").is_err());
        assert!(get(1, "/x y", Duration::from_millis(10)).is_err());
    }
}
