"""Ponte Ergon ↔ Hermes. O Ergon é a interface; o Hermes roda por baixo e nunca é exposto ao usuário.

Três partes, todas sem chamar modelo e sem ler credenciais de provedor:

1. Canais (``post_gateway_admission``, conferido em Hermes v0.22.2): registra no Ergon cada mensagem
   ADMITIDA pelo gateway (Teams/WhatsApp). O hook é *fail-open* no Hermes, por isso este plugin nunca
   lança exceção; WhatsApp sempre devolve "handled" (observação sem resposta automática), mesmo com o
   Ergon fora (o evento vai para um spool local e é reenviado depois).

2. Ferramentas por agente (``pre_tool_call``, *fail-closed* no Hermes): cada agente do Ergon é um subagente
   especializado, com as ferramentas que a coordenação (Aristóteles) liberou. A API do Hermes não escolhe
   ferramentas por execução, então a plataforma liga o conjunto seguro e este hook barra, a cada chamada, o
   que o agente da sessão não tem — dizendo quem da equipe tem, para ele pedir ajuda. Sessão desconhecida
   (gateway direto, agendamentos) ou Ergon fora do ar: só o conjunto básico (ERGON_BASE_TOOLSETS, "todo").

3. Ponte de controle (rede interna do Docker, porta ERGON_CONTROL_PORT): o painel do Hermes roda só em
   127.0.0.1 dentro do contêiner; o Ergon chega a ele por aqui, com o token da ponte, e SÓ às rotas da
   lista abaixo (login de contas por código, modelo padrão, catálogo de modelos e skills, ferramentas da
   plataforma da API). Variáveis de ambiente, arquivos, terminal, MCP e configuração bruta não passam.
"""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

logger = logging.getLogger("ergon_bridge")

_PLATFORMS = ("teams", "whatsapp")
_SOURCE_KEYS = ("chat_id", "chat_name", "chat_type", "user_id", "user_name", "thread_id", "is_bot", "scope_id", "guild_id", "message_id")
_TIMEOUT = float(os.environ.get("ERGON_BRIDGE_TIMEOUT", "4"))
_SPOOL_MAX = 500
_lock = threading.Lock()


def _url() -> str:
    return os.environ.get("ERGON_BRIDGE_URL", "http://ergon:8787/internal/bridge/v1/events")


def _url_for(path: str) -> str:
    """Outra rota interna do Ergon, no mesmo servidor da ponte de eventos."""
    u = urllib.parse.urlsplit(_url())
    return urllib.parse.urlunsplit((u.scheme, u.netloc, path, "", ""))


def _token() -> str:
    return os.environ.get("ERGON_BRIDGE_TOKEN", "")


def _spool_path() -> Path:
    home = Path(os.environ.get("HERMES_HOME", "/opt/data"))
    return home / "ergon_bridge" / "spool.jsonl"


def _post_to(url: str, payload: dict[str, Any], timeout: float = _TIMEOUT) -> dict[str, Any]:
    token = _token()
    if len(token) < 24:
        raise RuntimeError("ERGON_BRIDGE_TOKEN ausente")
    req = urllib.request.Request(
        url, method="POST", data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Ergon-Bridge-Token": token},
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read() or b"{}")
    return data if isinstance(data, dict) else {}


def _post(payload: dict[str, Any]) -> dict[str, Any]:
    return _post_to(_url(), payload)


# ---------------------------------------------------------------- 1. canais

def _spool(payload: dict[str, Any]) -> None:
    try:
        p = _spool_path()
        p.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            lines = p.read_text(encoding="utf-8").splitlines() if p.exists() else []
            lines.append(json.dumps(payload, ensure_ascii=False))
            p.write_text("\n".join(lines[-_SPOOL_MAX:]) + "\n", encoding="utf-8")
            os.chmod(p, 0o600)
    except Exception:  # noqa: BLE001 - nunca derrubar o gateway
        logger.warning("ergon_bridge: falha ao gravar spool", exc_info=False)


def _flush_spool() -> None:
    """Reenvia eventos guardados. O Ergon deduplica por ID externo, então reenvio é seguro."""
    p = _spool_path()
    with _lock:
        if not p.exists():
            return
        lines = [ln for ln in p.read_text(encoding="utf-8").splitlines() if ln.strip()]
        left: list[str] = []
        for ln in lines:
            try:
                _post(json.loads(ln))
            except Exception:  # noqa: BLE001
                left.append(ln)
        p.write_text("\n".join(left) + ("\n" if left else ""), encoding="utf-8")


