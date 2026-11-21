"""Navegador ao vivo com "Assumir o controle" (rc.41).

Enquanto um agente usa o navegador (ferramentas browser_* do Hermes, sobre o agent-browser), a pessoa vê a tela dele no
Ergon e pode assumir o mouse e o teclado naquela MESMA sessão (login, captcha, segundo fator), e depois devolver.

O mecanismo é o do próprio agent-browser (0.26): cada sessão abre sozinha um servidor de transmissão em 127.0.0.1, numa
porta escolhida pelo sistema (gravada em <pasta da sessão>/<nome>.stream). Por um WebSocket ele manda os quadros do
viewport (JPEG, Page.startScreencast, só enquanto há alguém ligado) e aceita mouse, teclado e toque
(Input.dispatch*Event). Esse servidor não tem senha: só escuta em 127.0.0.1 e recusa origens que não sejam locais. Por
isso NADA dele sai do contêiner direto: a ponte de controle (porta interna, com o token que o Ergon e o motor já
dividem) abre um túnel para ele depois de conferir o token, e só o servidor do Ergon fala com a ponte.

Três peças, que podem estar em processos diferentes do Hermes (a ponte de controle sobe no primeiro processo que
carrega o plugin; as ferramentas rodam no processo do gateway), e por isso conversam por arquivos pequenos numa pasta
temporária só do usuário do motor:

- registro (s-*.json): o processo das ferramentas grava qual sessão do agent-browser serve cada trabalho do Ergon, e um
  vigia (uma linha de execução) mantém o navegador vivo enquanto alguém assiste ou controla: o Hermes fecha o navegador
  parado (browser.inactivity_timeout) e o agent-browser se encerra sozinho sem comandos (AGENT_BROWSER_IDLE_TIMEOUT_MS;
  os eventos de entrada da transmissão NÃO contam como comando, medido), e a pessoa digitando a senha não é "parado";
- controle (c-*.json): quem está com o navegador (o agente, por padrão, ou a pessoa), até quando, e a "época", que sobe
  a cada devolução. Com a pessoa no controle, toda ferramenta browser_* espera (antes()): não age e não lê a página;
- presença (v-*): a ponte toca enquanto há um túnel aberto (alguém assistindo).

Limite conhecido (o mesmo do Hermes na tela do bot): a trava vale para as ferramentas do navegador. Um agente com
Terminal (ferramenta guardada, liberada só com a senha de quem administra) roda programas com o mesmo usuário do motor.

Só a biblioteca padrão; os módulos do Hermes entram por importação tardia (os testes de unidade rodam sem o motor).
"""
from __future__ import annotations

import hashlib
import json
import os
import select
import shutil
import socket
import subprocess
import tempfile
import threading
import time
from typing import Any, Callable

# quanto uma ferramenta browser_* segura o turno esperando a pessoa devolver, por chamada (como os cartões: 240 s); o
# agente é orientado a chamar de novo para continuar esperando
ESPERA_S = float(os.environ.get("ERGON_NAVEGADOR_ESPERA_S", "240"))
PASSO_S = float(os.environ.get("ERGON_NAVEGADOR_PASSO_S", "0.5"))
# o prazo que o Ergon pede a cada renovação (ele renova enquanto a pessoa mexe); sem renovação, o motor devolve sozinho
PRAZO_PADRAO_S = 600.0
PRAZO_MIN_S, PRAZO_MAX_S = 5.0, 900.0
# teto de uma tomada de controle, por mais que o Ergon renove: uma sessão esquecida não segura o agente para sempre
TETO_S = float(os.environ.get("ERGON_NAVEGADOR_TETO_S", "1800"))
PRESENCA_S = 20.0          # túnel aberto há menos que isto = alguém assistindo
VIGIA_PASSO_S = float(os.environ.get("ERGON_NAVEGADOR_VIGIA_S", "3"))
TUNEIS_MAX = 6             # túneis abertos ao mesmo tempo neste motor (o Ergon abre um por execução assistida)

# depois que a pessoa devolve, só estas seguem direto (elas releem a página); a primeira das outras é recusada uma vez,
# com o pedido de olhar a página de novo: as referências (@e12) e o que o agente sabia são da página de antes
_RELEEM = frozenset({"browser_snapshot", "browser_navigate", "browser_vision"})
# o navegador do motor tem duas formas, conforme a configuração (browser.backend): as ferramentas browser_* de sempre ou,
# por padrão no Hermes 0.22, uma só (browser_exec, que roda um trecho de código no mesmo Chromium do agent-browser)
_COMO_RELER = "chame browser_snapshot"
_COMO_RELER_EXEC = "rode um browser_exec que só leia a página (print(page_info()) e o texto dela)"

