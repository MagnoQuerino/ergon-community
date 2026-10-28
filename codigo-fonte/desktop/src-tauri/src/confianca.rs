//! Manifesto de versão assinado: o aplicativo só usa um manifesto que confere com uma chave do chaveiro embutido
//! (scripts/distribuicao/chaves.json) e com as regras abaixo — as mesmas do verificador de referência
//! (scripts/distribuicao/manifesto.mjs). Os dois passam pelos mesmos casos (testes/vetores-manifesto.json).

use base64::Engine;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::BTreeMap;

pub const FORMATO: u64 = 1;
pub const ORIGENS: [&str; 5] = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com", "ghcr.io", "pkg-containers.githubusercontent.com"];
const CHAVEIRO: &str = include_str!("../../../scripts/distribuicao/chaves.json");
/// prefixo DER (SPKI) de uma chave pública Ed25519: o resto são os 32 bytes da chave
const SPKI_ED25519: [u8; 12] = [0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Recusa {
    pub codigo: &'static str,
    pub mensagem: String,
}
impl std::fmt::Display for Recusa {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.codigo, self.mensagem)
    }
}
fn recusa<T>(codigo: &'static str, mensagem: impl Into<String>) -> Result<T, Recusa> {
    Err(Recusa { codigo, mensagem: mensagem.into() })
}

#[derive(Debug, Clone)]
pub struct Chave {
    pub publica: [u8; 32],
    pub revogada_em: Option<i64>,
}
pub type Chaveiro = BTreeMap<String, Chave>;

pub fn chaveiro_de(json: &str) -> Result<Chaveiro, String> {
    let v: Value = serde_json::from_str(json).map_err(|e| e.to_string())?;
    let mut c = Chaveiro::new();
    for (id, k) in v.as_object().ok_or("chaveiro não é um objeto")? {
        let der = base64::engine::general_purpose::STANDARD.decode(k["publica"].as_str().ok_or("sem chave pública")?).map_err(|e| e.to_string())?;
        if der.len() != 44 || der[..12] != SPKI_ED25519 {
            return Err(format!("{id}: não é uma chave Ed25519"));
        }
        let revogada_em = match k.get("revogadaEm").and_then(|r| r.as_str()) {
            Some(r) => Some(instante(r).ok_or(format!("{id}: data de revogação inválida"))?),
            None => None,
        };
        c.insert(id.clone(), Chave { publica: der[12..].try_into().unwrap(), revogada_em });
    }
    Ok(c)
}

/// O chaveiro que vem com este aplicativo.
pub fn chaveiro_embutido() -> Chaveiro {
    chaveiro_de(CHAVEIRO).expect("chaveiro embutido inválido")
}

// ------------------------------------------------------------------------------------------------- datas
/// "2026-10-27T19:22:47.180Z" (ou sem frações / com fuso ±hh:mm) → milissegundos desde 1970, em UTC.
pub fn instante(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    if b.len() < 19 || b[4] != b'-' || b[7] != b'-' || !(b[10] == b'T' || b[10] == b' ') || b[13] != b':' || b[16] != b':' {
        return None;
    }
    let n = |a: usize, z: usize| s.get(a..z)?.parse::<i64>().ok();
    let (ano, mes, dia, h, mi, se) = (n(0, 4)?, n(5, 7)?, n(8, 10)?, n(11, 13)?, n(14, 16)?, n(17, 19)?);
    if !(1..=12).contains(&mes) || !(1..=31).contains(&dia) || h > 23 || mi > 59 || se > 60 {
        return None;
    }
    let mut resto = &s[19..];
    let mut ms = 0i64;
    if let Some(r) = resto.strip_prefix('.') {
        let fim = r.find(|c: char| !c.is_ascii_digit()).unwrap_or(r.len());
        if fim == 0 {
            return None;
        }
        let frac = &r[..fim];
        ms = format!("{:0<3}", &frac[..frac.len().min(3)]).parse().ok()?;
        resto = &r[fim..];
    }
    let fuso = match resto {
        "Z" | "" => 0,
        f if f.len() == 6 && (f.starts_with('+') || f.starts_with('-')) && &f[3..4] == ":" => {
            let m = f[1..3].parse::<i64>().ok()? * 60 + f[4..6].parse::<i64>().ok()?;
            if f.starts_with('+') { m } else { -m }
        }
        _ => return None,
    };
    // dias desde 1970 (algoritmo de Howard Hinnant)
    let (y, m) = if mes <= 2 { (ano - 1, mes + 9) } else { (ano, mes - 3) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * m + 2) / 5 + dia - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let dias = era * 146097 + doe - 719468;
    Some(((dias * 86400 + h * 3600 + mi * 60 + se - fuso * 60) * 1000) + ms)
}