def _decide(session_key: str = "", platform: str = "", source: dict | None = None,
                 message_id: Any = None, text: str = "", **_: Any) -> dict[str, Any] | None:
    if platform not in _PLATFORMS:
        return None  # outras plataformas: comportamento normal do Hermes
    src = {k: v for k, v in (source or {}).items() if k in _SOURCE_KEYS and v not in (None, "")}
    payload = {
        "schema": "ergon.bridge.v1", "platform": platform, "message_id": str(message_id or src.get("message_id") or ""),
        "text": str(text or "")[:8000], "event_type": "message", "session_key": str(session_key)[:256], "source": src,
    }
    if not payload["message_id"]:
        payload["message_id"] = f"noid-{int(time.time() * 1000)}"
    try:
        _flush_spool()
        decision = _post(payload)
    except Exception as exc:  # noqa: BLE001
        logger.warning("ergon_bridge: Ergon indisponível (%s); evento guardado no spool", type(exc).__name__)
        _spool(payload)
        if platform == "whatsapp":
            return {"action": "handled"}  # nunca responder contatos por falha da ponte
        return {"action": "handled", "reply": "Ergon indisponível no momento; sua mensagem foi guardada e será registrada."}
    if platform == "whatsapp":
        reply = decision.get("reply")
        return {"action": "handled", **({"reply": reply} if isinstance(reply, str) and reply.strip() else {})}
    if decision.get("action") == "handled":
        reply = decision.get("reply")
        return {"action": "handled", **({"reply": reply} if isinstance(reply, str) and reply.strip() else {})}
    return None  # "continue": turno normal do agente Hermes


async def on_admission(**kwargs: Any) -> dict[str, Any] | None:
    """Hook assíncrono: o HTTP bloqueante roda em thread para não travar o loop do gateway."""
    try:
        return await asyncio.to_thread(_decide, **kwargs)
    except Exception:  # noqa: BLE001 - fail-closed para WhatsApp
        return {"action": "handled"} if kwargs.get("platform") == "whatsapp" else None


# ---------------------------------------------------------------- 2. ferramentas por agente

def _csv(name: str, default: str) -> list[str]:
    return [s.strip() for s in os.environ.get(name, default).split(",") if s.strip()]


_BASE_TOOLSETS = _csv("ERGON_BASE_TOOLSETS", "todo")
# Ferramentas fora do uso comum, mesmo com o conjunto ligado (criar/editar skills): skill_manage só passa pela
# regra do Treinar (_skills_gate), na sessão de um treinamento autorizado e só para aquela competência.
_DENY_TOOLS = frozenset(_csv("ERGON_DENY_TOOLS", "skill_manage"))
# Leitura do catálogo da busca de ferramentas do Hermes: algumas ferramentas (lista de passos, criar imagens) só
# chegam ao modelo por ela. Só lê o catálogo; a chamada de verdade (tool_call) o Hermes desembrulha antes deste
# hook, que confere o nome real da ferramenta. Antes, barrada para todos: as duas ficavam inalcançáveis.
_CATALOG_TOOLS = frozenset(_csv("ERGON_CATALOG_TOOLS", "tool_search,tool_describe"))
_POLICY_TTL = 20.0
# sessão → (validade, política: ferramentas liberadas, agente, quem tem cada conjunto, conjuntos que executam código,
# competências do agente, treinamento em curso)
_policy_cache: dict[str, tuple[float, dict[str, Any]]] = {}
_policy_lock = threading.Lock()
# Treinar: o que um treinamento autorizado pode fazer com a competência dele
_TRAINING_ACTIONS = frozenset({"create", "patch", "edit", "write_file", "remove_file"})
_BATCH_MAX = 20


