//! Atualizações do Ergon Desktop (Windows, ambiente próprio). Nada se atualiza sozinho: "Verificar" só lê e confere o
//! manifesto assinado do canal (o mesmo da instalação); "Atualizar" é sempre um pedido da pessoa. A versão marcada no
//! manifesto como de segurança obrigatória bloqueia o uso até atualizar (a tela de abertura não oferece outra saída).
//!
//! Atualizar o ambiente: backup dos dados (pelo lançador), o pacote anterior guardado, o pacote novo entregue, as
//! imagens presas aos digests do manifesto, os serviços religados e a versão conferida na saúde do Ergon. Se a versão
//! nova não responder, o pacote anterior volta e os serviços religam com ele. Os dados (volumes) e os segredos ficam
//! onde estão. Depois, se o próprio aplicativo for mais antigo, o instalador novo (conferido pelo SHA-256 do manifesto)
//! roda em modo de atualização silenciosa e reabre o aplicativo.
//!
//! Voltar para uma versão anterior (pedido da pessoa, com confirmação na tela de abertura): o mesmo caminho, ao
//! contrário. O manifesto assinado DA VERSÃO escolhida (anexado à página dela, com o nome do canal) é conferido como o
//! da atualização — assinatura, edição, canal, validade e aplicativo mínimo —, sem as travas de "versão anterior" e de
//! "repetição", que são para a atualização. Antes, um backup dos dados (obrigatório: os dados de uma versão mais nova
//! podem não abrir na anterior; sem ele, só se a pessoa pedir de novo). Não volta para antes da VOLTA_MINIMA nem para
//! antes do piso de segurança do canal (a versão de segurança obrigatória mais nova já publicada: a do manifesto do
//! canal ou a que ele carrega em "segurancaMinima"); se o manifesto do canal não puder ser conferido, a volta não é
//! feita. Só as DUAS versões publicadas logo antes da instalada podem ser escolhidas (decisão de 09/11: a lista
//! "recentes" do manifesto do canal, assinado; manifesto sem ela, de antes desta regra, não limita aqui). Cada pacote
//! assinado vale 90 dias; se o backup falhar, a tela oferece "Voltar mesmo sem backup" (outro clique). O aplicativo
//! não é trocado.

use crate::ambiente::{self, Evento};
use crate::{baixar, confianca};
use serde::Serialize;
use serde_json::Value;
use std::cmp::Ordering;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

