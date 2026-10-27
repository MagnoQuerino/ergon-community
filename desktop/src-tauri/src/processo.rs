//! Programas externos (docker, o lançador do Ergon) com argumentos fixos, sem janela de terminal e com prazo.

use std::io::{self, Read};
use std::process::{Command, Output, Stdio};
use std::thread;
use std::time::{Duration, Instant};

/// Um comando que nunca abre janela de terminal no Windows.
pub fn comando(programa: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut c = Command::new(programa);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// Roda até o fim ou até o prazo (aí encerra o processo). Lê as saídas em paralelo para nunca travar no pipe.
pub fn rodar(mut c: Command, prazo: Duration) -> io::Result<Output> {
    c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut filho = c.spawn()?;
    let mut saida = filho.stdout.take().expect("stdout");
    let mut erro = filho.stderr.take().expect("stderr");
    let t1 = thread::spawn(move || {
        let mut b = Vec::new();
        let _ = saida.read_to_end(&mut b);
        b
    });
    let t2 = thread::spawn(move || {
        let mut b = Vec::new();
        let _ = erro.read_to_end(&mut b);
        b
    });
    let fim = Instant::now() + prazo;
    let status = loop {
        if let Some(s) = filho.try_wait()? {
            break s;
        }
        if Instant::now() >= fim {
            let _ = filho.kill();
            let _ = filho.wait();
            return Err(io::Error::new(io::ErrorKind::TimedOut, "o programa não terminou no prazo"));
        }
        thread::sleep(Duration::from_millis(100));
    };
    Ok(Output { status, stdout: t1.join().unwrap_or_default(), stderr: t2.join().unwrap_or_default() })
}

/// Texto de uma saída sem as cores do terminal e sem linhas vazias.
pub fn linhas(bytes: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(bytes).lines().map(sem_cores).map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()
}

/// Tira as sequências ANSI (cores do PowerShell e do bash) de uma linha.
pub fn sem_cores(l: &str) -> String {
    let mut s = String::with_capacity(l.len());
    let mut it = l.chars().peekable();
    while let Some(ch) = it.next() {
        if ch == '\u{1b}' {
            if it.peek() == Some(&'[') {
                it.next();
                for c in it.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        s.push(ch);
    }
    s
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn tira_cores() {
        assert_eq!(sem_cores("\u{1b}[31m[ergon] falhou\u{1b}[0m"), "[ergon] falhou");
        assert_eq!(linhas(b"  a  \n\n\x1b[1mb\x1b[0m\n"), vec!["a", "b"]);
    }
}
