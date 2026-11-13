//! Ambiente do Ergon no Windows: uma distribuição WSL2 própria ("Ergon", em %LOCALAPPDATA%\ErgonAmbiente\wsl) com o Podman
//! dentro — sem Docker. A instalação é uma sequência de etapas com ponto de retomada gravado em disco:
//! cair a rede, fechar o aplicativo ou reiniciar o Windows no meio continua de onde parou, sem importar de novo nem
//! duplicar nada. Só o ambiente do Ergon é tocado: nenhuma outra distribuição, nem o .wslconfig, nem o Docker Desktop.

use crate::baixar;
use crate::confianca::{self, Chaveiro, EstadoAceito, Opcoes};
use crate::processo::{comando, rodar};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

/// Edição e canal deste aplicativo, e onde o manifesto do canal é descoberto (o ponteiro só descobre: quem decide é a
/// assinatura do manifesto).
/// O canal vem da compilação: a esteira compila a pré-versão (vX.Y.Z-rc.N) com ERGON_CANAL=teste.
pub const EDICAO: &str = "community";
pub const CANAL: &str = match option_env!("ERGON_CANAL") {
    Some(c) => c,
    None => "estavel",
};
pub const MANIFESTO_URL: &str = if mesmo_texto(CANAL, "teste") {
    "https://github.com/MagnoQuerino/ergon-community/releases/download/canal-teste/manifesto-teste.json"
} else {
    "https://github.com/MagnoQuerino/ergon-community/releases/latest/download/manifesto-estavel.json"
};
const fn mesmo_texto(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    let mut i = 0;
    while i < a.len() {
        if a[i] != b[i] {
            return false;
        }
        i += 1;
    }
    true
}
const LIMITE_MANIFESTO: u64 = 1 << 20;
const PORTA: u16 = crate::instalacao::PORTA_PADRAO;

