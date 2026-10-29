//! Atualizações do Ergon Desktop (Windows, ambiente próprio). Nada se atualiza sozinho: "Verificar" só lê e confere o
//! manifesto assinado do canal (o mesmo da instalação); "Atualizar" é sempre um pedido da pessoa. A versão marcada no
//! manifesto como de segurança obrigatória bloqueia o uso até atualizar (a tela de abertura não oferece outra saída).
//!
//! Atualizar o ambiente: backup dos dados (pelo lançador), o pacote anterior guardado, o pacote novo entregue, as
//! imagens presas aos digests do manifesto, os serviços religados e a versão conferida na saúde do Ergon. Se a versão
//! nova não responder, o pacote anterior volta e os serviços religam com ele. Os dados (volumes) e os segredos ficam
//! onde estão. Depois, se o próprio aplicativo for mais antigo, o instalador novo (conferido pelo SHA-256 do manifesto)
//! roda em modo de atualização silenciosa e reabre o aplicativo.

use crate::ambiente::{self, Evento};
use crate::{baixar, confianca};
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::path::PathBuf;
use std::time::{Duration, Instant};

const LIMITE_MANIFESTO: u64 = 1 << 20;
const APP: &str = env!("CARGO_PKG_VERSION");
/// onde o pacote anterior fica guardado durante a troca (dentro do ambiente)
const ANTERIOR: &str = "/opt/ergon-pacote.anterior";

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Situacao {
    /// versão do Ergon instalada no ambiente (ou a do aplicativo, sem ambiente)
    pub atual: String,
    /// versão deste aplicativo
    pub app: String,
    /// versão publicada mais nova que a instalada (nenhuma = em dia)
    pub nova: Option<String>,
    /// a versão nova traz correções de segurança obrigatórias: o uso fica bloqueado até atualizar
    pub obrigatoria: bool,
    pub motivo: Option<String>,
    /// página com as novidades da versão
    pub notas: Option<String>,
    /// dá para atualizar por aqui (Windows com o ambiente próprio)
    pub pode_atualizar: bool,
    /// não deu para verificar agora (sem rede, manifesto recusado): o Ergon segue como está
    pub erro: Option<String>,
}

fn maior(a: &str, b: &str) -> bool {
    confianca::comparar_versoes(a, b).map(|o| o == Ordering::Greater).unwrap_or(false)
}

/// O que o manifesto diz, comparado com o que está instalado. Função pura (testável).
pub fn situacao(m: &Value, instalada: Option<&str>, app: &str, pode_atualizar: bool) -> Situacao {
    let versao = m["versao"].as_str().unwrap_or("").to_string();
    let atual = instalada.unwrap_or(app).to_string();
    let nova = (maior(&versao, &atual) || maior(&versao, app)).then(|| versao.clone());
    let obrigatoria = nova.is_some() && m["seguranca"]["obrigatoria"].as_bool() == Some(true);
    Situacao {
        atual,
        app: app.to_string(),
        obrigatoria,
        motivo: if obrigatoria { m["seguranca"]["motivo"].as_str().map(String::from) } else { None },
        notas: nova.as_ref().and(m["notas"].as_str().map(String::from)),
        nova,
        pode_atualizar,
        erro: None,
    }
}

/// Lê e confere o manifesto do canal, sem gravar nada (a proteção contra repetição fica para a atualização: aqui o
/// mesmo manifesto já aceito só quer dizer "em dia").
pub fn verificar() -> Situacao {
    let instalada = ambiente::aceito().versao_instalada;
    let pode = cfg!(windows) && ambiente::ativo();
    let falha = |e: String| Situacao { atual: instalada.clone().unwrap_or_else(|| APP.into()), app: APP.into(), pode_atualizar: pode, erro: Some(e), ..Default::default() };
    let url = ambiente::manifesto_url();
    let b = match baixar::baixar_para_memoria(&url, LIMITE_MANIFESTO) { Ok(b) => b, Err(e) => return falha(format!("Não deu para ler a versão publicada ({e}).")) };
    let s = match baixar::baixar_para_memoria(&format!("{url}.sig"), 4096) { Ok(s) => s, Err(e) => return falha(format!("Não deu para ler a assinatura da versão ({e}).")) };
    let est = confianca::EstadoAceito { ultima_sequencia: None, versao_instalada: instalada.clone() };
    let o = confianca::Opcoes { chaves: &ambiente::chaveiro(), edicao: ambiente::EDICAO, canal: ambiente::CANAL, estado: &est, versao_cliente: Some(APP), agora: confianca::agora_ms() };
    match confianca::verificar_manifesto(&b, &s, &o) {
        Ok(m) => situacao(&m, instalada.as_deref(), APP, pode),
        // publicada mais antiga que a instalada: nada a fazer
        Err(e) if e.codigo == "REBAIXAMENTO" => Situacao { atual: instalada.clone().unwrap_or_else(|| APP.into()), app: APP.into(), pode_atualizar: pode, ..Default::default() },
        Err(e) => falha(format!("A versão publicada foi recusada ({}).", e.codigo)),
    }
}