_MSG_ESPERANDO = ("A pessoa assumiu o controle do navegador (por exemplo, para fazer o login ou resolver uma verificação) e ainda está "
                  "usando. Enquanto isso você não age nem lê a página. Não tente contornar por outro caminho (terminal, outra "
                  "ferramenta, outro navegador). Para continuar esperando, {reler}; ela devolve o controle quando terminar.")
_MSG_DEVOLVEU = ("A pessoa tinha assumido o controle do navegador e já devolveu. A página pode ter mudado (por exemplo, ela fez o "
                 "login): {reler} para ver como está agora antes de continuar. O que ela digitou não chega a você (o que ficou sem "
                 "enviar foi apagado): não peça a ela o que digitou.")
_MSG_PRAZO = ("A pessoa tinha assumido o controle do navegador e o prazo dela acabou: o controle voltou para você. Para ver como a "
              "página está agora, {reler}; se ainda faltar a parte dela, diga em uma frase o que falta.")


def _msg(modelo: str, tool_name: str) -> str:
    return modelo.format(reler=_COMO_RELER_EXEC if tool_name == "browser_exec" else _COMO_RELER)

_lock = threading.Lock()
_vistas: dict[str, int] = {}          # sessão → última época que o agente já viu (processo das ferramentas)
_avisadas: set[str] = set()           # sessões cujo "ativo" já foi ao Ergon (processo das ferramentas)
_abas: dict[str, str] = {}            # sessão → a aba em que a transmissão foi posta por último (por processo)
_vigia: threading.Thread | None = None
_tuneis = 0
_avisar: Callable[[dict[str, Any]], None] | None = None


def configurar(avisar: Callable[[dict[str, Any]], None] | None) -> None:
    """Quem conta ao Ergon o que mudou (ativo, fim, devolvido): o plugin passa a função que posta na ponte."""
    global _avisar
    _avisar = avisar


def _contar(evento: str, reg: dict[str, Any], **extra: Any) -> None:
    fn = _avisar
    if fn is None:
        return
    ev = {"evento": evento, "session_id": str(reg.get("sessao") or "")[:200], "task_id": str(reg.get("tarefa") or "")[:200], **extra}

    def enviar() -> None:
        try:
            fn(ev)
        except Exception:  # noqa: BLE001 - o Ergon fora não atrapalha o navegador
            pass

    threading.Thread(target=enviar, name="ergon-navegador-aviso", daemon=True).start()


# ------------------------------------------------------------------ arquivos de estado
def pasta() -> str:
    """Pasta do estado: temporária (some com o contêiner), só do usuário do motor (0700)."""
    d = os.environ.get("ERGON_NAVEGADOR_DIR") or os.path.join(tempfile.gettempdir(), f"ergon-navegador-{os.getuid()}")
    os.makedirs(d, mode=0o700, exist_ok=True)
    try:
        if os.stat(d).st_mode & 0o077:
            os.chmod(d, 0o700)
    except OSError:
        pass
    return d


def _h(sessao: str) -> str:
    return hashlib.sha256(sessao.encode("utf-8")).hexdigest()[:24]