pub enum Evento {
    Etapa(&'static str),
    Linha(String),
    Progresso { componente: String, feitos: u64, total: u64 },
}

#[derive(Debug, PartialEq)]
pub enum Fim {
    Pronto { versao: String },
    /// o WSL foi ativado e o Windows precisa reiniciar; o aplicativo abre sozinho depois e continua
    Reiniciar,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Progresso {
    /// última etapa concluída ("" = nenhuma)
    pub concluida: String,
    pub versao: Option<String>,
    pub reinicio_pedido: bool,
    pub atualizado_em: i64,
}

// ------------------------------------------------------------------------------------------------- lugares
pub fn pasta() -> PathBuf {
    if let Some(p) = std::env::var_os("ERGON_AMBIENTE_DIR") {
        return PathBuf::from(p);
    }
    // fora da pasta do aplicativo (%LOCALAPPDATA%\Ergon, a do instalador): desinstalar o aplicativo não leva o disco
    // do ambiente, onde ficam os dados
    std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir).join("ErgonAmbiente")
}
pub fn nome() -> String {
    if let Some(n) = NOME_EM_USO.lock().ok().and_then(|g| g.clone()) {
        return n;
    }
    let simples = |n: &String| !n.is_empty() && n.len() < 64 && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    std::env::var("ERGON_AMBIENTE_NOME").ok().filter(simples)
        // depois de uma migração em que o Windows não deixou o ambiente novo assumir o nome de antes
        .or_else(|| fs::read_to_string(crate::migracao::arq_nome()).ok().map(|t| t.trim().to_string()).filter(simples))
        .unwrap_or_else(|| "Ergon".into())
}
/// Durante a migração de um ambiente antigo, os comandos "dentro" vão para o ambiente novo (ver migracao.rs).
static NOME_EM_USO: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
pub(crate) fn usar_nome(n: Option<String>) {
    if let Ok(mut g) = NOME_EM_USO.lock() {
        *g = n;
    }
}
/// Programa dentro de um ambiente com nome dado (a migração fala com o antigo e com o novo ao mesmo tempo).
pub(crate) fn dentro_de(nome: &str, args: &[&str]) -> Command {
    let mut c = wsl();
    c.args(["-d", nome, "-u", "root", "--exec"]).args(args);
    c
}
pub(crate) fn wsl_cmd() -> Command {
    wsl()
}
fn arq_progresso() -> PathBuf {
    pasta().join("instalacao.json")
}
pub(crate) fn arq_aceito() -> PathBuf {
    pasta().join("manifesto-aceito.json")
}

pub fn ler_progresso() -> Progresso {
    fs::read_to_string(arq_progresso()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}
fn gravar_progresso(p: &mut Progresso) -> Result<(), String> {
    p.atualizado_em = confianca::agora_ms();
    fs::create_dir_all(pasta()).map_err(|e| e.to_string())?;
    let tmp = arq_progresso().with_extension("tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(p).unwrap()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, arq_progresso()).map_err(|e| e.to_string())
}
fn concluir(p: &mut Progresso, etapa: &str) -> Result<(), String> {
    p.concluida = etapa.into();
    gravar_progresso(p)
}

/// A instalação pelo ambiente próprio terminou neste computador (o aplicativo usa o motor de contêineres de dentro dele).
pub fn ativo() -> bool {
    cfg!(windows) && ler_progresso().concluida == "pronto"
}

// ------------------------------------------------------------------------------------------------- wsl.exe
fn wsl_exe() -> PathBuf {
    std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join(r"System32\wsl.exe")
}
fn wsl() -> Command {
    let mut c = comando(wsl_exe());
    c.env("WSL_UTF8", "1");
    c
}
/// Programa dentro do ambiente, sem shell do Windows no meio e com argumentos fixos.
pub fn dentro(args: &[&str]) -> Command {
    let mut c = wsl();
    c.args(["-d", &nome(), "-u", "root", "--exec"]).args(args);
    c
}

/// Saída do wsl.exe: UTF-16LE nas versões que ignoram WSL_UTF8, UTF-8 nas outras.
pub fn texto_wsl(b: &[u8]) -> String {
    let zeros = b.iter().skip(1).step_by(2).filter(|x| **x == 0).count();
    if b.len() >= 2 && zeros * 2 >= b.len() / 2 {
        let u: Vec<u16> = b.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).collect();
        String::from_utf16_lossy(&u).replace('\u{feff}', "")
    } else {
        String::from_utf8_lossy(b).replace('\u{feff}', "")
    }
}

pub(crate) fn rodar_wsl(c: Command, prazo: Duration) -> Result<String, String> {
    let o = rodar(c, prazo).map_err(|e| e.to_string())?;
    let t = format!("{}{}", texto_wsl(&o.stdout), texto_wsl(&o.stderr));
    if o.status.success() { Ok(t) } else { Err(t.trim().chars().take(400).collect()) }
}

/// O WSL atual (da Microsoft Store) está instalado? Só "--version": "--status" e "-l" saem com erro quando ainda não
/// há nenhuma distribuição, e isso não quer dizer que falta o WSL. O WSL antigo (o da caixa do Windows) não tem
/// "--version": aí, sim, precisa ativar/atualizar.
pub fn wsl_pronto() -> bool {
    let mut v = wsl();
    v.arg("--version");
    rodar_wsl(v, Duration::from_secs(30)).is_ok()
}

pub fn distribuicoes() -> Vec<String> {
    let mut c = wsl();
    c.args(["-l", "-q"]);
    rodar_wsl(c, Duration::from_secs(30)).map(|t| t.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()).unwrap_or_default()
}

pub fn registrado() -> bool {
    distribuicoes().iter().any(|d| d.eq_ignore_ascii_case(&nome()))
}

/// Mensagem simples para os erros conhecidos do WSL.
pub fn explicar_erro_wsl(e: &str) -> String {
    let l = e.to_lowercase();
    if l.contains("0x80370102") || l.contains("virtualiz") || l.contains("hcs_e_hyperv_not_installed") {
        "A virtualização está desligada neste computador. Ligue a opção de virtualização (Intel VT-x ou AMD-V/SVM) na configuração do computador (BIOS/UEFI) e abra o Ergon de novo.".into()
    } else if l.contains("0x80070422") {
        "O serviço do WSL está desativado no Windows. Reinicie o computador e abra o Ergon de novo.".into()
    } else {
        format!("O WSL respondeu com erro: {}", e.chars().take(300).collect::<String>())
    }
}

// ------------------------------------------------------------------------------------------------- manifesto
pub(crate) fn chaveiro() -> Chaveiro {
    if cfg!(feature = "origens-de-teste") {
        if let Some(t) = std::env::var_os("ERGON_CHAVEIRO").and_then(|p| fs::read_to_string(p).ok()) {
            return confianca::chaveiro_de(&t).expect("chaveiro de teste");
        }
    }
    confianca::chaveiro_embutido()
}
pub(crate) fn manifesto_url() -> String {
    if cfg!(feature = "origens-de-teste") {
        if let Ok(u) = std::env::var("ERGON_MANIFESTO_URL") {
            return u;
        }
    }
    MANIFESTO_URL.into()
}
pub(crate) fn aceito() -> EstadoAceito {
    let v: Value = fs::read_to_string(arq_aceito()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or(Value::Null);
    EstadoAceito { ultima_sequencia: v["ultimaSequencia"].as_u64(), versao_instalada: v["versaoInstalada"].as_str().map(String::from) }
}

/// Lê e confere o manifesto do canal. Na retomada da mesma instalação, o manifesto já aceito (guardado) vale de novo:
/// a proteção contra repetição é para versões novas, não para continuar a mesma.
pub(crate) fn manifesto_conferido() -> Result<Value, String> {
    let url = manifesto_url();
    let guardado = pasta().join("manifesto.json");
    let b = baixar::baixar_para_memoria(&url, LIMITE_MANIFESTO).map_err(|e| format!("Não deu para ler a versão publicada ({e})."))?;
    let s = baixar::baixar_para_memoria(&format!("{url}.sig"), 4096).map_err(|e| format!("Não deu para ler a assinatura da versão ({e})."))?;
    let mut est = aceito();
    if fs::read(&guardado).ok().as_deref() == Some(b.as_slice()) {
        est.ultima_sequencia = est.ultima_sequencia.map(|u| u.saturating_sub(1));
    }
    let o = Opcoes { chaves: &chaveiro(), edicao: EDICAO, canal: CANAL, estado: &est, versao_cliente: Some(env!("CARGO_PKG_VERSION")), agora: confianca::agora_ms() };
    let m = confianca::verificar_manifesto(&b, &s, &o).map_err(|e| format!("A versão publicada foi recusada: {e}. Nada foi instalado."))?;
    fs::create_dir_all(pasta()).map_err(|e| e.to_string())?;
    fs::write(&guardado, &b).map_err(|e| e.to_string())?;
    Ok(m)
}

pub(crate) fn componente<'a>(m: &'a Value, id: &str) -> Result<&'a Value, String> {
    m["componentes"].get(id).ok_or_else(|| format!("A versão {} não traz o componente \"{id}\" para este aplicativo.", m["versao"].as_str().unwrap_or("?")))
}

// ------------------------------------------------------------------------------------------------- instalar
/// Instala (ou continua a instalação). Cada etapa confere se já foi feita antes de fazer.
pub fn instalar(ev: &mut dyn FnMut(Evento)) -> Result<Fim, String> {
    if !cfg!(windows) {
        return instalar_linux(ev);
    }
    let mut p = ler_progresso();

    ev(Evento::Etapa("diagnostico"));
    let livre = espaco_livre(&pasta());
    ev(Evento::Linha(format!("Pasta do ambiente: {}", pasta().display())));
    if let Some(l) = livre {
        ev(Evento::Linha(format!("Espaço livre: {:.1} GB", l as f64 / 1e9)));
        if l < 12_000_000_000 {
            return Err(format!("Faltam pelo menos 12 GB livres no disco (há {:.1} GB). Libere espaço e tente de novo.", l as f64 / 1e9));
        }
    }

    ev(Evento::Etapa("wsl"));
    sem_boas_vindas_do_wsl();
    if !wsl_pronto() {
        if p.reinicio_pedido {
            // a próxima tentativa (botão Começar) ativa de novo, em vez de pedir outro reinício
            p.reinicio_pedido = false;
            gravar_progresso(&mut p)?;
            return Err(format!("O WSL ainda não responde depois do reinício. Tente de novo: o Ergon ativa o WSL outra vez. {}", fim_do_registro_de_ativacao()).trim().to_string());
        }
        ev(Evento::Linha("Ativando o WSL do Windows (o Windows pede permissão de administrador)…".into()));
        let precisa_reiniciar = match ativar_wsl(ev)? {
            Ativacao::Terminou { pede_reinicio: true, .. } => true,
            _ if wsl_pronto() => false,
            // terminou bem, mas o WSL só responde depois de o Windows reiniciar
            Ativacao::Terminou { codigo: 0, .. } => true,
            Ativacao::Terminou { codigo, .. } => {
                return Err(format!("O Windows não conseguiu ativar o WSL (código {codigo}). {}", fim_do_registro_de_ativacao()).trim().to_string());
            }
            Ativacao::AindaRodando => {
                return Err(format!("A ativação do WSL passou de 30 minutos sem terminar. Confira a internet; em computador de empresa, o bloqueio de downloads pode impedir a ativação: peça ao suporte para instalar o WSL e abra o Ergon de novo. {}", fim_do_registro_de_ativacao()).trim().to_string());
            }
        };
        if precisa_reiniciar {
            p.reinicio_pedido = true;
            gravar_progresso(&mut p)?;
            agendar_continuacao()?;
            return Ok(Fim::Reiniciar);
        }
    }
    p.reinicio_pedido = false;
    concluir(&mut p, "wsl")?;

    ev(Evento::Etapa("baixar"));
    let m = manifesto_conferido()?;
    let versao = m["versao"].as_str().unwrap_or("?").to_string();
    ev(Evento::Linha(format!("Versão {versao} conferida (assinatura, edição, canal e validade)")));
    let mut caminhos = std::collections::BTreeMap::new();
    for id in ["ambiente-wsl", "pacote-local"] {
        let c = componente(&m, id)?;
        let (url, sha, tam) = (c["url"].as_str().unwrap(), c["sha256"].as_str().unwrap(), c["tamanho"].as_u64().unwrap());
        let idc = id.to_string();
        let r = baixar::componente(url, sha, tam, &pasta().join("cache"), &mut |f, t| ev(Evento::Progresso { componente: idc.clone(), feitos: f, total: t })).map_err(|e| format!("{id}: {e}"))?;
        ev(Evento::Linha(format!("{id}: {}", if r.baixados == 0 { "já estava aqui, conferido".to_string() } else if r.retomado { format!("download retomado, {:.1} MB, conferido", r.baixados as f64 / 1e6) } else { format!("{:.1} MB, conferido", r.baixados as f64 / 1e6) })));
        caminhos.insert(id, r.caminho);
    }
    p.versao = Some(versao.clone());
    concluir(&mut p, "baixar")?;

    ev(Evento::Etapa("importar"));
    sem_boas_vindas_do_wsl(); // de novo: o WSL pode ter acabado de ser ativado
    if registrado() {
        ev(Evento::Linha(format!("O ambiente \"{}\" já existe neste computador: aproveitado.", nome())));
    } else {
        let disco = pasta().join("wsl");
        // pasta de uma importação que não terminou (e não ficou registrada): é nossa, recomeça limpa
        if disco.exists() {
            fs::remove_dir_all(&disco).map_err(|e| format!("Não deu para limpar a importação anterior ({e})."))?;
        }
        fs::create_dir_all(&disco).map_err(|e| e.to_string())?;
        let mut c = wsl();
        c.arg("--import").arg(nome()).arg(&disco).arg(&caminhos["ambiente-wsl"]).args(["--version", "2"]);
        rodar_wsl(c, Duration::from_secs(15 * 60)).map_err(|e| explicar_erro_wsl(&e))?;
        ev(Evento::Linha(format!("Ambiente \"{}\" criado (WSL2).", nome())));
    }
    let k = rodar_wsl(dentro(&["uname", "-r"]), Duration::from_secs(120)).map_err(|e| explicar_erro_wsl(&e))?;
    if !k.contains("WSL2") && !k.to_lowercase().contains("microsoft") {
        return Err(format!("O ambiente não está rodando em WSL2 ({}).", k.trim()));
    }
    concluir(&mut p, "importar")?;

    ev(Evento::Etapa("configurar"));
    entregar_pacote(&caminhos["pacote-local"])?;
    fixar_imagens(&m, &versao)?;
    ev(Evento::Linha("Imagens presas aos digests do manifesto.".into()));
    concluir(&mut p, "configurar")?;

    ev(Evento::Etapa("ligar"));
    ligar_motor_de_conteineres(ev)?;
    let mut c = dentro(&["env", "ERGON_SEM_NAVEGADOR=1", "/bin/bash", "/opt/ergon-pacote/ergon.sh", "instalar"]);
    transmitir(&mut c, Duration::from_secs(40 * 60), ev).map_err(|e| format!("A instalação dos serviços parou: {e}"))?;
    concluir(&mut p, "ligar")?;

    ev(Evento::Etapa("conferir"));
    let fim = Instant::now() + Duration::from_secs(300);
    loop {
        match crate::diag::ler_saude(PORTA) {
            crate::diag::Resposta::Ergon(s) if s.versao == versao => {
                ev(Evento::Linha(format!("Ergon {versao} respondendo em http://localhost:{PORTA}")));
                break;
            }
            r if Instant::now() > fim => return Err(format!("O Ergon não respondeu depois de ligar ({r:?}).")),
            _ => std::thread::sleep(Duration::from_secs(3)),
        }
    }
    let seq = m["sequencia"].as_u64().unwrap_or(0);
    fs::write(arq_aceito(), serde_json::to_vec_pretty(&serde_json::json!({ "ultimaSequencia": seq, "versaoInstalada": versao })).unwrap()).map_err(|e| e.to_string())?;
    p.concluida = "pronto".into();
    gravar_progresso(&mut p)?;
    desagendar_continuacao();
    Ok(Fim::Pronto { versao })
}

/// Prende as imagens do pacote entregue aos digests do manifesto: o motor de contêineres confere o conteúdo baixado contra eles (também a
/// imagem dos motores de cada pessoa, criados pelo gerente de motores).
pub(crate) fn fixar_imagens(m: &Value, versao: &str) -> Result<(), String> {
    for id in ["core", "motor"] {
        let c = componente(m, id)?;
        let (img, ver, dig) = (c["imagem"].as_str().unwrap(), c["versao"].as_str().unwrap_or(versao), c["digest"].as_str().unwrap());
        let (e1, e2) = (format!("s#image: {img}:{ver}$#image: {img}@{dig}#"), format!("s#ERGON_MOTOR_IMAGE: {img}:{ver}$#ERGON_MOTOR_IMAGE: {img}@{dig}#"));
        rodar_wsl(dentro(&["sed", "-i", "-e", &e1, "-e", &e2, "/opt/ergon-pacote/docker-compose.yml"]), Duration::from_secs(30))?;
        let usa = rodar_wsl(dentro(&["grep", "-c", &format!("{img}@{dig}"), "/opt/ergon-pacote/docker-compose.yml"]), Duration::from_secs(30)).unwrap_or_default();
        let sobrou = rodar_wsl(dentro(&["grep", "-cF", &format!("{img}:{ver}"), "/opt/ergon-pacote/docker-compose.yml"]), Duration::from_secs(30)).unwrap_or_default();
        if usa.trim().parse::<u32>().unwrap_or(0) == 0 || sobrou.trim().parse::<u32>().unwrap_or(0) > 0 {
            return Err(format!("O pacote da versão não usa a imagem {img}:{ver} do manifesto do jeito esperado."));
        }
    }
    Ok(())
}

/// O mesmo de `fixar_imagens`, num texto de compose (Linux: o pacote fica numa pasta da própria conta).
pub(crate) fn fixar_no_texto(texto: &str, m: &Value, versao: &str) -> Result<String, String> {
    let mut t: Vec<String> = texto.lines().map(String::from).collect();
    for id in ["core", "motor"] {
        let c = componente(m, id)?;
        let (img, ver, dig) = (c["imagem"].as_str().unwrap_or_default(), c["versao"].as_str().unwrap_or(versao), c["digest"].as_str().unwrap_or_default());
        for chave in ["image: ", "ERGON_MOTOR_IMAGE: "] {
            let (de, para) = (format!("{chave}{img}:{ver}"), format!("{chave}{img}@{dig}"));
            for l in t.iter_mut() {
                if let Some(inicio) = l.trim_end().strip_suffix(de.as_str()) {
                    *l = format!("{inicio}{para}");
                }
            }
        }
        let junto = t.join("\n");
        if img.is_empty() || dig.is_empty() || !junto.contains(&format!("{img}@{dig}")) || junto.contains(&format!("{img}:{ver}")) {
            return Err(format!("O pacote da versão não usa a imagem {img}:{ver} do manifesto do jeito esperado."));
        }
    }
    Ok(t.join("\n") + "\n")
}

/// Linux: o Ergon na conta da pessoa, com o Podman do sistema (o pacote .deb o traz), sem administrador. O pacote da
/// versão, conferido pelo manifesto, entra numa pasta da conta; as imagens são presas aos digests; o lançador instala
/// (pasta fixa ~/.local/share/ergon, segredos em ~/.ergon) e liga os serviços.
fn instalar_linux(ev: &mut dyn FnMut(Evento)) -> Result<Fim, String> {
    ev(Evento::Etapa("diagnostico"));
    let mut v = comando("podman");
    v.args(["info", "--format", "{{.Version.Version}}"]);
    let o = rodar(v, Duration::from_secs(90)).map_err(|_| "O Podman não está instalado neste computador. Instale o Ergon pelo pacote .deb (ele traz o Podman) e abra de novo.".to_string())?;
    if !o.status.success() {
        return Err(format!("O Podman não respondeu na sua conta: {}", String::from_utf8_lossy(&o.stderr).trim().chars().take(300).collect::<String>()));
    }
    ev(Evento::Linha(format!("Podman {} na sua conta (sem administrador).", String::from_utf8_lossy(&o.stdout).trim())));
    let casa = crate::instalacao::pasta_pessoal().ok_or("A pasta pessoal desta conta não foi encontrada.")?;
    let base = casa.join(".local/share/ergon-instalador");

    ev(Evento::Etapa("baixar"));
    let m = manifesto_conferido()?;
    let versao = m["versao"].as_str().unwrap_or("?").to_string();
    ev(Evento::Linha(format!("Versão {versao} conferida (assinatura, edição, canal e validade)")));
    let c = componente(&m, "pacote-local")?;
    let (url, sha, tam) = (c["url"].as_str().unwrap_or_default(), c["sha256"].as_str().unwrap_or_default(), c["tamanho"].as_u64().unwrap_or(0));
    let r = baixar::componente(url, sha, tam, &base.join("cache"), &mut |f, t| ev(Evento::Progresso { componente: "pacote-local".into(), feitos: f, total: t }))
        .map_err(|e| format!("pacote-local: {e}"))?;

    ev(Evento::Etapa("configurar"));
    let pac = base.join("pacote");
    let _ = fs::remove_dir_all(&pac);
    fs::create_dir_all(&pac).map_err(|e| e.to_string())?;
    // o zip pelo Python do sistema (o podman-compose já depende dele): nada de programa a mais
    let mut z = comando("python3");
    z.args(["-m", "zipfile", "-e"]).arg(&r.caminho).arg(&pac);
    let o = rodar(z, Duration::from_secs(120)).map_err(|e| format!("Não deu para abrir o pacote da versão ({e})."))?;
    if !o.status.success() {
        return Err(format!("Não deu para abrir o pacote da versão: {}", String::from_utf8_lossy(&o.stderr).trim().chars().take(300).collect::<String>()));
    }
    let compose = pac.join("docker-compose.yml");
    let texto = fs::read_to_string(&compose).map_err(|e| format!("O pacote da versão não tem o compose ({e})."))?;
    fs::write(&compose, fixar_no_texto(&texto, &m, &versao)?).map_err(|e| e.to_string())?;
    ev(Evento::Linha("Imagens presas aos digests do manifesto.".into()));

    ev(Evento::Etapa("ligar"));
    let mut c = comando("/bin/bash");
    c.arg(pac.join("ergon.sh")).arg("instalar").env("ERGON_SEM_NAVEGADOR", "1").env("ERGON_MOTOR", "podman").env("ERGON_LANG", "pt").current_dir(&pac);
    transmitir(&mut c, Duration::from_secs(40 * 60), ev).map_err(|e| format!("A instalação dos serviços parou: {e}"))?;

    ev(Evento::Etapa("conferir"));
    let fim = Instant::now() + Duration::from_secs(300);
    loop {
        match crate::diag::ler_saude(PORTA) {
            crate::diag::Resposta::Ergon(s) if s.versao == versao => {
                ev(Evento::Linha(format!("Ergon {versao} respondendo em http://localhost:{PORTA}")));
                break;
            }
            r if Instant::now() > fim => return Err(format!("O Ergon não respondeu depois de ligar ({r:?}).")),
            _ => std::thread::sleep(Duration::from_secs(3)),
        }
    }
    let _ = fs::remove_dir_all(&pac);
    Ok(Fim::Pronto { versao })
}

/// O pacote da versão (lançador + compose) entra pela entrada padrão: o ambiente não enxerga os discos do Windows.
pub(crate) fn entregar_pacote(zip: &Path) -> Result<(), String> {
    let mut c = dentro(&["sh", "-c", "rm -rf /opt/ergon-pacote /opt/ergon-pacote.zip && mkdir -p /opt/ergon-pacote && cat > /opt/ergon-pacote.zip && unzip -qo /opt/ergon-pacote.zip -d /opt/ergon-pacote && rm -f /opt/ergon-pacote.zip && chmod +x /opt/ergon-pacote/ergon.sh"]);
    c.stdin(fs::File::open(zip).map_err(|e| e.to_string())?).stdout(Stdio::piped()).stderr(Stdio::piped());
    let o = c.output().map_err(|e| e.to_string())?;
    if !o.status.success() {
        return Err(format!("Não deu para entregar o pacote ao ambiente: {}", texto_wsl(&o.stderr).trim()));
    }
    Ok(())
}

/// Liga o motor de contêineres dentro do ambiente (a API do Podman) e mantém o processo vivo em segundo plano (fechar a janela não para os
/// serviços; "Parar serviços" na bandeja para).
pub fn ligar_motor_de_conteineres(ev: &mut dyn FnMut(Evento)) -> Result<(), String> {
    if rodar_wsl(dentro(&["/usr/local/bin/ergon-ambiente", "pronto"]), Duration::from_secs(60)).is_ok() {
        return Ok(());
    }
    ev(Evento::Linha("Ligando o motor de contêineres do ambiente…".into()));
    let mut c = dentro(&["/usr/local/bin/ergon-ambiente", "servico"]);
    c.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    c.spawn().map_err(|e| format!("Não deu para ligar o ambiente ({e})."))?;
    let fim = Instant::now() + Duration::from_secs(90);
    while Instant::now() < fim {
        if rodar_wsl(dentro(&["/usr/local/bin/ergon-ambiente", "pronto"]), Duration::from_secs(30)).is_ok() {
            return Ok(());
        }
        std::thread::sleep(Duration::from_secs(2));
    }
    Err("O motor de contêineres do ambiente não respondeu.".into())
}

/// "Iniciar Ergon" com o ambiente próprio.
pub fn subir(ev: &mut dyn FnMut(Evento)) -> Result<(), String> {
    ligar_motor_de_conteineres(ev)?;
    let mut c = dentro(&["/bin/bash", "/root/.local/share/ergon/ergon.sh", "subir"]);
    transmitir(&mut c, Duration::from_secs(15 * 60), ev)
}

/// "Parar serviços": para o Ergon e desliga SÓ o ambiente do Ergon (as outras distribuições continuam).
pub fn parar(ev: &mut dyn FnMut(Evento)) -> Result<(), String> {
    let mut c = dentro(&["/bin/bash", "/root/.local/share/ergon/ergon.sh", "parar"]);
    transmitir(&mut c, Duration::from_secs(5 * 60), ev)?;
    let mut t = wsl();
    t.arg("--terminate").arg(nome());
    rodar_wsl(t, Duration::from_secs(60)).map(|_| ())
}

pub(crate) fn transmitir(c: &mut Command, prazo: Duration, ev: &mut dyn FnMut(Evento)) -> Result<(), String> {
    c.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut f = c.spawn().map_err(|e| e.to_string())?;
    let err = f.stderr.take().unwrap();
    let t = std::thread::spawn(move || BufReader::new(err).lines().map_while(Result::ok).collect::<Vec<_>>());
    let mut ultima = String::new();
    let fim = Instant::now() + prazo;
    for l in BufReader::new(f.stdout.take().unwrap()).lines().map_while(Result::ok) {
        let l = crate::processo::sem_cores(&l).trim().chars().take(300).collect::<String>();
        if !l.is_empty() {
            ultima = l.clone();
            ev(Evento::Linha(l));
        }
        if Instant::now() > fim {
            let _ = f.kill();
            return Err("passou do prazo".into());
        }
    }
    let st = f.wait().map_err(|e| e.to_string())?;
    let erros = t.join().unwrap_or_default();
    if st.success() {
        Ok(())
    } else {
        let u = erros.last().cloned().unwrap_or(ultima);
        Err(crate::processo::sem_cores(&u).trim_start_matches("[ergon]").trim().to_string())
    }
}

// ------------------------------------------------------------------------------------------------- Windows
#[derive(Debug, PartialEq)]
enum Ativacao {
    Terminou { codigo: u32, pede_reinicio: bool },
    /// passou do prazo e o instalador do Windows continua rodando (não é interrompido: parar no meio estraga mais)
    AindaRodando,
}

/// O que o instalador do WSL escreveu na última tentativa (fica na pasta do ambiente, para o diagnóstico).
fn registro_de_ativacao() -> PathBuf {
    pasta().join("ativar-wsl.log")
}

/// `wsl --install --no-distribution --web-download`, com o pedido de administrador do Windows (UAC). Só ativa o WSL:
/// nenhuma distribuição é instalada além da nossa. Lições do primeiro teste num computador sem WSL:
/// - `--web-download` baixa o WSL direto da Microsoft no GitHub, sem a Loja (bloqueada em muitas empresas, e aí o
///   instalador fica parado sem dizer nada); o próprio Ergon já depende do GitHub para baixar os componentes;
/// - espera só o processo que abrimos (o `Start-Process -Wait` de antes esperava também tudo o que o instalador deixa
///   aberto e podia ficar 30 minutos parado com o WSL já ativado);
/// - a saída do instalador vai para um arquivo, que a tela acompanha: a pessoa vê o download andar.
fn ativar_wsl(ev: &mut dyn FnMut(Evento)) -> Result<Ativacao, String> {
    // nos testes, ativar o WSL reiniciaria a máquina de teste: proibido
    if cfg!(feature = "origens-de-teste") && std::env::var_os("ERGON_PROIBIR_ATIVAR_WSL").is_some() {
        return Err("TESTE: o WSL não foi encontrado e ativá-lo está proibido neste teste".into());
    }
    fs::create_dir_all(pasta()).map_err(|e| e.to_string())?;
    let _ = fs::remove_file(registro_de_ativacao());
    // A saída do cmd elevado vem por um cano com nome (criado por nós, sem administrador) e não por um arquivo: um
    // processo de administrador escrevendo numa pasta da conta pode ser desviado para um arquivo do sistema. Um cano
    // por passo, então cada parte tem uma codificação só (o WSL antigo escreve em UTF-16, o novo em UTF-8).
    let coletor = elevado::Coletor::novo(3).ok();
    let p = elevado::abrir_como_administrador(&cmd_exe(), &linha_de_ativacao(&wsl_exe(), coletor.as_ref().map(|c| c.nome()))).map_err(|c| match c {
        1223 => "A permissão de administrador foi negada. O WSL é necessário para o Ergon; tente de novo e aceite o pedido do Windows.".to_string(),
        c => format!("O Windows não abriu o instalador do WSL (código {c})."),
    })?;
    ev(Evento::Linha("Permissão concedida. Baixando e ativando o WSL (leva alguns minutos)…".into()));
    let fim = Instant::now() + Duration::from_secs(30 * 60);
    let (mut vistas, mut ultimo_progresso, mut avisou) = (0usize, None::<Instant>, false);
    loop {
        let codigo = p.esperar(Duration::from_secs(1));
        if codigo.is_some() {
            if let Some(c) = &coletor {
                c.soltar();
            }
        }
        let partes = coletor.as_ref().map(|c| c.partes(codigo.is_some())).unwrap_or_default();
        let texto = texto_das_partes(&partes);
        if partes.len() >= 2 && !avisou {
            avisou = true;
            ev(Evento::Linha("Este Windows tem o WSL antigo: atualizando o WSL por outro caminho…".into()));
        }
        let linhas = linhas_do_registro(&texto, codigo.is_some());
        for l in linhas.iter().skip(vistas) {
            if eh_progresso(l) {
                // a barra de progresso reescreve a mesma linha várias vezes por segundo: uma a cada 5 s basta
                if ultimo_progresso.is_some_and(|t: Instant| t.elapsed() < Duration::from_secs(5)) {
                    continue;
                }
                ultimo_progresso = Some(Instant::now());
            }
            ev(Evento::Linha(l.chars().take(300).collect()));
        }
        vistas = vistas.max(linhas.len());
        let acabou = codigo.is_some() || Instant::now() > fim;
        if acabou {
            // o registro para o diagnóstico é gravado por nós, sem administrador
            let _ = fs::write(registro_de_ativacao(), texto.as_bytes());
        }
        if let Some(codigo) = codigo {
            return Ok(Ativacao::Terminou { codigo, pede_reinicio: pede_reinicio(codigo, &texto) });
        }
        if acabou {
            return Ok(Ativacao::AindaRodando);
        }
    }
}

/// O texto de cada passo, cada um na sua codificação, um depois do outro.
fn texto_das_partes(partes: &[Vec<u8>]) -> String {
    partes.iter().map(|b| texto_wsl(b)).collect::<Vec<_>>().join("\n")
}

/// Parâmetros do cmd elevado (os caminhos e o cano vão entre aspas; com /s, o cmd tira só as aspas de fora). Cada
/// passo manda a saída para o cano com nome, quando há um (sem ele, a saída se perde, mas a ativação acontece).
/// O WSL antigo que vinha com o Windows (10 e Server 2022) não conhece "--install --no-distribution" e sai com erro
/// na hora (medido na esteira): aí a segunda tentativa troca esse WSL pelo atual com "--update --web-download" e
/// repete a ativação, já com o wsl.exe novo.
fn linha_de_ativacao(wsl: &Path, cano: Option<&str>) -> String {
    let w = wsl.display();
    let r = cano.map(|c| format!(" > \"{c}\" 2>&1")).unwrap_or_default();
    format!(
        "/d /s /c \"set WSL_UTF8=1&& \"{w}\" --install --no-distribution --web-download{r} || (\"{w}\" --update --web-download{r}& \"{w}\" --install --no-distribution --web-download{r})\""
    )
}
fn cmd_exe() -> PathBuf {
    std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join(r"System32\cmd.exe")
}
/// Linhas do registro (a barra de progresso volta com \r). Enquanto o instalador roda, a última pode estar pela metade.
fn linhas_do_registro(texto: &str, terminou: bool) -> Vec<String> {
    let mut partes: Vec<&str> = texto.split(['\r', '\n']).collect();
    if !terminou {
        partes.pop();
    }
    partes.into_iter().map(str::trim).filter(|l| !l.is_empty()).map(String::from).collect()
}
fn eh_progresso(l: &str) -> bool {
    l.contains('%') && (l.starts_with('[') || l.chars().filter(|c| *c == '=').count() > 3)
}
/// 3010 = "terminou, falta reiniciar"; o texto cobre o Windows em português e em inglês.
fn pede_reinicio(codigo: u32, texto: &str) -> bool {
    let t = texto.to_lowercase();
    codigo == 3010 || ["reboot", "restart", "reinicializ", "reinicie", "reiniciar"].iter().any(|p| t.contains(p))
}
/// As últimas mensagens do instalador, para o erro e o diagnóstico.
fn fim_do_registro_de_ativacao() -> String {
    let texto = fs::read(registro_de_ativacao()).map(|b| texto_wsl(&b)).unwrap_or_default();
    resumo_do_registro(&texto)
}
fn resumo_do_registro(texto: &str) -> String {
    let l: Vec<String> = linhas_do_registro(texto, true).into_iter().filter(|l| !eh_progresso(l)).collect();
    if l.is_empty() {
        return String::new();
    }
    let u = l[l.len().saturating_sub(3)..].join(" / ");
    format!("Última mensagem do Windows: {}", u.chars().take(300).collect::<String>())
}

/// Abrir um programa com o pedido de administrador do Windows e esperar só por ele (ShellExecuteEx com "runas").
#[cfg(windows)]
mod elevado {
    use std::ffi::c_void;
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;
    use std::time::Duration;