/// Fim de uma atualização: o ambiente está na versão nova; se houver, o instalador novo do aplicativo, já conferido.
pub struct Feito {
    pub versao: String,
    pub instalador: Option<PathBuf>,
}

fn rodar(args: &[&str], prazo: u64) -> Result<String, String> {
    ambiente::rodar_wsl(ambiente::dentro(args), Duration::from_secs(prazo))
}

/// Atualiza o ambiente e prepara a atualização do aplicativo. Cada etapa avisa a tela.
pub fn atualizar(ev: &mut dyn FnMut(Evento)) -> Result<Feito, String> {
    if !cfg!(windows) || !ambiente::ativo() {
        return Err("Por aqui, a atualização é para o Ergon Desktop do Windows. Nos outros casos, baixe a versão nova na página de lançamentos.".into());
    }
    ev(Evento::Etapa("diagnostico"));
    let m = ambiente::manifesto_conferido()?;
    let versao = m["versao"].as_str().unwrap_or("?").to_string();
    let instalada = ambiente::aceito().versao_instalada;
    ev(Evento::Linha(format!("Versão {versao} conferida (assinatura, edição, canal e validade); instalada: {}", instalada.as_deref().unwrap_or("?"))));

    if instalada.as_deref() != Some(versao.as_str()) {
        // 1. backup dos dados (o lançador sabe fazer; Ergon trancado ou parado: segue, com o aviso)
        ev(Evento::Etapa("backup"));
        match rodar(&["sh", "-c", "\"$HOME/.local/share/ergon/ergon.sh\" backup"], 20 * 60) {
            Ok(_) => ev(Evento::Linha("Backup dos dados feito antes de atualizar.".into())),
            Err(e) => ev(Evento::Linha(format!("Backup não feito agora ({}): a atualização segue; os dados ficam onde estão.", e.lines().last().unwrap_or("").trim()))),
        }
        // 2. o pacote da versão nova, baixado e conferido
        ev(Evento::Etapa("baixar"));
        let c = ambiente::componente(&m, "pacote-local")?;
        let (url, sha, tam) = (c["url"].as_str().unwrap(), c["sha256"].as_str().unwrap(), c["tamanho"].as_u64().unwrap());
        let r = baixar::componente(url, sha, tam, &ambiente::pasta().join("cache"), &mut |f, t| ev(Evento::Progresso { componente: "pacote-local".into(), feitos: f, total: t }))
            .map_err(|e| format!("pacote-local: {e}"))?;
        // 3. o pacote anterior guardado; o novo entregue e preso aos digests
        ev(Evento::Etapa("configurar"));
        rodar(&["sh", "-c", &format!("rm -rf {ANTERIOR} && cp -a /opt/ergon-pacote {ANTERIOR}")], 120)?;
        ambiente::entregar_pacote(&r.caminho)?;
        ambiente::fixar_imagens(&m, &versao)?;
        ev(Evento::Linha("Pacote novo entregue; imagens presas aos digests do manifesto.".into()));
        // 4. religa pelo lançador novo (segredos e dados ficam; o .env da instalação também)
        ev(Evento::Etapa("ligar"));
        ambiente::ligar_motor_de_conteineres(ev)?;
        let instalar = |ev: &mut dyn FnMut(Evento)| {
            let mut c = ambiente::dentro(&["env", "ERGON_SEM_NAVEGADOR=1", "/bin/bash", "/opt/ergon-pacote/ergon.sh", "instalar"]);
            ambiente::transmitir(&mut c, Duration::from_secs(40 * 60), ev)
        };
        let ligou = instalar(&mut *ev);
        // 5. confere a versão nova no ar; senão, volta para a anterior
        ev(Evento::Etapa("conferir"));
        if ligou.is_err() || !responde(&versao, 300) {
            ev(Evento::Linha(format!("A versão {versao} não respondeu: voltando para a anterior.")));
            rodar(&["sh", "-c", &format!("test -d {ANTERIOR} && rm -rf /opt/ergon-pacote && mv {ANTERIOR} /opt/ergon-pacote")], 120)?;
            let volta = instalar(&mut *ev);
            let anterior = instalada.clone().unwrap_or_else(|| "anterior".into());
            return Err(if volta.is_ok() && instalada.as_deref().is_some_and(|v| responde(v, 300)) {
                format!("A versão {versao} não respondeu; o Ergon voltou para a {anterior} e está no ar. Nada se perdeu.")
            } else {
                format!("A versão {versao} não respondeu e a {anterior} também não voltou sozinha. Os dados estão guardados; veja o diagnóstico.")
            });
        }
        let seq = m["sequencia"].as_u64().unwrap_or(0);
        std::fs::write(ambiente::arq_aceito(), serde_json::to_vec_pretty(&serde_json::json!({ "ultimaSequencia": seq, "versaoInstalada": versao })).unwrap()).map_err(|e| e.to_string())?;
        let _ = rodar(&["rm", "-rf", ANTERIOR], 60);
        ev(Evento::Linha(format!("Ergon {versao} no ar.")));
    } else {
        ev(Evento::Linha(format!("O ambiente já está na {versao}.")));
    }

    // 6. o próprio aplicativo, se for mais antigo: o instalador novo, conferido, para rodar ao fechar
    let mut instalador = None;
    if maior(&versao, APP) {
        if let Ok(c) = ambiente::componente(&m, "desktop-windows") {
            ev(Evento::Etapa("aplicativo"));
            let (url, sha, tam) = (c["url"].as_str().unwrap(), c["sha256"].as_str().unwrap(), c["tamanho"].as_u64().unwrap());
            let r = baixar::componente(url, sha, tam, &ambiente::pasta().join("cache"), &mut |f, t| ev(Evento::Progresso { componente: "aplicativo".into(), feitos: f, total: t }))
                .map_err(|e| format!("aplicativo: {e}"))?;
            ev(Evento::Linha("Aplicativo novo baixado e conferido: ele se instala e reabre o Ergon.".into()));
            instalador = Some(r.caminho);
        }
    }
    Ok(Feito { versao, instalador })
}