pub fn agora_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

// ------------------------------------------------------------------------------------------------- versões
fn partes(v: &str) -> Result<(u64, u64, u64, Option<&str>), Recusa> {
    let (num, pre) = match v.split_once('-') {
        Some((n, p)) => (n, Some(p)),
        None => (v, None),
    };
    let ns: Vec<&str> = num.split('.').collect();
    let ok = ns.len() == 3 && ns.iter().all(|x| !x.is_empty() && x.bytes().all(|c| c.is_ascii_digit()));
    let pre_ok = pre.is_none_or(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-'));
    if !ok || !pre_ok {
        return recusa("FORMATO", format!("versão inválida: {v}"));
    }
    let p = |i: usize| ns[i].parse::<u64>().map_err(|_| Recusa { codigo: "FORMATO", mensagem: format!("versão inválida: {v}") });
    Ok((p(0)?, p(1)?, p(2)?, pre))
}

/// x.y.z[-pre]: pré-versão vem antes da versão final (1.0.2-rc.1 < 1.0.2).
pub fn comparar_versoes(a: &str, b: &str) -> Result<Ordering, Recusa> {
    let (x, y) = (partes(a)?, partes(b)?);
    let o = (x.0, x.1, x.2).cmp(&(y.0, y.1, y.2));
    if o != Ordering::Equal {
        return Ok(o);
    }
    Ok(match (x.3, y.3) {
        (None, None) => Ordering::Equal,
        (None, Some(_)) => Ordering::Greater,
        (Some(_), None) => Ordering::Less,
        (Some(p), Some(q)) => {
            let (ps, qs): (Vec<&str>, Vec<&str>) = (p.split('.').collect(), q.split('.').collect());
            for i in 0..ps.len().max(qs.len()) {
                let (Some(a), Some(b)) = (ps.get(i), qs.get(i)) else { return Ok(ps.len().cmp(&qs.len())) };
                let (na, nb) = (a.bytes().all(|c| c.is_ascii_digit()), b.bytes().all(|c| c.is_ascii_digit()));
                let o = match (na, nb) {
                    (true, true) => a.parse::<u64>().unwrap_or(0).cmp(&b.parse::<u64>().unwrap_or(0)),
                    (true, false) => Ordering::Less,
                    (false, true) => Ordering::Greater,
                    _ => a.cmp(b),
                };
                if o != Ordering::Equal {
                    return Ok(o);
                }
            }
            Ordering::Equal
        }
    })
}

// ------------------------------------------------------------------------------------------------- origens
/// HTTPS, sem usuário, senha ou porta, num dos hosts permitidos. Em testes (recurso "origens-de-teste"), também
/// http://127.0.0.1:<porta> — nunca no aplicativo publicado.
pub fn origem_permitida(url: &str) -> bool {
    if cfg!(feature = "origens-de-teste") {
        if let Some(r) = url.strip_prefix("http://127.0.0.1:") {
            return r.split('/').next().is_some_and(|p| p.parse::<u16>().is_ok());
        }
    }
    let Some(resto) = url.strip_prefix("https://") else { return false };
    let autoridade = resto.split(['/', '?', '#']).next().unwrap_or("");
    !autoridade.contains(['@', ':']) && ORIGENS.contains(&autoridade)
}

// ------------------------------------------------------------------------------------------------- forma
fn hex64(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c))
}
fn digest(s: &str) -> bool {
    s.strip_prefix("sha256:").is_some_and(hex64)
}