    #[repr(C)]
    struct Info {
        cb_size: u32,
        mascara: u32,
        hwnd: *mut c_void,
        verbo: *const u16,
        arquivo: *const u16,
        parametros: *const u16,
        pasta: *const u16,
        mostrar: i32,
        inst_app: *mut c_void,
        id_list: *mut c_void,
        classe: *const u16,
        chave_classe: *mut c_void,
        tecla: u32,
        icone: *mut c_void,
        processo: *mut c_void,
    }
    #[link(name = "shell32")]
    extern "system" {
        fn ShellExecuteExW(info: *mut Info) -> i32;
    }
    #[link(name = "kernel32")]
    extern "system" {
        fn WaitForSingleObject(h: *mut c_void, ms: u32) -> u32;
        fn GetExitCodeProcess(h: *mut c_void, codigo: *mut u32) -> i32;
        fn CloseHandle(h: *mut c_void) -> i32;
    }
    const SEE_MASK_NOCLOSEPROCESS: u32 = 0x40;
    const SEE_MASK_NOASYNC: u32 = 0x100;
    const SW_HIDE: i32 = 0;
    const WAIT_OBJECT_0: u32 = 0;
    const WAIT_TIMEOUT: u32 = 0x102;

    pub struct Processo(*mut c_void);
    impl Processo {
        /// Some(código) quando terminou; None se ainda roda depois da espera.
        pub fn esperar(&self, d: Duration) -> Option<u32> {
            match unsafe { WaitForSingleObject(self.0, d.as_millis() as u32) } {
                WAIT_TIMEOUT => None,
                WAIT_OBJECT_0 => {
                    let mut c = 0u32;
                    Some(if unsafe { GetExitCodeProcess(self.0, &mut c) } != 0 { c } else { u32::MAX })
                }
                _ => Some(u32::MAX),
            }
        }
    }
    impl Drop for Processo {
        fn drop(&mut self) {
            unsafe { CloseHandle(self.0) };
        }
    }
    fn larga(s: &std::ffi::OsStr) -> Vec<u16> {
        s.encode_wide().chain(Some(0)).collect()
    }
    /// Err(1223) = a pessoa recusou o pedido do Windows.
    pub fn abrir_como_administrador(programa: &Path, parametros: &str) -> Result<Processo, u32> {
        let (verbo, arquivo, params) = (larga("runas".as_ref()), larga(programa.as_os_str()), larga(parametros.as_ref()));
        let mut i = Info {
            cb_size: std::mem::size_of::<Info>() as u32,
            mascara: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC,
            hwnd: std::ptr::null_mut(),
            verbo: verbo.as_ptr(),
            arquivo: arquivo.as_ptr(),
            parametros: params.as_ptr(),
            pasta: std::ptr::null(),
            mostrar: SW_HIDE,
            inst_app: std::ptr::null_mut(),
            id_list: std::ptr::null_mut(),
            classe: std::ptr::null(),
            chave_classe: std::ptr::null_mut(),
            tecla: 0,
            icone: std::ptr::null_mut(),
            processo: std::ptr::null_mut(),
        };
        if unsafe { ShellExecuteExW(&mut i) } == 0 {
            return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32);
        }
        if i.processo.is_null() {
            return Err(0);
        }
        Ok(Processo(i.processo))
    }