def _write_ops(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """As operações de uma escrita de competência, achatadas e na ordem. O motor anuncia ao modelo só o formato em
    lote (operations=[...]); o formato simples (action/name no topo) ainda vale e é o que o motor guarda por op."""
    ops = payload.get("operations")
    if ops is None and str(payload.get("action") or "") != "batch":
        return [payload]
    top = payload.get("name")
    # op que não é objeto vira {} (sem nome): reprova a escrita inteira em vez de sumir da conferência
    return [{**op, "name": op.get("name") or top} if isinstance(op, dict) else {} for op in ops] if isinstance(ops, list) else []


def _training_write_ok(args: dict[str, Any], skill: str) -> bool:
    """Escrita do treinamento: TODAS as operações são da competência dele, com ação de escrita (nunca apagar)."""
    top = args.get("name")
    if top and _skill_base(top) != skill:
        return False
    ops = _write_ops(args)
    return 0 < len(ops) <= _BATCH_MAX and all(
        _skill_base(op.get("name")) == skill and str(op.get("action") or "") in _TRAINING_ACTIONS for op in ops)


def _skill_base(name: Any) -> str:
    """Nome da skill sem categoria nem prefixo de plugin ("ergon/x" ou "plugin:x" → "x")."""
    return str(name or "").strip().split(":")[-1].split("/")[-1]


def _norm_url(u: Any) -> str:
    s = str(u or "").strip()
    try:
        p = urllib.parse.urlsplit(s)
        return urllib.parse.urlunsplit((p.scheme.lower(), p.netloc.lower(), p.path.rstrip("/"), p.query, ""))
    except Exception:  # noqa: BLE001
        return s


def _tools_of(toolsets: list[str]) -> frozenset[str]:
    try:
        from toolsets import resolve_toolset  # módulo do Hermes
    except Exception:  # noqa: BLE001
        return frozenset()
    out: set[str] = set()
    for ts in toolsets:
        try:
            out.update(resolve_toolset(str(ts)))
        except Exception:  # noqa: BLE001 - conjunto desconhecido: nada liberado
            continue
    return frozenset(out - _DENY_TOOLS)


def _policy(session_id: str, task_id: str) -> dict[str, Any]:
    key = f"{session_id}|{task_id}"
    with _policy_lock:
        hit = _policy_cache.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
    toolsets: list[str] = _BASE_TOOLSETS
    pol: dict[str, Any] = {"who": "", "holders": {}, "guarded": {}, "skills": frozenset(), "training": None}
    try:
        data = _post_to(_url_for("/internal/bridge/v1/tool-policy"), {"session_id": session_id, "task_id": task_id}, timeout=3)
        if data.get("known") is True:
            raw = data.get("toolsets")
            toolsets = [str(x) for x in raw] if isinstance(raw, list) else []
            pol["who"] = str(data.get("agent") or "")[:60]
            h = data.get("holders")
            if isinstance(h, dict):
                pol["holders"] = {str(k): [str(n)[:60] for n in v][:6] for k, v in h.items() if isinstance(v, list)}
            gd = data.get("guarded")
            if isinstance(gd, dict):
                pol["guarded"] = {str(k)[:40]: str(v)[:30] for k, v in gd.items()}
            sk = data.get("skills")
            if isinstance(sk, list):
                pol["skills"] = frozenset(_skill_base(x)[:80] for x in sk[:60])
            tr = data.get("training")
            if isinstance(tr, dict) and isinstance(tr.get("skill"), str) and tr["skill"]:
                urls = tr.get("urls") if isinstance(tr.get("urls"), list) else []
                pol["training"] = {"skill": tr["skill"][:80], "urls": [str(u)[:2000] for u in urls][:10]}
    except Exception:  # noqa: BLE001 - Ergon fora: só o conjunto básico (fail-closed)
        pass
    pol["allowed"] = _tools_of(toolsets)
    with _policy_lock:
        if len(_policy_cache) > 500:
            _policy_cache.clear()
        _policy_cache[key] = (time.time() + _POLICY_TTL, pol)
    return pol


def _approval_on() -> bool:
    """A trava de aprovação nativa do motor (skills.write_approval) está ligada? Na dúvida, não."""
    try:
        from tools.write_approval import write_approval_enabled  # módulo do Hermes
        return bool(write_approval_enabled("skills"))
    except Exception:  # noqa: BLE001
        return False


def _skills_gate(tool_name: str, args: dict[str, Any], pol: dict[str, Any]) -> dict[str, Any] | None | bool:
    """Competências (skills) e Treinar. True = liberar; dict = barrar; None = não é com esta regra.

    Cada agente carrega só as próprias competências (a lista vem do Ergon); a lista geral de skills não é
    mostrada. Criar ou alterar competência só num treinamento autorizado no Ergon, e só a daquele treinamento.
    No treinamento, a leitura de páginas vale só para os links que a pessoa deu, e não há busca na web."""
    tr = pol.get("training")
    quem = pol.get("who") or "esta conversa"
    if tool_name == "skills_list":
        names = ", ".join(sorted(pol["skills"])) or "nenhuma"
        return {"action": "block", "message": f"No Ergon, cada agente usa só as próprias competências ({names}). Carregue uma com skill_view (name=...)."}
    if tool_name == "skill_view":
        base = _skill_base(args.get("name"))
        if base and (base in pol["skills"] or (tr and base == tr["skill"])):
            return True
        return {"action": "block", "message": f"A competência '{base or '?'}' não é de {quem} no Ergon. Use só as suas: {', '.join(sorted(pol['skills'])) or 'nenhuma'}."}
    if tool_name == "skill_manage":
        if tr and _training_write_ok(args, tr["skill"]):
            if not _approval_on():
                # sem a trava nativa a escrita iria direto para a biblioteca, sem a pessoa aprovar: nunca
                return {"action": "block", "message": "A trava de aprovação do motor está desligada; sem ela o treinamento não grava nada. "
                        "Termine dizendo que a competência não pôde ser escrita por isso."}
            return True
        return {"action": "block", "message": "Competências só são criadas ou alteradas num treinamento autorizado no Ergon (Treinar, no perfil do agente)"
                + (f"; neste treinamento, toda operação usa name=\"{tr['skill']}\" (create, patch, write_file ou remove_file; "
                   "nada de delete nem outra competência). Ex.: operations=[{\"action\": \"create\", \"name\": \""
                   f"{tr['skill']}\", \"category\": \"ergon\", \"content\": \"---\\nname: ...\"}}]." if tr else ".")}
    if tr and tool_name == "web_extract":
        urls = args.get("urls")
        urls = [urls] if isinstance(urls, str) else urls if isinstance(urls, list) else []
        ok = {_norm_url(u) for u in tr["urls"]}
        if urls and all(_norm_url(u) in ok for u in urls):
            return True
        return {"action": "block", "message": f"Neste treinamento, leia só os links que a pessoa deu: {', '.join(tr['urls']) or 'nenhum'}."}
    if tr and tool_name == "web_search":
        return {"action": "block", "message": "Neste treinamento não há busca na web: use só os documentos e os links fornecidos."}
    return None


def _who_has(tool_name: str, holders: dict[str, list[str]]) -> list[str]:
    names: list[str] = []
    for ts, people in holders.items():
        if tool_name in _tools_of([ts]):
            names.extend(p for p in people if p not in names)
    return names


def on_pre_tool_call(tool_name: str = "", args: Any = None, task_id: str = "", session_id: str = "", **_: Any) -> dict[str, Any] | None:
    """Trava por agente (definida pela coordenação no Ergon). A recusa diz quem tem a ferramenta, para o
    agente pedir ajuda em vez de improvisar."""
    try:
        if tool_name in _CATALOG_TOOLS:
            return None
        pol = _policy(str(session_id or ""), str(task_id or ""))
        allowed, who, holders, guarded = pol["allowed"], pol["who"], pol["holders"], pol["guarded"]
        gate = _skills_gate(tool_name, args if isinstance(args, dict) else {}, pol)
        if gate is True:
            return None
        if isinstance(gate, dict):
            return gate
        if tool_name in allowed:
            return None
        quem = who or "esta conversa"
        # ferramenta que executa código: só com a autorização do usuário (senha, no cartão que aparece na conversa)
        tid = next((t for ts, t in guarded.items() if tool_name in _tools_of([ts])), "")
        if tid and who:
            return {"action": "block", "message": (
                f"A ferramenta '{tool_name}' executa código e precisa da autorização do usuário. Não finja que executou: "
                f'diga em uma frase o que vai executar e escreva [[pedir-permissao ferramenta="{tid}" motivo="o que vai executar"]]. '
                "O usuário autoriza com a senha na conversa e você continua.")}
        others = [n for n in _who_has(tool_name, holders) if n != who]
        if others:
            return {"action": "block", "message": (
                f"A ferramenta '{tool_name}' não está liberada para {quem} no Ergon. Quem tem: {', '.join(others)}. "
                f'Peça ajuda com uma linha [[pedir-ajuda agente="{others[0]}" pedido="o que você precisa, com o contexto"]] e continue o que puder sem ela.')}
        return {"action": "block", "message": f"A ferramenta '{tool_name}' não está liberada para {quem} no Ergon e ninguém da equipe a tem. Continue sem ela e diga ao usuário o que ficou faltando."}
    except Exception:  # noqa: BLE001
        return {"action": "block", "message": "A verificação de ferramentas do Ergon falhou; ferramenta bloqueada."}


def on_post_tool_call(tool_name: str = "", args: Any = None, result: Any = None, task_id: str = "", session_id: str = "", **_: Any) -> None:
    """Treinar: conta ao Ergon o que aconteceu — cada escrita da competência que ficou em espera e cada link lido
    (quantos caracteres vieram). Fora do treinamento: cada vez que o agente carrega uma competência aprendida dele
    (a prova de uso que aparece no perfil). Nunca lança exceção (observador)."""
    if tool_name not in ("skill_manage", "web_extract", "skill_view"):
        return None
    try:
        pol = _policy(str(session_id or ""), str(task_id or ""))
        data: Any = result
        if isinstance(result, str):
            s = result.strip()
            data = json.loads(s) if s.startswith("{") else {}
        data = data if isinstance(data, dict) else {}
        payload: dict[str, Any] = {"session_id": str(session_id or "")[:200], "task_id": str(task_id or "")[:200], "tool": tool_name}
        if tool_name == "skill_view":
            base = _skill_base(args.get("name") if isinstance(args, dict) else "")
            if pol.get("training") or not data.get("success") or not _SKILL_NAME.fullmatch(base) or base not in pol["skills"]:
                return None
            payload["skill"] = base
        elif not pol.get("training"):
            return None
        elif tool_name == "skill_manage":
            payload["pending_id"] = str(data.get("pending_id") or "")[:40]
            payload["staged"] = bool(data.get("staged"))
        else:
            reads = []
            for r in (data.get("results") or [])[:20]:
                if not isinstance(r, dict):
                    continue
                content = str(r.get("content") or "")
                err = r.get("error")
                reads.append({"url": str(r.get("url") or "")[:2000], "chars": len(content.strip()), "ok": bool(content.strip()) and not err, "error": str(err or "")[:300]})
            payload["reads"] = reads
        _post_to(_url_for("/internal/bridge/v1/training-event"), payload, timeout=3)
    except Exception:  # noqa: BLE001 - observador: nunca atrapalha a ferramenta
        logger.warning("ergon_bridge: evento de treinamento não registrado", exc_info=False)
    return None


# ---------------------------------------------------------------- Treinar: competências no motor
# A trava de aprovação nativa (skills.write_approval) deixa cada escrita do treinamento em espera em
# HERMES_HOME/pending/skills. O Ergon lê, mostra à pessoa e manda aplicar ou descartar por aqui. A competência
# aplicada fica na categoria "ergon", com o nome que o Ergon deu, e marcada como privada: fora do índice comum de
# skills (session_platforms de uma plataforma que não existe); só carrega por skill_view, que a trava libera ao dono.
_SKILL_NAME = re.compile(r"ergon-[a-z0-9][a-z0-9-]{2,63}")
_PRIVATE = "ergon-privado"
_SKILL_FILE_MAX = 400 * 1024


def _mark_private(content: str, name: str) -> str:
    """Cabeçalho da competência com o nome do Ergon e a marca de privada; o corpo fica como está."""
    from agent.skill_utils import parse_frontmatter  # módulo do Hermes
    fm, body = parse_frontmatter(content or "")
    fm = dict(fm) if isinstance(fm, dict) else {}
    meta = fm.get("metadata") if isinstance(fm.get("metadata"), dict) else {}
    herm = meta.get("hermes") if isinstance(meta.get("hermes"), dict) else {}
    tags = [str(t)[:40] for t in herm.get("tags", [])][:8] if isinstance(herm.get("tags"), list) else []
    desc = str(fm.get("description") or "Competência ensinada no Ergon.").strip()[:120]
    out = {
        "name": name, "description": desc, "version": str(fm.get("version") or "0.1.0")[:20], "author": "Hermes",
        "metadata": {"hermes": {**({"tags": tags} if tags else {}), "session_platforms": [_PRIVATE]}},
    }
    # JSON é YAML válido: o cabeçalho sai sem depender de serializador
    head = "\n".join(f"{k}: {json.dumps(v, ensure_ascii=False)}" for k, v in out.items())
    return f"---\n{head}\n---\n{(body or '').lstrip()}"


def _skill_dir(name: str) -> Path | None:
    from tools.write_approval import _find_skill_path  # módulo do Hermes
    p = _find_skill_path(name)
    return Path(p) if p else None


def _read_skill(name: str) -> dict[str, str]:
    d = _skill_dir(name)
    files: dict[str, str] = {}
    if not d or not d.is_dir():
        return files
    for f in sorted(d.rglob("*")):
        rel = f.relative_to(d).as_posix()
        if not f.is_file() or f.is_symlink() or any(part.startswith(".") for part in rel.split("/")) or len(files) >= 80:
            continue
        try:
            if f.stat().st_size <= _SKILL_FILE_MAX:
                files[rel] = f.read_text(encoding="utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            continue
    return files


def _apply_write(payload: dict[str, Any]) -> dict[str, Any]:
    from tools.skill_manager_tool import apply_skill_pending  # replay nativo (a trava de aprovação não se aplica)
    res = apply_skill_pending(payload)
    try:
        data = json.loads(res) if isinstance(res, str) else res
    except Exception:  # noqa: BLE001
        data = {"success": False, "error": str(res)[:300]}
    return data if isinstance(data, dict) else {"success": False, "error": "resposta inesperada"}


def _ensure_private(name: str) -> None:
    d = _skill_dir(name)
    main = d / "SKILL.md" if d else None
    if main and main.is_file():
        cur = main.read_text(encoding="utf-8", errors="replace")
        marked = _mark_private(cur, name)
        if marked != cur:
            r = _apply_write({"action": "edit", "name": name, "content": marked})
            if not r.get("success"):
                raise RuntimeError(f"não consegui marcar como privada: {r.get('error') or r.get('message')}")


_OP_FIELDS = ("action", "name", "content", "category", "file_path", "file_content", "old_string", "new_string", "replace_all")


def _is_for(rec: dict[str, Any], name: str) -> bool:
    ops = _write_ops(rec.get("payload") or {})
    return bool(ops) and all(_skill_base(op.get("name")) == name for op in ops)


def skills_pending(ids: set[str], name: str) -> list[dict[str, Any]]:
    """As escritas em espera pedidas (pelos ids ou todas desta competência), uma linha por operação, na ordem.
    As operações de um lote saem com o mesmo id (é uma escrita em espera só)."""
    from tools import write_approval as wa
    out: list[dict[str, Any]] = []
    for r in wa.list_pending(wa.SKILLS):
        # com nome, só as desta competência (um id avisado de outra não entra); sem nome, as pedidas pelo id
        if not (_is_for(r, name) if name else r.get("id") in ids):
            continue
        for op in _write_ops(r.get("payload") or {}):
            out.append({"id": r.get("id"), **{k: v for k, v in op.items() if k in _OP_FIELDS}})
    return out


def skills_apply(ids: list[str], name: str) -> dict[str, str]:
    """Aplica as escritas em espera do treinamento, na ordem, com o nome e a marca do Ergon (lote ou não, cada
    operação vai pelo caminho simples: nome forçado, "create" de quem já existe vira reescrita, marca de privada)."""
    from tools import write_approval as wa
    if not _SKILL_NAME.fullmatch(name):
        raise ValueError("nome de competência inválido")
    recs = []
    for i in dict.fromkeys(str(x)[:40] for x in ids[:200]):  # sem repetir, na ordem
        rec = wa.get_pending(wa.SKILLS, i)
        if not rec or not _is_for(rec, name) or not all(str(op.get("action") or "") in _TRAINING_ACTIONS for op in _write_ops(rec.get("payload") or {})):
            raise ValueError(f"escrita em espera {i} não é desta competência (ou não existe mais)")
        recs.append(rec)
    for rec in recs:
        for op in _write_ops(rec["payload"]):
            p = {k: v for k, v in op.items() if k in _OP_FIELDS and v is not None}
            p["name"] = name
            action = str(p.get("action") or "")
            if action == "create":
                if _skill_dir(name) is not None:  # atualização que veio como "create": vira reescrita, sem duplicar
                    p = {"action": "edit", "name": name, "content": p.get("content") or ""}
                else:
                    p["category"] = "ergon"
            if p.get("content") and (p["action"] in ("create", "edit") or (p["action"] == "patch" and not p.get("old_string"))):
                p["content"] = _mark_private(str(p["content"]), name)
            r = _apply_write(p)
            if not r.get("success"):
                raise RuntimeError(f"{action}: {r.get('error') or r.get('message') or 'falhou'}")
        wa.discard_pending(wa.SKILLS, rec["id"])
    _ensure_private(name)
    return _read_skill(name)


def skills_restore(name: str, files: dict[str, str]) -> dict[str, str]:
    """Grava de novo uma versão guardada no Ergon (o SKILL.md e as referências)."""
    if not _SKILL_NAME.fullmatch(name) or not isinstance(files, dict) or not str(files.get("SKILL.md") or "").strip():
        raise ValueError("versão inválida")
    main = _mark_private(str(files["SKILL.md"]), name)
    r = _apply_write({"action": "edit", "name": name, "content": main} if _skill_dir(name) else {"action": "create", "name": name, "content": main, "category": "ergon"})
    if not r.get("success"):
        raise RuntimeError(r.get("error") or r.get("message") or "falhou")
    current = _read_skill(name)
    for rel in [k for k in current if k != "SKILL.md" and k not in files]:
        _apply_write({"action": "remove_file", "name": name, "file_path": rel})
    for rel, body in files.items():
        if rel == "SKILL.md" or ".." in rel.split("/") or rel.startswith("/"):
            continue
        r = _apply_write({"action": "write_file", "name": name, "file_path": rel, "file_content": str(body)})
        if not r.get("success"):
            raise RuntimeError(f"{rel}: {r.get('error') or r.get('message') or 'falhou'}")
    return _read_skill(name)


# ---------------------------------------------------------------- 3. ponte de controle

_DASH_PORT = os.environ.get("HERMES_DASHBOARD_PORT", "9119")
_DASH = f"http://127.0.0.1:{_DASH_PORT}"
_ACCOUNTS = "nous|openai-codex"
_SID = r"[A-Za-z0-9_-]{1,128}"
# (método, caminho exato em regex, parâmetros de consulta aceitos)
_ROUTES: list[tuple[str, re.Pattern[str], tuple[str, ...]]] = [
    ("GET", re.compile(r"/api/providers/oauth"), ()),
    ("POST", re.compile(rf"/api/providers/oauth/({_ACCOUNTS})/start"), ()),
    ("GET", re.compile(rf"/api/providers/oauth/({_ACCOUNTS})/poll/{_SID}"), ()),
    ("DELETE", re.compile(rf"/api/providers/oauth/sessions/{_SID}"), ()),
    ("DELETE", re.compile(rf"/api/providers/oauth/({_ACCOUNTS})"), ()),
    ("GET", re.compile(r"/api/model/info"), ()),
    ("GET", re.compile(r"/api/model/options"), ("refresh", "include_unconfigured")),
    ("POST", re.compile(r"/api/model/set"), ()),
    ("GET", re.compile(r"/api/skills"), ()),
    # endpoint próprio "ergon-ai" (módulo opcional, sem uso na Community): aponta para um gateway com a
    # credencial da pessoa; só esse id, só credencial ergai_ e só modelos conhecidos (ver _sanitize_ergon_ai)
    ("GET", re.compile(r"/api/providers/custom-endpoints"), ()),
    ("POST", re.compile(r"/api/providers/custom-endpoints"), ()),
    ("POST", re.compile(r"/api/providers/custom-endpoints/ergon-ai/activate"), ()),
    ("DELETE", re.compile(r"/api/providers/custom-endpoints/ergon-ai"), ()),
]
# Conjuntos que o Ergon pode ligar na plataforma da API. Os que executam código (terminal, Python) só depois
# que o usuário autoriza com a senha no Ergon — o Ergon confere a senha; aqui chega só o pedido com o token da
# ponte. Arquivos, navegador, agendamentos, delegação e mensagens ficam desligados nesta versão local.
_SAFE_TOOLSETS = frozenset(_csv("ERGON_SAFE_TOOLSETS", "todo,web,vision,image_gen,skills"))
_GUARDED_TOOLSETS = frozenset(_csv("ERGON_GUARDED_TOOLSETS", "code_execution,terminal"))
_MAX_BODY = 16 * 1024
_control_started = False
# Imagens que o motor gera (criar imagens): a resposta da execução traz só "MEDIA:<caminho>" — a rota de execuções do
# Hermes não embute a imagem, e o Ergon não enxerga o disco do motor. O Ergon busca por aqui, só desta pasta, só imagem.
_MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
_MEDIA_MAX = 10 * 1024 * 1024


def _media_dir() -> str:
    return os.path.realpath(os.path.join(os.environ.get("HERMES_HOME", "/opt/data"), "cache", "generated"))


def _media_file(raw: str) -> tuple[str, str] | None:
    """(caminho real, tipo) de uma imagem gerada, ou None: fora da pasta das geradas (também por link), outro tipo,
    vazia ou grande demais."""
    if not raw or "\x00" in raw or len(raw) > 512:
        return None
    real = os.path.realpath(raw)
    base = _media_dir()
    mime = _MEDIA_TYPES.get(os.path.splitext(real)[1].lower())
    if not mime or os.path.commonpath([real, base]) != base or not os.path.isfile(real):
        return None
    size = os.path.getsize(real)
    return (real, mime) if 0 < size <= _MEDIA_MAX else None


def _sanitize_ergon_ai(body: dict[str, Any]) -> dict[str, Any]:
    """Endpoint próprio do Ergon AI: id fixo, endereço https (http só para host de teste), credencial Ergon e modelos
    com nome simples. Nada mais passa (nem outro provedor, nem chave de terceiros)."""
    base, key = str(body.get("base_url") or "").strip(), str(body.get("api_key") or "").strip()
    models = [str(m) for m in (body.get("models") or []) if isinstance(m, str)][:8]
    model = str(body.get("model") or (models[0] if models else "")).strip()
    test_host = re.fullmatch(r"http://(host\.docker\.internal|localhost|127\.0\.0\.1|[a-z0-9-]+)(:\d+)?/v1/ai", base)
    if not (re.fullmatch(r"https://[a-z0-9.-]+(:\d+)?/v1/ai", base) or test_host):
        raise ValueError("endereço do Ergon AI inválido")
    if not re.fullmatch(r"ergai_[A-Za-z0-9_-]{20,}", key):
        raise ValueError("credencial do Ergon AI inválida")
    for m in [model, *models]:
        if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,60}", m):
            raise ValueError("modelo inválido")
    return {"id": "ergon-ai", "name": "Ergon AI", "base_url": base, "api_key": key, "model": model, "models": models or [model],
            "api_mode": "chat_completions", "discover_models": False, "make_default": bool(body.get("make_default"))}


def _sanitize_model_set(body: dict[str, Any]) -> dict[str, Any]:
    provider, model = str(body.get("provider") or "").strip(), str(body.get("model") or "").strip()
    if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,40}", provider) or not re.fullmatch(r"[\w./:@+-]{1,160}", model):
        raise ValueError("provedor ou modelo inválido")
    return {"scope": "main", "provider": provider, "model": model, "confirm_expensive_model": bool(body.get("confirm_expensive_model"))}