def _ler(path: str) -> dict[str, Any] | None:
    try:
        with open(path, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else None
    except (OSError, ValueError):
        return None


def _gravar(path: str, obj: dict[str, Any]) -> None:
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(obj, f)
    os.replace(tmp, path)


def _apagar(path: str) -> None:
    try:
        os.unlink(path)
    except OSError:
        pass


def _reg_path(sessao: str) -> str:
    return os.path.join(pasta(), f"s-{_h(sessao)}.json")


def _ctl_path(sessao: str) -> str:
    return os.path.join(pasta(), f"c-{_h(sessao)}.json")


def _vis_path(sessao: str) -> str:
    return os.path.join(pasta(), f"v-{_h(sessao)}")


def registro(ident: str) -> dict[str, Any] | None:
    """O registro do navegador de um trabalho do Ergon: `ident` é a sessão ou a tarefa que o Ergon conhece."""
    ident = str(ident or "")
    if not ident:
        return None
    direto = _ler(_reg_path(ident))
    if direto and direto.get("sessao") == ident:
        return direto
    try:
        nomes = [n for n in os.listdir(pasta()) if n.startswith("s-") and n.endswith(".json")]
    except OSError:
        return None
    for n in nomes:
        r = _ler(os.path.join(pasta(), n))
        if r and ident in (r.get("sessao"), r.get("tarefa")):
            return r
    return None


def _pid_vivo(pid: Any) -> bool:
    try:
        os.kill(int(pid), 0)
        return True
    except (OSError, ValueError, TypeError):
        return False


def porta(reg: dict[str, Any]) -> int | None:
    """A porta da transmissão desta sessão do agent-browser, se o programa dela ainda está de pé."""
    d, nome = str(reg.get("dir") or ""), str(reg.get("nome") or "")
    if not d or not nome:
        return None
    try:
        with open(os.path.join(d, f"{nome}.stream"), encoding="utf-8") as f:
            p = int(f.read().strip())
        with open(os.path.join(d, f"{nome}.pid"), encoding="utf-8") as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        return None
    return p if 0 < p < 65536 and _pid_vivo(pid) else None


def _assistindo(sessao: str) -> bool:
    try:
        return time.time() - os.stat(_vis_path(sessao)).st_mtime < PRESENCA_S
    except OSError:
        return False


def _tocar_presenca(sessao: str) -> None:
    p = _vis_path(sessao)
    try:
        os.utime(p, None)
    except OSError:
        try:
            os.close(os.open(p, os.O_WRONLY | os.O_CREAT, 0o600))
        except OSError:
            pass


# ------------------------------------------------------------------ quem está no controle
def controle(sessao: str) -> dict[str, Any]:
    """O estado do controle, já com o prazo conferido: {"pessoa", "epoca", "desde", "ate", "motivo"}."""
    c = _ler(_ctl_path(sessao)) or {}
    out = {"pessoa": c.get("pessoa") is True, "epoca": int(c.get("epoca") or 0), "desde": float(c.get("desde") or 0),
           "ate": float(c.get("ate") or 0), "motivo": str(c.get("motivo") or "")}
    if out["pessoa"] and out["ate"] <= time.time():
        return devolver(sessao, "prazo")
    return out


def assumir(sessao: str, prazo_s: float = PRAZO_PADRAO_S) -> dict[str, Any]:
    """A pessoa assume (ou renova o prazo, se já estava com ela). O prazo nunca passa do teto contado da tomada."""
    agora = time.time()
    prazo_s = min(max(float(prazo_s or PRAZO_PADRAO_S), PRAZO_MIN_S), PRAZO_MAX_S)
    with _lock:
        c = controle(sessao)
        desde = c["desde"] if c["pessoa"] else agora
        novo = {"pessoa": True, "epoca": c["epoca"], "desde": desde, "ate": min(agora + prazo_s, desde + TETO_S), "motivo": ""}
        _gravar(_ctl_path(sessao), novo)
    return novo


def devolver(sessao: str, motivo: str = "pessoa") -> dict[str, Any]:
    """O controle volta ao agente. Antes, apaga o que a pessoa deixou digitado e não enviou (senha, código de verificação,
    qualquer texto): depois da devolução o agente volta a ler a página. Sem estar com a pessoa: não muda."""
    c = _ler(_ctl_path(sessao)) or {}
    if c.get("pessoa") is not True:
        return {"pessoa": False, "epoca": int(c.get("epoca") or 0), "desde": 0.0, "ate": 0.0, "motivo": str(c.get("motivo") or ""), "senhas": 0}
    reg = registro(sessao)
    senhas = apagar_digitado(reg) if reg else 0
    novo = {"pessoa": False, "epoca": int(c.get("epoca") or 0) + 1, "desde": 0.0, "ate": 0.0, "motivo": str(motivo)[:20], "devolvido": time.time()}
    _gravar(_ctl_path(sessao), novo)
    if motivo != "pessoa" and reg:
        _contar("devolvido", reg, motivo=str(motivo)[:20])
    return {**novo, "senhas": senhas}


# O que a pessoa digita enquanto está no controle não pode chegar ao agente: depois da devolução ele volta a ler a página.
# O que foi ENVIADO já saiu dos campos (o formulário seguiu); o que ficou digitado e não enviado é apagado na devolução:
# senha, código de verificação num campo de texto comum, qualquer texto. Para saber o que a pessoa digitou (e não apagar
# o que a página já trazia), um ouvinte é posto em cada documento quando ela assume: guarda o valor que cada campo tinha
# e marca os campos em que chegou tecla de verdade. Documento aberto DURANTE o controle (ela entrou e a página seguinte
# pede o código) recebe o ouvinte na volta seguinte do vigia; nele, o valor de partida de todo campo é "vazio". Documento
# que nem chegou a receber o ouvinte: todo campo de texto preenchido é apagado. Campos de senha: sempre.
# Alcança o documento, os quadros da mesma origem e o shadow DOM aberto; quadro de outra origem, não (limite conhecido).
_JS_COMUM = (
    "const tipos=['text','search','tel','url','email','number','password'];"
    "const campo=(el)=>(el instanceof el.ownerDocument.defaultView.HTMLInputElement&&tipos.includes(el.type))"
    "||el instanceof el.ownerDocument.defaultView.HTMLTextAreaElement;"
    "const andar=(r,f)=>{let els=[];try{els=r.querySelectorAll('*')}catch(e){return}"
    "for(const el of els){try{f(el);if(el.shadowRoot)andar(el.shadowRoot,f);"
    "if(el.tagName==='IFRAME'||el.tagName==='FRAME'){const d=el.contentDocument;if(d)doc(d)}}catch(e){}}};"
)
# %s: true na hora em que a pessoa assume (os valores de agora são os da página); false nas voltas seguintes
_JS_OUVIR = (
    "(()=>{const primeira=%s;let n=0;" + _JS_COMUM +
    "const doc=(d)=>{const w=d.defaultView;if(!w||w.__ergonNav)return;const base=new WeakMap(),dig=new WeakSet();"
    "w.__ergonNav={base,dig};n++;"
    "const marca=(e)=>{if(!e.isTrusted)return;const t=(e.composedPath&&e.composedPath()[0])||e.target;if(t&&t.nodeType===1)dig.add(t)};"
    "d.addEventListener('input',marca,true);d.addEventListener('keydown',marca,true);"
    "andar(d,(el)=>{if(campo(el))base.set(el,primeira?el.value:'')})};"
    "doc(document);return n})()"
)
_JS_APAGAR = (
    "(()=>{let n=0;" + _JS_COMUM +
    "const doc=(d)=>{const w=d.defaultView;if(!w)return;const nav=w.__ergonNav;"
    "const si=Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype,'value').set,"
    "st=Object.getOwnPropertyDescriptor(w.HTMLTextAreaElement.prototype,'value').set;"
    "const avisar=(el)=>{el.dispatchEvent(new w.Event('input',{bubbles:true}));el.dispatchEvent(new w.Event('change',{bubbles:true}))};"
    "andar(d,(el)=>{if(campo(el)){if(!el.value)return;"
    "const digitado=el.type==='password'||!nav||nav.dig.has(el)||(nav.base.has(el)&&nav.base.get(el)!==el.value);"
    "if(digitado){(el instanceof w.HTMLTextAreaElement?st:si).call(el,'');avisar(el);n++}}"
    "else if(nav&&nav.dig.has(el)&&el.isContentEditable&&el.textContent){el.textContent='';avisar(el);n++}});"
    "try{delete w.__ergonNav}catch(e){}};"
    "doc(document);return n})()"
)


def _cli(reg: dict[str, Any], args: list[str], timeout: float = 8.0) -> dict[str, Any] | None:
    """Um comando do agent-browser na sessão registrada (sem criar outra: só com o programa dela de pé)."""
    if porta(reg) is None:
        return None
    exe = shutil.which("agent-browser")
    if not exe:
        return None
    env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR", "LANG", "PLAYWRIGHT_BROWSERS_PATH")}
    env["AGENT_BROWSER_SOCKET_DIR"] = str(reg["dir"])
    # se a sessão sumir entre a conferência e o comando, o que nascer aqui não tem navegador e some em segundos
    env["AGENT_BROWSER_IDLE_TIMEOUT_MS"] = "5000"
    try:
        r = subprocess.run([exe, "--session", str(reg["nome"]), "--json", *args], env=env, stdin=subprocess.DEVNULL,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=timeout, check=False)
        v = json.loads(r.stdout.decode("utf-8", "replace").strip() or "{}")
        return v if isinstance(v, dict) else None
    except Exception:  # noqa: BLE001
        return None


def acompanhar_aba(reg: dict[str, Any]) -> None:
    """Põe a transmissão (os quadros e a entrada da pessoa) na aba que está em uso. Com as ferramentas browser_* o
    agent-browser faz isso sozinho; o browser_exec abre abas por fora dele (o browser-harness fala direto com o
    Chromium), e aí o agent-browser sabe qual é a aba da vez mas a transmissão fica na anterior, parada (medido). Pedir a
    aba ativa de novo ("tab <id>") religa. Também é um comando: zera o relógio de parado do agent-browser."""
    r = _cli(reg, ["tab", "list"], timeout=5)
    abas = ((r or {}).get("data") or {}).get("tabs")
    if not isinstance(abas, list):
        return
    ativa = next((str(a.get("tabId") or "") for a in abas if isinstance(a, dict) and a.get("active")), "")
    s = str(reg.get("sessao") or "")
    with _lock:
        antes_ = _abas.get(s)
        _abas[s] = ativa
    if ativa and ativa.isalnum() and ativa != antes_ and (antes_ is not None or len(abas) > 1):
        _cli(reg, ["tab", ativa], timeout=5)


def ouvir_digitacao(reg: dict[str, Any], primeira: bool) -> None:
    """Põe (uma vez por documento) o ouvinte que marca os campos em que a pessoa digita. Ver _JS_OUVIR."""
    _cli(reg, ["eval", _JS_OUVIR % ("true" if primeira else "false")], timeout=5)


def apagar_digitado(reg: dict[str, Any]) -> int:
    """Apaga o que a pessoa deixou digitado e não enviou. Devolve quantos campos esvaziou."""
    r = _cli(reg, ["eval", _JS_APAGAR])
    try:
        return int(((r or {}).get("data") or {}).get("result") or 0)
    except (TypeError, ValueError):
        return 0


def estado(ident: str) -> dict[str, Any]:
    """O que o Ergon mostra: há navegador neste trabalho, e com quem ele está."""
    reg = registro(ident)
    if not reg or porta(reg) is None:
        return {"ativo": False, "controle": "agente", "epoca": 0, "ate": None}
    c = controle(str(reg["sessao"]))
    return {"ativo": True, "controle": "pessoa" if c["pessoa"] else "agente", "epoca": c["epoca"], "ate": c["ate"] if c["pessoa"] else None,
            "motivo": c["motivo"]}


# ------------------------------------------------------------------ no processo das ferramentas
def _espera_do_hermes() -> tuple[Any, Callable[[], None]]:
    """A janela de "esperando uma pessoa" do Hermes (o prazo do lote de ferramentas não conta este tempo) e o sinal de
    atividade (o vigia do gateway não mata o turno). Fora do motor: nada."""
    import contextlib
    try:
        from tools.approval_human_wait import activity_heartbeat, human_wait_window  # módulos do Hermes
        return human_wait_window(), activity_heartbeat("a pessoa está com o navegador")
    except Exception:  # noqa: BLE001
        return contextlib.nullcontext(), (lambda: None)


def antes(tool_name: str, sessao: str, tarefa: str = "") -> dict[str, Any] | None:
    """pre_tool_call das ferramentas browser_*: com a pessoa no controle, espera; devolveu, pede para reler a página."""
    if not str(tool_name or "").startswith("browser"):
        return None
    reg = registro(sessao) or registro(tarefa)
    if not reg:
        return None
    s = str(reg["sessao"])
    c = controle(s)
    if c["pessoa"]:
        janela, sinal = _espera_do_hermes()
        fim = time.time() + ESPERA_S
        with janela:
            while c["pessoa"] and time.time() < fim:
                time.sleep(PASSO_S)
                sinal()
                c = controle(s)
        if c["pessoa"]:
            return {"action": "block", "message": _msg(_MSG_ESPERANDO, tool_name)}
    with _lock:
        vista = _vistas.get(s, 0)
        if c["epoca"] <= vista:
            return None
        # avisado uma vez: a chamada seguinte (a releitura que o aviso pede) já segue
        _vistas[s] = c["epoca"]
        if tool_name in _RELEEM:
            return None
    return {"action": "block", "message": _msg(_MSG_PRAZO if c["motivo"] == "prazo" else _MSG_DEVOLVEU, tool_name)}


def _base_da_chave(chave: str) -> str:
    """A chave de sessão do Hermes sem os sufixos dele: "::local" (rota local) e "@<perfil>" (motor com vários perfis)."""
    chave = chave[:-len("::local")] if chave.endswith("::local") else chave
    return chave.split("@", 1)[0]


def _sessao_do_hermes(tarefa: str, nomeada: str = "") -> tuple[str, dict[str, Any]] | None:
    """A sessão do agent-browser que o Hermes abriu para esta tarefa: (chave, {nome, dir}). As ferramentas browser_*
    guardam pela tarefa; o browser_exec, pela tarefa ou pelo nome de sessão que o agente deu ("bu-named-<nome>"). Com
    mais de uma, vale a que foi usada por último."""
    try:
        from tools import browser_tool as bt  # módulo do Hermes
    except Exception:  # noqa: BLE001
        return None
    bases = {tarefa, f"bu-named-{nomeada}"} if nomeada else {tarefa}
    with bt._cleanup_lock:
        cand = [(float(bt._session_last_activity.get(k, 0)), k, v) for k, v in bt._active_sessions.items()
                if isinstance(v, dict) and v.get("session_name") and _base_da_chave(str(k)) in bases]
    if not cand:
        return None
    _, chave, info = max(cand, key=lambda x: x[0])
    nome = str(info["session_name"])
    return str(chave), {"nome": nome, "dir": os.path.join(bt._socket_safe_tmpdir(), f"agent-browser-{nome}")}


def depois(tool_name: str, sessao: str, tarefa: str, tarefa_real: str = "", nomeada: str = "") -> None:
    """post_tool_call das ferramentas do navegador: registra a sessão do navegador deste trabalho e liga o vigia.
    `sessao`/`tarefa` são os que o Ergon conhece; `tarefa_real` é a do Hermes (a de um ajudante é outra); `nomeada`, o
    nome de sessão que o agente passou ao browser_exec."""
    if not str(tool_name or "").startswith("browser") or not sessao:
        return
    achada = _sessao_do_hermes(tarefa_real or tarefa, nomeada)
    if not achada:
        return
    chave, s = achada
    reg = {"sessao": sessao, "tarefa": tarefa, "chave": chave, "nome": s["nome"], "dir": s["dir"], "pid": os.getpid(), "visto": time.time()}
    if porta(reg) is None:
        return
    antigo = _ler(_reg_path(sessao))
    if not antigo or any(antigo.get(k) != reg[k] for k in ("nome", "dir", "pid", "chave")):
        _gravar(_reg_path(sessao), reg)
    with _lock:
        novo = sessao not in _avisadas
        _avisadas.add(sessao)
    if novo:
        _contar("ativo", reg)
    _ligar_vigia()


def _ligar_vigia() -> None:
    global _vigia
    with _lock:
        if _vigia is not None and _vigia.is_alive():
            return
        _vigia = threading.Thread(target=_vigiar, name="ergon-navegador", daemon=True)
        _vigia.start()


def _vigiar() -> None:
    while True:
        time.sleep(VIGIA_PASSO_S)
        try:
            _volta_do_vigia()
        except Exception:  # noqa: BLE001 - o vigia nunca cai
            pass


def _volta_do_vigia() -> None:
    try:
        from tools import browser_tool as bt, browser_tool_lifecycle as ciclo  # módulos do Hermes
    except Exception:  # noqa: BLE001
        return
    for n in [x for x in os.listdir(pasta()) if x.startswith("s-") and x.endswith(".json")]:
        reg = _ler(os.path.join(pasta(), n))
        if not reg or reg.get("pid") != os.getpid():
            if reg and not _pid_vivo(reg.get("pid")):   # sobra de um processo que morreu
                _encerrar(reg)
            continue
        s, chave = str(reg["sessao"]), str(reg["chave"])
        with bt._cleanup_lock:
            info = bt._active_sessions.get(chave)
        if not isinstance(info, dict) or info.get("session_name") != reg.get("nome") or porta(reg) is None:
            _encerrar(reg)   # o Hermes fechou o navegador (fim do turno, parado demais) ou trocou de sessão
            continue
        com_pessoa = controle(s)["pessoa"]
        if com_pessoa or _assistindo(s):
            ciclo._update_session_activity(chave)
            acompanhar_aba(reg)
        if com_pessoa:
            ouvir_digitacao(reg, False)   # a página mudou durante o controle: o documento novo também é ouvido


def _encerrar(reg: dict[str, Any]) -> None:
    s = str(reg.get("sessao") or "")
    _apagar(_reg_path(s))
    _apagar(_ctl_path(s))
    _apagar(_vis_path(s))
    with _lock:
        _avisadas.discard(s)
        _vistas.pop(s, None)
        _abas.pop(s, None)
    _contar("fim", reg)


# ------------------------------------------------------------------ na ponte de controle
def tunel(handler: Any, ident: str) -> None:
    """GET /ergon/v1/navegador/fluxo com Upgrade: websocket (o token já foi conferido). Liga o pedido à transmissão da
    sessão por um túnel de bytes: quem fala WebSocket são as pontas (o servidor do Ergon e o agent-browser). O aperto de
    mão é refeito daqui, sem Origin nem extensões, para o agent-browser ver um cliente local."""
    global _tuneis
    reg = registro(ident)
    p = porta(reg) if reg else None
    chave = str(handler.headers.get("Sec-WebSocket-Key") or "")
    if str(handler.headers.get("Upgrade") or "").lower() != "websocket" or not (16 <= len(chave) <= 64) or not chave.isascii() or any(c in chave for c in "\r\n "):
        return handler._json(400, {"error": "pedido de transmissão inválido"})
    if not reg or p is None:
        return handler._json(404, {"error": "não há navegador aberto neste trabalho agora"})
    with _lock:
        if _tuneis >= TUNEIS_MAX:
            return handler._json(429, {"error": "muitas transmissões abertas ao mesmo tempo"})
        _tuneis += 1
    sessao = str(reg["sessao"])
    cima: socket.socket | None = None
    try:
        handler.close_connection = True
        cima = socket.create_connection(("127.0.0.1", p), timeout=5)
        cima.sendall((f"GET / HTTP/1.1\r\nHost: 127.0.0.1:{p}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                      f"Sec-WebSocket-Key: {chave}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode("ascii"))
        baixo: socket.socket = handler.connection
        cima.settimeout(None)
        baixo.settimeout(None)
        _tocar_presenca(sessao)
        _ligar_vigia()
        acompanhar_aba(reg)
        toque = time.time()
        while True:
            prontos, _, _ = select.select([cima, baixo], [], [], 5.0)
            if time.time() - toque >= 5.0:
                toque = time.time()
                _tocar_presenca(sessao)
                if porta(reg) is None:
                    break
            for de in prontos:
                dados = de.recv(65536)
                if not dados:
                    return None
                (baixo if de is cima else cima).sendall(dados)
    except OSError:
        pass
    finally:
        with _lock:
            _tuneis -= 1
        _apagar(_vis_path(sessao))
        if cima is not None:
            try:
                cima.close()
            except OSError:
                pass
    return None


def rota(handler: Any, method: str, path: str, q: dict[str, str], body: dict[str, Any]) -> None:
    """As rotas da ponte de controle: estado, assumir/devolver e a transmissão."""
    ident = str(q.get("sessao") or body.get("sessao") or "")[:200]
    if not ident:
        return handler._json(400, {"error": "informe a sessão"})
    if path == "/ergon/v1/navegador" and method == "GET":
        return handler._json(200, estado(ident))
    if path == "/ergon/v1/navegador/fluxo" and method == "GET":
        return tunel(handler, ident)
    if path == "/ergon/v1/navegador/controle" and method == "PUT":
        v = body.get("pessoa")
        if not isinstance(v, bool):
            return handler._json(400, {"error": "envie pessoa: true ou false"})
        reg = registro(ident)
        if not reg or porta(reg) is None:
            return handler._json(404, {"error": "não há navegador aberto neste trabalho agora"})
        s = str(reg["sessao"])
        if v:
            try:
                prazo = float(body.get("prazo_s") or PRAZO_PADRAO_S)
            except (TypeError, ValueError):
                prazo = PRAZO_PADRAO_S
            ja = controle(s)["pessoa"]
            acompanhar_aba(reg)   # o que a pessoa digitar vai para a aba que ela está vendo
            c = assumir(s, prazo)
            ouvir_digitacao(reg, not ja)
            _ligar_vigia()
            return handler._json(200, {"ok": True, "controle": "pessoa", "epoca": c["epoca"], "ate": c["ate"]})
        c = devolver(s, "pessoa")
        return handler._json(200, {"ok": True, "controle": "agente", "epoca": c["epoca"], "senhas": int(c.get("senhas") or 0)})
    return handler._json(404, {"error": "rota não liberada pela ponte do Ergon"})
