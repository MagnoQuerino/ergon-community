//! Ambiente do Ergon no Windows: uma distribuição WSL2 própria ("Ergon", em %LOCALAPPDATA%\ErgonAmbiente\wsl) com o Docker
//! Engine dentro — sem Docker Desktop. A instalação é uma sequência de etapas com ponto de retomada gravado em disco:
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

pub const ETAPAS: [(&str, &str); 7] = [
    ("diagnostico", "Conferindo este computador"),
    ("wsl", "Preparando o Windows (WSL)"),
    ("baixar", "Baixando os componentes"),
    ("importar", "Criando o ambiente do Ergon"),
    ("configurar", "Configurando"),
    ("ligar", "Ligando os serviços"),
    ("conferir", "Conferindo a instalação"),
];

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
    std::env::var("ERGON_AMBIENTE_NOME").ok().filter(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')).unwrap_or_else(|| "Ergon".into())
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
#[cfg_attr(not(test), allow(dead_code))]
fn passou(p: &Progresso, etapa: &str) -> bool {
    let i = |e: &str| ETAPAS.iter().position(|(n, _)| *n == e);
    matches!((i(&p.concluida), i(etapa)), (Some(a), Some(b)) if a >= b) || p.concluida == "pronto"
}

/// A instalação pelo ambiente próprio terminou neste computador (o aplicativo usa o Docker de dentro dele).
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
        return Err("O ambiente próprio do Ergon é para Windows; no Linux, o Ergon usa o Docker Engine do sistema.".into());
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
            return Err("O WSL ainda não responde depois do reinício. Reinicie o Windows mais uma vez; se continuar, rode a instalação de novo.".into());
        }
        ev(Evento::Linha("Ativando o WSL do Windows (o Windows pede permissão de administrador)…".into()));
        ativar_wsl()?;
        if !wsl_pronto() {
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

/// Prende as imagens do pacote entregue aos digests do manifesto: o Docker confere o conteúdo baixado contra eles (também a
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

/// Liga o Docker Engine dentro do ambiente e mantém o processo vivo em segundo plano (fechar a janela não para os
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
/// `wsl --install --no-distribution`, com o pedido de administrador do Windows (UAC). Só ativa o WSL: nenhuma
/// distribuição é instalada além da nossa.
fn ativar_wsl() -> Result<(), String> {
    // nos testes, ativar o WSL reiniciaria a máquina de teste: proibido
    if cfg!(feature = "origens-de-teste") && std::env::var_os("ERGON_PROIBIR_ATIVAR_WSL").is_some() {
        return Err("TESTE: o WSL não foi encontrado e ativá-lo está proibido neste teste".into());
    }
    let ps = std::env::var_os("SystemRoot").map(PathBuf::from).unwrap_or_else(|| PathBuf::from(r"C:\Windows")).join(r"System32\WindowsPowerShell\v1.0\powershell.exe");
    let mut c = comando(ps);
    c.args(["-NoProfile", "-NonInteractive", "-Command", "try { $p = Start-Process -FilePath \"$env:SystemRoot\\System32\\wsl.exe\" -ArgumentList '--install','--no-distribution' -Verb RunAs -Wait -PassThru -WindowStyle Hidden; exit $p.ExitCode } catch { exit 1223 }"]);
    let o = rodar(c, Duration::from_secs(30 * 60)).map_err(|e| e.to_string())?;
    match o.status.code() {
        Some(1223) => Err("A permissão de administrador foi negada. O WSL é necessário para o Ergon; tente de novo e aceite o pedido do Windows.".into()),
        _ => Ok(()),
    }
}

/// Depois do reinício, o Windows abre o aplicativo uma vez para continuar (HKCU\...\RunOnce: sem administrador).
fn agendar_continuacao() -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut c = comando(reg_exe());
    c.args(["add", r"HKCU\Software\Microsoft\Windows\CurrentVersion\RunOnce", "/v", "ErgonInstalacao", "/t", "REG_SZ", "/f", "/d"]).arg(format!("\"{}\" --continuar-instalacao", exe.display()));
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
fn sem_boas_vindas_do_wsl() {
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
fn reg_exe() -> PathBuf {
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
    fn saida_do_wsl_em_utf16_ou_utf8() {
        let u16le: Vec<u8> = "Ubuntu\r\nErgon\r\n".encode_utf16().flat_map(|c| c.to_le_bytes()).collect();
        assert_eq!(texto_wsl(&u16le).lines().map(str::trim).collect::<Vec<_>>(), vec!["Ubuntu", "Ergon"]);
        assert_eq!(texto_wsl("Ergon\n".as_bytes()), "Ergon\n");
    }

    #[test]
    fn retomada_por_etapa() {
        let p = Progresso { concluida: "baixar".into(), ..Default::default() };
        assert!(passou(&p, "wsl") && passou(&p, "baixar") && !passou(&p, "importar"));
        assert!(passou(&Progresso { concluida: "pronto".into(), ..Default::default() }, "conferir"));
        assert!(!passou(&Progresso::default(), "diagnostico"));
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