    // ------------------------------------------------------------------ canos com nome (a saída do cmd elevado)
    #[link(name = "kernel32")]
    extern "system" {
        fn CreateNamedPipeW(nome: *const u16, abertura: u32, modo: u32, maximo: u32, saida: u32, entrada: u32, espera: u32, seguranca: *mut c_void) -> *mut c_void;
        fn ConnectNamedPipe(h: *mut c_void, sobreposto: *mut c_void) -> i32;
        fn ReadFile(h: *mut c_void, buf: *mut u8, n: u32, lidos: *mut u32, sobreposto: *mut c_void) -> i32;
        fn CreateFileW(nome: *const u16, acesso: u32, compartilhar: u32, seguranca: *mut c_void, disposicao: u32, flags: u32, modelo: *mut c_void) -> *mut c_void;
        fn LocalFree(h: *mut c_void) -> *mut c_void;
    }
    #[link(name = "advapi32")]
    extern "system" {
        fn ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl: *const u16, revisao: u32, sd: *mut *mut c_void, tamanho: *mut u32) -> i32;
    }
    #[repr(C)]
    struct AtributosSeguranca {
        tamanho: u32,
        descritor: *mut c_void,
        herdar: i32,
    }
    /// Quem pode usar o cano: o sistema, o dono (a pessoa) e quem está como administrador. Sem os administradores,
    /// numa conta sem privilégio em que outra pessoa digita a senha de administrador (comum em empresas), o cmd elevado
    /// roda como outra conta, não abre o cano e, pelo jeito do cmd, nem roda o passo.
    const QUEM_PODE: &str = "D:P(A;;GA;;;SY)(A;;GA;;;OW)(A;;GA;;;BA)";
    const PIPE_ACCESS_INBOUND: u32 = 0x1;
    const FILE_FLAG_FIRST_PIPE_INSTANCE: u32 = 0x0008_0000;
    /// PIPE_TYPE_BYTE, PIPE_READMODE_BYTE e PIPE_WAIT valem 0: só a recusa de quem vem pela rede
    const PIPE_REJECT_REMOTE_CLIENTS: u32 = 0x8;
    const ERROR_PIPE_CONNECTED: i32 = 535;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const OPEN_EXISTING: u32 = 3;
    fn invalido(h: *mut c_void) -> bool {
        h.is_null() || h as isize == -1
    }
    struct Cano(*mut c_void);
    // o handle só é usado pela linha que o recebe
    unsafe impl Send for Cano {}

    type Partes = std::sync::Arc<std::sync::Mutex<Vec<(usize, Vec<u8>)>>>;

    /// Recebe o que o cmd elevado escreve: n instâncias do mesmo cano, uma por passo; cada uma vira uma parte, na ordem
    /// em que o passo se conectou. Criado por nós, sem administrador; só aceita quem está neste computador.
    pub struct Coletor {
        nome: String,
        n: usize,
        partes: Partes,
        vivas: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    }
    impl Coletor {
        pub fn novo(n: usize) -> Result<Coletor, u32> {
            use std::sync::atomic::{AtomicUsize, Ordering};
            let unico = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
            let nome = format!(r"\\.\pipe\ergon-ativar-wsl-{}-{unico}", std::process::id());
            let largo = larga(nome.as_ref());
            let partes: Partes = Default::default();
            let ordem = std::sync::Arc::new(AtomicUsize::new(0));
            let vivas = std::sync::Arc::new(AtomicUsize::new(0));
            let mut sd: *mut c_void = std::ptr::null_mut();
            let sddl = larga(QUEM_PODE.as_ref());
            if unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.as_ptr(), 1, &mut sd, std::ptr::null_mut()) } == 0 {
                return Err(std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32);
            }
            let mut atributos = AtributosSeguranca { tamanho: std::mem::size_of::<AtributosSeguranca>() as u32, descritor: sd, herdar: 0 };
            for i in 0..n {
                let abertura = PIPE_ACCESS_INBOUND | if i == 0 { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 };
                let h = unsafe { CreateNamedPipeW(largo.as_ptr(), abertura, PIPE_REJECT_REMOTE_CLIENTS, n as u32, 0, 64 * 1024, 0, &mut atributos as *mut AtributosSeguranca as *mut c_void) };
                if invalido(h) {
                    let e = std::io::Error::last_os_error().raw_os_error().unwrap_or(0) as u32;
                    if i == 0 {
                        unsafe { LocalFree(sd) };
                        return Err(e);
                    }
                    break;
                }
                let (cano, partes, ordem, vivas) = (Cano(h), partes.clone(), ordem.clone(), vivas.clone());
                vivas.fetch_add(1, Ordering::SeqCst);
                std::thread::spawn(move || {
                    let cano = cano;
                    let ligado = unsafe { ConnectNamedPipe(cano.0, std::ptr::null_mut()) } != 0
                        || std::io::Error::last_os_error().raw_os_error() == Some(ERROR_PIPE_CONNECTED);
                    if ligado {
                        let idx = ordem.fetch_add(1, Ordering::SeqCst);
                        if let Ok(mut p) = partes.lock() {
                            p.push((idx, Vec::new()));
                        }
                        let mut buf = vec![0u8; 4096];
                        loop {
                            let mut lidos = 0u32;
                            let ok = unsafe { ReadFile(cano.0, buf.as_mut_ptr(), buf.len() as u32, &mut lidos, std::ptr::null_mut()) } != 0;
                            if !ok || lidos == 0 {
                                break;
                            }
                            if let Ok(mut p) = partes.lock() {
                                if let Some(x) = p.iter_mut().find(|x| x.0 == idx) {
                                    x.1.extend_from_slice(&buf[..lidos as usize]);
                                }
                            }
                        }
                    }
                    unsafe { CloseHandle(cano.0) };
                    vivas.fetch_sub(1, Ordering::SeqCst);
                });
            }
            unsafe { LocalFree(sd) };
            Ok(Coletor { nome, n, partes, vivas })
        }
        pub fn nome(&self) -> &str {
            &self.nome
        }
        /// O que cada passo escreveu até agora, na ordem dos passos. Depois do fim, as partes vazias (as instâncias
        /// soltas por nós) ficam de fora.
        pub fn partes(&self, terminou: bool) -> Vec<Vec<u8>> {
            let mut p = self.partes.lock().map(|p| p.clone()).unwrap_or_default();
            p.sort_by_key(|x| x.0);
            p.into_iter().map(|x| x.1).filter(|b| !terminou || !b.is_empty()).collect()
        }
        /// Depois que o cmd terminou: solta as instâncias que ninguém usou (elas esperariam uma conexão para sempre) e
        /// espera um pouco as linhas de leitura acabarem de ler o resto.
        pub fn soltar(&self) {
            use std::sync::atomic::Ordering;
            let largo = larga(self.nome.as_ref());
            for _ in 0..self.n {
                let h = unsafe { CreateFileW(largo.as_ptr(), GENERIC_WRITE, 0, std::ptr::null_mut(), OPEN_EXISTING, 0, std::ptr::null_mut()) };
                if !invalido(h) {
                    unsafe { CloseHandle(h) };
                }
            }
            let ate = std::time::Instant::now() + Duration::from_secs(2);
            while self.vivas.load(Ordering::SeqCst) > 0 && std::time::Instant::now() < ate {
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}
#[cfg(not(windows))]
mod elevado {
    use std::path::Path;
    use std::time::Duration;
    pub struct Processo;
    impl Processo {
        pub fn esperar(&self, _: Duration) -> Option<u32> {
            Some(u32::MAX)
        }
    }
    pub fn abrir_como_administrador(_: &Path, _: &str) -> Result<Processo, u32> {
        Err(0)
    }
    pub struct Coletor;
    impl Coletor {
        pub fn novo(_: usize) -> Result<Coletor, u32> {
            Err(0)
        }
        pub fn nome(&self) -> &str {
            ""
        }
        pub fn partes(&self, _: bool) -> Vec<Vec<u8>> {
            Vec::new()
        }
        pub fn soltar(&self) {}
    }
}

/// Depois do reinício, o Windows abre o aplicativo uma vez para continuar (HKCU\...\RunOnce: sem administrador).
fn agendar_continuacao() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut c = comando(reg_exe());
    c.args(["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce", "/v", "ErgonInstalacao", "/t", "REG_SZ", "/f", "/d"]).arg(format!("\"{}\"", exe.display()));
    let o = rodar(c, Duration::from_secs(30)).map_err(|e| e.to_string())?;
    if o.status.success() { Ok(()) } else { Err("Não deu para agendar a continuação depois do reinício.".into()) }
}
fn desagendar_continuacao() {
    let mut c = comando(reg_exe());
    c.args(["delete", r"HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce", "/v", "ErgonInstalacao", "/f"]);
    let _ = rodar(c, Duration::from_secs(30));
}
/// Na primeira vez que o WSL é usado, o Windows abre a janela "Boas-vindas ao WSL" (outro programa, no meio da nossa
/// instalação). Marca como já vista (HKCU\...\Lxss\OOBEComplete, sem administrador), só se ainda não houver o valor.
pub(crate) fn sem_boas_vindas_do_wsl() {
    let chave = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss";
    let mut c = comando(reg_exe());
    c.args(["query", chave, "/v", "OOBEComplete"]);
    if rodar(c, Duration::from_secs(30)).map(|o| o.status.success()).unwrap_or(true) {
        return;
    }
    let mut c = comando(reg_exe());
    c.args(["add", chave, "/v", "OOBEComplete", "/t", "REG_DWORD", "/d", "1", "/f"]);
    let _ = rodar(c, Duration::from_secs(30));
}
pub(crate) fn reg_exe() -> PathBuf {
    std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join(r"System32\reg.exe")
}

