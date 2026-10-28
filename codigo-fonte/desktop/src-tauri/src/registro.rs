//! Registro do aplicativo (estados e erros, nunca senhas, tokens ou endereços de login): arquivo "ergon-desktop.log"
//! na pasta de registros do aplicativo e a saída de erro. Se a pasta não estiver disponível, o aplicativo abre do
//! mesmo jeito — registro nunca impede a partida.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

const LIMITE: u64 = 512 * 1024;

struct Registro {
    arquivo: Mutex<Option<File>>,
}

static REGISTRO: Registro = Registro { arquivo: Mutex::new(None) };

impl log::Log for Registro {
    fn enabled(&self, m: &log::Metadata) -> bool {
        m.level() <= log::Level::Info && m.target().starts_with("ergon_desktop")
    }
    fn log(&self, r: &log::Record) {
        if !self.enabled(r.metadata()) {
            return;
        }
        let linha = format!("[{}][{}][{}] {}\n", agora(), r.level(), r.target(), r.args());
        eprint!("{linha}");
        if let Ok(mut a) = self.arquivo.lock() {
            if let Some(f) = a.as_mut() {
                let _ = f.write_all(linha.as_bytes());
            }
        }
    }
    fn flush(&self) {}
}

/// Hora UTC "AAAA-MM-DD HH:MM:SS" sem dependências.
fn agora() -> String {
    let s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (dias, resto) = (s / 86_400, s % 86_400);
    // dias desde 1970-01-01 → data (algoritmo de Howard Hinnant)
    let z = dias as i64 + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let a = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    format!("{a:04}-{m:02}-{d:02} {:02}:{:02}:{:02}", resto / 3600, resto % 3600 / 60, resto % 60)
}

/// Liga o registro (só a saída de erro, por enquanto).
pub fn iniciar() {
    let _ = log::set_logger(&REGISTRO);
    log::set_max_level(log::LevelFilter::Info);
}

/// Passa a gravar também na pasta de registros (começa de novo quando o arquivo passa de 512 KB).
pub fn gravar_em(pasta: &Path) {
    if fs::create_dir_all(pasta).is_err() {
        return;
    }
    let f = pasta.join("ergon-desktop.log");
    let grande = fs::metadata(&f).map(|m| m.len() > LIMITE).unwrap_or(false);
    let aberto = if grande { File::create(&f) } else { OpenOptions::new().create(true).append(true).open(&f) };
    if let (Ok(a), Ok(mut slot)) = (aberto, REGISTRO.arquivo.lock()) {
        *slot = Some(a);
    }
}

#[cfg(test)]
mod testes {
    #[test]
    fn data_legivel() {
        let a = super::agora();
        assert_eq!(a.len(), 19);
        assert!(a.starts_with("20"));
    }
}