pub fn validar_forma(m: &Value) -> Result<(), Recusa> {
    let f = |cond: bool, msg: &str| if cond { Ok(()) } else { recusa("FORMATO", msg.to_string()) };
    f(m.is_object(), "manifesto não é um objeto")?;
    f(m["formato"].as_u64() == Some(FORMATO), "formato desconhecido")?;
    f(m["produto"] == "ergon", "produto diferente")?;
    f(matches!(m["edicao"].as_str(), Some("community" | "proprietary")), "edição desconhecida")?;
    f(matches!(m["canal"].as_str(), Some("estavel" | "teste")), "canal desconhecido")?;
    partes(m["versao"].as_str().unwrap_or(""))?;
    f(m["sequencia"].as_u64().is_some_and(|s| s > 0 && s <= 9_007_199_254_740_991), "sequência inválida")?;
    let (e, v) = (m["emitidoEm"].as_str().and_then(instante), m["validoAte"].as_str().and_then(instante));
    f(e.is_some() && v.is_some(), "datas inválidas")?;
    f(v > e, "validade antes da emissão")?;
    if let Some(c) = m.get("clienteMinimo") {
        partes(c.as_str().unwrap_or(""))?;
    }
    let comps = m["componentes"].as_object().filter(|o| !o.is_empty());
    f(comps.is_some(), "sem componentes")?;
    for (id, c) in comps.unwrap() {
        f(id.len() >= 2 && id.len() <= 40 && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'), "componente com nome inválido")?;
        match c["tipo"].as_str() {
            Some("oci") => {
                let img = c["imagem"].as_str().unwrap_or("");
                let nome_ok = img.strip_prefix("ghcr.io/").is_some_and(|r| !r.is_empty() && r.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._/-".contains(&b)));
                f(nome_ok, &format!("{id}: imagem inválida"))?;
                f(digest(c["digest"].as_str().unwrap_or("")), &format!("{id}: digest inválido"))?;
                let pl = c["plataformas"].as_object();
                f(pl.is_some_and(|p| p.values().all(|d| d.as_str().is_some_and(digest))), &format!("{id}: digest de plataforma inválido"))?;
            }
            Some("arquivo") => {
                let url = c["url"].as_str();
                f(url.is_some(), &format!("{id}: sem url"))?;
                f(hex64(c["sha256"].as_str().unwrap_or("")), &format!("{id}: SHA-256 inválido"))?;
                f(c["tamanho"].as_u64().is_some_and(|t| t > 0), &format!("{id}: tamanho inválido"))?;
                if !origem_permitida(url.unwrap()) {
                    return recusa("ORIGEM", format!("{id}: {} fora das origens permitidas", url.unwrap()));
                }
            }
            _ => return recusa("FORMATO", format!("{id}: tipo desconhecido")),
        }
    }
    Ok(())
}

// ------------------------------------------------------------------------------------------------- assinatura
pub fn conferir_assinatura(bytes: &[u8], sig: &[u8], chaves: &Chaveiro, agora: i64) -> Result<String, Recusa> {
    let s: Value = serde_json::from_slice(sig).or_else(|_| recusa("ASSINATURA", "arquivo de assinatura ilegível"))?;
    let (Some(id), Some(valor)) = (s["keyId"].as_str(), s["assinatura"].as_str()) else {
        return recusa("ASSINATURA", "assinatura sem chave ou valor");
    };
    if id.len() < 3 || id.len() > 40 || !id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
        return recusa("ASSINATURA", "assinatura sem chave ou valor");
    }
    let Some(k) = chaves.get(id) else { return recusa("CHAVE_DESCONHECIDA", format!("chave {id} não está no chaveiro deste aplicativo")) };
    if k.revogada_em.is_some_and(|r| r <= agora) {
        return recusa("CHAVE_REVOGADA", format!("chave {id} revogada"));
    }
    let ass = base64::engine::general_purpose::STANDARD.decode(valor).ok().and_then(|b| <[u8; 64]>::try_from(b.as_slice()).ok());
    let pub_ = VerifyingKey::from_bytes(&k.publica).ok();
    let ok = match (ass, pub_) {
        (Some(a), Some(p)) => p.verify_strict(bytes, &Signature::from_bytes(&a)).is_ok(),
        _ => false,
    };
    if !ok {
        return recusa("ASSINATURA", "a assinatura não confere com o manifesto");
    }
    Ok(id.to_string())
}

#[derive(Debug, Clone, Default)]
pub struct EstadoAceito {
    pub ultima_sequencia: Option<u64>,
    pub versao_instalada: Option<String>,
}

pub struct Opcoes<'a> {
    pub chaves: &'a Chaveiro,
    pub edicao: &'a str,
    pub canal: &'a str,
    pub estado: &'a EstadoAceito,
    pub versao_cliente: Option<&'a str>,
    pub agora: i64,
}

