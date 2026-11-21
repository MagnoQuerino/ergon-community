"""Provedor "ergon" da ferramenta computer_use do Hermes (rc.42): o controle do computador DA PESSOA.

O motor roda num contêiner, sem tela; o cua-driver do Hermes controlaria a "área de trabalho" do próprio contêiner. Aqui,
cada ação da ferramenta (capturar a tela, clicar, digitar, teclas, abrir um programa) vai ao Ergon pela ponte de sempre
(POST /internal/bridge/v1/computador, com o token da ponte), e o Ergon decide (ligado? bloqueado? protegida? a pessoa
assumiu?), pergunta no cartão quando é o caso, registra e repassa ao Ergon Desktop no computador dela, que executa com o
mouse e o teclado do sistema e devolve a captura. Nada abre porta no computador da pessoa nem no contêiner.

A imagem do motor copia esta pasta para /opt/hermes/plugins/computer_use/ergon (provedor embutido) e o cofre fixa
computer_use.backend = ergon (hermes/vault/ergon-vault.py). O formato da ferramenta para o modelo é o do Hermes; o que o
aparelho não faz (itens numerados da tela, árvore de acessibilidade, set_value) volta como "unsupported_action".

De qual trabalho é a ação: o plugin do Ergon (ergon_bridge, pre_tool_call) põe a sessão e o card da chamada num lugar que
os dois enxergam (contexto(), abaixo), na mesma linha de execução em que o Hermes roda a ferramenta logo depois.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import types
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Optional

from tools.computer_use.backend import ActionResult, CaptureResult, ComputerUseBackend, ComputerUseProvider

# o pedido pode esperar a pessoa decidir no cartão (o Ergon segura até 240 s) e a captura de tela é grande
_PRAZO_S = float(os.environ.get("ERGON_COMPUTADOR_PRAZO_S", "300"))
_CONTEXTO = "ergon_computador_contexto"
_NOTA = ("This computer is driven through the Ergon Desktop app: no numbered elements. Click by `coordinate` [x, y] "
         "in the pixels of THIS screenshot.")


def contexto() -> types.ModuleType:
    """O lugar comum entre o plugin do Ergon e este provedor: a sessão e o card da chamada em curso, por linha de execução."""
    m = sys.modules.get(_CONTEXTO)
    if m is None:
        m = types.ModuleType(_CONTEXTO)
        m.local = threading.local()  # type: ignore[attr-defined]
        m.ultimo = ("", "")  # type: ignore[attr-defined]
        sys.modules[_CONTEXTO] = m
    return m


def marcar(session_id: str, task_id: str) -> None:
    """Chamado pelo plugin do Ergon antes de cada computer_use (pre_tool_call)."""
    c = contexto()
    c.local.sessao = (str(session_id or "")[:200], str(task_id or "")[:200])
    c.ultimo = c.local.sessao


def _sessao() -> tuple[str, str]:
    c = contexto()
    return getattr(c.local, "sessao", None) or c.ultimo


def _url() -> str:
    u = urllib.parse.urlsplit(os.environ.get("ERGON_BRIDGE_URL", "http://ergon:8787/internal/bridge/v1/events"))
    return urllib.parse.urlunsplit((u.scheme, u.netloc, "/internal/bridge/v1/computador", "", ""))


def pedir(acao: str, args: dict[str, Any]) -> dict[str, Any]:
    """Uma ação ao Ergon. Erro de rede vira uma resposta com a frase para o agente (nunca uma exceção solta)."""
    token = os.environ.get("ERGON_BRIDGE_TOKEN", "")
    if len(token) < 24:
        return {"ok": False, "code": "sem_ergon", "error": "O controle do computador só funciona com o Ergon."}
    sessao, tarefa = _sessao()
    corpo = json.dumps({"acao": acao, "args": args, "session_id": sessao, "task_id": tarefa}).encode("utf-8")
    req = urllib.request.Request(_url(), method="POST", data=corpo, headers={"Content-Type": "application/json", "X-Ergon-Bridge-Token": token})
    try:
        with urllib.request.urlopen(req, timeout=_PRAZO_S) as r:
            data = json.loads(r.read() or b"{}")
    except (urllib.error.URLError, OSError, ValueError) as e:
        return {"ok": False, "code": "sem_ergon", "error": f"O Ergon não respondeu agora ({type(e).__name__}). Tente de novo em instantes."}
    return data if isinstance(data, dict) else {"ok": False, "error": "resposta inválida do Ergon"}


def _resultado(acao: str, r: dict[str, Any]) -> ActionResult:
    """Feito: o efeito não é conferido por aqui (o agente captura a tela de novo). Recusado ou falhou: a frase do Ergon vai
    como erro da ferramenta (o Hermes devolve {"error": ...}), sem a escada de "tente em primeiro plano" do cua-driver, que
    aqui só levaria o agente a insistir no que a pessoa não liberou."""
    if r.get("ok") is not True:
        raise RuntimeError(str(r.get("error") or r.get("message") or "falhou")[:500])
    return ActionResult(ok=True, action=acao, message=str(r.get("message") or "ok")[:500], effect="unverifiable")


def _nao_faz(acao: str, o_que: str) -> ActionResult:
    return ActionResult(ok=False, action=acao, code="unsupported_action", message=f"{o_que} Use coordinate [x, y] from a vision capture.")


def _xy(x: Optional[int], y: Optional[int]) -> Optional[list[int]]:
    return [int(x), int(y)] if x is not None and y is not None else None


class ErgonBackend(ComputerUseBackend):
    """Uma sessão do Hermes. Sem estado próprio: o aparelho e a decisão são do Ergon."""

    def __init__(self, permission_mode: str = "standard") -> None:
        self.permission_mode = permission_mode
        self._last_app: Optional[str] = None
        self._last_target: dict[str, Any] = {}

    def start(self) -> None: return None
    def stop(self) -> None: return None
    def is_available(self) -> bool: return True

    def capture(self, mode: str = "som", app: Optional[str] = None, pid: Optional[int] = None, window_id: Optional[int] = None) -> CaptureResult:
        if mode == "ax":
            raise RuntimeError("this computer has no accessibility tree here: capture with mode='vision' and act by coordinate")
        r = pedir("capture", {"mode": "vision"})
        if r.get("ok") is not True or not r.get("png_b64"):
            # a ferramenta do Hermes transforma a exceção em {"error": ...}: a frase do Ergon chega inteira ao agente
            raise RuntimeError(str(r.get("error") or "a captura falhou"))
        b64 = str(r["png_b64"])
        return CaptureResult(mode="vision", width=int(r.get("width") or 0), height=int(r.get("height") or 0), png_b64=b64,
                             png_bytes_len=len(b64) * 3 // 4, image_mime_type=str(r.get("mime") or "image/png"), app="screen", note=_NOTA)

    def click(self, *, element: Optional[int] = None, x: Optional[int] = None, y: Optional[int] = None, button: str = "left",
              click_count: int = 1, modifiers: Optional[list[str]] = None, delivery_mode: Optional[str] = None, bring_to_front: bool = False) -> ActionResult:
        if element is not None or _xy(x, y) is None:
            return _nao_faz("click", "Numbered elements are not available on this computer.")
        acao = {"right": "right_click", "middle": "middle_click"}.get(button) or ("double_click" if click_count >= 2 else "click")
        args: dict[str, Any] = {"coordinate": _xy(x, y)}
        if modifiers:
            args["modifiers"] = list(modifiers)
        return _resultado(acao, pedir(acao, args))

    def drag(self, *, from_element: Optional[int] = None, to_element: Optional[int] = None, from_xy: Optional[tuple[int, int]] = None,
             to_xy: Optional[tuple[int, int]] = None, button: str = "left", modifiers: Optional[list[str]] = None,
             delivery_mode: Optional[str] = None, bring_to_front: bool = False) -> ActionResult:
        if not from_xy or not to_xy:
            return _nao_faz("drag", "Drag needs from_coordinate and to_coordinate.")
        return _resultado("drag", pedir("drag", {"from_coordinate": [int(from_xy[0]), int(from_xy[1])], "to_coordinate": [int(to_xy[0]), int(to_xy[1])]}))

    def scroll(self, *, direction: str, amount: int = 3, element: Optional[int] = None, x: Optional[int] = None, y: Optional[int] = None,
               modifiers: Optional[list[str]] = None, delivery_mode: Optional[str] = None, bring_to_front: bool = False) -> ActionResult:
        args: dict[str, Any] = {"direction": direction, "amount": int(amount)}
        if _xy(x, y):
            args["coordinate"] = _xy(x, y)
        return _resultado("scroll", pedir("scroll", args))

    def type_text(self, text: str, *, delivery_mode: Optional[str] = None, bring_to_front: bool = False) -> ActionResult:
        return _resultado("type", pedir("type", {"text": text}))

    def key(self, keys: str, *, delivery_mode: Optional[str] = None, bring_to_front: bool = False) -> ActionResult:
        return _resultado("key", pedir("key", {"keys": keys}))

    def _lista(self, acao: str, chave: str) -> list[dict[str, Any]]:
        r = pedir(acao, {})
        if r.get("ok") is not True:
            raise RuntimeError(str(r.get("error") or f"{acao} falhou"))
        v = r.get(chave)
        return v if isinstance(v, list) else []

    def list_apps(self) -> list[dict[str, Any]]: return self._lista("list_apps", "apps")
    def list_windows(self) -> list[dict[str, Any]]: return self._lista("list_windows", "windows")

    def focus_app(self, app: str, raise_window: bool = False) -> ActionResult:
        res = _resultado("focus_app", pedir("focus_app", {"app": app}))
        if res.ok:
            self._last_app = app
        return res

    def set_value(self, value: str, element: Optional[int] = None) -> ActionResult:
        return _nao_faz("set_value", "set_value needs numbered elements, not available here: click the control and type instead.")


class ErgonProvider(ComputerUseProvider):
    name = "ergon"
    display_name = "Ergon Desktop (o computador da pessoa)"

    def create_backend(self, *, permission_mode: str) -> ComputerUseBackend:
        return ErgonBackend(permission_mode=permission_mode)

    def is_available(self) -> bool:
        return True


def register(ctx):
    ctx.register_computer_use_provider(ErgonProvider())