const LIMITE_MANIFESTO: u64 = 1 << 20;
const APP: &str = env!("CARGO_PKG_VERSION");
/// onde o pacote anterior fica guardado durante a troca (dentro do ambiente)
const ANTERIOR: &str = "/opt/ergon-pacote.anterior";
/// A versão mais antiga para a qual o aplicativo volta: a 1.1.0-rc.27, que muda a base da equipe (cada agente vira um
/// perfil do motor; numa versão anterior a equipe não acharia os agentes). Para voltar ao que era antes dela, o caminho é
/// o backup feito na atualização. (Até a rc.26 a mínima era a 1.1.0-rc.24: antes dela, o Ergon nunca recriava a equipe de
/// cada pessoa (os agentes) quando a versão mudava: numa volta para uma anterior, só o centro voltaria e a equipe
/// seguiria na versão de agora (e a 1.1.0-rc.14 já tinha trocado o que roda dentro do ambiente, Podman no lugar do
/// Docker). O servidor usa o mesmo valor na lista de versões (server/src/version.ts, VOLTA_MINIMA; um teste do
/// servidor confere que os dois andam juntos).)
pub const VOLTA_MINIMA: &str = "1.1.0-rc.27";
/// onde cada versão publicada guarda o seu manifesto assinado (manifesto-<canal>.json, anexado à página dela)
const VERSOES: &str = "https://github.com/MagnoQuerino/ergon-community/releases/download";
/// começo da mensagem quando o backup antes de voltar não deu certo: a tela oferece "voltar mesmo sem backup"
pub const SEM_BACKUP: &str = "SEM_BACKUP:";

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
        if crate::migracao::precisa() {
            // ambiente antigo (Docker por dentro): os dados passam para um ambiente novo, com o Podman (migracao.rs)
            crate::migracao::migrar(&m, &versao, &r.caminho, ev)?;
        } else {
            // 3 a 5: o pacote anterior guardado, o novo entregue, religado e conferido (senão, o anterior volta)
            trocar_pacote(&m, &versao, &r.caminho, instalada.as_deref(), ev)?;
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

/// Põe no ambiente o pacote da `versao` (já baixado e conferido): o de agora guardado, o novo entregue e preso aos
/// digests do manifesto, os serviços religados pelo lançador dele (segredos, dados e o .env da instalação ficam) e a
/// versão conferida na saúde do Ergon. Se ela não responder, o pacote de antes volta e religa. Serve para atualizar e
/// para voltar a uma versão anterior.
fn trocar_pacote(m: &Value, versao: &str, pacote: &Path, instalada: Option<&str>, ev: &mut dyn FnMut(Evento)) -> Result<(), String> {
    // o pacote de agora guardado; o outro entregue e preso aos digests
    ev(Evento::Etapa("configurar"));
    rodar(&["sh", "-c", &format!("rm -rf {ANTERIOR} && cp -a /opt/ergon-pacote {ANTERIOR}")], 120)?;
    // qualquer falha daqui até o instalar põe o pacote de antes de volta (os serviços ainda não foram religados): o
    // pacote no lugar nunca fica pela metade, e a próxima troca não guarda um pacote quebrado como "o de antes"
    ou_desfaz(|| entregar(m, versao, pacote, &mut *ev), por_de_volta_o_anterior)?;
    let instalar = |ev: &mut dyn FnMut(Evento)| {
        let mut c = ambiente::dentro(&["env", "ERGON_SEM_NAVEGADOR=1", "/bin/bash", "/opt/ergon-pacote/ergon.sh", "instalar"]);
        ambiente::transmitir(&mut c, Duration::from_secs(40 * 60), ev)
    };
    let ligou = instalar(&mut *ev);
    // confere a versão no ar; senão, volta para a de antes
    ev(Evento::Etapa("conferir"));
    if ligou.is_err() || !responde(versao, 300) {
        ev(Evento::Linha(format!("A versão {versao} não respondeu: voltando para a de antes.")));
        por_de_volta_o_anterior()?;
        let volta = instalar(&mut *ev);
        let anterior = instalada.unwrap_or("anterior");
        return Err(if volta.is_ok() && instalada.is_some_and(|v| responde(v, 300)) {
            format!("A versão {versao} não respondeu; o Ergon voltou para a {anterior} e está no ar. Nada se perdeu.")
        } else {
            format!("A versão {versao} não respondeu e a {anterior} também não voltou sozinha. Os dados estão guardados; veja o diagnóstico.")
        });
    }
    esperar_equipe(&mut *ev, 180);
    Ok(())
}

/// O pacote da `versao` entregue no lugar, preso aos digests do manifesto, e o ambiente pronto para religar.
fn entregar(m: &Value, versao: &str, pacote: &Path, ev: &mut dyn FnMut(Evento)) -> Result<(), String> {
    ambiente::entregar_pacote(pacote)?;
    ambiente::fixar_imagens(m, versao)?;
    ev(Evento::Linha("Pacote novo entregue; imagens presas aos digests do manifesto.".into()));
    // religa pelo lançador do pacote entregue (segredos e dados ficam; o .env da instalação também)
    ev(Evento::Etapa("ligar"));
    ambiente::ligar_motor_de_conteineres(ev)?;
    Ok(())
}

/// O pacote guardado antes da troca volta para o lugar (sem ele guardado, falha e nada muda).
fn por_de_volta_o_anterior() -> Result<(), String> {
    rodar(&["sh", "-c", &format!("test -d {ANTERIOR} && rm -rf /opt/ergon-pacote && mv {ANTERIOR} /opt/ergon-pacote")], 120).map(|_| ())
}

/// Roda `etapa`; se ela falhar, roda `desfazer` antes de devolver o erro dela (se o desfazer também falhar, a mensagem
/// diz). Função genérica (testável).
fn ou_desfaz<T>(etapa: impl FnOnce() -> Result<T, String>, desfazer: impl FnOnce() -> Result<(), String>) -> Result<T, String> {
    match etapa() {
        Ok(v) => Ok(v),
        Err(e) => match desfazer() {
            Ok(()) => Err(e),
            Err(d) => Err(format!("{e} (e o pacote de antes não voltou para o lugar sozinho: {d})")),
        },
    }
}

/// Leituras seguidas da saúde com a equipe livre para dar a espera por terminada antes de a etapa aparecer: logo
/// depois que a versão responde, a equipe pode ainda não ter começado a ligar ou a renovar (o Ergon acabou de subir).
const CARENCIA_EQUIPE: u32 = 3;

/// A espera pela equipe termina? `livres`: leituras seguidas com a equipe livre; `avisou`: a etapa já apareceu (aí
/// basta uma). Função pura (testável).
fn equipe_terminou(livres: u32, avisou: bool) -> bool {
    livres >= if avisou { 1 } else { CARENCIA_EQUIPE }
}

/// Depois de trocar a versão, o Ergon também liga e renova a equipe (os agentes de cada pessoa) para ela: enquanto a
/// saúde disser "ligando" ou "renovando", a tela mostra a etapa "Atualizando a equipe". Antes de dar a equipe por
/// pronta sem a etapa ter aparecido, umas leituras de carência (CARENCIA_EQUIPE, 3 s entre elas). Tem prazo: passado,
/// segue (a própria página do Ergon mostra o resto). Uma versão sem esse aviso na saúde passa direto, depois da
/// carência. Com as partes das pessoas fechadas depois de religar, a equipe só liga quando cada uma entrar: aí a
/// etapa não aparece aqui (a página do Ergon mostra).
fn esperar_equipe(ev: &mut dyn FnMut(Evento), segundos: u64) {
    let fim = Instant::now() + Duration::from_secs(segundos);
    let mut avisou = false;
    let mut livres = 0u32;
    loop {
        match crate::diag::ler_saude(crate::instalacao::PORTA_PADRAO) {
            crate::diag::Resposta::Ergon(s) if s.renovando => {
                livres = 0;
                if !avisou {
                    ev(Evento::Etapa("equipe"));
                    ev(Evento::Linha("Atualizando a equipe para a versão nova.".into()));
                    avisou = true;
                }
            }
            crate::diag::Resposta::Ergon(_) => {
                livres += 1;
                if equipe_terminou(livres, avisou) {
                    return;
                }
            }
            _ => return,
        }
        if Instant::now() > fim {
            return;
        }
        std::thread::sleep(Duration::from_secs(3));
    }
}

// ------------------------------------------------------------------------------------------------- voltar
/// O que a tela de abertura mostra antes de voltar: dá ou não dá (e por quê, em palavras simples).
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Avaliacao {
    /// versão instalada agora
    pub atual: String,
    /// versão escolhida
    pub alvo: String,
    pub pode: bool,
    pub motivo: Option<String>,
}

fn anterior_a(a: &str, b: &str) -> bool {
    confianca::comparar_versoes(a, b).map(|o| o == Ordering::Less).unwrap_or(true)
}

/// Por que não dá para voltar da `instalada` para o `alvo` (None: dá). `seguranca`: o piso de segurança do canal (a
/// versão de segurança obrigatória mais nova já publicada), se houver. Função pura (testável).
pub fn motivo_para_nao_voltar(alvo: &str, instalada: Option<&str>, seguranca: Option<&str>) -> Option<String> {
    if confianca::comparar_versoes(alvo, alvo).is_err() {
        return Some("Essa versão não foi reconhecida. Nada foi mudado.".into());
    }
    let Some(inst) = instalada else {
        return Some("Não deu para saber qual versão está instalada agora; por segurança, a volta não é feita.".into());
    };
    match confianca::comparar_versoes(alvo, inst) {
        Ok(Ordering::Less) => {}
        Ok(Ordering::Equal) => return Some(format!("O Ergon já está na {alvo}.")),
        Ok(Ordering::Greater) => return Some(format!("A {alvo} é mais nova que a instalada ({inst}): para ir para ela, use “Atualizar”.")),
        Err(_) => return Some("Não deu para saber qual versão está instalada agora; por segurança, a volta não é feita.".into()),
    }
    if anterior_a(alvo, VOLTA_MINIMA) {
        return Some(format!(
            "A {alvo} é anterior à {VOLTA_MINIMA}, que mudou a base da equipe: por aqui, não dá para voltar para antes dela. Para voltar ao que era antes, use o backup feito na atualização."
        ));
    }
    if let Some(s) = seguranca {
        if anterior_a(alvo, s) {
            return Some(format!("A {s} trouxe revisões de segurança que precisam ficar aplicadas: não dá para voltar para uma versão anterior a ela."));
        }
    }
    None
}

/// Endereço do manifesto assinado de uma versão (já conferida como versão bem formada), no canal deste aplicativo.
pub(crate) fn manifesto_da_versao_url(versao: &str) -> String {
    if cfg!(feature = "origens-de-teste") {
        if let Ok(u) = std::env::var("ERGON_MANIFESTO_VERSAO_URL") {
            return u.replace("{versao}", versao);
        }
    }
    format!("{VERSOES}/v{versao}/manifesto-{}.json", ambiente::CANAL)
}

fn opcoes_sem_travas<'a>(chaves: &'a confianca::Chaveiro, est: &'a confianca::EstadoAceito) -> confianca::Opcoes<'a> {
    confianca::Opcoes { chaves, edicao: ambiente::EDICAO, canal: ambiente::CANAL, estado: est, versao_cliente: Some(APP), agora: confianca::agora_ms() }
}

/// O manifesto assinado da versão escolhida, conferido: assinatura, edição, canal, validade e aplicativo mínimo (a
/// volta é pedida de propósito: sem as travas de "versão anterior" e de "repetição", que são para a atualização).
fn manifesto_da_versao(alvo: &str) -> Result<Value, String> {
    let url = manifesto_da_versao_url(alvo);
    let b = baixar::baixar_para_memoria(&url, LIMITE_MANIFESTO).map_err(|e| {
        if e.mensagem.starts_with("404") {
            format!("A {alvo} não tem, publicado, o pacote assinado para voltar pelo aplicativo. Na página dela está o instalador.")
        } else {
            format!("Não deu para consultar a {alvo} agora (sem internet?). Nada foi mudado.")
        }
    })?;
    let s = baixar::baixar_para_memoria(&format!("{url}.sig"), 4096).map_err(|_| format!("Não deu para ler a assinatura da {alvo}. Nada foi mudado."))?;
    let chaves = ambiente::chaveiro();
    let est = confianca::EstadoAceito::default();
    let m = confianca::verificar_manifesto(&b, &s, &opcoes_sem_travas(&chaves, &est)).map_err(|e| match e.codigo {
        "EXPIRADO" => format!("O pacote assinado da {alvo} venceu (cada um vale 90 dias depois de assinado): por segurança, a volta não é feita."),
        "CLIENTE_ANTIGO" => format!("A {alvo} pede um aplicativo mais novo que este. Nada foi mudado."),
        c => format!("O pacote da {alvo} foi recusado na conferência ({c}). Nada foi mudado."),
    })?;
    if m["versao"].as_str() != Some(alvo) {
        return Err(format!("O pacote publicado não é o da {alvo}. Nada foi mudado."));
    }
    for id in ["pacote-local", "core", "motor"] {
        ambiente::componente(&m, id)?;
    }
    Ok(m)
}

/// O piso de segurança que um manifesto do canal (já conferido) declara: a própria versão, se for de segurança
/// obrigatória, ou a que ele carrega em "segurancaMinima" (a de segurança obrigatória mais nova publicada até ela: o
/// aviso não se perde quando sai uma versão comum depois); a mais nova das duas. Função pura (testável).
pub fn piso_de_seguranca(m: &Value) -> Option<String> {
    let propria = if m["seguranca"]["obrigatoria"].as_bool() == Some(true) { m["versao"].as_str().map(String::from) } else { None };
    let carregada = m["segurancaMinima"].as_str().filter(|v| confianca::comparar_versoes(v, v).is_ok()).map(String::from);
    match (propria, carregada) {
        (Some(a), Some(b)) => Some(if maior(&b, &a) { b } else { a }),
        (a, b) => a.or(b),
    }
}

/// O manifesto do canal baixado (`baixado`: o manifesto e a assinatura; None: não baixou), conferido. Falha fechada: sem
/// o manifesto conferido (sem rede, assinatura que não confere, vencido…), a volta não é feita.
fn canal_conferido(baixado: Option<(Vec<u8>, Vec<u8>)>, o: &confianca::Opcoes) -> Result<Value, String> {
    let nao = || "Não deu para conferir agora as revisões de segurança publicadas; por segurança, a volta não é feita. Nada foi mudado.".to_string();
    let (b, s) = baixado.ok_or_else(nao)?;
    confianca::verificar_manifesto(&b, &s, o).map_err(|_| nao())
}

/// O piso de segurança do manifesto do canal baixado (ver canal_conferido).
#[cfg(test)]
fn piso_conferido(baixado: Option<(Vec<u8>, Vec<u8>)>, o: &confianca::Opcoes) -> Result<Option<String>, String> {
    canal_conferido(baixado, o).map(|m| piso_de_seguranca(&m))
}

/// O manifesto publicado agora no canal, conferido (ver canal_conferido): dele saem o piso de segurança e as versões
/// publicadas ("recentes"). Sem a trava do aplicativo mínimo: aqui só se lê, e um canal que pede um aplicativo mais novo
/// continua valendo para isso.
fn canal_publicado() -> Result<Value, String> {
    let url = ambiente::manifesto_url();
    let baixado = baixar::baixar_para_memoria(&url, LIMITE_MANIFESTO)
        .ok()
        .and_then(|b| baixar::baixar_para_memoria(&format!("{url}.sig"), 4096).ok().map(|s| (b, s)));
    let chaves = ambiente::chaveiro();
    let est = confianca::EstadoAceito::default();
    let o = confianca::Opcoes { chaves: &chaves, edicao: ambiente::EDICAO, canal: ambiente::CANAL, estado: &est, versao_cliente: None, agora: confianca::agora_ms() };
    canal_conferido(baixado, &o)
}

/// Só as DUAS versões publicadas logo antes da instalada podem ser escolhidas (decisão de 09/11). A lista vem do
/// manifesto do canal, assinado ("recentes": as versões publicadas no canal até a mais nova, a mais nova primeiro). Sem
/// a lista (manifesto de antes desta regra: vale daqui para frente), não limita aqui: a tela já mostra só as duas. Com a
/// lista, falha fechada: lista que não se lê, ou sem a instalada nela, não volta. Função pura (testável).
pub fn fora_das_duas_anteriores(alvo: &str, instalada: &str, recentes: Option<&Value>) -> Option<String> {
    let recentes = recentes?;
    let nao = || Some("Não deu para conferir as versões publicadas antes da instalada; por segurança, a volta não é feita. Nada foi mudado.".to_string());
    let Some(lista) = recentes.as_array() else { return nao() };
    let mut versoes: Vec<&str> = Vec::with_capacity(lista.len());
    for v in lista {
        match v.as_str() {
            Some(s) if confianca::comparar_versoes(s, s).is_ok() => versoes.push(s),
            _ => return nao(),
        }
    }
    let igual = |a: &str, b: &str| confianca::comparar_versoes(a, b).map(|o| o == Ordering::Equal).unwrap_or(false);
    // a instalada fora da lista (a página dela saiu, ou ficou para trás das que o manifesto carrega): não é falha passageira
    let Some(i) = versoes.iter().position(|v| igual(*v, instalada)) else {
        return Some(format!("A versão instalada ({instalada}) já não está entre as publicadas recentemente: por aqui, a volta não é feita. Para voltar, baixe o instalador na página da versão. Nada foi mudado."));
    };
    let duas: Vec<&str> = versoes.iter().skip(i + 1).take(2).copied().collect();
    if duas.iter().any(|v| igual(*v, alvo)) {
        return None;
    }
    Some(match duas.as_slice() {
        [] => format!("Por aqui, dá para voltar só para as duas versões publicadas antes da instalada ({instalada}), e não há nenhuma antes dela."),
        [a] => format!("Por aqui, dá para voltar só para as duas versões publicadas antes da instalada ({instalada}): agora, só para a {a}."),
        [a, b, ..] => format!("Por aqui, dá para voltar só para as duas versões publicadas antes da instalada ({instalada}): a {a} ou a {b}."),
    })
}

/// Tudo o que precisa valer antes de voltar (a avaliação da tela e a volta usam o mesmo). Devolve o manifesto da versão.
fn conferir_volta(alvo: &str) -> Result<Value, String> {
    if !cfg!(windows) || !ambiente::ativo() {
        return Err("Por aqui, voltar de versão pelo aplicativo é para o Ergon Desktop do Windows. Nos outros casos, baixe o instalador na página da versão e instale por cima.".into());
    }
    let instalada = ambiente::aceito().versao_instalada;
    if let Some(m) = motivo_para_nao_voltar(alvo, instalada.as_deref(), None) {
        return Err(m);
    }
    if crate::migracao::precisa() {
        return Err("Este computador ainda usa o ambiente antigo do Ergon: atualize primeiro para a versão mais recente.".into());
    }
    let canal = canal_publicado()?;
    if let Some(motivo) = fora_das_duas_anteriores(alvo, instalada.as_deref().unwrap_or(""), canal.get("recentes")) {
        return Err(motivo);
    }
    let m = manifesto_da_versao(alvo)?;
    let piso = piso_de_seguranca(&canal);
    if let Some(motivo) = motivo_para_nao_voltar(alvo, instalada.as_deref(), piso.as_deref()) {
        return Err(motivo);
    }
    Ok(m)
}

/// Dá para voltar para `alvo`? Só lê (nada muda).
pub fn avaliar_volta(alvo: &str) -> Avaliacao {
    let atual = ambiente::aceito().versao_instalada.unwrap_or_else(|| APP.into());
    match conferir_volta(alvo) {
        Ok(_) => Avaliacao { atual, alvo: alvo.to_string(), pode: true, motivo: None },
        Err(m) => Avaliacao { atual, alvo: alvo.to_string(), pode: false, motivo: Some(m) },
    }
}

/// Volta o Ergon para a versão `alvo`: confere tudo de novo, faz o backup (sem ele, só com `sem_backup`), troca o
/// pacote mantendo os dados e grava a versão instalada. Devolve a versão no ar.
pub fn voltar(alvo: &str, sem_backup: bool, ev: &mut dyn FnMut(Evento)) -> Result<String, String> {
    ev(Evento::Etapa("diagnostico"));
    let m = conferir_volta(alvo)?;
    let aceito = ambiente::aceito();
    let instalada = aceito.versao_instalada.clone();
    ev(Evento::Linha(format!("Versão {alvo} conferida (assinatura, edição, canal e validade); instalada: {}", instalada.as_deref().unwrap_or("?"))));

    // 1. backup: aqui é obrigatório (o que a versão mais nova gravou pode não abrir na anterior)
    ev(Evento::Etapa("backup"));
    match rodar(&["sh", "-c", "\"$HOME/.local/share/ergon/ergon.sh\" backup"], 20 * 60) {
        Ok(_) => ev(Evento::Linha("Backup dos dados feito antes de voltar.".into())),
        Err(e) if sem_backup => ev(Evento::Linha(format!("Backup não feito ({}): a volta segue porque você pediu.", e.lines().last().unwrap_or("").trim()))),
        Err(e) => {
            let porque = e.lines().last().unwrap_or("").trim().trim_start_matches("[ergon]").trim().to_string();
            return Err(format!(
                "{SEM_BACKUP}Não deu para fazer o backup dos seus dados agora{}. Nada foi mudado. Você pode tentar de novo daqui a pouco ou voltar mesmo sem backup.",
                if porque.is_empty() { String::new() } else { format!(" ({porque})") }
            ));
        }
    }

    // 2. o pacote da versão escolhida, baixado e conferido
    ev(Evento::Etapa("baixar"));
    let c = ambiente::componente(&m, "pacote-local")?;
    let (url, sha, tam) = (c["url"].as_str().unwrap_or_default(), c["sha256"].as_str().unwrap_or_default(), c["tamanho"].as_u64().unwrap_or(0));
    let r = baixar::componente(url, sha, tam, &ambiente::pasta().join("cache"), &mut |f, t| ev(Evento::Progresso { componente: "pacote-local".into(), feitos: f, total: t }))
        .map_err(|e| format!("pacote-local: {e}"))?;

    // 3 a 5: troca, religa e confere (se a escolhida não responder, a de agora volta)
    trocar_pacote(&m, alvo, &r.caminho, instalada.as_deref(), ev)?;

    // a versão instalada passa a ser a escolhida; a última sequência aceita fica como estava (o manifesto do canal, já
    // aceito, continua valendo para atualizar de novo depois)
    std::fs::write(ambiente::arq_aceito(), serde_json::to_vec_pretty(&serde_json::json!({ "ultimaSequencia": aceito.ultima_sequencia, "versaoInstalada": alvo })).unwrap())
        .map_err(|e| e.to_string())?;
    let _ = rodar(&["rm", "-rf", ANTERIOR], 60);
    ev(Evento::Linha(format!("Ergon {alvo} no ar; os seus dados ficaram.")));
    Ok(alvo.to_string())
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

    #[test]
    fn voltar_so_para_anterior_e_nao_antiga_demais() {
        let pode = |alvo: &str, inst: Option<&str>| motivo_para_nao_voltar(alvo, inst, None);
        assert_eq!(VOLTA_MINIMA, "1.1.0-rc.27", "a rc.27 muda a base da equipe (perfis): antes dela, só pelo backup");
        assert_eq!(pode("1.1.0-rc.28", Some("1.1.0-rc.29")), None, "anterior e depois da mínima: pode");
        assert_eq!(pode(VOLTA_MINIMA, Some("1.1.0-rc.29")), None, "a mínima ainda pode");
        assert_eq!(pode("1.1.0-rc.29", Some("1.1.0")), None, "da final para a última pré-versão");
        let antiga = pode("1.1.0-rc.26", Some("1.1.0-rc.27")).expect("antes da mínima: não pode");
        assert!(antiga.contains("base da equipe") && antiga.contains(VOLTA_MINIMA) && antiga.contains("backup"), "{antiga}");
        assert!(pode("1.1.0-rc.24", Some("1.1.0-rc.28")).is_some());
        assert!(pode("1.1.0-rc.9", Some("1.1.0-rc.28")).is_some(), "rc.9 < rc.27 (número, não texto)");
        assert!(pode("1.0.1", Some("1.1.0-rc.28")).is_some());
        assert!(pode("1.1.0-rc.27", Some("1.1.0-rc.27")).unwrap().contains("já está"), "a mesma: nada a fazer");
        assert!(pode("1.1.0-rc.28", Some("1.1.0-rc.27")).unwrap().contains("Atualizar"), "mais nova: é atualizar");
        assert!(pode("1.1.0-rc.25", None).is_some(), "sem saber a instalada: não volta");
    }

    #[test]
    fn falha_no_meio_da_troca_poe_o_pacote_de_antes_de_volta() {
        use std::cell::Cell;
        let desfez = Cell::new(false);
        let r: Result<(), String> = ou_desfaz(|| Err("o pacote não abriu".to_string()), || {
            desfez.set(true);
            Ok(())
        });
        assert_eq!(r, Err("o pacote não abriu".to_string()), "o erro da etapa é o que vale");
        assert!(desfez.get(), "o pacote de antes volta para o lugar");
        let desfez = Cell::new(false);
        assert_eq!(ou_desfaz(|| Ok(7), || {
            desfez.set(true);
            Ok(())
        }), Ok(7));
        assert!(!desfez.get(), "deu certo: nada a desfazer");
        let r: Result<(), String> = ou_desfaz(|| Err("o pacote não abriu".to_string()), || Err("sem o de antes".to_string()));
        let e = r.unwrap_err();
        assert!(e.contains("o pacote não abriu") && e.contains("sem o de antes"), "{e}");
    }

    #[test]
    fn espera_da_equipe_tem_carencia_antes_de_dar_por_pronta() {
        assert!(!equipe_terminou(1, false), "logo depois de subir, a equipe pode ainda não ter começado");
        assert!(!equipe_terminou(CARENCIA_EQUIPE - 1, false));
        assert!(equipe_terminou(CARENCIA_EQUIPE, false), "passada a carência sem a equipe ocupada: segue");
        assert!(equipe_terminou(1, true), "a etapa já apareceu e a equipe ficou pronta: segue");
        assert!(!equipe_terminou(0, true));
    }

    #[test]
    fn voltar_so_para_as_duas_publicadas_antes_da_instalada() {
        let lista = serde_json::json!(["1.1.0-rc.28", "1.1.0-rc.27", "1.1.0-rc.26", "1.1.0-rc.25", "1.1.0-rc.24"]);
        let fora = |alvo: &str, inst: &str| fora_das_duas_anteriores(alvo, inst, Some(&lista));
        assert_eq!(fora("1.1.0-rc.26", "1.1.0-rc.27"), None, "a anterior: pode");
        assert_eq!(fora("1.1.0-rc.25", "1.1.0-rc.27"), None, "a segunda anterior: pode");
        let terceira = fora("1.1.0-rc.24", "1.1.0-rc.27").expect("a terceira anterior: não pode");
        assert!(terceira.contains("duas versões") && terceira.contains("1.1.0-rc.26") && terceira.contains("1.1.0-rc.25"), "{terceira}");
        assert_eq!(fora("1.1.0-rc.27", "1.1.0-rc.28"), None, "instalada a mais nova do canal");
        assert!(fora("1.1.0-rc.25", "1.1.0-rc.28").is_some(), "da rc.28, a rc.25 é a terceira");
        let uma = fora("1.1.0-rc.23", "1.1.0-rc.25").expect("só uma publicada antes");
        assert!(uma.contains("só para a 1.1.0-rc.24"), "{uma}");
        assert!(fora("1.1.0-rc.23", "1.1.0-rc.24").unwrap().contains("nenhuma antes"), "nenhuma publicada antes");
        // sem a lista (manifesto de antes desta regra): não limita aqui
        assert_eq!(fora_das_duas_anteriores("1.1.0-rc.20", "1.1.0-rc.27", None), None);
        // lista que não se lê, ou sem a instalada nela: falha fechada
        for ruim in [serde_json::json!("1.1.0-rc.26"), serde_json::json!(["1.1.0-rc.27", 7]), serde_json::json!(["1.1.0-rc.27", "lixo"]), serde_json::json!(["1.1.0-rc.26", "1.1.0-rc.25"])] {
            let m = fora_das_duas_anteriores("1.1.0-rc.26", "1.1.0-rc.27", Some(&ruim)).expect("falha fechada");
            assert!(m.contains("Nada foi mudado"), "{m}");
        }
        // sem a instalada na lista: o porquê é outro (não é falha passageira) e diz o caminho
        let sem = fora_das_duas_anteriores("1.1.0-rc.26", "1.1.0-rc.27", Some(&serde_json::json!(["1.1.0-rc.26", "1.1.0-rc.25"]))).expect("falha fechada");
        assert!(sem.contains("já não está entre as publicadas recentemente") && sem.contains("1.1.0-rc.27") && sem.contains("instalador"), "{sem}");
        let ilegivel = fora_das_duas_anteriores("1.1.0-rc.26", "1.1.0-rc.27", Some(&serde_json::json!(["1.1.0-rc.27", 7]))).expect("falha fechada");
        assert!(ilegivel.starts_with("Não deu para conferir"), "{ilegivel}");
    }

    #[test]
    fn voltar_recusa_versao_mal_formada() {
        for v in ["", "1.1", "1.1.0#x", "../1.1.0", "1.1.0-rc.20/../../x", "1.1.0?a=b", "v1.1.0"] {
            assert!(motivo_para_nao_voltar(v, Some("1.1.0-rc.24"), None).unwrap().contains("não foi reconhecida"), "{v}");
        }
    }

    #[test]
    fn voltar_nao_passa_por_cima_de_seguranca_obrigatoria() {
        let m = motivo_para_nao_voltar("1.1.0-rc.25", Some("1.1.0-rc.28"), Some("1.1.0-rc.26")).expect("a rc.26 é de segurança");
        assert!(m.contains("1.1.0-rc.26") && m.contains("segurança"), "{m}");
        assert_eq!(motivo_para_nao_voltar("1.1.0-rc.26", Some("1.1.0-rc.28"), Some("1.1.0-rc.26")), None, "a própria de segurança pode");
        assert_eq!(motivo_para_nao_voltar("1.1.0-rc.27", Some("1.1.0-rc.28"), Some("1.1.0-rc.26")), None, "depois dela também");
    }

    #[test]
    fn piso_de_seguranca_vem_da_propria_ou_da_carregada_adiante() {
        let p = |v: Value| piso_de_seguranca(&v);
        assert_eq!(p(serde_json::json!({ "versao": "1.1.0-rc.27" })), None, "versão comum, sem piso");
        assert_eq!(p(m("1.1.0-rc.27", true)), Some("1.1.0-rc.27".into()), "a própria é de segurança");
        // a rc.26 foi de segurança e a rc.27 saiu comum: o piso segue na rc.27 do canal
        assert_eq!(p(serde_json::json!({ "versao": "1.1.0-rc.27", "segurancaMinima": "1.1.0-rc.26" })), Some("1.1.0-rc.26".into()));
        let mut ambos = m("1.1.0-rc.27", true);
        ambos["segurancaMinima"] = serde_json::json!("1.1.0-rc.26");
        assert_eq!(p(ambos), Some("1.1.0-rc.27".into()), "a mais nova das duas");
        assert_eq!(p(serde_json::json!({ "versao": "1.1.0-rc.27", "segurancaMinima": "lixo" })), None);
    }

    /// Os manifestos assinados de teste (scripts/distribuicao/vetores.mjs), conferidos como o do canal.
    #[test]
    fn piso_do_canal_falha_fechada() {
        use base64::Engine as _;
        let v: Value = serde_json::from_str(include_str!("../testes/vetores-manifesto.json")).unwrap();
        let chaves = confianca::chaveiro_de(&v["chaves"].to_string()).unwrap();
        let b64 = |s: &Value| base64::engine::general_purpose::STANDARD.decode(s.as_str().unwrap()).unwrap();
        let est = confianca::EstadoAceito::default();
        let agora = confianca::instante(v["agora"].as_str().unwrap()).unwrap();
        let o = confianca::Opcoes { chaves: &chaves, edicao: "community", canal: "estavel", estado: &est, versao_cliente: None, agora };
        let piso = |nome: &str| {
            let c = v["casos"].as_array().unwrap().iter().find(|c| c["nome"] == nome).unwrap_or_else(|| panic!("caso {nome}"));
            piso_conferido(Some((b64(&c["manifesto"]), b64(&c["sig"]))), &o)
        };
        assert_eq!(piso("correto"), Ok(None), "canal conferido, sem segurança: nenhum piso");
        assert_eq!(piso("atualização de segurança aceita"), Ok(Some("1.0.2".into())));
        assert_eq!(piso("piso de segurança aceito"), Ok(Some("1.0.1".into())), "o piso carregado adiante");
        assert_eq!(piso("cliente antigo"), Ok(None), "o aplicativo mínimo não esconde o piso");
        for nome in ["vencido", "byte editado", "chave fora do chaveiro", "não é JSON"] {
            assert!(piso(nome).unwrap_err().contains("revisões de segurança"), "{nome}: sem o canal conferido, a volta não é feita");
        }
        assert!(piso_conferido(None, &o).unwrap_err().contains("Nada foi mudado"), "sem rede: a volta não é feita");
    }

    #[test]
    fn manifesto_de_cada_versao_no_canal_deste_aplicativo() {
        if std::env::var_os("ERGON_MANIFESTO_VERSAO_URL").is_some() {
            return; // bateria com servidor de teste: o endereço vem de fora
        }
        let u = manifesto_da_versao_url("1.1.0-rc.20");
        assert_eq!(u, format!("https://github.com/MagnoQuerino/ergon-community/releases/download/v1.1.0-rc.20/manifesto-{}.json", ambiente::CANAL));
        assert!(confianca::origem_permitida(&u), "origem permitida: o download confere a cada salto");
    }
}