/// Tudo o que o aplicativo exige antes de usar um manifesto. Devolve o manifesto conferido.
pub fn verificar_manifesto(bytes: &[u8], sig: &[u8], o: &Opcoes) -> Result<Value, Recusa> {
    let id = conferir_assinatura(bytes, sig, o.chaves, o.agora)?; // primeiro a assinatura: nada não assinado é lido
    let m: Value = serde_json::from_slice(bytes).or_else(|_| recusa("FORMATO", "manifesto não é JSON"))?;
    validar_forma(&m)?;
    if m.get("chave").is_some_and(|c| c.as_str() != Some(id.as_str())) {
        return recusa("ASSINATURA", "o manifesto declara outra chave");
    }
    let (ed, ca, ve) = (m["edicao"].as_str().unwrap(), m["canal"].as_str().unwrap(), m["versao"].as_str().unwrap());
    if ed != o.edicao {
        return recusa("EDICAO", format!("manifesto da edição {ed}; esta instalação é {}", o.edicao));
    }
    if ca != o.canal {
        return recusa("CANAL", format!("manifesto do canal {ca}; esta instalação segue {}", o.canal));
    }
    if instante(m["validoAte"].as_str().unwrap()).unwrap() <= o.agora {
        return recusa("EXPIRADO", "metadados vencidos");
    }
    if instante(m["emitidoEm"].as_str().unwrap()).unwrap() > o.agora + 10 * 60_000 {
        return recusa("FORMATO", "emitido no futuro");
    }
    let seq = m["sequencia"].as_u64().unwrap();
    if o.estado.ultima_sequencia.is_some_and(|u| seq <= u) {
        return recusa("REPETICAO", format!("sequência {seq} não é mais nova que a já aceita"));
    }
    if let Some(vi) = &o.estado.versao_instalada {
        if comparar_versoes(ve, vi)? == Ordering::Less {
            return recusa("REBAIXAMENTO", format!("{ve} é anterior à instalada ({vi})"));
        }
    }
    if let (Some(min), Some(cli)) = (m.get("clienteMinimo").and_then(|c| c.as_str()), o.versao_cliente) {
        if comparar_versoes(cli, min)? == Ordering::Less {
            return recusa("CLIENTE_ANTIGO", format!("esta versão pede o aplicativo {min} ou mais novo"));
        }
    }
    Ok(m)
}

pub fn sha256_hex(b: &[u8]) -> String {
    Sha256::digest(b).iter().map(|x| format!("{x:02x}")).collect()
}

/// Confere um arquivo baixado contra o componente do manifesto (tamanho antes do hash).
pub fn conferir_arquivo(buf: &[u8], comp: &Value, id: &str) -> Result<(), Recusa> {
    let t = comp["tamanho"].as_u64().unwrap_or(0);
    if buf.len() as u64 != t {
        return recusa("TAMANHO", format!("{id}: {} bytes, o manifesto diz {t}", buf.len()));
    }
    if sha256_hex(buf) != comp["sha256"].as_str().unwrap_or("") {
        return recusa("HASH", format!("{id}: SHA-256 diferente do manifesto"));
    }
    Ok(())
}