fn responde(versao: &str, segundos: u64) -> bool {
    let fim = Instant::now() + Duration::from_secs(segundos);
    loop {
        if let crate::diag::Resposta::Ergon(s) = crate::diag::ler_saude(crate::instalacao::PORTA_PADRAO) {
            if s.versao == versao {
                return true;
            }
        }
        if Instant::now() > fim {
            return false;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}

/// Roda o instalador novo em modo de atualização silenciosa; ele fecha este aplicativo, troca os arquivos e reabre.
pub fn aplicar_instalador(caminho: &std::path::Path) -> Result<(), String> {
    let mut c = crate::processo::comando(caminho);
    c.args(["/UPDATE", "/S", "/R"]);
    c.spawn().map(|_| ()).map_err(|e| format!("Não deu para iniciar o instalador novo ({e})."))
}

#[cfg(test)]
mod testes {
    use super::*;

    fn m(versao: &str, seg: bool) -> Value {
        let mut v = serde_json::json!({ "versao": versao, "notas": "https://github.com/x/y/releases/tag/v1" });
        if seg {
            v["seguranca"] = serde_json::json!({ "obrigatoria": true, "motivo": "fecha uma falha no acesso ao cofre do motor." });
        }
        v
    }

    #[test]
    fn em_dia_nova_e_obrigatoria() {
        let s = situacao(&m("1.1.0-rc.11", false), Some("1.1.0-rc.11"), "1.1.0-rc.11", true);
        assert_eq!((s.nova, s.obrigatoria), (None, false), "mesma versão: em dia");
        let s = situacao(&m("1.1.0-rc.12", false), Some("1.1.0-rc.11"), "1.1.0-rc.11", true);
        assert_eq!((s.nova.as_deref(), s.obrigatoria, s.notas.is_some()), (Some("1.1.0-rc.12"), false, true), "nova comum: não bloqueia");
        let s = situacao(&m("1.1.0-rc.12", true), Some("1.1.0-rc.11"), "1.1.0-rc.11", true);
        assert!(s.obrigatoria && s.motivo.is_some(), "nova de segurança: obrigatória, com o motivo");
        let s = situacao(&m("1.1.0-rc.11", true), Some("1.1.0-rc.11"), "1.1.0-rc.11", true);
        assert!(!s.obrigatoria, "a de segurança já instalada não bloqueia nada");
        let s = situacao(&m("1.1.0", false), Some("1.1.0-rc.11"), "1.1.0-rc.11", true);
        assert_eq!(s.nova.as_deref(), Some("1.1.0"), "estável depois da rc é mais nova");
        let s = situacao(&m("1.1.0-rc.12", false), Some("1.1.0-rc.12"), "1.1.0-rc.11", true);
        assert_eq!(s.nova.as_deref(), Some("1.1.0-rc.12"), "ambiente em dia, aplicativo antigo: ainda há o que atualizar");
    }
}