#[cfg(windows)]
fn espaco_livre(p: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    extern "system" {
        fn GetDiskFreeSpaceExW(dir: *const u16, livre: *mut u64, total: *mut u64, total_livre: *mut u64) -> i32;
    }
    let mut alvo = p.to_path_buf();
    while !alvo.exists() {
        alvo = alvo.parent()?.to_path_buf();
    }
    let w: Vec<u16> = alvo.as_os_str().encode_wide().chain(Some(0)).collect();
    let (mut l, mut t, mut tl) = (0u64, 0u64, 0u64);
    (unsafe { GetDiskFreeSpaceExW(w.as_ptr(), &mut l, &mut t, &mut tl) } != 0).then_some(l)
}
#[cfg(not(windows))]
fn espaco_livre(_: &Path) -> Option<u64> {
    None
}

#[cfg(test)]
mod testes {
    use super::*;

    #[test]
    fn imagens_presas_aos_digests_no_texto() {
        let d = format!("sha256:{}", "a".repeat(64));
        let m = serde_json::json!({ "versao": "1.2.3", "componentes": {
            "core": { "imagem": "ghcr.io/x/ergon", "versao": "1.2.3", "digest": d },
            "motor": { "imagem": "ghcr.io/x/ergon-hermes", "versao": "1.2.3", "digest": d } } });
        let texto = "services:\n  ergon:\n    image: ghcr.io/x/ergon:1.2.3\n  hermes:\n    image: ghcr.io/x/ergon-hermes:1.2.3\n  motores:\n    image: ghcr.io/x/ergon:1.2.3\n    environment:\n      ERGON_MOTOR_IMAGE: ghcr.io/x/ergon-hermes:1.2.3\n";
        let t = fixar_no_texto(texto, &m, "1.2.3").unwrap();
        assert!(!t.contains(":1.2.3"), "nenhuma referência por versão sobra: {t}");
        assert_eq!(t.matches(&format!("@{d}")).count(), 4);
        // pacote de outra versão: recusado
        assert!(fixar_no_texto(&texto.replace("1.2.3", "9.9.9"), &m, "1.2.3").is_err());
    }