#[cfg(test)]
mod testes {
    use super::*;

    /// Os mesmos casos do verificador de referência (gerados por scripts/distribuicao/vetores.mjs).
    #[test]
    fn vetores_do_verificador_de_referencia() {
        let v: Value = serde_json::from_str(include_str!("../testes/vetores-manifesto.json")).unwrap();
        let chaves = chaveiro_de(&v["chaves"].to_string()).unwrap();
        let b64 = |s: &Value| base64::engine::general_purpose::STANDARD.decode(s.as_str().unwrap()).unwrap();
        let casos = v["casos"].as_array().unwrap();
        assert!(casos.len() >= 20, "poucos casos");
        for c in casos {
            let est = EstadoAceito {
                ultima_sequencia: c["estado"]["ultimaSequencia"].as_u64(),
                versao_instalada: c["estado"]["versaoInstalada"].as_str().map(String::from),
            };
            let o = Opcoes {
                chaves: &chaves,
                edicao: c["edicao"].as_str().unwrap(),
                canal: c["canal"].as_str().unwrap(),
                estado: &est,
                versao_cliente: c["versaoCliente"].as_str(),
                agora: instante(v["agora"].as_str().unwrap()).unwrap(),
            };
            let r = verificar_manifesto(&b64(&c["manifesto"]), &b64(&c["sig"]), &o);
            let esperado = c["esperado"].as_str().unwrap();
            match (&r, esperado) {
                (Ok(_), "ok") => {}
                (Err(e), cod) if e.codigo == cod => {}
                _ => panic!("{}: esperava {esperado}, veio {:?}", c["nome"], r.map(|_| "ok")),
            }
        }
    }

    #[test]
    fn chaveiro_embutido_valido() {
        assert!(!chaveiro_embutido().is_empty());
    }

    #[test]
    fn datas() {
        assert_eq!(instante("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(instante("2026-10-27T19:22:47.180Z"), Some(1793128967180));
        assert_eq!(instante("2026-10-27T16:22:47.180-03:00"), Some(1793128967180));
        assert_eq!(instante("2026-13-01T00:00:00Z"), None);
        assert_eq!(instante("ontem"), None);
    }

    #[test]
    fn versoes() {
        let ordem = ["1.0.0", "1.0.1-rc.1", "1.0.1-rc.2", "1.0.1-rc.10", "1.0.1", "1.0.10", "1.1.0", "2.0.0"];
        for w in ordem.windows(2) {
            assert_eq!(comparar_versoes(w[0], w[1]).unwrap(), Ordering::Less, "{} < {}", w[0], w[1]);
        }
        assert!(comparar_versoes("1.0", "1.0.0").is_err());
    }

    #[test]
    fn origens() {
        assert!(origem_permitida("https://github.com/x/y/releases/download/v1/a.zip"));
        assert!(origem_permitida("https://release-assets.githubusercontent.com/a?b=c"));
        for u in ["http://github.com/a", "https://exemplo.com/a", "https://u:s@github.com/a", "https://github.com:8443/a", "https://github.com.exemplo.com/a"] {
            assert!(!origem_permitida(u), "{u}");
        }
        assert_eq!(origem_permitida("http://127.0.0.1:8080/a"), cfg!(feature = "origens-de-teste"));
    }

    #[test]
    fn arquivo_truncado_ou_corrompido() {
        let dados = b"conteudo";
        let c = serde_json::json!({ "tamanho": dados.len(), "sha256": sha256_hex(dados) });
        assert!(conferir_arquivo(dados, &c, "x").is_ok());
        assert_eq!(conferir_arquivo(&dados[..3], &c, "x").unwrap_err().codigo, "TAMANHO");
        assert_eq!(conferir_arquivo(b"conteudO", &c, "x").unwrap_err().codigo, "HASH");
    }
}