def _dash_call(method: str, path: str, query: str, body: dict[str, Any] | None) -> tuple[int, bytes]:
    token = os.environ.get("HERMES_DASHBOARD_SESSION_TOKEN", "")
    if not token:
        return 503, json.dumps({"error": "painel interno sem token (HERMES_DASHBOARD_SESSION_TOKEN)"}).encode()
    req = urllib.request.Request(
        _DASH + path + (f"?{query}" if query else ""), method=method,
        data=None if body is None else json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Hermes-Session-Token": token},
    )
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()[:4000]
    except Exception as exc:  # noqa: BLE001
        return 503, json.dumps({"error": f"painel interno indisponível ({type(exc).__name__})"}).encode()


class _ControlHandler(BaseHTTPRequestHandler):
    server_version = "ergon-control/1"

    def log_message(self, *_a: Any) -> None:  # silencioso: nada de URLs/tokens no log
        return

    def _send(self, status: int, data: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _json(self, status: int, obj: Any) -> None:
        self._send(status, json.dumps(obj, ensure_ascii=False).encode("utf-8"))

    def _authorized(self) -> bool:
        token = _token()
        got = self.headers.get("X-Ergon-Bridge-Token", "")
        return len(token) >= 24 and hmac.compare_digest(got.encode(), token.encode())

    def _body(self, limit: int = _MAX_BODY) -> dict[str, Any] | None:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return None
        if n > limit:
            raise ValueError("corpo grande demais")
        data = json.loads(self.rfile.read(n) or b"{}")
        return data if isinstance(data, dict) else {}

    def _handle(self, method: str) -> None:
        if not self._authorized():
            return self._json(401, {"error": "token da ponte inválido"})
        parts = urllib.parse.urlsplit(self.path)
        path = parts.path
        try:
            # Treinar: o pedido (com o texto dos documentos) e as versões guardadas são maiores
            body = self._body(1024 * 1024 if path in ("/ergon/v1/learn-prompt", "/ergon/v1/skills/restore") else _MAX_BODY)
        except Exception:  # noqa: BLE001
            return self._json(400, {"error": "corpo inválido"})
        if path.startswith("/ergon/v1/learn-prompt") or path.startswith("/ergon/v1/skills/"):
            return self._training(method, path, body or {})
        if path == "/ergon/v1/health" and method == "GET":
            status, _ = _dash_call("GET", "/api/model/info", "", None)
            return self._json(200, {"ok": True, "dashboard": status == 200})
        if path == "/ergon/v1/api-toolsets" and method == "GET":
            return self._api_toolsets_get()
        if path == "/ergon/v1/api-toolsets" and method == "PUT":
            return self._api_toolsets_put(body or {})
        if path == "/ergon/v1/media" and method == "GET":
            return self._media_get(dict(urllib.parse.parse_qsl(parts.query)).get("path", ""))
        for m, rx, allowed_q in _ROUTES:
            if m == method and rx.fullmatch(path):
                q = urllib.parse.parse_qsl(parts.query)
                query = urllib.parse.urlencode([(k, v) for k, v in q if k in allowed_q and re.fullmatch(r"[a-z0-9_]{1,20}", v)])
                if path == "/api/model/set":
                    try:
                        body = _sanitize_model_set(body or {})
                    except ValueError as exc:
                        return self._json(400, {"error": str(exc)})
                elif path == "/api/providers/custom-endpoints" and method == "POST":
                    try:
                        body = _sanitize_ergon_ai(body or {})
                    except ValueError as exc:
                        return self._json(400, {"error": str(exc)})
                elif method in ("POST", "PUT"):
                    body = {}
                status, data = _dash_call(method, path, query, body if method in ("POST", "PUT") else None)
                return self._send(status, data)
        return self._json(404, {"error": "rota não liberada pela ponte do Ergon"})

    def _training(self, method: str, path: str, body: dict[str, Any]) -> None:
        """Rotas do Treinar (só POST): o turno do /learn e as escritas de competência em espera."""
        if method != "POST":
            return self._json(405, {"error": "use POST"})
        try:
            from tools import write_approval as wa  # módulo do Hermes
            if path == "/ergon/v1/learn-prompt":
                from agent.learn_prompt import build_learn_prompt  # o /learn nativo
                return self._json(200, {"prompt": build_learn_prompt(str(body.get("request") or "")[:900_000])})
            if path == "/ergon/v1/skills/pending":
                ids = {str(i)[:40] for i in (body.get("ids") or [])} if isinstance(body.get("ids"), list) else set()
                return self._json(200, {"records": skills_pending(ids, str(body.get("name") or ""))})
            if path == "/ergon/v1/skills/apply":
                ids = [str(i) for i in body.get("ids") or []] if isinstance(body.get("ids"), list) else []
                return self._json(200, {"files": skills_apply(ids, str(body.get("name") or ""))})
            if path == "/ergon/v1/skills/discard":
                for i in (body.get("ids") or [])[:200] if isinstance(body.get("ids"), list) else []:
                    wa.discard_pending(wa.SKILLS, str(i)[:40])
                return self._json(200, {"ok": True})
            name = str(body.get("name") or "")
            if not _SKILL_NAME.fullmatch(name):
                return self._json(400, {"error": "nome de competência inválido"})
            if path == "/ergon/v1/skills/files":
                return self._json(200, {"files": _read_skill(name)})
            if path == "/ergon/v1/skills/restore":
                files = body.get("files") if isinstance(body.get("files"), dict) else {}
                return self._json(200, {"files": skills_restore(name, {str(k): str(v) for k, v in files.items()})})
            if path == "/ergon/v1/skills/remove":
                if _skill_dir(name):
                    r = _apply_write({"action": "delete", "name": name})
                    if not r.get("success"):
                        return self._json(409, {"error": str(r.get("error") or r.get("message") or "falhou")[:300]})
                return self._json(200, {"ok": True})
        except (ValueError, RuntimeError) as exc:
            return self._json(409, {"error": str(exc)[:300]})
        except Exception as exc:  # noqa: BLE001
            return self._json(500, {"error": f"falha no treinamento ({type(exc).__name__})"})
        return self._json(404, {"error": "rota não liberada pela ponte do Ergon"})

    def _media_get(self, raw: str) -> None:
        hit = _media_file(raw)
        if not hit:
            return self._json(404, {"error": "imagem não encontrada"})
        with open(hit[0], "rb") as f:
            data = f.read(_MEDIA_MAX + 1)
        self.send_response(200)
        self.send_header("Content-Type", hit[1])
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _api_toolsets_get(self) -> None:
        try:
            from hermes_cli.config import load_config  # módulo do Hermes
            from hermes_cli.tools_config import _get_platform_tools
            enabled = sorted(_get_platform_tools(load_config(), "api_server", include_default_mcp_servers=False))
        except Exception as exc:  # noqa: BLE001
            return self._json(503, {"error": f"não consegui ler a configuração ({type(exc).__name__})"})
        return self._json(200, {"enabled": enabled, "safe": sorted(_SAFE_TOOLSETS), "guarded": sorted(_GUARDED_TOOLSETS)})

    def _api_toolsets_put(self, body: dict[str, Any]) -> None:
        raw = body.get("enabled")
        if not isinstance(raw, list):
            return self._json(400, {"error": "envie enabled: [...]"})
        wanted = sorted({str(x) for x in raw} & (_SAFE_TOOLSETS | _GUARDED_TOOLSETS) | {"todo"})
        status, data = _dash_call("PUT", "/api/config", "", {"config": {"platform_toolsets": {"api_server": wanted}}})
        if status != 200:
            return self._send(status, data)
        return self._json(200, {"ok": True, "enabled": wanted})

    def do_GET(self) -> None:  # noqa: N802
        self._handle("GET")

    def do_POST(self) -> None:  # noqa: N802
        self._handle("POST")

    def do_PUT(self) -> None:  # noqa: N802
        self._handle("PUT")

    def do_DELETE(self) -> None:  # noqa: N802
        self._handle("DELETE")


def _start_control() -> None:
    """Sobe a ponte de controle uma vez por contêiner (outros processos encontram a porta ocupada)."""
    global _control_started
    port = int(os.environ.get("ERGON_CONTROL_PORT", "0") or 0)
    if _control_started or port <= 0 or len(_token()) < 24:
        return
    try:
        srv = ThreadingHTTPServer(("0.0.0.0", port), _ControlHandler)
    except OSError:
        return  # já aberta por outro processo do Hermes
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, name="ergon-control", daemon=True).start()
    _control_started = True
    logger.info("ergon_bridge: ponte de controle na porta %s (rede interna)", port)


def register(ctx) -> None:
    ctx.register_hook("post_gateway_admission", on_admission)
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("post_tool_call", on_post_tool_call)
    try:
        _start_control()
    except Exception:  # noqa: BLE001 - a ponte de controle nunca derruba o Hermes
        logger.warning("ergon_bridge: ponte de controle não iniciou", exc_info=False)