    #[test]
    fn saida_do_wsl_em_utf16_ou_utf8() {
        let u16le: Vec<u8> = "Ubuntu\r\nErgon\r\n".encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
        assert_eq!(texto_wsl(&u16le).lines().map(str::trim).collect::<Vec<_>>(), vec!["Ubuntu", "Ergon"]);
        assert_eq!(texto_wsl("Ergon\n".as_bytes()), "Ergon\n");
    }

    #[test]
    fn ativacao_do_wsl_sem_loja_e_com_registro() {
        let w = Path::new(r"C:\Windows\System32\wsl.exe");
        let l = linha_de_ativacao(w, Some(r"\\.\pipe\ergon-ativar-wsl-1-2"));
        assert_eq!(l, r#"/d /s /c "set WSL_UTF8=1&& "C:\Windows\System32\wsl.exe" --install --no-distribution --web-download > "\\.\pipe\ergon-ativar-wsl-1-2" 2>&1 || ("C:\Windows\System32\wsl.exe" --update --web-download > "\\.\pipe\ergon-ativar-wsl-1-2" 2>&1& "C:\Windows\System32\wsl.exe" --install --no-distribution --web-download > "\\.\pipe\ergon-ativar-wsl-1-2" 2>&1)""#);
        // sem o cano, a ativação acontece do mesmo jeito (só a saída se perde)
        assert_eq!(linha_de_ativacao(w, None), r#"/d /s /c "set WSL_UTF8=1&& "C:\Windows\System32\wsl.exe" --install --no-distribution --web-download || ("C:\Windows\System32\wsl.exe" --update --web-download& "C:\Windows\System32\wsl.exe" --install --no-distribution --web-download)""#);
        // cada passo na sua codificação: o WSL antigo em UTF-16, o novo em UTF-8
        let antigo: Vec<u8> = "--install: unrecognized option: no-distribution\r\n".encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
        let t = texto_das_partes(&[antigo, "Instalando: Subsistema do Windows para Linux\r\n".as_bytes().to_vec()]);
        assert_eq!(linhas_do_registro(&t, true), vec!["--install: unrecognized option: no-distribution", "Instalando: Subsistema do Windows para Linux"]);
    }

    /// O caminho de verdade: o cmd aberto com o pedido de administrador escreve no cano criado sem administrador. Só
    /// com ERGON_TESTE_ELEVADO (na esteira, onde a máquina é administradora e o Windows não pergunta); numa máquina de
    /// desenvolvimento ele abriria o pedido do Windows.
    #[cfg(windows)]
    #[test]
    fn cmd_elevado_escreve_no_cano_criado_sem_administrador() {
        if std::env::var_os("ERGON_TESTE_ELEVADO").is_none() {
            return;
        }
        let c = elevado::Coletor::novo(3).expect("cano com nome");
        let n = c.nome().to_string();
        let p = elevado::abrir_como_administrador(&cmd_exe(), &format!("/d /s /c \"(echo elevado) > \"{n}\" 2>&1 || exit /b 7\"")).expect("cmd elevado");
        let codigo = p.esperar(Duration::from_secs(60)).expect("o cmd elevado terminou");
        assert_eq!(codigo, 0, "o cmd elevado abriu o cano");
        c.soltar();
        let partes: Vec<String> = c.partes(true).iter().map(|b| texto_wsl(b).trim().to_string()).collect();
        assert_eq!(partes, vec!["elevado"]);
    }

    #[cfg(windows)]
    #[test]
    fn coletor_recebe_cada_passo_pelo_cano_e_solta_o_que_sobra() {
        use std::os::windows::process::CommandExt;
        let c = elevado::Coletor::novo(3).expect("cano com nome");
        let n = c.nome().to_string();
        assert!(n.starts_with(r"\\.\pipe\ergon-ativar-wsl-"));
        let st = std::process::Command::new(cmd_exe())
            // um segundo entre os passos, como entre os passos do wsl: a ordem das partes é a ordem de conexão
            .raw_arg(format!("/d /s /c \"(echo um) > \"{n}\" 2>&1 & ping -n 2 127.0.0.1 > nul & (echo dois) > \"{n}\" 2>&1\""))
            .status()
            .expect("cmd");
        assert!(st.success());
        // a terceira instância ninguém usou: soltar não pode travar
        let t0 = Instant::now();
        c.soltar();
        assert!(t0.elapsed() < Duration::from_secs(5));
        let p: Vec<String> = c.partes(true).iter().map(|b| texto_wsl(b).trim().to_string()).collect();
        assert_eq!(p, vec!["um", "dois"]);
        // o nome é único: outro coletor no mesmo processo não colide
        let d = elevado::Coletor::novo(1).expect("outro cano");
        assert_ne!(d.nome(), n);
        d.soltar();
    }

    #[test]
    fn registro_da_ativacao_com_barra_de_progresso() {
        let t = "Baixando: Subsistema do Windows para Linux 2.6.1\r\n[====      12.0%      ]\r[========  40.0%    ]\r[===";
        // rodando: a última parte pode estar pela metade e fica de fora
        assert_eq!(linhas_do_registro(t, false), vec!["Baixando: Subsistema do Windows para Linux 2.6.1", "[====      12.0%      ]", "[========  40.0%    ]"]);
        assert_eq!(linhas_do_registro(t, true).len(), 4);
        assert!(eh_progresso("[========  40.0%    ]") && !eh_progresso("Instalando: 100% concluído? não"));
        let fim = "Baixando: WSL\r\n[==== 50.0% ]\r\nInstalando: Plataforma de Máquina Virtual\r\nA operação solicitada foi bem-sucedida. As alterações não entrarão em vigor até que o sistema seja reinicializado.\r\n";
        assert!(pede_reinicio(0, fim));
        assert!(pede_reinicio(0, "The requested operation is successful. Changes will not be effective until the system is rebooted."));
        assert!(pede_reinicio(3010, ""));
        assert!(!pede_reinicio(0, "A operação foi concluída com êxito."));
        let r = resumo_do_registro(fim);
        assert!(r.starts_with("Última mensagem do Windows: Baixando: WSL / Instalando") && !r.contains("50.0%"), "{r}");
        assert_eq!(resumo_do_registro(""), "");
    }

    #[test]
    fn erros_conhecidos_do_wsl() {
        assert!(explicar_erro_wsl("Error code: Wsl/Service/CreateInstance/0x80370102").contains("virtualização"));
        assert!(explicar_erro_wsl("algo").starts_with("O WSL respondeu"));
    }

    #[test]
    fn nome_do_ambiente_so_aceita_nome_simples() {
        std::env::set_var("ERGON_AMBIENTE_NOME", "Ergon; rm -rf");
        assert_eq!(nome(), "Ergon");
        std::env::remove_var("ERGON_AMBIENTE_NOME");
    }
}
