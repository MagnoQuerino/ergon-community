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
   plataforma da API, passos por pedido, resumo das conversas longas, medição do custo, as chaves que a pessoa guardou
   para a equipe por um cartão — só gravar, listar nomes e apagar —, o juiz da meta e o pedido de revisão). As outras
   variáveis de ambiente, arquivos, terminal, MCP e configuração bruta não passam.

4. Equipe nativa (rc.27): cada agente do Ergon é um PERFIL do Hermes por workspace (``profiles/<nome>``: SOUL.md, memória,
   competências, histórico e configuração próprios). A ponte de controle cria e atualiza o perfil
   (``/ergon/v1/perfis/<nome>``), o Ergon manda cada execução para ``/p/<nome>/v1/runs``. O gerente de plugins do Hermes
   é um por perfil: o perfil recebe um atalho para este plugin (sem ele, a trava de ferramentas não existiria ali). A
   memória longa fica com a escrita em espera (``memory.write_approval``) até a pessoa aprovar no Ergon; a busca em
   conversas antigas vale só no próprio perfil; os ajudantes temporários (``delegate_task``) herdam a política do agente
   que os chamou (``subagent_start``) e o Ergon é avisado quando terminam (``subagent_stop``).

5. Rotinas (rc.27): cada rotina com horário é um job do agendador do Hermes no perfil do agente (sem agente: o script
   do job só avisa o Ergon, que faz a coleta, pede o trabalho por /p/<perfil>/v1/runs e confere a entrega). Aprovações
   nativas: o que pede o sim da pessoa no Ergon para o turno no portão de aprovação do Hermes até ela decidir no cartão.

6. Conversar pelo Telegram e pelo Discord (``pre_gateway_dispatch``, antes da autorização do gateway): a mensagem de quem
   está pareado vai ao Ergon e o Hermes não roda turno (skip); quem não está recebe o código do pareamento nativo. A
   saída (respostas, cartões com botões, avisos) é buscada no Ergon e mandada pelo adaptador vivo do gateway.

Custo (``pre_api_request`` / ``post_api_request``, observadores): o tamanho de cada parte de cada chamada ao modelo
(instruções, ferramentas, memória, conversa) e o total que o provedor informou, sem guardar conteúdo.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import hmac
import json
import logging
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

logger = logging.getLogger("ergon_bridge")

# Contrato com o servidor do Ergon (/ergon/v1/health): a mesma versão do plugin.yaml e do rótulo ergon.plugin.version da
# imagem (hermes/Dockerfile); um teste confere as três. Capacidade nova = acrescentar aqui (o servidor confere a lista
# para saber se o motor precisa ser renovado).
PLUGIN_VERSION = "0.6.0"
# medicao: do que é feita cada chamada ao modelo (/ergon/v1/medicao); passos: o máximo de passos por pedido que a pessoa
# escolhe no Ergon (/ergon/v1/passos); aprovar_depois_de_ler: com a proteção ligada, pede a aprovação em vez de barrar;
# compactacao: resumir as conversas longas mais cedo, ligado ou não, por escolha da pessoa (/ergon/v1/compactacao)
# compactacao: resumir as conversas longas mais cedo, ligado ou não, por escolha da pessoa (/ergon/v1/compactacao)
# perfis (rc.27): cada agente da equipe é um perfil do motor (/ergon/v1/perfis/<nome>); memoria: a memória longa do perfil,
# com a escrita em espera até a pessoa aprovar; ajudantes: os subagentes do motor, com aviso de começo e fim ao Ergon
# modelos_tarefa: o modelo de cada tarefa de apoio (GET /api/model/auxiliary, POST /api/model/set com scope auxiliary), o
# dos ajudantes temporários (/ergon/v1/delegacao) e quais modelos enxergam imagens (/ergon/v1/modelos/visao), do motor ou
# de um perfil (/p/<perfil>/...)
# ajustes: as escolhas da pessoa que são configuração do motor (modelos reserva, não treinar com os dados, busca
# privada, arrumar competências sem uso, idioma), por /ergon/v1/ajustes; cota: os limites e o saldo da conta de IA
# (/ergon/v1/cota); pausa: pausar e retomar o trabalho novo (/ergon/v1/pausa); nao_treinar: o pedido de não usar os dados
# para treino vai de fato em cada chamada pelo OpenRouter (a rota de execuções do motor não repassa a configuração)
# cartoes: perguntar de volta, pedido seguro de chave e senha de administrador (ferramentas do conjunto ergon_cartoes e
# /ergon/v1/chaves); comandos: o juiz da meta e o pedido de revisão do Hermes (/ergon/v1/meta/julgar, /ergon/v1/revisao/pedido)
# recursos: as capacidades da equipe: navegador, vídeo, busca no X, leitura de arquivos e voz como conjuntos que
# o Ergon liga; proteções do Terminal, conselho de modelos, loja de competências, conectores prontos, conquistas e voz
# pelas rotas /ergon/v1/recursos, /conselho, /loja, /conectores, /conquistas, /checkpoints e /voz
# canais: conversar com a equipe pelo Telegram e pelo Discord (/ergon/v1/canais, pre_gateway_dispatch)
# rotinas: cada rotina com horário é um job do agendador do motor no perfil do agente (/ergon/v1/rotinas/<id>), e o aviso
# do horário volta ao Ergon (/internal/bridge/v1/rotina/disparo); aprovacoes: o que pede o sim da pessoa no Ergon para o
# turno no portão de aprovação do motor (approval.request, respondido pelo Ergon em POST /v1/runs/{id}/approval)
CAPACIDADES = ("conexoes", "bloqueio_prefixo", "known_plugin_toolsets", "medicao", "passos", "aprovar_depois_de_ler", "compactacao",
               "perfis", "memoria", "ajudantes", "modelos_tarefa", "ajustes", "cota", "pausa", "nao_treinar", "cartoes", "comandos",
               "recursos", "canais", "rotinas", "aprovacoes")
_TS_CONEXOES = "ergon_conexoes"
# Os conjuntos de ferramentas que este plugin registra ficam em _ERGON_PLUGIN_TOOLSETS, mais abaixo (o mesmo de
# ERGON_PLUGIN_TOOLSETS em hermes/vault/ergon-vault.py)
# as marcas gravadas por hermes/vault/ergon-vault.py: a das migrações ({"versao": N}) e a das imagens antigas ("1")
_MIGRACOES_MARKER = ".ergon-migracoes"
_CONFIG_MARKER = ".ergon-config"

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
_ESCRITA_DE_ARQUIVO = frozenset({"write_file", "patch"})
_ESCREVEM_ARQUIVO_COM = frozenset({"terminal", "code_execution"})
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
    # Leitura de arquivos (conjunto "file"): gravar e alterar arquivos só para quem também tem Terminal ou Executar código
    # (que já gravam o que quiserem, com a senha da pessoa). Sem eles, o conjunto vale só para ler e procurar.
    if not _ESCREVEM_ARQUIVO_COM & {str(t) for t in toolsets}:
        out -= _ESCRITA_DE_ARQUIVO
    return frozenset(out - _DENY_TOOLS)


def _policy(session_id: str, task_id: str) -> dict[str, Any]:
    key = f"{session_id}|{task_id}"
    with _policy_lock:
        hit = _policy_cache.get(key)
        if hit and hit[0] > time.time():
            return hit[1]
    toolsets: list[str] = _BASE_TOOLSETS
    pol: dict[str, Any] = {"who": "", "holders": {}, "guarded": {}, "skills": frozenset(), "training": None, "denied": frozenset(), "mcp": None}
    try:
        data = _post_to(_url_for("/internal/bridge/v1/tool-policy"), {"session_id": session_id, "task_id": task_id}, timeout=3)
        if data.get("known") is True:
            raw = data.get("toolsets")
            toolsets = [str(x) for x in raw] if isinstance(raw, list) else []
            pol["who"] = str(data.get("agent") or "")[:60]
            bl = data.get("bloqueadas")
            if isinstance(bl, list):
                pol["denied"] = frozenset(str(x)[:60] for x in bl[:100])
            h = data.get("holders")
            if isinstance(h, dict):
                pol["holders"] = {str(k): [str(n)[:60] for n in v][:6] for k, v in h.items() if isinstance(v, list)}
            gd = data.get("guarded")
            if isinstance(gd, dict):
                pol["guarded"] = {str(k)[:40]: str(v)[:30] for k, v in gd.items()}
            sk = data.get("skills")
            if isinstance(sk, list):
                pol["skills"] = frozenset(_skill_base(x)[:80] for x in sk[:60])
            mc = data.get("conectores")
            if isinstance(mc, dict):
                esc = mc.get("escrita")
                pol["mcp"] = {"ligado": mc.get("ligado") is True, "escrita": [str(x)[:60] for x in esc[:100]] if isinstance(esc, list) else []}
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


def _negada(tool_name: str, denied: Any) -> bool:
    """Barrada pela lista do Ergon: o nome exato, ou um prefixo (entrada terminada em "_", como "browser_": vale para
    toda ferramenta do grupo, inclusive as que uma versão nova do motor acrescentar)."""
    return any(tool_name == d or (d.endswith("_") and len(d) > 1 and tool_name.startswith(d)) for d in denied)


_BLOQUEIO_PADRAO = ("Por segurança, a ferramenta '{t}' não funciona agora nesta conversa: ela já leu conteúdo privado das contas conectadas, "
                    "e a pessoa pediu para aprovar antes de abrir sites ou rodar programas. Continue sem ela (a busca na web segue valendo) "
                    "e diga à pessoa o que ficou faltando.")


_ALVO_MAX = 3500


def _alvo(args: Any) -> str:
    """O que a pessoa precisa ver no cartão, e o que a aprovação dela prende no Ergon (conexoes/regra.ts,
    chavesDeAprovacao): o endereço (todos, numa lista), a imagem ou o programa; nas outras ferramentas, o pedido inteiro.
    Longo demais: o começo e a conferência do texto inteiro, para um pedido diferente nunca valer pela mesma aprovação."""
    if not isinstance(args, dict):
        return ""
    texto = ""
    for k in ("urls", "url", "image_url", "command", "code", "expression"):
        v = args.get(k)
        if isinstance(v, list):
            v = "\n".join(str(x) for x in v)
        if isinstance(v, str) and v.strip():
            texto = v.strip()
            break
    if not texto and args:
        texto = json.dumps(args, ensure_ascii=False, sort_keys=True, default=str)
    if len(texto) > _ALVO_MAX:
        conf = hashlib.sha256(texto.encode("utf-8", "replace")).hexdigest()[:24]
        texto = f"{texto[:_ALVO_MAX - 120]}\n[… mais {len(texto) - (_ALVO_MAX - 120)} caracteres; conferência {conf}]"
    return texto


def _dispensa(tool_name: str, args: Any) -> bool:
    """Imagem que já está na conversa (data:) não vem de endereço nenhum: não pede aprovação (o mesmo de _le_endereco)."""
    return tool_name in _LEEM_ENDERECO_NOMES and not _le_endereco(tool_name, args)


def _pedir_aprovacao(tool_name: str, args: Any, session_id: str, task_id: str) -> str | None:
    """Pede ao Ergon o cartão de aprovação e devolve a mensagem da recusa ao agente. None = liberada: a pessoa já aprovou
    este alvo ali (a aprovação vale para o que o cartão mostrou, então a lista de nomes não muda e o Ergon confere
    chamada a chamada), ou a proteção acabou de ser desligada. Ergon fora: barra (fail-closed).

    Com o portão nativo (rc.27), o cartão novo segura o turno até a pessoa decidir (ou o prazo do motor acabar) e o Ergon é
    consultado de novo: aprovado, a ferramenta segue no mesmo turno; sem resposta, o cartão continua com ela."""
    pedido = {"session_id": session_id[:200], "task_id": task_id[:200], "ferramenta": tool_name[:60], "alvo": _alvo(args)}
    url = _url_for("/internal/bridge/v1/depois-de-ler")
    try:
        data = _post_to(url, pedido, timeout=5)
    except Exception:  # noqa: BLE001
        return _BLOQUEIO_PADRAO.format(t=tool_name)
    if data.get("liberada") is True:
        return None
    if _segurar_ate_decidir(tool_name, str(data.get("texto") or ""), str(data.get("cartao") or "")):
        try:
            data = _post_to(url, pedido, timeout=5)
        except Exception:  # noqa: BLE001
            return _BLOQUEIO_PADRAO.format(t=tool_name)
        if data.get("liberada") is True:
            return None
    texto = data.get("texto")
    return texto[:1200] if isinstance(texto, str) and texto.strip() else _BLOQUEIO_PADRAO.format(t=tool_name)


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
        if tool_name in _FILHOS_TOOLS:
            # a chave guardada (ou apagada) por cartão, também a deste mesmo trabalho, vale já neste comando do perfil; e o
            # mascaramento do Hermes (um por pasta de perfil: agent/redact.py, _vault_scope) passa a conhecer o valor aqui
            _chaves_no_terminal()
            _mascarar_guardadas()
        # ajudante temporário: vale a política de quem o chamou (a sessão dele é desconhecida do Ergon)
        session_id, task_id = _sessao_do_pedido(str(session_id or ""), str(task_id or ""))
        # a busca em conversas antigas vale só no próprio perfil (agente + workspace): o argumento "profile" abriria as
        # conversas de outro agente ou de outro workspace do mesmo motor
        if tool_name == "session_search" and isinstance(args, dict) and str(args.get("profile") or "").strip():
            return {"action": "block", "message": "A busca em conversas antigas vale só para as suas próprias conversas neste workspace. Chame de novo sem o argumento profile."}
        if _le_endereco(tool_name, args):
            _lembrar_web(str(session_id or ""), str(task_id or ""))
        pol = _policy(str(session_id or ""), str(task_id or ""))
        # cartões (perguntar, pedir chave, senha de administrador): de todo agente do Ergon; fora de um trabalho do Ergon, não
        if tool_name in _CARTOES_TOOLS:
            return None if pol.get("who") else {"action": "block", "message": "Esta ferramenta só funciona dentro de um trabalho no Ergon."}
        # proteção que a pessoa ligou no Ergon (desligada por padrão): depois de ler conteúdo privado das contas, abrir
        # endereços ou rodar programas pede a aprovação dela num cartão (ver conexoes/regra.ts no Ergon). Já aprovado
        # este alvo: segue para as outras travas. Imagem já na conversa (data:): não pede.
        if _negada(tool_name, pol.get("denied", ())) and not _dispensa(tool_name, args):
            aprovacao = _pedir_aprovacao(tool_name, args, str(session_id or ""), str(task_id or ""))
            if aprovacao is not None:
                return {"action": "block", "message": aprovacao}
        allowed, who, holders, guarded = pol["allowed"], pol["who"], pol["holders"], pol["guarded"]
        gate = _skills_gate(tool_name, args if isinstance(args, dict) else {}, pol)
        if gate is True:
            return None
        if isinstance(gate, dict):
            return gate
        if tool_name in allowed:
            return None
        # conector pronto (MCP): não tem conjunto fixo no Hermes (um por conector); vale a regra do Ergon
        if tool_name.startswith(_MCP_PREFIXO) and not pol.get("training"):
            return _mcp_gate(tool_name, pol)
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


# ---------------------------------------------------------------- conexões: as contas e os aplicativos conectados
# O plugin só repassa: credenciais, regra de confirmação e registro ficam no Ergon. O motor nunca vê token de conta.
_CONEXOES_TIMEOUT = float(os.environ.get("ERGON_CONEXOES_TIMEOUT", "90"))
_web_lida: dict[str, float] = {}
# As ferramentas que trazem o conteúdo de um endereço (a mesma lista de LEEM_ENDERECO em conexoes/regra.ts no Ergon):
# usar uma delas é ler conteúdo de fora. Imagem em data: não vem de endereço nenhum (já está na conversa).
_LEEM_ENDERECO_PREFIXOS = ("web_", "browser", "mcp__")
_LEEM_ENDERECO_NOMES = frozenset({"vision_analyze"})


def _le_endereco(tool_name: str, args: Any) -> bool:
    if tool_name.startswith(_LEEM_ENDERECO_PREFIXOS):
        return True
    if tool_name not in _LEEM_ENDERECO_NOMES:
        return False
    alvo = str(args.get("image_url") or "") if isinstance(args, dict) else ""
    return not alvo.strip().lower().startswith("data:")


def _lembrar_web(session_id: str, task_id: str) -> None:
    with _policy_lock:
        if len(_web_lida) > 2000:
            _web_lida.clear()
        _web_lida[f"{session_id}|{task_id}"] = time.time()


def _conexoes(payload: dict[str, Any], session_id: str, task_id: str) -> str:
    session_id, task_id = _sessao_do_pedido(session_id, task_id)
    key = f"{session_id}|{task_id}"
    base = {"session_id": session_id[:200], "task_id": task_id[:200]}
    try:
        data = _post_to(_url_for("/internal/bridge/v1/conexoes"), {**payload, **base, "leu_web": key in _web_lida}, timeout=_CONEXOES_TIMEOUT)
    except Exception:  # noqa: BLE001 - a resposta ao modelo diz o que houve; ele não pode fingir que fez
        # sem o nome da exceção: o modelo tende a repetir a frase à pessoa
        return json.dumps({"ok": False, "status": "falhou", "texto": "O sistema não respondeu. Não sei se a ação foi feita: diga isso à pessoa."}, ensure_ascii=False)
    if not isinstance(data, dict):
        data = {"ok": False, "status": "falhou", "texto": "Resposta inesperada do sistema: não sei se a ação foi feita."}
    # a ação espera a confirmação da pessoa num cartão: o turno fica no portão de aprovação do motor até ela decidir (rc.27).
    # O Ergon executa o que o cartão mostrou, no clique; aqui só se busca o resultado (nunca o que o modelo disser agora)
    cartao = str(data.pop("cartao", "") or "")
    resumo = str(data.pop("resumo", "") or "")
    if data.get("status") == "aguardando_confirmacao" and _segurar_ate_decidir("conexoes_executar", resumo or str(data.get("texto") or ""), cartao):
        try:
            depois = _post_to(_url_for("/internal/bridge/v1/conexoes"), {"op": "cartao", "cartao": cartao, **base}, timeout=_CONEXOES_TIMEOUT)
            if isinstance(depois, dict) and depois.get("status"):
                depois.pop("cartao", None)
                depois.pop("resumo", None)
                data = depois
        except Exception:  # noqa: BLE001 - fica o "espera a confirmação" de antes: a resposta segue depois
            pass
    # esta sessão pode ter acabado de ler conteúdo privado: a próxima ferramenta confere a política de novo
    with _policy_lock:
        _policy_cache.pop(key, None)
    return json.dumps(data, ensure_ascii=False)


def tool_conexoes_listar(args: dict[str, Any], task_id: str = "", session_id: str = "", **_: Any) -> str:
    return _conexoes({"op": "listar", "conexao": str((args or {}).get("conexao") or "")[:40]}, str(session_id or ""), str(task_id or ""))


def tool_conexoes_executar(args: dict[str, Any], task_id: str = "", session_id: str = "", **_: Any) -> str:
    a = args or {}
    params = a.get("parametros")
    return _conexoes({"op": "executar", "conexao": str(a.get("conexao") or "")[:40], "acao": str(a.get("acao") or "")[:80], "parametros": params if isinstance(params, dict) else {}}, str(session_id or ""), str(task_id or ""))


_CONEXOES_LISTAR = {
    "name": "conexoes_listar",
    "description": "Lista as ações disponíveis nas contas e aplicativos conectados no Ergon (Microsoft 365, Google, Asana, Trello, WhatsApp e outros), com os parâmetros de cada uma.",
    "parameters": {"type": "object", "properties": {"conexao": {"type": "string", "description": "uma conexão só, como asana ou microsoft; vazio = só a lista das ligadas (chame de novo com conexao para ver as ações e os parâmetros)"}}},
}
_CONEXOES_EXECUTAR = {
    "name": "conexoes_executar",
    "description": "Executa uma ação numa conta ou aplicativo conectado: buscar e ler e-mails de qualquer período, deixar rascunhos, enviar, consultar a agenda, ler arquivos, criar, concluir e mover tarefas, responder no Teams ou no WhatsApp. O sistema cuida do acesso e, quando for o caso, pede a confirmação da pessoa.",
    "parameters": {"type": "object", "required": ["conexao", "acao"], "properties": {
        "conexao": {"type": "string", "description": "por exemplo microsoft, google, asana, trello, whatsapp"},
        "acao": {"type": "string", "description": "por exemplo tarefa.criar, email.buscar, email.rascunho, teams.enviar"},
        "parametros": {"type": "object", "description": "os parâmetros da ação, como vêm em conexoes_listar"},
    }},
}


def on_post_tool_call(tool_name: str = "", args: Any = None, result: Any = None, task_id: str = "", session_id: str = "", **_: Any) -> None:
    """Treinar: conta ao Ergon o que aconteceu — cada escrita da competência que ficou em espera e cada link lido
    (quantos caracteres vieram). Fora do treinamento: cada vez que o agente carrega uma competência aprendida dele
    (a prova de uso que aparece no perfil). Nunca lança exceção (observador)."""
    if tool_name == "memory":
        return _avisar_memoria(result, str(session_id or ""), str(task_id or ""))
    if tool_name not in ("skill_manage", "web_extract", "skill_view"):
        return None
    try:
        session_id, task_id = _sessao_do_pedido(str(session_id or ""), str(task_id or ""))
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
    _fixar(name)
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
    _fixar(name)
    return _read_skill(name)


# ---------------------------------------------------------------- 4. equipe nativa: cada agente é um perfil do motor
# O Ergon decide o nome (estável, derivado de workspace + agente) e o que o perfil tem; aqui só se grava, dentro de
# profiles/<nome>. Nada de CLI: o gateway acha o perfil novo pela pasta, sem reiniciar (provado na v0.22.2, com
# gateway.multiplex_profiles ligado pela migração 4 do cofre).
_PERFIL_NOME = re.compile(r"erg-[0-9a-f]{20}")
_PERFIL_ESTADO = ".ergon-perfil.json"
_PERFIL_SUBPASTAS = ("memories", "sessions", "skills", "skins", "logs", "plans", "workspace", "cron", "home")
_ALMA_MAX = 60_000
# quantos ajudantes ao mesmo tempo: o padrão e o teto são os do Hermes (delegation.max_concurrent_children 10); a pessoa
# reduz no Ergon para economizar (cada ajudante é uma conversa a mais com o modelo)
AJUDANTES_PADRAO = 10
AJUDANTES_MIN, AJUDANTES_MAX = 1, 10
_AJUDANTE_RESUMO_MAX = 24_000   # o resultado de um ajudante que vai ao Ergon (caracteres): o teto do Hermes (delegation.max_summary_chars)
_COMPETENCIA_NOME = re.compile(r"[a-z0-9][a-z0-9_.-]{0,80}")
_perfis_lock = threading.Lock()
_pais: dict[str, str] = {}      # sessão do ajudante → sessão de quem chamou
_pais_lock = threading.Lock()


def _sessao_do_pedido(session_id: str, task_id: str) -> tuple[str, str]:
    """A sessão que o Ergon conhece: a de um ajudante temporário vira a do agente que o chamou."""
    with _pais_lock:
        pai = _pais.get(session_id)
    return (pai, pai) if pai else (session_id, task_id)


def on_subagent_start(parent_session_id: str = "", child_session_id: str = "", **_: Any) -> None:
    """Um ajudante temporário começou: ele trabalha com a política do agente que o chamou, e o Ergon fica sabendo que a
    execução tem um ajudante em andamento (em /v1/runs o resultado dele só entra na conversa no pedido seguinte)."""
    try:
        pai, filho = str(parent_session_id or "")[:200], str(child_session_id or "")[:200]
        if not pai or not filho:
            return None
        with _pais_lock:
            if len(_pais) > 4000:
                _pais.clear()
            _pais[filho] = _pais.get(pai, pai)   # ajudante de ajudante: a sessão do agente lá de cima
            pai = _pais[filho]
        _post_to(_url_for("/internal/bridge/v1/ajudante"), {"evento": "inicio", "session_id": pai, "filho": filho}, timeout=3)
    except Exception:  # noqa: BLE001 - observador
        logger.warning("ergon_bridge: começo do ajudante não avisado", exc_info=False)
    return None


def on_subagent_stop(parent_session_id: str = "", child_session_id: str = "", child_status: str = "", child_summary: Any = None, **_: Any) -> None:
    """O ajudante terminou: o Ergon recebe o resultado dele (em /v1/runs a execução de quem chamou já terminou, e o motor só
    mostraria o resultado no pedido seguinte da conversa, sem hora certa de gravar): é o Ergon que faz a continuação."""
    try:
        pai, filho = str(parent_session_id or "")[:200], str(child_session_id or "")[:200]
        with _pais_lock:
            pai = _pais.get(filho) or _pais.get(pai, pai)
        if pai and filho:
            _post_to(_url_for("/internal/bridge/v1/ajudante"), {"evento": "fim", "session_id": pai, "filho": filho, "estado": str(child_status or "")[:40], "resumo": str(child_summary or "")[:_AJUDANTE_RESUMO_MAX]}, timeout=5)
    except Exception:  # noqa: BLE001 - observador
        logger.warning("ergon_bridge: fim do ajudante não avisado", exc_info=False)
    return None


def _avisar_memoria(result: Any, session_id: str, task_id: str) -> None:
    """O agente quis anotar na memória longa e a escrita ficou em espera: o Ergon mostra à pessoa para aprovar."""
    try:
        data = json.loads(result) if isinstance(result, str) and result.strip().startswith("{") else result
        if not isinstance(data, dict) or not data.get("staged"):
            return None
        session_id, task_id = _sessao_do_pedido(session_id, task_id)
        _post_to(_url_for("/internal/bridge/v1/memoria-pendente"), {"session_id": session_id[:200], "task_id": task_id[:200], "pending_id": str(data.get("pending_id") or "")[:40]}, timeout=3)
    except Exception:  # noqa: BLE001 - observador
        logger.warning("ergon_bridge: anotação de memória em espera não avisada", exc_info=False)
    return None


def _raiz() -> Path:
    """A pasta do perfil padrão do motor (onde ficam profiles/, plugins/ e a configuração da equipe)."""
    try:
        from hermes_constants import get_default_hermes_root  # módulo do Hermes
        return Path(get_default_hermes_root())
    except Exception:  # noqa: BLE001
        return Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))


def _perfil_dir(nome: str) -> Path:
    if not _PERFIL_NOME.fullmatch(nome or ""):
        raise ValueError("nome de perfil inválido")
    return _raiz() / "profiles" / nome


class _no_perfil:
    """Dentro do perfil do agente: competências, memória e escritas em espera valem na pasta dele."""

    def __init__(self, nome: str):
        self.dir = _perfil_dir(nome)
        self.tok = None

    def __enter__(self) -> Path:
        if not self.dir.is_dir():
            raise ValueError("o perfil do agente ainda não existe no motor")
        from hermes_constants import set_hermes_home_override  # módulo do Hermes
        self.tok = set_hermes_home_override(str(self.dir))
        return self.dir

    def __exit__(self, *_a: Any) -> None:
        if self.tok is not None:
            from hermes_constants import reset_hermes_home_override
            reset_hermes_home_override(self.tok)


def _yaml():
    import hermes_yaml  # o leitor do próprio Hermes (YAML 1.1)
    return hermes_yaml


def _ler_yaml(path: Path) -> dict[str, Any]:
    if not path.is_file():
        return {}
    data = _yaml().safe_load(path.read_text(encoding="utf-8"))
    if data is None:
        return {}
    if not isinstance(data, dict):
        raise ValueError("config.yaml não é um mapa")
    return data


def _gravar_texto(path: Path, texto: str, modo: int = 0o644) -> None:
    tmp = path.with_name(path.name + ".ergon-tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(texto)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, modo)
    os.replace(tmp, path)


def _lista_cfg(v: Any) -> list[str]:
    """Uma lista do config.yaml (versões antigas do "config set" gravavam '["a", "b"]' como texto)."""
    if isinstance(v, list):
        return [str(x) for x in v]
    if isinstance(v, str) and v.strip().startswith("["):
        try:
            x = json.loads(v.replace("'", '"'))
            return [str(i) for i in x] if isinstance(x, list) else []
        except ValueError:
            return []
    return []


def _config_do_perfil(base: dict[str, Any], e: dict[str, Any]) -> dict[str, Any]:
    """A configuração do perfil: a da equipe (perfil padrão: modelo, provedores, passos, resumo, travas) com o que é do
    agente por cima — as ferramentas dele, a memória com aprovação, a busca nas conversas dele e os ajudantes."""
    import copy
    cfg = copy.deepcopy(base)
    for k in ("gateway", "multiplex_profiles", "profile_routes"):   # multiplexação e rotas são só do perfil padrão
        cfg.pop(k, None)
    pt = cfg.get("platform_toolsets") if isinstance(cfg.get("platform_toolsets"), dict) else {}
    ligados = set(_lista_cfg(pt.get("api_server")))
    quer = {str(x) for x in e.get("ferramentas") or []}
    aj = e.get("ajudantes") or {}
    extras = {t for t, on in (("memory", e.get("memoria")), ("session_search", e.get("busca")), ("delegation", aj.get("ligado"))) if on}
    # só o que a pessoa ligou para a equipe E o Ergon liberou a este agente (menos definições de ferramenta por chamada);
    # o pre_tool_call continua conferindo cada chamada. Linha de comando e agendador do perfil: a mesma lista (nunca a larga).
    # A lista de passos e os cartões (perguntar de volta, pedir chave/senha) ficam sempre, como na API da equipe
    # (_SEMPRE_TOOLSETS): sem eles o agente no perfil não teria como perguntar nem pedir uma chave com segurança.
    lista = sorted((ligados & quer & (_SAFE_TOOLSETS | _GUARDED_TOOLSETS)) | extras | _SEMPRE_TOOLSETS)
    cfg["platform_toolsets"] = {**pt, "api_server": list(lista), "cli": list(lista), "cron": list(lista)}   # listas próprias: sem âncoras no YAML
    kn = cfg.get("known_plugin_toolsets") if isinstance(cfg.get("known_plugin_toolsets"), dict) else {}
    conhecidos = sorted(set(_lista_cfg(kn.get("api_server"))) | set(_ERGON_PLUGIN_TOOLSETS))
    cfg["known_plugin_toolsets"] = {**kn, "api_server": list(conhecidos), "cli": list(conhecidos), "cron": list(conhecidos)}
    mem = dict(cfg.get("memory")) if isinstance(cfg.get("memory"), dict) else {}
    mem.update({"memory_enabled": bool(e.get("memoria")), "user_profile_enabled": bool(e.get("memoria")), "write_approval": True})
    cfg["memory"] = mem
    n = aj.get("max")
    n = n if isinstance(n, int) and not isinstance(n, bool) and AJUDANTES_MIN <= n <= AJUDANTES_MAX else AJUDANTES_PADRAO
    dele = dict(cfg.get("delegation")) if isinstance(cfg.get("delegation"), dict) else {}
    dele.update({"max_concurrent_children": n, "max_spawn_depth": 1})   # ajudante não chama ajudante (o padrão do Hermes)
    cfg["delegation"] = dele
    sk = dict(cfg.get("skills")) if isinstance(cfg.get("skills"), dict) else {}
    sk["write_approval"] = True
    cfg["skills"] = sk
    plug = dict(cfg.get("plugins")) if isinstance(cfg.get("plugins"), dict) else {}
    plug["enabled"] = sorted(set(_lista_cfg(plug.get("enabled"))) | {"ergon_bridge"})
    cfg["plugins"] = plug
    modelo = e.get("modelo") if isinstance(e.get("modelo"), dict) else None
    if modelo and modelo.get("model"):
        m = dict(cfg.get("model")) if isinstance(cfg.get("model"), dict) else {}
        if modelo.get("provider") and modelo["provider"] != m.get("provider"):
            m = {"provider": modelo["provider"]}   # outro provedor: endereço e chave do padrão não valem
        m["default"] = modelo["model"]
        cfg["model"] = m
    return cfg


def _env_do_perfil(raiz: Path, destino: Path) -> None:
    """O .env do perfil: as chaves de provedor da equipe e a chave da API (na rota /p/<perfil>/ o Hermes lê os segredos
    do .env do PERFIL), sem nada de canal de mensagens (um perfil com o token de um canal subiria o canal de novo)."""
    origem = raiz / ".env"
    originais = origem.read_text(encoding="utf-8", errors="replace").splitlines() if origem.is_file() else []
    linhas = list(originais)
    tmp = destino.with_name(".env.ergon-corte")
    try:
        _gravar_texto(tmp, "\n".join(linhas) + ("\n" if linhas else ""), 0o600)
        from hermes_cli.profile_channels import ChannelKeyIndex, strip_channel_env_file  # o mesmo corte do "profile create --clone"
        strip_channel_env_file(tmp, ChannelKeyIndex(raiz))
        linhas = tmp.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:  # noqa: BLE001 - sem o corte do Hermes: só o que é com certeza chave de provedor
        linhas = [ln for ln in originais if re.match(r"\s*(?:export\s+)?[A-Z][A-Z0-9_]*(_API_KEY|_BASE_URL|_API_BASE)\s*=", ln)]
    finally:
        try:
            tmp.unlink()
        except OSError:
            pass
    chave = os.environ.get("API_SERVER_KEY", "")
    if not chave:
        for ln in originais:
            if ln.startswith("API_SERVER_KEY="):
                chave = ln.split("=", 1)[1].strip()
    linhas = [ln for ln in linhas if not ln.startswith("API_SERVER_KEY=")] + ([f"API_SERVER_KEY={chave}"] if chave else [])
    texto = "\n".join(linhas) + "\n"
    if not destino.is_file() or destino.read_text(encoding="utf-8", errors="replace") != texto:
        _gravar_texto(destino, texto, 0o600)


def _assinatura(path: Path) -> str:
    try:
        st = path.stat()
        return f"{st.st_mtime_ns}:{st.st_size}"
    except OSError:
        return "-"


def _achar_competencia(base: Path, nome: str) -> Path | None:
    """A pasta de uma competência pelo nome, dentro de skills/ (na raiz, numa categoria ou numa subcategoria)."""
    skills = base / "skills"
    for padrao in (nome, f"*/{nome}", f"*/*/{nome}"):
        for p in sorted(skills.glob(padrao)):
            if (p / "SKILL.md").is_file() and not p.is_symlink():
                return p
    return None


def _competencias_do_perfil(raiz: Path, d: Path, nomes: list[str], antes: list[str]) -> list[str]:
    """As competências do agente moram no perfil dele: as que faltam vêm do perfil padrão (onde o Treinar gravava até a
    rc.26 e onde fica a biblioteca); as da biblioteca que deixaram de ser dele saem. As aprendidas no Treinar (ergon-…)
    nunca saem por aqui. Devolve as da biblioteca que este passo trouxe (para saber o que pode tirar depois)."""
    import shutil
    trazidas = [n for n in antes if _COMPETENCIA_NOME.fullmatch(n)]
    for nome in nomes:
        if not _COMPETENCIA_NOME.fullmatch(nome) or _achar_competencia(d, nome):
            continue
        src = _achar_competencia(raiz, nome)
        if not src:
            continue
        dst = d / "skills" / src.relative_to(raiz / "skills")
        dst.parent.mkdir(parents=True, exist_ok=True)
        tmp = dst.with_name(f".{dst.name}.ergon-tmp")
        shutil.rmtree(tmp, ignore_errors=True)
        shutil.copytree(src, tmp, symlinks=False, ignore=shutil.ignore_patterns(".*"))
        os.replace(tmp, dst)
        if not _SKILL_NAME.fullmatch(nome) and nome not in trazidas:
            trazidas.append(nome)
    for nome in [n for n in trazidas if n not in nomes]:
        velho = _achar_competencia(d, nome)
        if velho and not _SKILL_NAME.fullmatch(nome):
            shutil.rmtree(velho, ignore_errors=True)
        trazidas.remove(nome)
    return trazidas


def _limpar_perfil(body: dict[str, Any]) -> dict[str, Any]:
    """Só os campos esperados, nos formatos esperados (o corpo vem do servidor do Ergon, com o token da ponte)."""
    alma = str(body.get("alma") or "").strip()
    if not alma or len(alma) > _ALMA_MAX:
        raise ValueError("envie alma (as instruções do agente)")

    def lst(v: Any, rx: re.Pattern[str], n: int) -> list[str]:
        return [str(x) for x in (v if isinstance(v, list) else [])[:n] if rx.fullmatch(str(x))]

    aj = body.get("ajudantes") if isinstance(body.get("ajudantes"), dict) else {}
    mx = aj.get("max")
    modelo = body.get("modelo") if isinstance(body.get("modelo"), dict) else None
    if modelo:
        prov, mod = str(modelo.get("provider") or "").strip(), str(modelo.get("model") or "").strip()
        modelo = {"provider": prov, "model": mod} if re.fullmatch(r"[\w./:@+-]{1,160}", mod) and (not prov or re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,40}", prov)) else None
    return {
        "alma": alma, "ferramentas": sorted(set(lst(body.get("ferramentas"), re.compile(r"[a-z][a-z0-9_]{0,40}"), 40))),
        "memoria": body.get("memoria") is not False, "busca": body.get("busca") is not False,
        "ajudantes": {"ligado": aj.get("ligado") is not False, "max": mx if isinstance(mx, int) and not isinstance(mx, bool) and AJUDANTES_MIN <= mx <= AJUDANTES_MAX else AJUDANTES_PADRAO},
        "modelo": modelo, "competencias": sorted(set(lst(body.get("competencias"), _COMPETENCIA_NOME, 200))),
    }


def _carimbo_do_perfil(raiz: Path, pedido: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps([PLUGIN_VERSION, pedido, _assinatura(raiz / "config.yaml"), _assinatura(raiz / ".env")], sort_keys=True).encode()).hexdigest()


def _refazer_config_do_perfil(raiz: Path, d: Path, e: dict[str, Any]) -> None:
    """O config.yaml e o .env do perfil, refeitos da configuração da equipe com o que é do agente por cima."""
    cfg = _modelos_proprios_por_cima(_config_do_perfil(_ler_yaml(raiz / "config.yaml"), e), d)
    _gravar_texto(d / "config.yaml", _yaml().safe_dump(cfg, sort_keys=False, allow_unicode=True), 0o640)
    try:
        from hermes_cli.profile_channels import ChannelKeyIndex, strip_channel_config  # nada de canal no perfil
        strip_channel_config(d / "config.yaml", ChannelKeyIndex(raiz))
    except Exception:  # noqa: BLE001
        pass
    _env_do_perfil(raiz, d / ".env")


_perfis_vistos: dict[str, str] = {"sinal": ""}


def _perfis_acompanhar(forcar: bool = False) -> int:
    """A configuração da equipe (config.yaml) ou o .env do perfil padrão mudaram: cada perfil é refeito a partir deles.

    No gateway com vários perfis, cada perfil lê os segredos SÓ do .env dele (agent/secret_scope.py,
    build_profile_secret_scope) e a configuração SÓ do config.yaml dele. Sem isto, uma chave guardada por um cartão (que vai
    ao .env do perfil padrão) não chegava ao Terminal do agente, uma chave apagada continuava valendo no perfil, e a troca do
    modelo padrão, dos modelos reserva, das ferramentas ligadas ou de um conector só chegava ao perfil quando o Ergon
    mandasse o perfil de novo (até 6 horas depois). Devolve quantos perfis foram refeitos."""
    raiz = _raiz()
    sinal = f"{_assinatura(raiz / 'config.yaml')}|{_assinatura(raiz / '.env')}"
    if not forcar and sinal == _perfis_vistos["sinal"]:
        return 0
    n = 0
    for nome in perfis_listar():
        try:
            d = _perfil_dir(nome)
            with _perfis_lock:
                try:
                    estado = json.loads((d / _PERFIL_ESTADO).read_text(encoding="utf-8"))
                except (OSError, ValueError):
                    continue
                pedido = estado.get("pedido") if isinstance(estado, dict) else None
                if not isinstance(pedido, dict):
                    continue  # perfil gravado antes deste acompanhamento: o próximo garantir do Ergon grava o pedido
                carimbo = _carimbo_do_perfil(raiz, pedido)
                if estado.get("carimbo") == carimbo:
                    continue
                _refazer_config_do_perfil(raiz, d, pedido)
                _gravar_texto(d / _PERFIL_ESTADO, json.dumps({**estado, "carimbo": carimbo}, ensure_ascii=False))
                n += 1
        except Exception:  # noqa: BLE001 - um perfil com problema não impede os outros
            logger.warning("ergon_bridge: perfil não acompanhou a configuração da equipe", exc_info=False)
    _perfis_vistos["sinal"] = sinal
    return n


def _perfis_laco() -> None:
    while True:
        try:
            _perfis_acompanhar()
        except Exception:  # noqa: BLE001 - nunca derruba o motor
            pass
        time.sleep(float(os.environ.get("ERGON_PERFIS_PASSO_S", "5")))


def perfil_garantir(nome: str, body: dict[str, Any]) -> dict[str, Any]:
    """Cria o perfil do agente se não existe e deixa-o como o Ergon pede. Idempotente e retomável: cada parte só é
    gravada quando mudou (o SOUL, a configuração, o .env, o atalho do plugin, as competências), e uma queda no meio é
    completada na próxima chamada. Nada aqui apaga memória, histórico ou competência aprendida."""
    import shutil
    d = _perfil_dir(nome)
    e = _limpar_perfil(body)
    raiz = _raiz()
    with _perfis_lock:
        criado = not d.is_dir()
        if criado:
            # montado numa pasta escondida e publicado com uma troca de nome: o gateway relê profiles/ a cada pedido e só
            # enxerga nomes válidos (sem ponto na frente), então nunca atende um perfil pela metade
            tmp = d.with_name(f".{nome}.ergon-novo")
            shutil.rmtree(tmp, ignore_errors=True)
            tmp.mkdir(parents=True)
            for sub in _PERFIL_SUBPASTAS:
                (tmp / sub).mkdir()
            # sem as competências de fábrica: o agente só tem as dele (e o índice delas nas instruções fica curto)
            _gravar_texto(tmp / ".no-bundled-skills", "Perfil de um agente do Ergon: só as competências dele.\n")
            _gravar_texto(tmp / "SOUL.md", e["alma"] + "\n")
            os.replace(tmp, d)
        for sub in _PERFIL_SUBPASTAS:
            (d / sub).mkdir(exist_ok=True)
        mudou: list[str] = ["criado"] if criado else []
        alma = d / "SOUL.md"
        if not alma.is_file() or alma.read_text(encoding="utf-8", errors="replace") != e["alma"] + "\n":
            _gravar_texto(alma, e["alma"] + "\n")
            mudou.append("alma")
        # o plugin dentro do perfil: um atalho para a cópia da equipe (o cofre a renova a cada abertura; o atalho acompanha)
        atalho = d / "plugins" / "ergon_bridge"
        alvo = os.path.join("..", "..", "..", "plugins", "ergon_bridge")
        if not (atalho.is_symlink() and os.readlink(atalho) == alvo):
            atalho.parent.mkdir(exist_ok=True)
            if atalho.is_symlink() or atalho.is_file():
                atalho.unlink()
            elif atalho.is_dir():
                shutil.rmtree(atalho)
            os.symlink(alvo, atalho)
            mudou.append("plugin")
        try:
            estado = json.loads((d / _PERFIL_ESTADO).read_text(encoding="utf-8"))
            estado = estado if isinstance(estado, dict) else {}
        except (OSError, ValueError):
            estado = {}
        pedido = {k: v for k, v in e.items() if k not in ("alma", "competencias")}
        carimbo = _carimbo_do_perfil(raiz, pedido)
        if estado.get("carimbo") != carimbo or not (d / "config.yaml").is_file() or not (d / ".env").is_file():
            _refazer_config_do_perfil(raiz, d, pedido)
            mudou.append("config")
        antes = [str(x) for x in estado.get("biblioteca") or []] if isinstance(estado.get("biblioteca"), list) else []
        trazidas = _competencias_do_perfil(raiz, d, e["competencias"], antes)
        # o pedido fica guardado: quando a configuração da equipe (config.yaml) ou o .env do perfil padrão mudam, o perfil é
        # refeito por aqui mesmo (_perfis_acompanhar), sem esperar o Ergon mandar de novo
        novo = {"carimbo": carimbo, "biblioteca": trazidas, "plugin": PLUGIN_VERSION, "pedido": pedido}
        if novo != estado:
            _gravar_texto(d / _PERFIL_ESTADO, json.dumps(novo, ensure_ascii=False))
    return {"ok": True, "perfil": nome, "criado": criado, "mudou": mudou}


# Os modelos por tarefa escolhidos PARA UM AGENTE (janela do agente › Modelos por tarefa: /p/<perfil>/api/model/set com scope
# auxiliary e /p/<perfil>/ergon/v1/delegacao) são gravados pelo painel do Hermes no config.yaml do perfil. Esse arquivo é
# refeito a partir da configuração da equipe sempre que ela muda (perfil_garantir): sem esta lembrança, a escolha do agente
# sumiria na próxima mudança da equipe. A ponte guarda aqui o que foi escolhido para o perfil e reaplica por cima.
_PERFIL_MODELOS = ".ergon-perfil-modelos.json"


def _ler_modelos_proprios(d: Path) -> dict[str, Any]:
    try:
        x = json.loads((d / _PERFIL_MODELOS).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    if not isinstance(x, dict):
        return {}
    aux = x.get("auxiliary") if isinstance(x.get("auxiliary"), dict) else {}
    aux = {t: v for t, v in aux.items() if re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,63}", str(t)) and isinstance(v, dict)
           and re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,40}", str(v.get("provider") or "")) and re.fullmatch(r"[\w./:@+-]{1,160}", str(v.get("model") or ""))}
    dele = x.get("delegation") if isinstance(x.get("delegation"), dict) else None
    if dele and not (re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,40}", str(dele.get("provider") or "")) and re.fullmatch(r"[\w./:@+-]{1,160}", str(dele.get("model") or ""))):
        dele = None
    return {"auxiliary": aux, **({"delegation": {"provider": dele["provider"], "model": dele["model"]}} if dele else {})}


def _lembrar_modelo_do_perfil(perfil: str, tipo: str, body: dict[str, Any]) -> None:
    """Depois que o painel gravou: guarda a escolha do agente (tarefa de apoio ou ajudantes). "Usar o principal" tira."""
    try:
        d = _perfil_dir(perfil)
        if not d.is_dir():
            return None
        with _perfis_lock:
            atual = _ler_modelos_proprios(d)
            aux = dict(atual.get("auxiliary") or {})
            if tipo == "auxiliary":
                task, prov, mod = str(body.get("task") or ""), str(body.get("provider") or ""), str(body.get("model") or "")
                if task == "__reset__":
                    aux = {}
                elif prov == "auto" or not mod:
                    aux.pop(task, None)
                else:
                    aux[task] = {"provider": prov, "model": mod}
                atual["auxiliary"] = aux
            elif tipo == "delegation":
                if body.get("provider") and body.get("model"):
                    atual["delegation"] = {"provider": str(body["provider"]), "model": str(body["model"])}
                else:
                    atual.pop("delegation", None)
            _gravar_texto(d / _PERFIL_MODELOS, json.dumps(atual, ensure_ascii=False, sort_keys=True))
    except Exception:  # noqa: BLE001 - a escolha já foi gravada pelo painel; só a lembrança falhou
        logger.warning("ergon_bridge: escolha de modelo do perfil não lembrada", exc_info=False)
    return None


def _modelos_proprios_por_cima(cfg: dict[str, Any], d: Path) -> dict[str, Any]:
    """A configuração refeita do perfil com os modelos por tarefa que são do agente (os outros seguem os da equipe)."""
    proprios = _ler_modelos_proprios(d)
    if proprios.get("auxiliary"):
        aux = dict(cfg.get("auxiliary")) if isinstance(cfg.get("auxiliary"), dict) else {}
        for task, v in proprios["auxiliary"].items():
            t = dict(aux.get(task)) if isinstance(aux.get(task), dict) else {}
            t.update({"provider": v["provider"], "model": v["model"]})
            aux[task] = t
        cfg["auxiliary"] = aux
    if proprios.get("delegation"):
        dele = dict(cfg.get("delegation")) if isinstance(cfg.get("delegation"), dict) else {}
        dele.update(proprios["delegation"])
        cfg["delegation"] = dele
    return cfg


def perfis_listar() -> list[str]:
    p = _raiz() / "profiles"
    return sorted(x.name for x in p.iterdir() if x.is_dir() and _PERFIL_NOME.fullmatch(x.name)) if p.is_dir() else []


def _ler_curto(path: Path, limite: int = 20_000) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")[:limite]
    except OSError:
        return ""


def perfil_memoria(nome: str) -> dict[str, Any]:
    """A memória longa do agente (o que ele sabe da pessoa e as notas dele) e as anotações que esperam aprovação."""
    with _no_perfil(nome) as d:
        from tools import write_approval as wa  # módulo do Hermes
        pend = []
        for r in wa.list_pending(wa.MEMORY)[:100]:
            p = r.get("payload") if isinstance(r.get("payload"), dict) else {}
            ops = p.get("operations") if isinstance(p.get("operations"), list) else [p]
            pend.append({"id": str(r.get("id") or "")[:40], "criado": r.get("created_at"), "alvo": "pessoa" if p.get("target") == "user" else "notas",
                         "itens": [{"acao": str(o.get("action") or "")[:20], "texto": str(o.get("content") or o.get("new_text") or "")[:4000], "antes": str(o.get("old_text") or "")[:4000]}
                                   for o in ops[:20] if isinstance(o, dict)]})
        return {"notas": _ler_curto(d / "memories" / "MEMORY.md"), "pessoa": _ler_curto(d / "memories" / "USER.md"), "pendentes": pend}


def perfil_memoria_decidir(nome: str, pid: str, aprovar: bool) -> dict[str, Any]:
    with _no_perfil(nome):
        from tools import write_approval as wa
        rec = wa.get_pending(wa.MEMORY, pid)
        if not rec:
            raise ValueError("essa anotação não está mais em espera")
        if aprovar:
            from tools.memory_tool import MemoryStore, apply_memory_pending  # o mesmo caminho do "/memory approve"
            store = MemoryStore()
            store.load_from_disk()
            r = apply_memory_pending(rec.get("payload") or {}, store)
            if not (isinstance(r, dict) and r.get("success")):
                raise RuntimeError(str((r or {}).get("error") or "a memória não aceitou a anotação")[:300])
        wa.discard_pending(wa.MEMORY, pid)
    return {"ok": True, "aprovada": aprovar}


def skills_remove(name: str) -> dict[str, Any]:
    """Remove a competência a pedido da pessoa (Treinar, no Ergon). A competência treinada fica fixada e o Hermes não apaga
    competência fixada: solta a fixação antes; se não apagar, fixa de novo."""
    with contextlib.suppress(Exception):
        from tools import skill_usage  # módulo do Hermes
        skill_usage.set_pinned(name, False)
    r = _apply_write({"action": "delete", "name": name})
    if not r.get("success"):
        _fixar(name)
    return r


def _fixar(name: str) -> bool:
    """Competência treinada pela pessoa fica fixada no motor ("pinned"): a arrumação automática das competências sem uso
    (Curator do Hermes) pula as fixadas — nunca marca como parada nem arquiva. Sem efeito se já está fixada. Nunca lança
    exceção (o treinamento já foi aplicado; a arrumação automática fica desligada por padrão)."""
    try:
        from tools import skill_usage  # módulo do Hermes
        if (skill_usage.get_record(name) or {}).get("pinned") is True:
            return True
        return bool(skill_usage.set_pinned(name, True))
    except Exception:  # noqa: BLE001
        logger.warning("ergon_bridge: não consegui fixar a competência treinada", exc_info=False)
        return False


def _nomes_treinados(base: Path) -> list[str]:
    try:
        return sorted({d.parent.name for d in base.rglob("SKILL.md") if _SKILL_NAME.fullmatch(d.parent.name) and ".archive" not in d.parts})[:500]
    except Exception:  # noqa: BLE001
        return []


def fixar_treinadas() -> int:
    """Fixa todas as competências do Ergon que estão no motor (as de antes desta versão também), no perfil padrão e em cada
    perfil de agente (rc.27: a competência treinada mora em profiles/<perfil>/skills, e o registro de uso é do perfil).
    Devolve quantas ficaram fixadas. Chamado antes de ligar a arrumação automática e a cada leitura dos ajustes."""
    try:
        from hermes_constants import get_hermes_home  # módulo do Hermes
        n = sum(1 for nome in _nomes_treinados(Path(get_hermes_home()) / "skills") if _fixar(nome))
    except Exception:  # noqa: BLE001
        return 0
    for perfil in perfis_listar():
        try:
            with _no_perfil(perfil) as d:
                n += sum(1 for nome in _nomes_treinados(d / "skills") if _fixar(nome))
        except Exception:  # noqa: BLE001 - um perfil com problema não impede os outros
            continue
    return n


# ---------------------------------------------------------------- custo: do que é feita cada chamada ao modelo
# Medido no pedido que vai de verdade ao provedor (pre_api_request: o prompt de sistema e as mensagens, sem corte) e no
# total que o provedor informa (post_api_request: tokens de entrada, os lidos do cache e os de saída). Só TAMANHOS, nunca
# conteúdo, por sessão, num arquivo dentro do cofre (HERMES_HOME); o Ergon lê pela ponte de controle quando a execução
# termina (/ergon/v1/medicao). Os dois ganchos são observadores: nunca lançam exceção e não mudam nada no pedido.
# Os ganchos rodam numa thread de trabalho do Hermes (plugins_dispatch, com limite de tempo); arquivo, e não memória,
# porque a ponte de controle pode estar no outro processo do motor (painel ou gateway: quem subiu primeiro).
_MEDICAO_MAX = 200          # chamadas guardadas por sessão (as mais recentes)
_MEDICAO_DIAS = 3           # sessões paradas há mais que isso saem
_MEDICAO_PENDENTE_S = 900   # pedido sem resposta (tentativa que falhou) sai da memória depois disso
_IMAGEM_CHARS = 3000        # imagem anexada: conta como ~750 tokens (o tamanho do base64 não é o custo)
_FERRAMENTAS_TTL = 600
# O texto do prompt de sistema do Hermes v0.22.2 (conferido em tools/memory_tool_store.py, agent/prompt_builder.py e
# agent/system_prompt.py; o teste test_ergon_bridge_custo.py prende com o motor de verdade): os blocos da memória
# começam com a linha de "═" e o cabeçalho; a lista de competências vai de "## Skills" até a frase depois de
# </available_skills>; depois da memória vêm a linha do perfil, a data e o ambiente.
_SEP_MEMORIA = "═" * 46
_CABECALHOS_MEMORIA = ("MEMORY (your personal notes)", "USER PROFILE (who the user is)")
_FIM_MEMORIA = ("\n\nActive Hermes profile:", "\n\nConversation started:", "\n\n# Hermes runtime environment")
_pendentes: dict[str, dict[str, Any]] = {}
_ferramentas_cache: dict[tuple[str, ...], tuple[float, int, int]] = {}
_medicao_lock = threading.Lock()
_ultima_limpeza = [0.0]
# Turno: a marca de um pedido do motor (o turn_id do Hermes, um por run_conversation, igual em todas as chamadas dele), em
# resumo, para o Ergon separar as chamadas de cada execução sem depender do relógio. Quando o motor resume uma conversa
# longa no meio do pedido, ele troca de sessão (agent/conversation_compression.py): as chamadas do mesmo pedido passam a
# ser gravadas também na sessão nova, e a nova recebe as anteriores dele, para a execução ser lida inteira por qualquer
# uma das duas.
_TURNO_TTL_S = 6 * 3600
_TURNOS_MAX = 2000
_sessoes_do_turno: dict[str, tuple[float, list[str]]] = {}


def _texto(v: Any) -> str:
    """O texto de um prompt de sistema ou de uma parte de mensagem (texto puro, blocos da Anthropic, partes)."""
    if isinstance(v, str):
        return v
    if isinstance(v, list):
        return "\n\n".join(t for t in (_texto(x) for x in v) if t)
    if isinstance(v, dict):
        return _texto(v.get("text") if "text" in v else v.get("content"))
    return "" if v is None else str(v)


def _trecho_memoria(sistema: str) -> int:
    """Caracteres dos blocos de memória (notas e perfil da pessoa) dentro do prompt de sistema."""
    total = 0
    for cab in _CABECALHOS_MEMORIA:
        i = sistema.find(f"{_SEP_MEMORIA}\n{cab}")
        if i < 0:
            continue
        fins = [j for j in (sistema.find(m, i + 1) for m in (*_FIM_MEMORIA, f"\n\n{_SEP_MEMORIA}\n")) if j > i]
        total += (min(fins) if fins else len(sistema)) - i
    return total


def _trecho_competencias(sistema: str) -> int:
    """Caracteres da lista de competências (skills) que o motor põe no prompt de sistema."""
    i = sistema.find("## Skills\n")
    if i < 0:
        return 0
    tag = "</available_skills>"
    j = sistema.find(tag, i)
    if j < 0:
        return 0
    k = sistema.find("\n\n", j + len(tag) + 2)
    return (k if k > 0 else len(sistema)) - i


def _inteiro(v: Any) -> int:
    return max(0, int(v)) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0


def _e_imagem(p: Any) -> bool:
    return isinstance(p, dict) and str(p.get("type") or "") in ("image_url", "input_image", "image")


def _tamanho_conversa(mensagens: Any) -> tuple[int, int]:
    """(caracteres, imagens) das mensagens fora o prompt de sistema: a conversa, o pedido, o que as ferramentas devolveram."""
    chars = imgs = 0
    for m in mensagens if isinstance(mensagens, list) else []:
        if not isinstance(m, dict) or m.get("role") in ("system", "developer"):
            continue
        c = m.get("content")
        if isinstance(c, list):
            imgs += sum(1 for p in c if _e_imagem(p))
            m = {**m, "content": [p for p in c if not _e_imagem(p)]}
        try:
            chars += len(json.dumps(m, ensure_ascii=False, separators=(",", ":"), default=str))
        except (TypeError, ValueError):
            chars += len(str(m))
    return chars, imgs


def _tamanho_ferramentas(platform: str, tool_count: int) -> tuple[int, bool]:
    """(caracteres das definições de ferramentas, exato?). As mesmas definições que o motor monta para a plataforma
    (model_tools.get_tool_definitions + o arranjo da busca de ferramentas), guardadas por 10 min. Exato quando o número
    bate com o que foi ao modelo; senão, proporcional ao número de ferramentas."""
    from hermes_cli.config import load_config  # módulo do Hermes
    from hermes_cli.tools_config import _get_platform_tools
    import model_tools
    sets = tuple(sorted(_get_platform_tools(load_config(), platform or "api_server", include_default_mcp_servers=False)))
    hit = _ferramentas_cache.get(sets)
    if hit is None or time.time() - hit[0] > _FERRAMENTAS_TTL:
        defs = model_tools.get_tool_definitions(enabled_toolsets=list(sets), quiet_mode=True)
        try:
            from tools.tool_search import assemble_tool_defs
            defs = assemble_tool_defs(defs).tool_defs
        except Exception:  # noqa: BLE001 - sem a busca de ferramentas: as definições como vieram
            pass
        hit = (time.time(), len(defs), sum(len(json.dumps(d, ensure_ascii=False, separators=(",", ":"), default=str)) for d in defs))
        _ferramentas_cache[sets] = hit
    _, n, chars = hit
    if not tool_count or n == tool_count:
        return chars, bool(tool_count)
    return round(chars * tool_count / max(n, 1)), False


# O resumo da conversa (compactação): o Hermes troca a parte antiga da conversa por uma mensagem de resumo que começa com
# um prefixo fixo (agent/context_compressor.py: SUMMARY_PREFIX "[CONTEXT COMPACTION — REFERENCE ONLY]…", o antigo
# LEGACY_SUMMARY_PREFIX "[CONTEXT SUMMARY]:"; pode vir junto de outra mensagem, depois de um separador). Medimos só o
# tamanho dele: quando muda de uma chamada para a seguinte, a conversa acabou de ser resumida (o Ergon mostra isso).
_PREFIXOS_RESUMO = ("[CONTEXT COMPACTION", "[CONTEXT SUMMARY]:")
_e_resumo_hermes: list[Any] = []


def _e_resumo(m: Any) -> bool:
    """A mensagem é o resumo da conversa? Pelo próprio Hermes (is_compaction_summary_message); sem ele, pelo prefixo."""
    if not _e_resumo_hermes:
        try:
            from agent.context_compressor import is_compaction_summary_message  # módulo do Hermes
            _e_resumo_hermes.append(is_compaction_summary_message)
        except Exception:  # noqa: BLE001 - fora do motor (testes só com a biblioteca padrão)
            _e_resumo_hermes.append(None)
    fn = _e_resumo_hermes[0]
    if fn is not None:
        try:
            return bool(fn(m))
        except Exception:  # noqa: BLE001
            pass
    if not isinstance(m, dict):
        return False
    if m.get("_compressed_summary"):
        return True
    t = _texto(m.get("content"))
    return any(p in t for p in _PREFIXOS_RESUMO)


def _tamanho_resumo(mensagens: Any) -> int:
    """Caracteres do resumo da conversa nas mensagens que vão ao modelo (0 = a conversa não foi resumida)."""
    total = 0
    for m in mensagens if isinstance(mensagens, list) else []:
        if isinstance(m, dict) and m.get("role") not in ("system", "developer") and _e_resumo(m):
            total += len(_texto(m.get("content")))
    return total


def _marca_turno(turn_id: Any) -> str:
    """A marca do pedido: um resumo do turn_id (que traz a sessão), nunca o próprio id."""
    return hashlib.sha256(str(turn_id).encode("utf-8")).hexdigest()[:16] if turn_id else ""


def on_pre_api_request(session_id: str = "", api_request_id: str = "", system_prompt: Any = None, request_messages: Any = None,
                       tool_count: int = 0, platform: str = "", model: str = "", api_call_count: int = 0, turn_id: Any = "",
                       **_: Any) -> None:
    """Antes de cada chamada ao modelo: o tamanho de cada parte do pedido (nada do conteúdo)."""
    try:
        if not session_id or not api_request_id:
            return None
        sistema = _texto(system_prompt)
        conversa, imagens = _tamanho_conversa(request_messages)
        try:
            ferramentas, exato = _tamanho_ferramentas(str(platform or "api_server"), _inteiro(tool_count))
        except Exception:  # noqa: BLE001 - sem o registro de ferramentas: fica sem essa parte (marcada como não exata)
            ferramentas, exato = 0, False
        rec = {"t": round(time.time(), 3), "n": _inteiro(api_call_count), "turno": _marca_turno(turn_id), "sistema": len(sistema), "memoria": _trecho_memoria(sistema),
               "competencias": _trecho_competencias(sistema), "ferramentas": int(ferramentas), "ferramentas_exato": bool(exato),
               "n_ferramentas": _inteiro(tool_count), "conversa": conversa + imagens * _IMAGEM_CHARS, "imagens": imagens,
               "resumo": _tamanho_resumo(request_messages), "modelo": str(model or "")[:120]}
        agora = time.time()
        with _medicao_lock:
            for k in [k for k, v in _pendentes.items() if agora - v["t"] > _MEDICAO_PENDENTE_S]:
                _pendentes.pop(k, None)
            _pendentes[str(api_request_id)] = {**rec, "sessao": str(session_id)}
    except Exception:  # noqa: BLE001 - observador: nunca atrapalha a chamada
        logger.debug("ergon_bridge: medição do pedido falhou", exc_info=False)
    return None


def _uso(usage: Any) -> dict[str, int] | None:
    """O que o provedor informou (CanonicalUsage do Hermes): entrada total, a parte lida do cache e a saída."""
    if not isinstance(usage, dict):
        return None

    def n(k: str) -> int:
        v = usage.get(k)
        return max(0, int(v)) if isinstance(v, (int, float)) and not isinstance(v, bool) else 0

    entrada = n("prompt_tokens") or (n("input_tokens") + n("cache_read_tokens") + n("cache_write_tokens"))
    if not entrada and not n("output_tokens"):
        return None
    return {"entrada": entrada, "cache_lido": n("cache_read_tokens"), "cache_gravado": n("cache_write_tokens"), "saida": n("output_tokens")}


def on_post_api_request(session_id: str = "", api_request_id: str = "", usage: Any = None, **_: Any) -> None:
    """Depois de cada chamada: junta o total informado pelo provedor à medição do pedido e grava."""
    try:
        with _medicao_lock:
            rec = _pendentes.pop(str(api_request_id or ""), None)
        if not rec:
            return None
        sessao = rec.pop("sessao", "") or str(session_id or "")
        rec["uso"] = _uso(usage)
        if sessao:
            _gravar_do_turno(sessao, rec)
    except Exception:  # noqa: BLE001 - observador
        logger.debug("ergon_bridge: medição da resposta falhou", exc_info=False)
    return None


def _gravar_do_turno(sessao: str, rec: dict[str, Any]) -> None:
    """Grava a chamada na sessão dela e em toda sessão por onde o mesmo pedido já passou; a sessão nova de um pedido (o
    motor resumiu a conversa e trocou de sessão) recebe antes as chamadas que o pedido já tinha feito."""
    turno = str(rec.get("turno") or "")
    if not turno:
        return _gravar_medicao(sessao, rec)
    agora = time.time()
    with _medicao_lock:
        for k in [k for k, (t, _s) in _sessoes_do_turno.items() if agora - t > _TURNO_TTL_S]:
            _sessoes_do_turno.pop(k, None)
        while len(_sessoes_do_turno) >= _TURNOS_MAX:
            _sessoes_do_turno.pop(next(iter(_sessoes_do_turno)))
        _, sessoes = _sessoes_do_turno.get(turno, (agora, []))
        nova = sessao not in sessoes
        if nova:
            sessoes = [*sessoes, sessao]
        _sessoes_do_turno[turno] = (agora, sessoes)
    if nova and len(sessoes) > 1:
        for antes in medicao(sessoes[0]):
            if antes.get("turno") == turno:
                _gravar_medicao(sessao, antes)
    for s in sessoes:
        _gravar_medicao(s, rec)


def _medicao_dir() -> Path:
    return Path(os.environ.get("HERMES_HOME", "/opt/data")) / "ergon_bridge" / "medicao"


def _medicao_path(sessao: str) -> Path:
    # o nome do arquivo não diz nada da sessão (o id do Ergon tem o workspace e o agente)
    return _medicao_dir() / (hashlib.sha256(sessao.encode("utf-8")).hexdigest()[:40] + ".jsonl")


def _gravar_medicao(sessao: str, rec: dict[str, Any]) -> None:
    p = _medicao_path(sessao)
    linha = json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n"
    with _medicao_lock:
        p.parent.mkdir(parents=True, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(linha)
        try:
            os.chmod(p, 0o600)
        except OSError:
            pass
        if p.stat().st_size > 600 * _MEDICAO_MAX:  # guarda só as mais recentes
            linhas = p.read_text(encoding="utf-8").splitlines()[-_MEDICAO_MAX:]
            tmp = p.with_suffix(".tmp")
            tmp.write_text("\n".join(linhas) + "\n", encoding="utf-8")
            os.replace(tmp, p)
        if time.time() - _ultima_limpeza[0] > 3600:
            _ultima_limpeza[0] = time.time()
            limite = time.time() - _MEDICAO_DIAS * 86400
            for velho in p.parent.glob("*.jsonl"):
                try:
                    if velho.stat().st_mtime < limite:
                        velho.unlink()
                except OSError:
                    pass


def medicao(sessao: str, desde: float = 0.0) -> list[dict[str, Any]]:
    """As chamadas medidas de uma sessão, desde um instante (segundos desde 1970), as mais recentes por último."""
    try:
        linhas = _medicao_path(sessao).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for ln in linhas:
        try:
            rec = json.loads(ln)
        except ValueError:
            continue  # linha cortada (queda no meio da gravação)
        if isinstance(rec, dict) and float(rec.get("t") or 0) >= desde:
            out.append(rec)
    return out[-_MEDICAO_MAX:]


# ---------------------------------------------------------------- passos por pedido
# agent.max_turns: o Hermes relê do config.yaml a cada execução (gateway/run.py, _current_max_iterations), então vale a
# partir do próximo pedido, sem reiniciar nada. A pessoa escolhe no Ergon; o padrão (90, o da instalação do Hermes) vem da
# migração 10 do cofre (o 20 da migração 1 que ninguém escolheu vira 90). O teto, 150, segura um laço que nunca termina.
PASSOS_MIN, PASSOS_MAX = 5, 150
PASSOS_PADRAO = 90

# ---------------------------------------------------------------- resumir as conversas longas mais cedo
# compression.threshold_tokens: o teto absoluto do Hermes para resumir a conversa (vale o menor entre ele e a fração da
# janela do modelo). A migração 3 do cofre grava este número onde ninguém escolheu (o mesmo valor: um teste confere; a
# escolha do número está explicada lá). Desligado = null: fica só o limite do próprio Hermes, perto do fim da janela — o
# resumo nunca é desligado de todo (sem ele, uma conversa longa estouraria o limite do modelo). O Hermes cria um agente
# novo a cada pedido da API e lê a seção compression nessa hora: vale a partir do próximo pedido, sem reiniciar.
COMPACTAR_LIMITE = 150000


# ---------------------------------------------------------------- ajustes do motor que a pessoa escolhe no Ergon (rc.27)
# Tudo aqui é configuração do próprio Hermes (config.yaml), gravada pelo painel interno dele (mescla, com a trava de escrita
# dele), como os passos e a compactação. O Ergon guarda a escolha da pessoa e manda de novo quando o motor abre.
#  - reserva (fallback_providers): modelos de outras contas de IA, tentados em ordem quando o principal falha;
#  - nao_treinar (provider_routing.data_collection: deny): pede ao OpenRouter só provedores que não guardam/treinam com os
#    dados. A rota de execuções do Hermes (a que o Ergon usa) NÃO repassa essa chave ao agente (gateway/platforms/
#    api_server.py, _create_agent: sem provider_data_collection), então o plugin põe o pedido em cada chamada pelo
#    intermediário de requisição do Hermes (llm_request): ver on_llm_request;
#  - busca_privada (web.keyless_fallback: false + web.search_backend): sem os serviços de busca gratuitos de terceiros
#    (o anel exa/parallel/firecrawl/keenable); a busca vai direto ao DuckDuckGo (pacote ddgs) ou a um SearXNG da pessoa.
#    No Hermes, LER uma página inteira (web_extract) sempre passa por um desses serviços: com a busca privada, fica sem;
#  - arrumar_competencias (curator.enabled): o Curator marca como paradas e arquiva competências sem uso. Desligado por
#    padrão (migração do cofre: é economia, não benefício); as competências treinadas no Ergon ficam fixadas e ele nunca
#    as toca;
#  - anotar_memoria (auxiliary.background_review.enabled, com skills.creation_nudge_interval 0): depois da conversa, a cada
#    memory.nudge_interval mensagens da pessoa, o Hermes revisa o que vale guardar na memória longa do agente (a gravação
#    fica em espera até a pessoa aprovar). Ligado por padrão (migração 5); a revisão de competências fica sempre de fora
#    (intervalo 0: a trava do Treinar barraria tudo, e ela só gastaria chamadas);
#  - raciocinio (agent.reasoning_effort): a profundidade do raciocínio do modelo. "high" por padrão (migração 10); "" é o
#    padrão do próprio modelo. O Hermes ajusta ao que cada provedor aceita;
#  - idioma (display.language): as mensagens fixas do motor no idioma da pessoa.
RESERVA_MAX = 5
_IDIOMAS_MOTOR = ("pt", "en")
# o que a tela oferece (VALID_REASONING_EFFORTS do Hermes tem mais níveis; os extremos ficam fora) e o padrão do Ergon
RACIOCINIO_NIVEIS = ("", "low", "medium", "high")
RACIOCINIO_PADRAO = "high"
_RE_PROVEDOR = re.compile(r"[a-z0-9][a-z0-9_.:-]{0,60}")
_RE_MODELO = re.compile(r"[\w./:@+-]{1,160}")
_FALSO = (False, "false", "off", "no", "0", 0)


def reserva_limpa(raw: Any) -> list[dict[str, str]]:
    """A lista de modelos reserva como o Hermes guarda ([{provider, model}]), sem repetidos, na ordem, até RESERVA_MAX.
    Entrada malformada: ValueError (nada é gravado)."""
    if not isinstance(raw, list) or len(raw) > 20:
        raise ValueError("envie reserva: [{provider, model}]")
    out: list[dict[str, str]] = []
    for e in raw:
        provider = str(e.get("provider") or "").strip().lower() if isinstance(e, dict) else ""
        model = str(e.get("model") or "").strip() if isinstance(e, dict) else ""
        if not _RE_PROVEDOR.fullmatch(provider) or not _RE_MODELO.fullmatch(model):
            raise ValueError("modelo reserva inválido")
        if not any(x["provider"] == provider and x["model"] == model for x in out):
            out.append({"provider": provider, "model": model})
    return out[:RESERVA_MAX]


def busca_privada_backend() -> str | None:
    """Com o que a busca privada funciona neste motor: "ddgs" (o pacote do DuckDuckGo está instalado), "searxng" (a
    pessoa apontou um SearXNG dela) ou None (nada: ligar deixaria a equipe sem busca)."""
    try:
        import importlib.util
        if importlib.util.find_spec("ddgs") is not None:
            return "ddgs"
    except Exception:  # noqa: BLE001
        pass
    return "searxng" if os.environ.get("SEARXNG_URL", "").strip() else None


def ajustes_ler(cfg: Any) -> dict[str, Any]:
    """O que está valendo no motor (config.yaml com os padrões do Hermes)."""
    cfg = cfg if isinstance(cfg, dict) else {}
    sec = lambda k: cfg.get(k) if isinstance(cfg.get(k), dict) else {}  # noqa: E731
    reserva: list[dict[str, str]] = []
    for e in (cfg.get("fallback_providers") if isinstance(cfg.get("fallback_providers"), list) else []):
        try:
            reserva += [x for x in reserva_limpa([e]) if x not in reserva]
        except ValueError:
            continue
    web = sec("web")
    aux = sec("auxiliary")
    revisao = aux.get("background_review") if isinstance(aux.get("background_review"), dict) else {}
    try:
        lembrete = int(sec("memory").get("nudge_interval", 10))
    except (TypeError, ValueError):
        lembrete = 10
    return {
        "reserva": reserva[:RESERVA_MAX],
        "nao_treinar": str(sec("provider_routing").get("data_collection") or "").strip().lower() == "deny",
        "busca_privada": web.get("keyless_fallback", True) in _FALSO and str(web.get("search_backend") or "") in ("ddgs", "searxng"),
        "busca_privada_disponivel": busca_privada_backend() is not None,
        "arrumar_competencias": sec("curator").get("enabled", True) not in _FALSO,
        "anotar_memoria": revisao.get("enabled", True) not in _FALSO and lembrete > 0,
        "raciocinio": str(sec("agent").get("reasoning_effort") or "").strip().lower()[:12],
        "idioma": str(sec("display").get("language") or "en")[:12],
    }


def ajustes_config(body: dict[str, Any]) -> dict[str, Any]:
    """O pedaço do config.yaml para as escolhas que vieram (só as que vieram). Valor inválido: ValueError; busca privada
    num motor sem a busca direta: LookupError (nada é gravado: a equipe ficaria sem busca)."""
    out: dict[str, Any] = {}
    if "reserva" in body:
        out["fallback_providers"] = reserva_limpa(body["reserva"])
    if "nao_treinar" in body:
        if not isinstance(body["nao_treinar"], bool):
            raise ValueError("envie nao_treinar: true ou false")
        out["provider_routing"] = {"data_collection": "deny" if body["nao_treinar"] else "allow"}
    if "busca_privada" in body:
        if not isinstance(body["busca_privada"], bool):
            raise ValueError("envie busca_privada: true ou false")
        if body["busca_privada"]:
            backend = busca_privada_backend()
            if backend is None:
                raise LookupError("este motor ainda não tem a busca direta")
            # ler a página inteira só passa por serviços de terceiros: sem leitor fixado, o motor diz que não há (e não tenta)
            out["web"] = {"keyless_fallback": False, "search_backend": backend, "extract_backend": ""}
        else:
            # de volta à experiência completa: a leitura de páginas pela Exa (sem chave, plano gratuito; migração 10)
            out["web"] = {"keyless_fallback": True, "search_backend": "", "extract_backend": "exa"}
    if "arrumar_competencias" in body:
        if not isinstance(body["arrumar_competencias"], bool):
            raise ValueError("envie arrumar_competencias: true ou false")
        out["curator"] = {"enabled": body["arrumar_competencias"]}
    if "anotar_memoria" in body:
        if not isinstance(body["anotar_memoria"], bool):
            raise ValueError("envie anotar_memoria: true ou false")
        # a revisão de competências fica sempre de fora (intervalo 0), ligada ou não a anotação de memória
        out["auxiliary"] = {"background_review": {"enabled": body["anotar_memoria"]}}
        out["skills"] = {"creation_nudge_interval": 0}
    if "raciocinio" in body:
        if body["raciocinio"] not in RACIOCINIO_NIVEIS:
            raise ValueError("profundidade do raciocínio inválida")
        out["agent"] = {"reasoning_effort": body["raciocinio"]}
    if "idioma" in body:
        if body["idioma"] not in _IDIOMAS_MOTOR:
            raise ValueError("idioma inválido")
        out["display"] = {"language": body["idioma"]}
    if not out:
        raise ValueError("nada para gravar")
    return out


# "Não treinar com os meus dados", de fato em cada chamada: a leitura do config.yaml fica em memória por alguns segundos
_nao_treinar_cache: tuple[float, bool] = (0.0, False)


def _nao_treinar() -> bool:
    global _nao_treinar_cache
    at, v = _nao_treinar_cache
    if time.time() - at < 15:
        return v
    try:
        from hermes_cli.config import load_config_readonly  # módulo do Hermes
        pr = load_config_readonly().get("provider_routing")
        v = isinstance(pr, dict) and str(pr.get("data_collection") or "").strip().lower() == "deny"
    except Exception:  # noqa: BLE001 - na dúvida, pede (é o padrão do Ergon e o lado seguro)
        v = True
    _nao_treinar_cache = (time.time(), v)
    return v


def on_llm_request(request: Any = None, base_url: Any = "", **_: Any) -> dict[str, Any] | None:
    """Intermediário de requisição do Hermes (llm_request): em chamadas pelo OpenRouter, com a escolha ligada, acrescenta
    provider.data_collection = "deny" ao corpo (o mesmo lugar em que o Hermes põe as preferências de provedor:
    extra_body.provider). Outros provedores não têm esse pedido: nada muda. Nunca lança exceção; sem mudança devolve None."""
    try:
        if "openrouter.ai" not in str(base_url or "").lower() or not isinstance(request, dict) or "messages" not in request:
            return None
        if not _nao_treinar():
            return None
        extra = dict(request["extra_body"]) if isinstance(request.get("extra_body"), dict) else {}
        prefs = dict(extra["provider"]) if isinstance(extra.get("provider"), dict) else {}
        if prefs.get("data_collection") == "deny":
            return None
        prefs["data_collection"] = "deny"
        extra["provider"] = prefs
        return {"request": {**request, "extra_body": extra}, "source": "ergon_bridge", "reason": "data_collection"}
    except Exception:  # noqa: BLE001
        return None


# ---------------------------------------------------------------- cotas e saldo da conta de IA (rc.27)
# O próprio Hermes sabe perguntar ao provedor quanto da assinatura já foi usado (agent/account_usage.py: as janelas de 5 h
# e da semana do ChatGPT e do Claude, a cota e o saldo da chave do OpenRouter, os créditos do Nous Portal). Aqui só o
# resumo: percentuais, datas e o saldo. Nada de credenciais nem do corpo cru da resposta. Guardado por alguns minutos.
_COTA_TTL = 300.0
_cota_cache: dict[str, Any] = {"at": 0.0, "data": None}
_cota_lock = threading.Lock()
_RE_DINHEIRO = re.compile(r"\$\s?(-?[0-9][0-9,]*(?:\.[0-9]+)?)")
_JANELAS = {"session": "sessao", "current session": "sessao", "weekly": "semana", "current week": "semana",
            "opus week": "semana_modelo", "sonnet week": "semana_modelo", "subscription": "assinatura", "api key quota": "chave"}


def _iso(dt: Any) -> str | None:
    try:
        return dt.isoformat() if dt is not None else None
    except Exception:  # noqa: BLE001
        return None


def cota_resumo(snapshot: Any) -> dict[str, Any] | None:
    """Um AccountUsageSnapshot do Hermes → o que o Ergon mostra. None = nada a mostrar."""
    if snapshot is None:
        return None
    janelas = []
    for w in list(getattr(snapshot, "windows", ()) or ())[:8]:
        usado = getattr(w, "used_percent", None)
        if not isinstance(usado, (int, float)) or isinstance(usado, bool) or usado != usado:
            continue
        rotulo = str(getattr(w, "label", "") or "")[:40]
        janelas.append({"tipo": _JANELAS.get(rotulo.strip().lower(), "outro"), "rotulo": rotulo, "usado": round(max(0.0, min(100.0, float(usado))), 1),
                        "renova_em": _iso(getattr(w, "reset_at", None)), "escopo": "modelo" if getattr(w, "scope", "") == "model" else "conta"})
    detalhes = [str(x) for x in list(getattr(snapshot, "details", ()) or ())[:12]]
    saldo = None
    renova = None
    for linha in detalhes:
        baixo = linha.lower()
        if saldo is None and (baixo.startswith("credits balance:") or baixo.startswith("total usable:")):
            m = _RE_DINHEIRO.search(linha)
            if m:
                try:
                    saldo = float(m.group(1).replace(",", ""))
                except ValueError:
                    saldo = None
        if renova is None and baixo.startswith("renews:"):
            renova = linha.split(":", 1)[1].strip()[:40] or None
    ilimitado = any(x.lower().startswith("credits balance: unlimited") for x in detalhes)
    if not janelas and saldo is None and not ilimitado:
        return None
    return {"provedor": str(getattr(snapshot, "provider", "") or "")[:40], "plano": (str(getattr(snapshot, "plan", "") or "")[:40] or None),
            "janelas": janelas, "saldo_usd": saldo, "saldo_ilimitado": ilimitado, "renova_em": renova,
            "lido_em": _iso(getattr(snapshot, "fetched_at", None))}


def _cota_agora() -> list[dict[str, Any]]:
    """Pergunta aos provedores (rede): a conta do modelo padrão e, se houver login, os créditos do Nous Portal."""
    contas: list[dict[str, Any]] = []
    provedor = ""
    try:
        from hermes_cli.config import load_config  # módulo do Hermes
        m = load_config().get("model")
        provedor = str(m.get("provider") or "").strip().lower() if isinstance(m, dict) else ""
    except Exception:  # noqa: BLE001
        provedor = ""
    from agent import account_usage as au  # módulo do Hermes
    if provedor and provedor != "nous":
        try:
            r = cota_resumo(au.fetch_account_usage(provedor))
            if r:
                contas.append(r)
        except Exception:  # noqa: BLE001
            pass
    try:
        if au._nous_logged_in():
            r = cota_resumo(au.build_nous_credits_snapshot(au._fetch_portal_account(10.0)))
            if r:
                contas.append(r)
    except Exception:  # noqa: BLE001
        pass
    return contas


def cota(forcar: bool = False) -> dict[str, Any]:
    with _cota_lock:
        if not forcar and _cota_cache["data"] is not None and time.time() - _cota_cache["at"] < _COTA_TTL:
            return _cota_cache["data"]
    data = {"contas": _cota_agora(), "agora": round(time.time(), 3)}
    with _cota_lock:
        _cota_cache.update(at=time.time(), data=data)
    return data


# ---------------------------------------------------------------- cartões: perguntar de volta, pedir chave, senha de administrador
# O que o Hermes só oferece no terminal, no aplicativo dele e nos canais (clarify, captura segura de segredo, pedido de
# senha do sudo) chega aos agentes do Ergon por estas três ferramentas. A API do Hermes não entrega a ferramenta clarify
# (ela depende de agent.clarify_callback, que só as outras portas preenchem, e nenhum gancho recebe o agente), então o
# plugin registra a equivalente, com o MESMO esquema, a mesma validação e o mesmo formato de resultado do clarify
# (tools/clarify_tool.py) e disparando os mesmos ganchos de espera humana (tools/human_input_hooks.py). O cartão aparece
# no Ergon; a ferramenta espera a resposta (até _CARTAO_ESPERA) e a devolve no mesmo trabalho. Sem resposta no prazo, o
# cartão continua com a pessoa e a resposta chega como a próxima mensagem (o Ergon cuida disso).
# Chave ou senha: o valor NUNCA passa pelo modelo, pela conversa nem por registro. O Ergon manda o valor direto à ponte
# de controle (/ergon/v1/chaves), que grava no .env do motor pelo gravador do próprio Hermes (hermes_cli.config.
# save_env_value: a mesma fonte de segredos das outras chaves); o agente recebe só "guardada como NOME" e usa por
# variável de ambiente. A senha de administrador "só para este trabalho" vai para o cache do sudo do Hermes
# (tools/terminal_tool_sudo.py, por sessão: na API, a sessão é a própria execução) e não é gravada em lugar nenhum.
_TS_CARTOES = "ergon_cartoes"
_ERGON_PLUGIN_TOOLSETS = (_TS_CONEXOES, _TS_CARTOES)
_CARTOES_TOOLS = frozenset({"perguntar", "pedir_chave", "pedir_senha_admin"})
_CARTAO_ESPERA = float(os.environ.get("ERGON_CARTAO_ESPERA_S", "240"))
_CARTAO_PASSO = float(os.environ.get("ERGON_CARTAO_PASSO_S", "2"))
_CHAVE_NOME = re.compile(r"[A-Z][A-Z0-9_]{2,60}")
# nomes que mexem no próprio motor, no Ergon ou na execução de programas: nunca por um cartão
_CHAVE_PREFIXOS_NEGADOS = ("HERMES_", "ERGON_", "AUXILIARY_", "GATEWAY_", "TERMINAL_", "SUDO_", "LD_", "PYTHON", "DYLD_", "API_SERVER_")
_SUDO = "SUDO_PASSWORD"
_VALOR_MAX = 4000
_chaves_lock = threading.Lock()
_sudo_escopos: dict[str, str] = {}  # sessão → escopo do cache do sudo no Hermes (para apagar no fim do pedido)
_sudo_valores: set[str] = set()  # senhas de administrador entregues só para um trabalho (memória, para mascarar)
_SEM_RESPOSTA = ("A pessoa ainda não respondeu. O cartão continua com ela no Ergon: não pergunte de novo nem invente a resposta. "
                 "Diga em uma frase que aguarda a resposta e pare por aqui; ela chega como a próxima mensagem deste trabalho.")
_SEM_CARTAO = "Não foi possível mostrar o cartão à pessoa agora. Diga a ela, em uma frase, o que você precisa, e pare por aqui."


def _chave_recusa(nome: str) -> str | None:
    """Por que este nome não pode ser guardado por um cartão (None = pode). As credenciais de provedor do Hermes entram por
    Configurações › IA, nunca por aqui; os nomes que o gravador do Hermes recusa (PATH, LD_PRELOAD…) também ficam fora."""
    if not _CHAVE_NOME.fullmatch(nome) or nome.startswith(_CHAVE_PREFIXOS_NEGADOS):
        return "nome inválido: use letras maiúsculas, números e _ (por exemplo GITHUB_TOKEN), sem prefixos do sistema"
    try:
        from tools.env_passthrough import _is_hermes_provider_credential  # módulo do Hermes
        if _is_hermes_provider_credential(nome):
            return "essa é uma chave de provedor de IA: ela é ligada em Configurações, não por aqui"
    except Exception:  # noqa: BLE001 - fora do motor (testes só com a biblioteca padrão)
        pass
    try:
        from hermes_cli.config import validate_env_var_name_for_write  # módulo do Hermes
        validate_env_var_name_for_write(nome)
    except ImportError:
        pass
    except Exception:  # noqa: BLE001
        return "esse nome é reservado pelo sistema"
    return None


def _chaves_path() -> Path:
    return Path(os.environ.get("HERMES_HOME", "/opt/data")) / "ergon_bridge" / "chaves.json"


def _chaves_ler() -> dict[str, dict[str, Any]]:
    """O registro das chaves guardadas pela equipe: só nomes, para quê e quando. Nunca valores."""
    try:
        data = json.loads(_chaves_path().read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}
    return {str(k): v for k, v in data.items() if isinstance(v, dict) and _CHAVE_NOME.fullmatch(str(k))} if isinstance(data, dict) else {}


def _chaves_gravar(reg: dict[str, dict[str, Any]]) -> None:
    p = _chaves_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(reg, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    os.chmod(tmp, 0o600)
    os.replace(tmp, p)


def _env_do_motor() -> dict[str, str]:
    try:
        from hermes_cli.config import load_env  # módulo do Hermes
        return dict(load_env())
    except Exception:  # noqa: BLE001
        return {}


def chaves_listar() -> dict[str, Any]:
    env = _env_do_motor()
    reg = _chaves_ler()
    return {"chaves": [{"nome": n, "motivo": str(v.get("motivo") or "")[:300], "quando": str(v.get("quando") or "")[:40], "agente": str(v.get("agente") or "")[:60]}
                       for n, v in sorted(reg.items()) if env.get(n)],
            "sudo": bool(env.get(_SUDO))}


def chave_guardar(nome: str, valor: str, motivo: str = "", agente: str = "", sudo: bool = False) -> None:
    """Grava no .env do motor pelo gravador do Hermes (com a trava de escrita e a lista de nomes negados dele)."""
    if sudo:
        nome = _SUDO
    elif (recusa := _chave_recusa(nome)):
        raise ValueError(recusa)
    valor = valor.replace("\r", "").replace("\n", "")
    if not valor or len(valor) > _VALOR_MAX or any(ord(c) < 32 or ord(c) == 127 for c in valor):
        raise ValueError("valor vazio, longo demais ou com caracteres de controle")
    if not valor.isascii():
        # o gravador do Hermes tira os acentos e escreve no registro do motor QUAIS caracteres eram (posição e letra):
        # parte do valor iria para o registro e o que ficaria guardado seria outro valor. Recusa antes de gravar.
        raise ValueError("o valor tem acentos ou caracteres especiais que o cofre não guarda")
    from hermes_cli.config import save_env_value  # módulo do Hermes
    save_env_value(nome, valor)
    if _env_do_motor().get(nome) != valor:
        raise RuntimeError("o cofre da equipe não aceitou gravar agora")
    if not sudo:
        with _chaves_lock:
            reg = _chaves_ler()
            reg[nome] = {"motivo": motivo[:300], "agente": agente[:60], "quando": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
            _chaves_gravar(reg)
    # no gateway com vários perfis, cada agente lê os segredos do .env do PERFIL dele: a chave chega lá agora, e o nome
    # entra na lista de passagem do Terminal (sem ela o valor do perfil não chega ao comando)
    _perfis_acompanhar(forcar=True)
    _chaves_no_terminal()
    _mascarar_guardadas()


def chave_apagar(nome: str) -> bool:
    if nome != _SUDO and not _CHAVE_NOME.fullmatch(nome):
        raise ValueError("nome inválido")
    with _chaves_lock:
        reg = _chaves_ler()
        if nome != _SUDO and nome not in reg:
            return False  # só o que entrou por um cartão sai por aqui (as chaves de provedor têm a tela delas)
        from hermes_cli.config import remove_env_value  # módulo do Hermes
        remove_env_value(nome)
        # no gateway com vários perfis o gravador do Hermes não mexe no ambiente do processo (para ele tudo ali é "perfil
        # roteado": hermes_cli/config.py, _publish_env_value), mas o valor pode estar lá (o .env lido na partida do motor,
        # ou a releitura que este plugin fazia até a rc.27): sem isto ele sobrava no processo depois de apagado
        os.environ.pop(nome, None)
        if reg.pop(nome, None) is not None:
            _chaves_gravar(reg)
    # e sai também do .env de cada perfil (é de lá que o Terminal de cada agente lê)
    _perfis_acompanhar(forcar=True)
    _limpar_instantaneos(nome)
    return True


def _limpar_instantaneos(nome: str) -> None:
    """O Terminal do Hermes guarda o ambiente de cada sessão aberta num arquivo de trabalho dentro do cofre
    (cache/scratch/hermes-snap-*.sh, apagado quando a sessão do Terminal fecha): é por ele que a variável chega aos
    comandos seguintes. Chave apagada sai também dali, para não sobrar numa sessão do Terminal ainda aberta."""
    raiz = Path(os.environ.get("HERMES_HOME", "/opt/data"))
    marca = re.compile(rf"^(?:declare -x|export) {re.escape(nome)}=")
    arquivos: list[Path] = []
    # o do perfil padrão e o de cada perfil de agente (cada um tem o próprio cache/scratch)
    for pasta in [raiz / "cache" / "scratch", *[raiz / "profiles" / p / "cache" / "scratch" for p in perfis_listar()]]:
        try:
            arquivos += list(pasta.glob("hermes-snap-*.sh*"))
        except OSError:
            continue
    for f in arquivos:
        try:
            linhas = f.read_text(encoding="utf-8", errors="surrogateescape").splitlines(keepends=True)
            ficam = [ln for ln in linhas if not marca.match(ln)]
            if len(ficam) != len(linhas):
                tmp = f.with_name(f.name + ".ergon")
                tmp.write_text("".join(ficam), encoding="utf-8", errors="surrogateescape")
                os.chmod(tmp, f.stat().st_mode & 0o777)
                os.replace(tmp, f)
        except OSError:
            continue


def _valores_guardados() -> list[str]:
    """Os valores das chaves guardadas por cartão que este processo enxerga (só na memória, para mascarar)."""
    nomes = [*_chaves_ler().keys(), _SUDO]
    env = _env_do_motor()
    vistos = {os.environ.get(n) or "" for n in nomes} | {env.get(n) or "" for n in nomes}
    with _chaves_lock:
        vistos |= set(_sudo_valores)
    return sorted((v for v in vistos if len(v) >= 4), key=len, reverse=True)


def _mascarar_guardadas() -> None:
    """Registra os valores no mascaramento do próprio Hermes (agent/redact.py, register_vault_redaction_value: troca exata,
    vale mesmo com security.redact_secrets desligado). O gancho transform_tool_result abaixo repete a troca na saída de
    toda ferramenta, para não depender de qual caminho a saída tomou."""
    try:
        from agent.redact import register_vault_redaction_value  # módulo do Hermes
        for v in _valores_guardados():
            register_vault_redaction_value(v)
    except Exception:  # noqa: BLE001
        pass


def _recarregar_env() -> None:
    """Traz para este processo o que a ponte de controle acabou de gravar no .env (ela pode estar no outro processo do
    motor); o Hermes também relê o .env a cada pedido (gateway/run.py). No gateway com vários perfis, NÃO: reload_env
    escreve o .env do perfil deste pedido no ambiente do processo, que é de todos os perfis (a chave de um perfil iria
    parar no Terminal dos outros e ficaria lá depois de apagada); ali vale o escopo de segredos do perfil, refeito abaixo."""
    try:
        from hermes_cli import config as hc  # módulo do Hermes
        inval = getattr(hc, "invalidate_env_cache", None)
        if callable(inval):
            inval()
        if not _multiplexado():
            hc.reload_env()
    except Exception:  # noqa: BLE001
        pass
    _chaves_no_terminal()
    _mascarar_guardadas()


def _multiplexado() -> bool:
    try:
        from agent.secret_scope import is_multiplex_active  # módulo do Hermes
        return bool(is_multiplex_active())
    except Exception:  # noqa: BLE001
        return False


# As ferramentas que abrem processos filhos (Terminal, processos em segundo plano, executar código): é nelas que a chave
# guardada por cartão precisa chegar como variável de ambiente.
_FILHOS_TOOLS = frozenset({"terminal", "process_manage", "execute_code"})


def _chaves_no_terminal() -> None:
    """A chave guardada por cartão chega ao Terminal do agente também no perfil dele (gateway com vários perfis).

    No perfil padrão o valor está no ambiente do processo (save_env_value) e o Terminal o herda. Num perfil de agente, não:
    o Hermes monta o ambiente do filho com o ambiente do processo SEM os restos do perfil padrão
    (tools/environments/local.py, strip_launch_profile_env) e só acrescenta, do escopo de segredos do perfil (o .env dele),
    os nomes da lista de passagem (tools/env_passthrough.py, scoped_passthrough_additions). Essa lista vem de duas fontes:
    as competências (register_env_passthrough) e terminal.env_passthrough do config.yaml, lida UMA vez por perfil e
    guardada até o motor reiniciar (_config_passthrough) — por isso pôr o nome no config.yaml do perfil não adiantava.
    Aqui: (1) os nomes guardados entram na lista de passagem pelo registro público do Hermes (o mesmo das competências; o
    Hermes continua recusando as chaves de provedor, e o valor de cada perfil vem do escopo DELE, nunca do ambiente do
    processo); (2) o escopo de segredos já instalado neste pedido é refeito do .env do perfil
    (refresh_installed_secret_scope, o mesmo que o Hermes usa depois de descobrir uma fonte de segredos), porque ele foi
    montado no começo do pedido: a chave entregue no meio do trabalho vale no comando seguinte e a apagada sai na hora.
    Nos perfis os nomes da lista de passagem ficam fora do instantâneo do Terminal (base.py), então nada sobra lá."""
    try:
        from tools.env_passthrough import register_env_passthrough  # módulo do Hermes
        nomes = sorted(_chaves_ler().keys())
        if nomes:
            register_env_passthrough(nomes)
    except Exception:  # noqa: BLE001 - fora do motor (testes só com a biblioteca padrão)
        pass
    try:
        from agent.secret_scope import current_secret_scope, current_secret_scope_home, refresh_installed_secret_scope  # módulo do Hermes
        if isinstance(current_secret_scope(), dict):
            casa = current_secret_scope_home()
            if not casa:
                from hermes_constants import get_hermes_home  # módulo do Hermes
                casa = str(get_hermes_home())
            refresh_installed_secret_scope(Path(casa))
    except Exception:  # noqa: BLE001 - na dúvida, o escopo fica como o Hermes montou
        logger.debug("ergon_bridge: escopo de segredos não refeito", exc_info=False)


def on_transform_tool_result(result: Any = None, **_: Any) -> str | None:
    """Nenhuma saída de ferramenta leva ao modelo o valor de uma chave guardada por cartão (por exemplo um `echo $NOME`)."""
    try:
        if not isinstance(result, str) or not result:
            return None
        out = result
        for v in _valores_guardados():
            if v in out:
                out = out.replace(v, "«chave guardada»")
        return out if out != result else None
    except Exception:  # noqa: BLE001 - na dúvida, o resultado segue como veio (o mascaramento do Hermes continua valendo)
        return None


def _cartao(tipo: str, dados: dict[str, Any], session_id: str, task_id: str) -> dict[str, Any]:
    """Abre o cartão no Ergon e espera a resposta. Devolve o último estado: respondida, recusada, esperando (o prazo
    acabou: o cartão fica com a pessoa), cancelada (o trabalho parou) ou falhou (o Ergon não respondeu)."""
    import uuid
    base = {"pedido": uuid.uuid4().hex, "tipo": tipo, "session_id": session_id[:200], "task_id": task_id[:200]}
    try:
        r = _post_to(_url_for("/internal/bridge/v1/cartao"), {**base, **dados}, timeout=10)
    except Exception:  # noqa: BLE001
        return {"estado": "falhou"}
    fim = time.time() + _CARTAO_ESPERA
    falhas = 0
    while r.get("estado") == "esperando" and time.time() < fim and falhas < 15:
        time.sleep(_CARTAO_PASSO)
        try:
            r = _post_to(_url_for("/internal/bridge/v1/cartao/estado"), base, timeout=10)
            falhas = 0
        except Exception:  # noqa: BLE001 - o Ergon piscou: tenta de novo até o prazo
            falhas += 1
    if r.get("estado") == "esperando":
        try:  # avisa que parou de esperar: daqui em diante a resposta volta como mensagem (ou chegou neste instante)
            r = _post_to(_url_for("/internal/bridge/v1/cartao/estado"), {**base, "desistir": True}, timeout=10)
        except Exception:  # noqa: BLE001
            pass
    return r if isinstance(r, dict) else {"estado": "falhou"}


class _SemGancho:
    """Fora do motor (testes só com a biblioteca padrão): o mesmo uso, sem os ganchos do Hermes."""
    outcome = ""

    def __enter__(self) -> "_SemGancho":
        return self

    def __exit__(self, *_a: Any) -> bool:
        return False


def _espera_humana(kind: str, prompt: str) -> Any:
    """O mesmo par de ganchos que o Hermes dispara nas outras portas (on_human_input_request / _resolved)."""
    try:
        from tools.human_input_hooks import human_input_request  # módulo do Hermes
        return human_input_request(kind, prompt=prompt)
    except Exception:  # noqa: BLE001
        return _SemGancho()


def tool_perguntar(args: dict[str, Any], task_id: str = "", session_id: str = "", **_: Any) -> str:
    from tools import clarify_tool as ct  # módulo do Hermes: a validação e o formato do resultado são os do clarify
    normalized, error = ct._normalize_questions((args or {}).get("questions"))
    if error:
        return json.dumps({"error": error}, ensure_ascii=False)
    with _espera_humana("clarify", "\n".join(q["question"] for q in normalized)) as human:
        r = _cartao("pergunta", {"perguntas": [{"qid": q["qid"], "pergunta": q["question"][:2000], "opcoes": [c[:300] for c in (q["choices_offered"] or [])],
                                                "varias": bool(q["multi_select"])} for q in normalized]}, str(session_id or ""), str(task_id or ""))
        estado = r.get("estado")
        outcome = {"respondida": "submitted", "recusada": "cancelled", "cancelada": "cancelled", "esperando": "timed_out"}.get(str(estado), "undelivered")
        human.outcome = outcome
        respostas = r.get("respostas") if isinstance(r.get("respostas"), dict) else {}
        reply: dict[str, Any] = {"answers": respostas, "outcome": outcome}
        if outcome == "timed_out":
            reply["notice"] = _SEM_RESPOSTA
        elif outcome == "undelivered":
            reply["notice"] = str(r.get("texto") or _SEM_CARTAO)[:600]
        elif outcome == "cancelled":
            reply["notice"] = "A pessoa preferiu não responder. Siga com o que tem, ou diga o que ficou faltando."
        return ct._result(normalized, reply)


def tool_pedir_chave(args: dict[str, Any], task_id: str = "", session_id: str = "", **_: Any) -> str:
    a = args or {}
    nome = re.sub(r"[^A-Za-z0-9_]", "_", str(a.get("nome") or "").strip()).upper()
    motivo = re.sub(r"\s+", " ", str(a.get("motivo") or "")).strip()[:300]
    uso = (f"O valor nunca aparece para você. Use a variável de ambiente {nome} (por exemplo ${nome} num comando do Terminal ou "
           f"os.environ['{nome}'] num programa); nunca imprima, copie para arquivo nem escreva o valor numa resposta.")
    if (recusa := _chave_recusa(nome)):
        return json.dumps({"ok": False, "erro": recusa}, ensure_ascii=False)
    if not motivo:
        return json.dumps({"ok": False, "erro": "diga em motivo, em uma frase, para que a chave serve (a pessoa lê isso no cartão)"}, ensure_ascii=False)
    if not a.get("substituir") and _env_do_motor().get(nome) and nome in _chaves_ler():
        _recarregar_env()
        return json.dumps({"ok": True, "guardada_como": nome, "ja_estava": True, "uso": uso}, ensure_ascii=False)
    with _espera_humana("secret", f"{nome}: {motivo}") as human:
        r = _cartao("chave", {"nome": nome, "motivo": motivo}, str(session_id or ""), str(task_id or ""))
        estado = str(r.get("estado"))
        if estado == "respondida":
            _recarregar_env()
            human.outcome = "provided"
            return json.dumps({"ok": True, "guardada_como": nome, "uso": uso}, ensure_ascii=False)
        human.outcome = {"recusada": "skipped", "cancelada": "cancelled", "esperando": "timeout"}.get(estado, "error")
        texto = {"recusada": "A pessoa preferiu não informar essa chave. Siga sem ela, ou diga o que ficou faltando.",
                 "esperando": _SEM_RESPOSTA, "cancelada": "O trabalho foi interrompido."}.get(estado, str(r.get("texto") or _SEM_CARTAO)[:600])
        return json.dumps({"ok": False, "estado": estado, "texto": texto}, ensure_ascii=False)


def tool_pedir_senha_admin(args: dict[str, Any], task_id: str = "", session_id: str = "", **_: Any) -> str:
    motivo = re.sub(r"\s+", " ", str((args or {}).get("motivo") or "")).strip()[:300]
    if not motivo:
        return json.dumps({"ok": False, "erro": "diga em motivo o comando que precisa de administrador e para quê (a pessoa lê isso no cartão)"}, ensure_ascii=False)
    feito = "Use sudo normalmente nos comandos do Terminal (sem -S e sem escrever a senha); não peça a senha de novo neste trabalho."
    if _env_do_motor().get(_SUDO):
        _recarregar_env()
        return json.dumps({"ok": True, "ja_estava": True, "texto": "A senha de administrador já está guardada. " + feito}, ensure_ascii=False)
    with _espera_humana("sudo", motivo) as human:
        r = _cartao("sudo", {"motivo": motivo}, str(session_id or ""), str(task_id or ""))
        estado = str(r.get("estado"))
        if estado == "respondida":
            valor = r.pop("valor", None)
            human.outcome = "provided"
            if isinstance(valor, str) and valor:
                # só para este trabalho: o cache do sudo do Hermes, no escopo desta sessão (na API, a própria execução)
                from tools import terminal_tool_sudo as sudo  # módulo do Hermes
                sudo._set_cached_sudo_password(valor)
                with _chaves_lock:
                    _sudo_valores.add(valor)
                    _sudo_escopos[str(session_id or "")] = sudo._get_sudo_password_cache_scope()
                del valor
                _mascarar_guardadas()
                return json.dumps({"ok": True, "texto": "Senha entregue ao Terminal só para este trabalho. " + feito}, ensure_ascii=False)
            _recarregar_env()
            return json.dumps({"ok": True, "texto": "A senha de administrador ficou guardada. " + feito}, ensure_ascii=False)
        human.outcome = {"recusada": "skipped", "cancelada": "cancelled", "esperando": "timeout"}.get(estado, "error")
        texto = {"recusada": "A pessoa preferiu não informar a senha de administrador. Siga sem sudo, ou diga o que ficou faltando.",
                 "esperando": _SEM_RESPOSTA, "cancelada": "O trabalho foi interrompido."}.get(estado, str(r.get("texto") or _SEM_CARTAO)[:600])
        return json.dumps({"ok": False, "estado": estado, "texto": texto}, ensure_ascii=False)


def on_post_llm_call(session_id: str = "", **_: Any) -> None:
    """Fim do pedido: a senha de administrador entregue "só para este trabalho" sai do cache do sudo do Hermes. O valor
    continua só na lista de mascaramento deste processo (a resposta final ainda pode citá-lo); nada em disco."""
    try:
        with _chaves_lock:
            escopo = _sudo_escopos.pop(str(session_id or ""), None)
        if not escopo:
            return None
        from tools import terminal_tool_sudo as sudo  # módulo do Hermes
        with sudo._sudo_password_cache_lock:
            sudo._sudo_password_cache.pop(escopo, None)
    except Exception:  # noqa: BLE001 - observador
        pass
    return None


_esperas_vistas: list[dict[str, Any]] = []  # as últimas esperas humanas vistas pelos ganchos (sem o que a pessoa digitou)


def _avisar_espera(fase: str, kw: dict[str, Any]) -> None:
    ev = {"fase": fase, "kind": str(kw.get("kind") or "")[:40], "request_id": str(kw.get("request_id") or "")[:64],
          "session_id": str(kw.get("session_id") or "")[:200], "outcome": str(kw.get("outcome") or "")[:40]}
    with _chaves_lock:
        _esperas_vistas.append(ev)
        del _esperas_vistas[:-50]

    def enviar() -> None:
        try:
            _post_to(_url_for("/internal/bridge/v1/espera"), ev, timeout=3)
        except Exception:  # noqa: BLE001 - observador: o Ergon fora não atrapalha a espera
            pass

    threading.Thread(target=enviar, name="ergon-espera", daemon=True).start()


def on_human_input_request(**kw: Any) -> None:
    """Toda vez que o motor para esperando uma pessoa (pergunta, senha do sudo, aprovação de comando), o Ergon fica
    sabendo — também as esperas que não nasceram de um cartão nosso. Nunca traz o que a pessoa digitou."""
    try:
        _avisar_espera("pedido", kw)
    except Exception:  # noqa: BLE001
        pass
    return None


def on_human_input_resolved(**kw: Any) -> None:
    try:
        _avisar_espera("resolvido", kw)
    except Exception:  # noqa: BLE001
        pass
    return None


_PERGUNTAR_PADRAO = {
    "name": "perguntar",
    "description": "Faz de 1 a 5 perguntas à pessoa quando você precisa de uma decisão ou de um esclarecimento antes de continuar. Ela responde num cartão e a resposta volta aqui.",
    "parameters": {"type": "object", "required": ["questions"], "properties": {"questions": {"type": "array", "minItems": 1, "maxItems": 5, "items": {
        "type": "object", "required": ["question"], "properties": {"question": {"type": "string"}, "choices": {"type": "array", "items": {"type": "string"}, "maxItems": 4},
                                                                   "multi_select": {"type": "boolean"}}}}}},
}


def _perguntar_schema() -> dict[str, Any]:
    """O esquema do clarify do Hermes, com o nome da ferramenta do Ergon (a descrição dele ensina o modelo a usar)."""
    try:
        from tools.clarify_tool import CLARIFY_SCHEMA  # módulo do Hermes
        return {**CLARIFY_SCHEMA, "name": "perguntar", "description": CLARIFY_SCHEMA["description"]
                + " The question is shown to the user as a card in Ergon and the answer comes back here; if the user has not answered yet, end your turn and wait."}
    except Exception:  # noqa: BLE001
        return _PERGUNTAR_PADRAO


_PEDIR_CHAVE = {
    "name": "pedir_chave",
    "description": ("Pede à pessoa uma chave, senha ou token de um serviço (por exemplo GITHUB_TOKEN) de forma segura: ela digita num cartão protegido, o valor "
                    "vai direto para o cofre da equipe e você recebe só o nome. Depois, use pela variável de ambiente com esse nome (Terminal, programas, "
                    "competências). Nunca peça chave ou senha no texto da conversa: use sempre esta ferramenta."),
    "parameters": {"type": "object", "required": ["nome", "motivo"], "properties": {
        "nome": {"type": "string", "description": "nome da variável, em maiúsculas, como GITHUB_TOKEN ou OPENWEATHER_API_KEY"},
        "motivo": {"type": "string", "description": "uma frase para a pessoa: para que serve e onde ela encontra a chave"},
        "substituir": {"type": "boolean", "description": "true para pedir de novo uma chave já guardada (a antiga parou de funcionar)"},
    }},
}
_PEDIR_SENHA_ADMIN = {
    "name": "pedir_senha_admin",
    "description": ("Pede à pessoa a senha de administrador (sudo) quando um comando do Terminal precisar dela. Ela digita num cartão protegido; o valor vai "
                    "direto para o Terminal e você nunca o vê. Depois use sudo normalmente. Só peça quando um comando falhar por falta de senha."),
    "parameters": {"type": "object", "required": ["motivo"], "properties": {
        "motivo": {"type": "string", "description": "o comando que precisa de administrador e para quê, em uma frase para a pessoa"},
    }},
}


# ---------------------------------------------------------------- meta com juiz e revisão independente (/goal e /review do Hermes)
# Os comandos /goal e /review não passam pela API do Hermes (são das portas com sessão própria). O Ergon conduz as rodadas e
# chama aqui o mesmo mecanismo: o juiz da meta (hermes_cli/goals.py, judge_goal: o modelo auxiliar decide se o critério
# foi cumprido) com o texto de continuação do próprio Hermes, e o pedido de revisão (agent/review_engine.py,
# build_review_task), que o Ergon entrega a um revisor numa sessão separada.
def meta_julgar(meta: str, resposta: str) -> dict[str, Any]:
    from hermes_cli import goals  # módulo do Hermes
    veredito, motivo, sem_leitura, _espera, sem_juiz = goals.judge_goal(meta[:4000], resposta[:60000])
    return {"veredito": str(veredito), "motivo": str(motivo or "")[:600], "sem_leitura": bool(sem_leitura), "sem_juiz": bool(sem_juiz),
            "continuar": goals.CONTINUATION_PROMPT_TEMPLATE.format(goal=meta[:4000])}


def revisao_pedido(mensagens: list[Any], foco: str) -> dict[str, str]:
    from agent import review_engine  # módulo do Hermes
    snap = [{"role": "user" if str(m.get("role")) == "user" else "assistant", "text": str(m.get("text") or "")[:12000]}
            for m in mensagens[-review_engine.DEFAULT_CONTEXT_MESSAGES:] if isinstance(m, dict) and str(m.get("text") or "").strip()]
    titulo, pedido = review_engine.build_review_task(snap, foco[:2000])
    return {"titulo": str(titulo), "pedido": str(pedido)}


# ---------------------------------------------------------------- 4. conversar pelo Telegram e pelo Discord
# A pessoa cria o próprio bot e fala com a equipe por lá. O gateway do Hermes faz a conexão (de saída: sem endereço
# público) e guarda o código do bot no .env do motor (dentro do cofre). Este plugin:
#  - pre_gateway_dispatch (antes da autorização e dos comandos do Hermes): só conversa direta; quem ainda não foi
#    ligado recebe um código de pareamento (o pareamento NATIVO do gateway, gateway/pairing.py, com o nosso texto: o do
#    Hermes manda rodar um comando); quem já foi ligado tem a mensagem entregue ao Ergon, que roda o pedido pelo mesmo
#    caminho das conversas do app, e o Hermes não roda turno nenhum por conta própria (skip). Qualquer falha: skip.
#  - register_platform_handler: os botões Aprovar/Recusar (Telegram: CallbackQueryHandler só para "erg:"; Discord:
#    on_interaction só para "erg:") e as referências do adaptador vivo, no processo do gateway.
#  - a saída (respostas, cartões, avisos) é buscada no Ergon por este processo (espera longa) e mandada pelo adaptador
#    vivo: a ponte de controle pode estar em outro processo do motor (o painel), que não tem o adaptador.
_CANAIS = ("telegram", "discord")
_CANAL_ENV = {"telegram": "TELEGRAM_BOT_TOKEN", "discord": "DISCORD_BOT_TOKEN"}
_CANAL_NOME = {"telegram": "Telegram", "discord": "Discord"}
_CANAL_TOKEN = {
    "telegram": re.compile(r"\d{5,14}:[A-Za-z0-9_-]{30,64}"),
    "discord": re.compile(r"[A-Za-z0-9_-]{18,40}\.[A-Za-z0-9_-]{4,12}\.[A-Za-z0-9_-]{20,90}"),
}
_CANAL_CODIGO = (
    "Código para ligar esta conversa ao Ergon: {code}\n"
    "No Ergon, abra Conexões › Conversar com a equipe pelo {canal} e digite este código. Ele vale por 1 hora.\n\n"
    "Code to link this chat to Ergon: {code}\n"
    "In Ergon, open Connections › Talk to the team on {canal} and type this code. It is valid for 1 hour."
)
_CANAL_FORA = ("O Ergon não recebeu esta mensagem agora. Mande de novo em instantes.\n"
               "Ergon did not get this message right now. Please send it again in a moment.")
_CANAL_TEXTO_MAX = {"telegram": 4000, "discord": 1900}
_canal_vivos: dict[str, dict[str, Any]] = {}
_canal_laco_ligado = False


def _canal_arquivo() -> Path:
    return Path(os.environ.get("HERMES_HOME", "/opt/data")) / "ergon_bridge" / "canais.json"


def _canal_lembrados() -> dict[str, Any]:
    try:
        data = json.loads(_canal_arquivo().read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:  # noqa: BLE001
        return {}


def _canal_lembrar(platform: str, user_id: str, chat_id: str, user_name: str) -> None:
    """A conversa de quem pediu o código (no Discord, a conversa direta tem um número próprio): o Ergon recebe junto com
    o pareamento, para saber onde responder e avisar."""
    try:
        with _lock:
            data = _canal_lembrados()
            plat = data.get(platform) if isinstance(data.get(platform), dict) else {}
            plat[str(user_id)] = {"chat_id": str(chat_id), "user_name": str(user_name or "")[:120], "at": int(time.time())}
            data[platform] = dict(sorted(plat.items(), key=lambda kv: kv[1].get("at", 0))[-20:])
            p = _canal_arquivo()
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
            os.chmod(p, 0o600)
    except Exception:  # noqa: BLE001
        logger.warning("ergon_bridge: não gravei a conversa do canal", exc_info=False)


def _canal_store(gateway: Any = None, source: Any = None) -> Any:
    """O pareamento do próprio gateway (o mesmo que a autorização dele consulta); fora do gateway, o do disco."""
    if gateway is not None:
        try:
            s = gateway._pairing_store_for(source)
            if s is not None:
                return s
        except Exception:  # noqa: BLE001
            pass
    from gateway.pairing import PairingStore  # módulo do Hermes
    return PairingStore()


def _canal_quando(event: Any) -> str:
    ts = getattr(event, "timestamp", None)
    try:
        return ts.astimezone().isoformat() if ts is not None else ""
    except Exception:  # noqa: BLE001
        return ""


async def _canal_responder(adapter: Any, chat_id: str, text: str) -> None:
    if adapter is None or not text:
        return
    try:
        await adapter.send(chat_id, text)
    except Exception:  # noqa: BLE001
        logger.warning("ergon_bridge: resposta ao canal não saiu", exc_info=False)


async def _canal_entrada(event: Any, source: Any, platform: str, gateway: Any) -> dict[str, Any]:
    def skip(reason: str) -> dict[str, Any]:
        return {"action": "skip", "reason": f"ergon: {reason}"}

    user_id = str(getattr(source, "user_id", "") or "")
    chat_id = str(getattr(source, "chat_id", "") or "")
    if not user_id or not chat_id or getattr(source, "chat_type", "") != "dm" or getattr(source, "is_bot", False) is True:
        return skip("só conversa direta")
    if platform in _canal_vivos and _canal_vivos[platform].get("loop") is None:
        _canal_vivos[platform]["loop"] = asyncio.get_running_loop()
    store = _canal_store(gateway, source)
    adapter = None
    try:
        adapter = gateway._delivery_adapter_for(source) if gateway is not None else None
    except Exception:  # noqa: BLE001
        adapter = None
    adapter = adapter or (_canal_vivos.get(platform) or {}).get("adapter")
    user_name = str(getattr(source, "user_name", "") or "")
    if not await asyncio.to_thread(store.is_approved, platform, user_id):
        # canal que já tem dono: desconhecidos não recebem nada (nem código)
        if await asyncio.to_thread(store.list_approved, platform):
            return skip("canal já ligado a outra conta")
        code = await asyncio.to_thread(store.generate_code, platform, user_id, user_name)
        if code:
            _canal_lembrar(platform, user_id, chat_id, user_name)
            await _canal_responder(adapter, chat_id, _CANAL_CODIGO.format(code=code, canal=_CANAL_NOME[platform]))
        return skip("conta ainda não ligada")
    _canal_lembrar(platform, user_id, chat_id, user_name)
    payload = {
        "schema": "ergon.canais.v1", "tipo": "mensagem", "canal": platform, "user_id": user_id, "chat_id": chat_id,
        "user_name": user_name[:120], "message_id": str(getattr(event, "message_id", "") or f"noid-{int(time.time() * 1000)}")[:200],
        "text": str(getattr(event, "text", "") or "")[:8000], "sent_at": _canal_quando(event),
        "anexos": len(getattr(event, "media_urls", None) or []),
    }
    try:
        r = await asyncio.to_thread(_post_to, _url_for("/internal/bridge/v1/canais/entrada"), payload)
        reply = r.get("reply")
        if r.get("digitando") and adapter is not None:
            try:
                await adapter.send_typing(chat_id)
            except Exception:  # noqa: BLE001
                pass
    except Exception as exc:  # noqa: BLE001
        logger.warning("ergon_bridge: Ergon indisponível para o canal (%s)", type(exc).__name__)
        reply = _CANAL_FORA
    if isinstance(reply, str) and reply.strip():
        await _canal_responder(adapter, chat_id, reply)
    return skip("entregue ao Ergon")


async def on_pre_dispatch(event: Any = None, gateway: Any = None, **_: Any) -> dict[str, Any] | None:
    """Telegram e Discord: nada chega ao agente do Hermes por fora do Ergon. Outras plataformas: como antes."""
    try:
        source = getattr(event, "source", None)
        platform = str(getattr(getattr(source, "platform", None), "value", "") or "")
    except Exception:  # noqa: BLE001
        return None
    if platform not in _CANAIS:
        return None
    try:
        return await _canal_entrada(event, source, platform, gateway)
    except Exception:  # noqa: BLE001 - porta de entrada: na dúvida, não passa
        logger.warning("ergon_bridge: falha na entrada do canal %s", platform, exc_info=False)
        return {"action": "skip", "reason": "ergon: falha na entrada do canal"}


async def _canal_clique(platform: str, user_id: str, chat_id: str, dado: str, message_id: str, evento: str) -> str | None:
    """Clique em Aprovar/Recusar: só de quem está ligado; a decisão é do Ergon (a mesma função da tela)."""
    store = _canal_store()
    if not await asyncio.to_thread(store.is_approved, platform, user_id):
        return None
    payload = {"schema": "ergon.canais.v1", "tipo": "clique", "canal": platform, "user_id": user_id, "chat_id": chat_id,
               "dado": dado[:80], "message_id": message_id[:200], "evento": evento[:200]}
    try:
        r = await asyncio.to_thread(_post_to, _url_for("/internal/bridge/v1/canais/entrada"), payload)
    except Exception:  # noqa: BLE001
        return _CANAL_FORA
    reply = r.get("reply")
    return reply if isinstance(reply, str) and reply.strip() else None


async def _tg_clique(update: Any, context: Any) -> None:  # noqa: ARG001
    try:
        q = update.callback_query
        data = str(getattr(q, "data", "") or "")
        if not data.startswith("erg:"):
            return
        try:
            await q.answer()
        except Exception:  # noqa: BLE001
            pass
        msg = getattr(q, "message", None)
        chat = getattr(msg, "chat", None)
        if msg is None or str(getattr(chat, "type", "")) != "private":
            return
        reply = await _canal_clique("telegram", str(q.from_user.id), str(msg.chat_id), data[4:], str(msg.message_id), str(getattr(q, "id", "")))
        if reply:
            await msg.get_bot().send_message(chat_id=msg.chat_id, text=reply[:4000])
    except Exception:  # noqa: BLE001
        logger.warning("ergon_bridge: clique do Telegram não tratado", exc_info=False)


async def _dc_interacao(interaction: Any) -> None:
    try:
        data = getattr(interaction, "data", None) or {}
        cid = str(data.get("custom_id") or "") if isinstance(data, dict) else ""
        if not cid.startswith("erg:"):
            return
        try:
            if not interaction.response.is_done():
                await interaction.response.defer()
        except Exception:  # noqa: BLE001
            pass
        if getattr(interaction, "guild", None) is not None:
            return
        msg = getattr(interaction, "message", None)
        chat_id = str(getattr(interaction, "channel_id", "") or "")
        reply = await _canal_clique("discord", str(interaction.user.id), chat_id, cid[4:], str(getattr(msg, "id", "") or ""), str(getattr(interaction, "id", "")))
        if reply:
            await interaction.followup.send(reply[:1900])
    except Exception:  # noqa: BLE001
        logger.warning("ergon_bridge: clique do Discord não tratado", exc_info=False)


def _canal_vivo(platform: str, native: Any, adapter: Any) -> None:
    global _canal_laco_ligado
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    _canal_vivos[platform] = {"native": native, "adapter": adapter, "loop": loop}
    with _lock:
        if _canal_laco_ligado:
            return
        _canal_laco_ligado = True
    threading.Thread(target=_canal_laco, name="ergon-canais", daemon=True).start()


def _fabrica_telegram(native: Any, adapter: Any) -> None:
    from telegram.ext import CallbackQueryHandler  # a biblioteca que o adaptador do Hermes usa
    native.add_handler(CallbackQueryHandler(_tg_clique, pattern=r"^erg:"))
    _canal_vivo("telegram", native, adapter)


def _fabrica_discord(native: Any, adapter: Any) -> None:
    native.add_listener(_dc_interacao, "on_interaction")
    _canal_vivo("discord", native, adapter)


async def _canal_enviar_async(item: dict[str, Any]) -> dict[str, Any]:
    platform = str(item.get("canal") or "")
    vivo = _canal_vivos.get(platform)
    if not vivo:
        return {"ok": False, "erro": "desligado"}
    native, adapter = vivo["native"], vivo["adapter"]
    tipo = str(item.get("tipo") or "texto")
    chat_id = str(item.get("chat_id") or "")
    texto = str(item.get("texto") or "")
    botoes = [(str(b[0])[:40], str(b[1])[:56]) for b in (item.get("botoes") or []) if isinstance(b, list) and len(b) == 2][:4]
    limite = _CANAL_TEXTO_MAX[platform]
    if tipo == "digitando":
        await adapter.send_typing(chat_id)
        return {"ok": True}
    if tipo == "texto":
        r = await adapter.send(chat_id, texto)  # o adaptador formata e divide o texto longo
        if getattr(r, "success", False):
            return {"ok": True, "message_id": str(getattr(r, "message_id", "") or "")}
        return {"ok": False, "erro": str(getattr(r, "error", "") or "falhou")[:200], "passageiro": bool(getattr(r, "retryable", False))}
    if platform == "telegram":
        bot = native.bot
        if tipo == "cartao":
            from telegram import InlineKeyboardButton, InlineKeyboardMarkup
            teclado = InlineKeyboardMarkup([[InlineKeyboardButton(rotulo, callback_data="erg:" + dado) for rotulo, dado in botoes]]) if botoes else None
            m = await bot.send_message(chat_id=int(chat_id), text=texto[:limite], reply_markup=teclado)
            return {"ok": True, "message_id": str(m.message_id)}
        if tipo == "editar":
            await bot.edit_message_text(chat_id=int(chat_id), message_id=int(item.get("message_id") or 0), text=texto[:limite], reply_markup=None)
            return {"ok": True}
    if platform == "discord":
        import discord  # a biblioteca que o adaptador do Hermes usa
        user_id = int(item.get("user_id") or 0)
        user = native.get_user(user_id) or await native.fetch_user(user_id)
        canal = user.dm_channel or await user.create_dm()
        if tipo == "cartao":
            view = None
            if botoes:
                view = discord.ui.View(timeout=None)
                for i, (rotulo, dado) in enumerate(botoes):
                    view.add_item(discord.ui.Button(label=rotulo, custom_id="erg:" + dado,
                                                    style=discord.ButtonStyle.success if i == 0 else discord.ButtonStyle.secondary))
            m = await canal.send(texto[:limite], view=view) if view is not None else await canal.send(texto[:limite])
            if view is not None:
                view.stop()  # o clique chega pelo on_interaction (vale também depois de reiniciar)
            return {"ok": True, "message_id": str(m.id)}
        if tipo == "editar":
            await canal.get_partial_message(int(item.get("message_id") or 0)).edit(content=texto[:limite], view=None)
            return {"ok": True}
    return {"ok": False, "erro": "tipo desconhecido"}


def _canal_enviar(item: dict[str, Any]) -> dict[str, Any]:
    """Manda um item da saída pelo adaptador vivo, no laço do gateway. Devolve a confirmação para o Ergon."""
    ident = str(item.get("id") or "")
    vivo = _canal_vivos.get(str(item.get("canal") or ""))
    loop = vivo.get("loop") if vivo else None
    if loop is None or not loop.is_running():
        return {"id": ident, "ok": False, "erro": "sem conexão", "passageiro": True}
    try:
        r = asyncio.run_coroutine_threadsafe(_canal_enviar_async(item), loop).result(timeout=45)
    except Exception as exc:  # noqa: BLE001
        nome = type(exc).__name__
        # sem rede, limite da plataforma, tempo esgotado: o Ergon tenta de novo; o resto é definitivo
        passageiro = any(x in nome for x in ("Timeout", "Network", "RetryAfter", "Connect", "ServerError", "RateLimited"))
        return {"id": ident, "ok": False, "erro": nome[:80], "passageiro": passageiro}
    return {"id": ident, **r}


def _canal_laco() -> None:
    """Busca no Ergon o que há para mandar (espera longa) e confirma o que saiu. Nunca derruba o gateway."""
    acks: list[dict[str, Any]] = []
    falhas = 0
    while True:
        try:
            r = _post_to(_url_for("/internal/bridge/v1/canais/saida"),
                         {"schema": "ergon.canais.v1", "canais": sorted(_canal_vivos), "acks": acks, "espera": 20}, timeout=32)
            acks = []
            falhas = 0
            for item in (r.get("itens") or [])[:20]:
                if isinstance(item, dict):
                    acks.append(_canal_enviar(item))
            if not acks:
                time.sleep(0.2)
        except Exception:  # noqa: BLE001 - Ergon fechado ou reiniciando: espera e tenta de novo (as confirmações ficam)
            falhas += 1
            time.sleep(min(60.0, 2.0 * 2 ** min(falhas, 5)))


def _canal_estado() -> dict[str, Any]:
    """O que o Ergon mostra na tela: se o código do bot está guardado, a situação da conexão e quem está ligado."""
    from gateway.pairing import PairingStore  # módulos do Hermes
    from hermes_cli.config import load_env
    env = load_env()
    plats: dict[str, Any] = {}
    try:
        from gateway.status import read_runtime_status
        rt = read_runtime_status() or {}
        plats = rt.get("platforms") if isinstance(rt.get("platforms"), dict) else {}
    except Exception:  # noqa: BLE001
        plats = {}
    store = PairingStore()
    out: dict[str, Any] = {}
    for c in _CANAIS:
        p = plats.get(c) if isinstance(plats.get(c), dict) else {}
        out[c] = {
            "configurado": bool(str(env.get(_CANAL_ENV[c]) or "").strip()),
            "estado": str(p.get("state") or "")[:40] or None, "erro": str(p.get("error_code") or "")[:60] or None,
            "ligados": [{"user_id": str(a.get("user_id") or ""), "user_name": str(a.get("user_name") or "")[:120]} for a in store.list_approved(c)][:5],
        }
    return out


def _canal_reiniciar() -> bool:
    """O gateway só lê o .env ao iniciar: pede o reinício pelo próprio Hermes ("hermes gateway restart", o que o botão do
    painel dele roda). Pelo painel (POST /api/gateway/restart) não deu nesta imagem: o processo que ele cria termina com
    "no dependency environment is committed for this install" e o gateway segue igual (conferido no motor de verdade); o
    comando direto, como o usuário do motor, reinicia sob o s6. Sai depois da resposta desta rota (a ponte de controle pode
    estar no próprio gateway) e solto do processo, para não morrer junto com ele."""
    cli = os.environ.get("ERGON_HERMES_CLI", "/opt/hermes/.venv/bin/hermes")
    if not os.path.exists(cli):
        return False

    def ir() -> None:
        time.sleep(0.8)
        try:
            subprocess.Popen([cli, "gateway", "restart"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, start_new_session=True)
        except Exception:  # noqa: BLE001
            logger.warning("ergon_bridge: não consegui pedir o reinício do gateway", exc_info=False)

    threading.Thread(target=ir, name="ergon-canais-reinicio", daemon=True).start()
    return True


def _canal_limpar(store: Any, platform: str, manter: str = "") -> None:
    for a in store.list_approved(platform):
        if str(a.get("user_id") or "") != manter:
            store.revoke(platform, str(a.get("user_id") or ""))


def _canal_zerar_espera(store: Any, platform: str) -> None:
    """Bot novo (ou canal desligado): a espera de 10 minutos entre pedidos de código, que o Hermes guarda por pessoa, não
    vale para o bot seguinte (a pessoa acabou de trocar o código do bot e vai pedir o código de pareamento de novo). O
    bloqueio por tentativas erradas fica como está."""
    try:
        with store._lock:
            limites = store._limits()
            novos = {k: x for k, x in limites.items() if not str(k).startswith(platform + ":")}
            if novos != limites:
                store._save_limits(novos)
    except Exception:  # noqa: BLE001 - sem isso, a pessoa só espera os 10 minutos
        logger.warning("ergon_bridge: não zerei a espera do pareamento", exc_info=False)


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
    # o modelo de cada tarefa de apoio (resumir a conversa, dar nome, ver imagens…): a lista é a do Hermes, com as
    # tarefas que os plugins registrarem; gravar é POST /api/model/set com scope "auxiliary" (ver _sanitize_model_set)
    ("GET", re.compile(r"/api/model/auxiliary"), ()),
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
# ponte. Agendamentos e mensagens do motor ficam de fora (o Ergon tem rotinas e canais próprios).
# rc.27: navegador, vídeo (ver e criar), busca no X, leitura de arquivos e voz entram na lista do que a pessoa pode ligar.
# Regra do dono (12/11): o navegador, ver vídeos, ler arquivos e a voz vêm ligados (migração 10 do cofre), com o aviso de
# custo ou de risco na tela; busca no X e criar vídeos precisam da chave de outro serviço e ligam quando a pessoa a tiver.
_SAFE_TOOLSETS = frozenset(_csv("ERGON_SAFE_TOOLSETS", "todo,web,vision,image_gen,skills,ergon_conexoes,ergon_cartoes,browser,video,video_gen,x_search,file,tts"))
# sempre ligados na API, qualquer que seja a lista pedida: a lista de passos e os cartões (sem eles o agente não tem como
# perguntar nem pedir uma chave com segurança; quem pode usar é decidido a cada chamada, na trava)
_SEMPRE_TOOLSETS = frozenset({"todo", _TS_CARTOES})
_GUARDED_TOOLSETS = frozenset(_csv("ERGON_GUARDED_TOOLSETS", "code_execution,terminal"))
_MAX_BODY = 16 * 1024
_ROTAS_GRANDES = ("/ergon/v1/meta/julgar", "/ergon/v1/revisao/pedido")
_control_started = False
# Imagens que o motor gera (criar imagens): a resposta da execução traz só "MEDIA:<caminho>" — a rota de execuções do
# Hermes não embute a imagem, e o Ergon não enxerga o disco do motor. O Ergon busca por aqui, só desta pasta, só imagem.
_MEDIA_TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}
_MEDIA_MAX = 10 * 1024 * 1024


def _known(cfg: Any, platform: str) -> list[str]:
    """known_plugin_toolsets[plataforma] como o Hermes lê (lista; outra coisa vale vazio)."""
    known = cfg.get("known_plugin_toolsets") if isinstance(cfg, dict) else None
    lst = known.get(platform) if isinstance(known, dict) else None
    return sorted({str(x) for x in lst}) if isinstance(lst, list) else []


def _vault_config() -> int:
    """A última migração de configuração que o cofre recebeu (marcas gravadas por hermes/vault/ergon-vault.py, lidas
    como lá): a maior versão legível entre .ergon-migracoes = {"versao": N} e o .ergon-config das versões antigas (texto
    puro vale no máximo 1). Marca ilegível (vazia, cortada, bytes estranhos) não conta: vale a outra. Nenhuma: 0."""
    home = os.environ.get("HERMES_HOME", "/opt/data")
    versoes = []
    for nome in (_MIGRACOES_MARKER, _CONFIG_MARKER):
        try:
            with open(os.path.join(home, nome), "rb") as f:
                raw = f.read(200).decode("utf-8", errors="replace").strip()
        except Exception:  # noqa: BLE001
            continue
        if raw.isdigit():
            versoes.append(min(int(raw), 1))
            continue
        try:
            v = json.loads(raw).get("versao") if raw.startswith("{") else None
        except Exception:  # noqa: BLE001
            v = None
        if isinstance(v, int) and not isinstance(v, bool) and v >= 0:
            versoes.append(v)
    return max(versoes, default=0)


def _dados_antigos() -> bool | None:
    """O cofre recebeu a cópia dos dados de antes do cofre (o volume antigo em texto aberto, montado em /legacy na
    primeira abertura)? Lido da marca que hermes/vault/ergon-vault.py grava ao criar o cofre ({"migrated_from_legacy":
    true/false}). Sem marca, ou ilegível: None (não se sabe). O servidor só apaga o volume antigo com True."""
    home = os.environ.get("HERMES_HOME", "/opt/data")
    try:
        with open(os.path.join(home, ".ergon-vault"), "rb") as f:
            v = json.loads(f.read(500).decode("utf-8", errors="replace")).get("migrated_from_legacy")
    except Exception:  # noqa: BLE001
        return None
    return v if isinstance(v, bool) else None


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


# Chave própria (BYOK): a lista é a do próprio Hermes (o catálogo de provedores do /api/env: só as credenciais
# principais de provedor, nunca outras variáveis). Nous e ChatGPT entram por login, não por chave. O valor nunca
# volta: a consulta diz apenas se está ligada.
_BYOK_LOGIN = {"nous", "openai-codex"}
_BYOK_KEY = re.compile(r"[A-Za-z0-9_.:+/=-]{8,400}")
# endpoints próprios (OpenAI-compatível): "outro" (na internet, https) e os locais (LM Studio, Ollama: rede local)
_BYOK_CUSTOM = {"outro": "https", "lmstudio": "local", "ollama": "local"}
_BYOK_CUSTOM_ID = re.compile(r"byok-[a-z0-9-]{1,40}")


def _byok_catalog() -> dict[str, dict[str, Any]]:
    status, data = _dash_call("GET", "/api/env", "", None)
    if status != 200:
        raise RuntimeError(f"painel do motor respondeu {status}")
    env = json.loads(data or b"{}")
    out: dict[str, dict[str, Any]] = {}
    for var, row in env.items():
        prov = str((row or {}).get("provider") or "")
        if not prov or prov in _BYOK_LOGIN or not row.get("is_password") or not row.get("provider_primary") or row.get("channel_managed"):
            continue
        if not re.fullmatch(r"[A-Z][A-Z0-9_]{2,60}", var) or not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{1,40}", prov):
            continue
        url = row.get("url") if isinstance(row.get("url"), str) and str(row.get("url")).startswith("https://") else None
        out.setdefault(prov, {"var": var, "name": str(row.get("provider_label") or prov)[:60], "url": url, "set": bool(row.get("is_set"))})
    return out


def _sanitize_byok(body: dict[str, Any]) -> tuple[str, str]:
    provider, key = str(body.get("provider") or "").strip(), str(body.get("key") or "").strip()
    cat = _byok_catalog()
    if provider not in cat:
        raise ValueError("provedor de chave própria desconhecido")
    if not _BYOK_KEY.fullmatch(key):
        raise ValueError("a chave não tem o formato de uma chave de API")
    return cat[provider]["var"], key


def _byok_url(kind: str, raw: str) -> str:
    """Endereço de um endpoint próprio: "outro" só https na internet; LM Studio e Ollama só na rede local. Nunca o
    próprio contêiner (127.*, localhost, ::1: ali estão a ponte e o painel do motor) nem endereços de metadados."""
    import ipaddress
    import socket
    u = urllib.parse.urlsplit(raw.strip())
    if u.scheme not in ("http", "https") or not u.hostname or u.username or u.password or u.query or u.fragment:
        raise ValueError("endereço inválido")
    if _BYOK_CUSTOM[kind] == "https" and u.scheme != "https":
        raise ValueError("use um endereço https")
    try:
        ips = {ipaddress.ip_address(a[4][0]) for a in socket.getaddrinfo(u.hostname, u.port or (443 if u.scheme == "https" else 80))}
    except (OSError, ValueError):
        raise ValueError("não encontrei esse endereço")
    for ip in ips:
        if ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast or ip.is_reserved:
            raise ValueError("esse endereço não é permitido")
        if _BYOK_CUSTOM[kind] == "https" and ip.is_private:
            raise ValueError("para a rede local, use LM Studio ou Ollama")
        if _BYOK_CUSTOM[kind] == "local" and not ip.is_private:
            raise ValueError("modelos locais: use o endereço do computador na rede local")
    return raw.strip().rstrip("/")


# Perfil do Hermes (hermes_constants.PROFILE_ID_RE): as rotas de modelo aceitam /p/<perfil>/... e a ponte repassa ao
# painel como ?profile=<perfil> (cada agente da equipe é um perfil; sem o prefixo, vale o do motor).
_PERFIL = r"[a-z0-9][a-z0-9_-]{0,63}"
_ROTAS_COM_PERFIL = frozenset({"/api/model/info", "/api/model/auxiliary", "/api/model/set", "/ergon/v1/delegacao"})
_PROVEDOR = r"[a-z0-9][a-z0-9_.-]{0,40}"
_MODELO = r"[\w./:@+-]{1,160}"
_TAREFA = r"[a-z0-9][a-z0-9_.-]{0,63}"


def _sanitize_model_set(body: dict[str, Any]) -> dict[str, Any]:
    """POST /api/model/set: só o modelo principal (scope main, o de sempre) ou o de UMA tarefa de apoio (scope
    auxiliary). Tarefa de apoio: provider "auto" e model "" = usar o principal; "__reset__" = todas voltam ao principal.
    Endereço, chave e esforço de raciocínio nunca passam: só contas que o motor já tem."""
    provider, model = str(body.get("provider") or "").strip(), str(body.get("model") or "").strip()
    confirm = bool(body.get("confirm_expensive_model"))
    if str(body.get("scope") or "main") == "auxiliary":
        task = str(body.get("task") or "").strip()
        if task == "__reset__":
            return {"scope": "auxiliary", "task": task, "provider": "auto", "model": ""}
        if not re.fullmatch(_TAREFA, task):
            raise ValueError("tarefa inválida")
        if provider == "auto" and not model:
            return {"scope": "auxiliary", "task": task, "provider": "auto", "model": ""}
        if not re.fullmatch(_PROVEDOR, provider) or provider == "auto" or not re.fullmatch(_MODELO, model):
            raise ValueError("provedor ou modelo inválido")
        return {"scope": "auxiliary", "task": task, "provider": provider, "model": model, "confirm_expensive_model": confirm}
    if not re.fullmatch(_PROVEDOR, provider) or not re.fullmatch(_MODELO, model):
        raise ValueError("provedor ou modelo inválido")
    return {"scope": "main", "provider": provider, "model": model, "confirm_expensive_model": confirm}


def _sanitize_delegacao(body: dict[str, Any]) -> dict[str, str]:
    """O modelo dos ajudantes temporários (delegation.provider/model): os dois vazios = o mesmo de quem pediu a ajuda."""
    provider, model = str(body.get("provider") or "").strip(), str(body.get("model") or "").strip()
    if not provider and not model:
        return {"provider": "", "model": ""}
    if not re.fullmatch(_PROVEDOR, provider) or not re.fullmatch(_MODELO, model):
        raise ValueError("provedor ou modelo inválido")
    return {"provider": provider, "model": model}


def modelos_visao(pares: Any) -> list[bool | None]:
    """Para cada {provider, model}: o modelo aceita imagem? True/False pelo que o Hermes sabe (catálogo dele e ajustes
    da configuração); None = não se sabe."""
    out: list[bool | None] = []
    try:
        from agent.image_routing import _lookup_supports_vision  # módulo do Hermes
        from hermes_cli.config import load_config_readonly
        cfg = load_config_readonly()
    except Exception:  # noqa: BLE001
        _lookup_supports_vision, cfg = None, None
    for par in (pares if isinstance(pares, list) else [])[:40]:
        v = None
        if _lookup_supports_vision is not None and isinstance(par, dict):
            provider, model = str(par.get("provider") or ""), str(par.get("model") or "")
            if re.fullmatch(_PROVEDOR, provider) and re.fullmatch(_MODELO, model):
                try:
                    v = _lookup_supports_vision(provider, model, cfg)
                except Exception:  # noqa: BLE001
                    v = None
        out.append(v if isinstance(v, bool) else None)
    return out


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


# ---------------------------------------------------------------- 3b. rotinas no agendador do motor (rc.27)
# Cada rotina do Ergon com horário vira um job do agendador do Hermes (cron) no PERFIL do agente que a executa: o
# agendador é o relógio (horário no fuso da pessoa, recuperação do horário perdido, pausar, rodar agora). O job é
# "sem agente" (no_agent + script): o script, gerado aqui, só deixa um aviso numa pasta (sem rede, sem segredo: o ambiente
# dos scripts do Hermes tira as chaves), e este plugin entrega o aviso ao Ergon (/internal/bridge/v1/rotina/disparo).
# O trabalho do agente continua por /p/<perfil>/v1/runs, pedido pelo Ergon: a coleta dos dados (as contas conectadas
# ficam no Ergon), a conferência de evidência, o acompanhamento ao vivo, o parar, a conversa da rotina e as aprovações
# (num job com agente, o Hermes nega toda aprovação: "cron jobs run without a user present") continuam como eram.
_ROTINA_ID = re.compile(r"rtn_[0-9a-f]{32}")
_JOB_ID = re.compile(r"[a-f0-9]{12}")
_HORA = re.compile(r"([01]\d|2[0-3]):([0-5]\d)")
_DISPAROS_PASSO = float(os.environ.get("ERGON_DISPAROS_PASSO_S", "2"))
_DISPARO_VALE_S = 3 * 86400  # aviso que o Ergon não recebeu em 3 dias: fica para trás (o Ergon registra como perdido)
_disparos_iniciado = False


def _disparos_dir() -> Path:
    return _raiz() / "ergon_bridge" / "disparos"


def _script_da_rotina(rid: str) -> str:
    return f"ergon_rotina_{rid}.py"


def _texto_do_script(rid: str, perfil: str) -> str:
    """O script do job: deixa um aviso (rotina, perfil, hora) na pasta dos disparos e termina sem nada na saída (o
    Hermes registra a rodada como silenciosa, sem chamar modelo)."""
    return (
        "# Ergon: aviso do horário de uma rotina (gerado pelo plugin do Ergon; não edite)\n"
        "import json, os, pathlib, time\n"
        f"d = pathlib.Path({str(_disparos_dir())!r})\n"
        "d.mkdir(parents=True, exist_ok=True)\n"
        f"nome = '{rid}-%d.json' % time.time_ns()\n"
        "tmp = d / ('.' + nome)\n"
        f"tmp.write_text(json.dumps({{'rotina': {rid!r}, 'perfil': {perfil!r}, 'em': time.time()}}), encoding='utf-8')\n"
        "os.replace(tmp, d / nome)\n"
    )


def _agenda_no_motor(dias: list[int], hora: str, fuso: str) -> str:
    """A expressão cron no fuso do motor para "estes dias da semana (0 = domingo), a esta hora, neste fuso". O agendador
    do Hermes conta no fuso dele (timezone do perfil, ou o do servidor): o horário da pessoa é convertido aqui, com o
    deslocamento de agora (o Ergon confere a próxima execução e manda de novo se o horário de verão mudar a conta)."""
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    m = _HORA.fullmatch(hora or "")
    if not m or not dias or any(not isinstance(d, int) or d < 0 or d > 6 for d in dias):
        raise ValueError("agenda inválida: dias 0–6 e hora HH:MM")
    try:
        origem = ZoneInfo(fuso)
    except Exception as exc:  # noqa: BLE001
        raise ValueError("fuso desconhecido") from exc
    try:
        import hermes_time  # módulo do Hermes: o fuso do perfil (config.yaml) ou o do servidor
        destino = hermes_time.get_timezone() or datetime.now().astimezone().tzinfo
    except Exception:  # noqa: BLE001
        destino = datetime.now().astimezone().tzinfo
    hh, mm = int(m.group(1)), int(m.group(2))
    hoje = datetime.now(origem).date()
    pares: list[tuple[int, int, int]] = []
    for i in range(7):
        d = hoje + timedelta(days=i)
        if d.isoweekday() % 7 not in dias:
            continue
        no_motor = datetime(d.year, d.month, d.day, hh, mm, tzinfo=origem).astimezone(destino)
        pares.append((no_motor.isoweekday() % 7, no_motor.hour, no_motor.minute))
    contagem: dict[tuple[int, int], int] = {}
    for _w, h, mi in pares:
        contagem[(h, mi)] = contagem.get((h, mi), 0) + 1
    h, mi = max(contagem, key=lambda k: contagem[k])
    semana = sorted({w for w, ph, pm in pares if (ph, pm) == (h, mi)})
    return f"{mi} {h} * * {','.join(str(w) for w in semana)}"


def _job_da_rotina(rid: str) -> dict[str, Any] | None:
    """O job desta rotina no perfil atual (pelo script, que leva o id da rotina)."""
    from cron import jobs as cj  # módulo do Hermes
    nome = _script_da_rotina(rid)
    for j in cj.list_jobs(include_disabled=True):
        if str(j.get("script") or "") == nome:
            return j
    return None


def _job_resumo(rid: str, j: dict[str, Any] | None) -> dict[str, Any]:
    if not j:
        return {"rotina": rid, "job_id": None}
    estado = str(j.get("state") or ("paused" if j.get("enabled") is False else "scheduled"))
    return {"rotina": rid, "job_id": str(j.get("id") or ""), "proxima": j.get("next_run_at"), "ultima": j.get("last_run_at"),
            "ultimo_estado": j.get("last_status"), "pausada": estado == "paused" or j.get("enabled") is False,
            "agenda": (j.get("schedule") or {}).get("expr") if isinstance(j.get("schedule"), dict) else None}


def _remover_no_perfil(rid: str) -> bool:
    from cron import jobs as cj  # módulo do Hermes
    j = _job_da_rotina(rid)
    if j:
        cj.remove_job(str(j["id"]))
    with contextlib.suppress(OSError):
        (_perfil_dir_atual() / "scripts" / _script_da_rotina(rid)).unlink()
    return bool(j)


def _perfil_dir_atual() -> Path:
    from hermes_constants import get_hermes_home  # módulo do Hermes
    return Path(get_hermes_home())


class _no_agendador_do_perfil(_no_perfil):
    """Dentro do perfil do agente E no agendador dele (cron/jobs.json da pasta do perfil)."""

    def __enter__(self) -> Path:
        d = super().__enter__()
        from cron import jobs as cj  # módulo do Hermes
        self._loja = cj.use_cron_store(d)
        self._loja.__enter__()
        return d

    def __exit__(self, *a: Any) -> None:
        try:
            self._loja.__exit__(*a)
        finally:
            super().__exit__(*a)


def rotina_garantir(rid: str, body: dict[str, Any]) -> dict[str, Any]:
    """Cria ou atualiza o job da rotina no perfil do agente (idempotente). body: perfil, nome, dias, hora, fuso, ligada
    (false = pausada no agendador) e, se o agente mudou, antes (o perfil de onde o job sai)."""
    if not _ROTINA_ID.fullmatch(rid or ""):
        raise ValueError("rotina inválida")
    perfil = str(body.get("perfil") or "")
    antes = str(body.get("antes") or "")
    nome = re.sub(r"\s+", " ", str(body.get("nome") or "rotina")).strip()[:80] or "rotina"
    dias = body.get("dias") if isinstance(body.get("dias"), list) else []
    expr = _agenda_no_motor([int(d) for d in dias if isinstance(d, (int, float))], str(body.get("hora") or ""), str(body.get("fuso") or "UTC"))
    ligada = body.get("ligada") is not False
    if antes and antes != perfil and _PERFIL_NOME.fullmatch(antes) and _perfil_dir(antes).is_dir():
        with _no_agendador_do_perfil(antes):
            _remover_no_perfil(rid)
    from cron import jobs as cj  # módulo do Hermes
    with _no_agendador_do_perfil(perfil) as d:
        scripts = d / "scripts"
        scripts.mkdir(parents=True, exist_ok=True)
        arq = scripts / _script_da_rotina(rid)
        texto = _texto_do_script(rid, perfil)
        if not arq.is_file() or arq.read_text(encoding="utf-8") != texto:
            _gravar_texto(arq, texto)
        j = _job_da_rotina(rid)
        titulo = f"Ergon · {nome}"
        criado = False
        if not j:
            j = cj.create_job(prompt=None, schedule=expr, name=titulo, deliver="local", script=arq.name, no_agent=True,
                              paused=not ligada, paused_reason=None if ligada else "pausada no Ergon")
            criado = True
        else:
            atual = (j.get("schedule") or {}).get("expr") if isinstance(j.get("schedule"), dict) else None
            mudou: dict[str, Any] = {}
            if atual != expr:
                mudou["schedule"] = expr
            if str(j.get("name") or "") != titulo:
                mudou["name"] = titulo
            if mudou:
                j = cj.update_job(str(j["id"]), mudou) or j
            pausada = str(j.get("state") or "") == "paused" or j.get("enabled") is False
            if ligada and pausada:
                j = cj.resume_job(str(j["id"])) or j
            elif not ligada and not pausada:
                j = cj.pause_job(str(j["id"]), reason="pausada no Ergon") or j
        return {**_job_resumo(rid, cj.get_job(str(j["id"])) or j), "criado": criado, "perfil": perfil}


def rotina_remover(rid: str, perfil: str) -> dict[str, Any]:
    if not _ROTINA_ID.fullmatch(rid or ""):
        raise ValueError("rotina inválida")
    if not _perfil_dir(perfil).is_dir():
        return {"ok": True, "removida": False}
    with _no_agendador_do_perfil(perfil):
        return {"ok": True, "removida": _remover_no_perfil(rid)}


def rotina_rodar(rid: str, perfil: str) -> dict[str, Any]:
    """Rodar agora pelo agendador: o job dispara no próximo tique dele (até um minuto)."""
    if not _ROTINA_ID.fullmatch(rid or ""):
        raise ValueError("rotina inválida")
    from cron import jobs as cj  # módulo do Hermes
    with _no_agendador_do_perfil(perfil):
        j = _job_da_rotina(rid)
        if not j:
            raise LookupError("esta rotina não está no agendador deste agente")
        return _job_resumo(rid, cj.trigger_job(str(j["id"])) or j)


def rotinas_listar(perfil: str) -> list[dict[str, Any]]:
    from cron import jobs as cj  # módulo do Hermes
    with _no_agendador_do_perfil(perfil):
        out = []
        for j in cj.list_jobs(include_disabled=True):
            m = re.fullmatch(r"ergon_rotina_(rtn_[0-9a-f]{32})\.py", str(j.get("script") or ""))
            if m:
                out.append(_job_resumo(m.group(1), j))
        return out


def _entregar_disparos() -> int:
    """Os avisos deixados pelos scripts dos jobs vão ao Ergon; o que não foi entregue (Ergon fora) fica para a próxima volta."""
    d = _disparos_dir()
    if not d.is_dir():
        return 0
    n = 0
    for arq in sorted(d.glob("rtn_*.json")):
        try:
            dados = json.loads(arq.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001 - aviso ilegível: sai
            with contextlib.suppress(OSError):
                arq.unlink()
            continue
        rid = str(dados.get("rotina") or "")
        em = float(dados.get("em") or 0)
        if not _ROTINA_ID.fullmatch(rid) or time.time() - em > _DISPARO_VALE_S:
            with contextlib.suppress(OSError):
                arq.unlink()
            continue
        try:
            _post_to(_url_for("/internal/bridge/v1/rotina/disparo"), {"rotina": rid, "perfil": str(dados.get("perfil") or "")[:40], "em": em}, timeout=10)
        except Exception:  # noqa: BLE001 - Ergon fora: tenta de novo
            break
        with contextlib.suppress(OSError):
            arq.unlink()
        n += 1
    return n


def _disparos_laco() -> None:
    while True:
        try:
            _entregar_disparos()
        except Exception:  # noqa: BLE001 - nunca derruba o motor
            pass
        time.sleep(_DISPAROS_PASSO)


def _iniciar_disparos() -> None:
    """Um entregador por processo (o gateway, onde o agendador roda os scripts)."""
    global _disparos_iniciado
    with _lock:
        if _disparos_iniciado or not _token():
            return
        _disparos_iniciado = True
    threading.Thread(target=_disparos_laco, name="ergon-rotinas", daemon=True).start()


# ---------------------------------------------------------------- 3c. aprovações nativas (rc.27)
# O que pede o sim da pessoa no Ergon (uma ação numa conta que pede confirmação; abrir sites ou rodar programas depois de
# ler as contas, com a proteção ligada) usa o portão de aprovação do próprio Hermes (tools.approval.request_tool_approval:
# o mesmo dos comandos perigosos do Terminal): o turno fica parado até a pessoa decidir no cartão do Ergon, pelo prazo do
# motor (approvals.timeout, 5 min). O Ergon recebe o pedido no fluxo de eventos da execução (approval.request) e responde
# pela API (POST /v1/runs/{id}/approval). À prova de modelo: depois do portão, a decisão que vale é a que está no Ergon
# (o plugin pergunta de novo); se a pessoa não respondeu no prazo, o cartão continua com ela e a resposta segue depois,
# como era antes.
def _portao_nativo() -> Any:
    try:
        from tools.approval import request_tool_approval  # módulo do Hermes
        return request_tool_approval
    except Exception:  # noqa: BLE001
        return None


def _segurar_ate_decidir(tool_name: str, texto: str, cartao: str) -> bool:
    """Para o turno no portão de aprovação do motor até a pessoa decidir o cartão (ou o prazo acabar). True = esperou."""
    portao = _portao_nativo()
    if portao is None or not re.fullmatch(r"apr_[0-9a-f]{32}", cartao or ""):
        return False
    try:
        portao(tool_name, re.sub(r"\s+", " ", texto or "").strip()[:900] or "a pessoa precisa aprovar", rule_key=f"ergon_{cartao}")
    except Exception:  # noqa: BLE001 - o portão falhou: vale o que o Ergon disser
        return False
    return True

# ---------------------------------------------------------------- 4. capacidades da equipe (rc.27)
# Tudo o que o Hermes oferece e o Ergon mostra em Configurações › Capacidades da equipe. Cada rota é fechada: o Ergon
# manda só o que a tela escolhe, e daqui sai só o que a tela mostra. O que é benefício vem ligado (regra do dono, 12/11):
# as proteções do Terminal (checkpoints, aviso de código inseguro) e a limpeza dos arquivos temporários pela migração 7 do
# cofre; as conquistas são só leitura do histórico local. A pessoa desliga para economizar.
_PLUGINS_DO_MOTOR = {"codigo_inseguro": "security-guidance", "limpeza": "disk-cleanup"}
_NOME = re.compile(r"[a-z0-9][a-z0-9_.-]{0,60}")
_ID_COMPETENCIA = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.:@/+-]{1,200}")
_FLUXO = re.compile(r"[A-Za-z0-9_-]{8,80}")
_VOZ_MAX = 25 * 1024 * 1024
_AUDIO_EXT = (".ogg", ".oga", ".opus", ".mp3", ".m4a", ".mp4", ".wav", ".webm", ".flac", ".aac")
# Conectores prontos (MCP): sem a escrita liberada pela pessoa no Ergon, só passam as ferramentas de consulta. A lista é
# de permissão (o que não se reconhece como consulta conta como escrita).
_MCP_PREFIXO = "mcp__"
_MCP_CONSULTA = frozenset({"get", "list", "search", "read", "fetch", "find", "query", "describe", "view", "lookup", "count", "show",
                           "whoami", "retrieve", "browse", "preview", "inspect", "status", "info", "ping", "help"})
# "resolve" e "check" ficaram fora do começo de consulta: em muitos conectores resolvem um problema ou marcam um item
# (resolve_issue, check_item). resolve_<algo>_id (achar o identificador de algo) continua consulta.
_MCP_RESOLVE_ID = re.compile(r"^resolve_[a-z0-9_]*_id$")
# palavras que, em qualquer parte do nome, mudam dados: get_or_create_user, status_update, read_and_delete_message…
_MCP_ESCRITA = frozenset({
    "create", "add", "insert", "update", "upsert", "edit", "modify", "patch", "set", "put", "write", "save", "delete", "remove",
    "destroy", "erase", "purge", "clear", "drop", "archive", "unarchive", "move", "rename", "send", "reply", "forward", "publish",
    "share", "invite", "assign", "unassign", "mark", "close", "reopen", "approve", "reject", "submit", "cancel", "complete", "resolve",
    "toggle", "enable", "disable", "execute", "exec", "trigger", "deploy", "upload", "import", "transfer", "pay", "charge", "refund",
    "subscribe", "unsubscribe", "grant", "revoke", "restore", "kick", "ban", "mute", "and", "or",
})


def _mcp_partes(tool_name: str) -> tuple[str, str]:
    """("servidor", "ferramenta") de mcp__<servidor>__<ferramenta> (como o Hermes monta: tools/mcp_tool_schema.py)."""
    servidor, _, ferramenta = tool_name[len(_MCP_PREFIXO):].partition("__")
    return servidor, ferramenta


def _mcp_consulta(ferramenta: str) -> bool:
    """Só consulta: começa por um verbo de leitura E nenhuma outra palavra do nome muda dados. Na dúvida, escrita."""
    nome = re.sub(r"[^a-z0-9]+", "_", re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", ferramenta).lower()).strip("_")
    partes = [p for p in nome.split("_") if p]
    if not partes:
        return False
    if _MCP_RESOLVE_ID.fullmatch(nome):
        return not any(p in _MCP_ESCRITA for p in partes[1:])
    return partes[0] in _MCP_CONSULTA and not any(p in _MCP_ESCRITA for p in partes[1:])


def _mcp_gate(tool_name: str, pol: dict[str, Any]) -> dict[str, Any] | None:
    """Ferramenta de conector pronto: None = liberada. Só para o agente que tem "Conectores prontos" no Ergon; escrita só
    no conector em que a pessoa liberou a escrita (Conexões › Mais aplicativos)."""
    quem = pol.get("who") or "esta conversa"
    mcp = pol.get("mcp")
    if not isinstance(mcp, dict) or not mcp.get("ligado"):
        return {"action": "block", "message": f"Os conectores prontos não estão liberados para {quem} no Ergon. Continue sem '{tool_name}' e diga ao usuário o que ficou faltando."}
    servidor, ferramenta = _mcp_partes(tool_name)
    if _mcp_consulta(ferramenta):
        return None
    escrita = {re.sub(r"[^A-Za-z0-9_]", "_", str(x)) for x in (mcp.get("escrita") or [])}
    if servidor in escrita:
        return None
    return {"action": "block", "message": (
        f"O conector '{servidor}' está só para consulta no Ergon: '{ferramenta}' muda dados e a pessoa ainda não liberou a escrita nele. "
        "Não tente outro caminho: diga em uma frase o que você ia fazer e que ela pode liberar a escrita desse conector em Conexões › Mais aplicativos.")}


def _config() -> dict[str, Any]:
    from hermes_cli.config import load_config  # módulo do Hermes
    cfg = load_config()
    return cfg if isinstance(cfg, dict) else {}


def _ligado(v: Any, padrao: bool = False) -> bool:
    if v is None:
        return padrao
    return v not in (False, "false", "off", "no", 0, "0", "")


def _plugins_ligados(cfg: dict[str, Any]) -> set[str]:
    p = cfg.get("plugins") if isinstance(cfg.get("plugins"), dict) else {}
    on = {str(x) for x in p.get("enabled")} if isinstance(p.get("enabled"), list) else set()
    off = {str(x) for x in p.get("disabled")} if isinstance(p.get("disabled"), list) else set()
    return on - off


def _conectores_ligados(cfg: dict[str, Any]) -> list[str]:
    s = cfg.get("mcp_servers")
    return sorted(str(k) for k, c in s.items() if isinstance(c, dict) and _ligado(c.get("enabled"), True)) if isinstance(s, dict) else []


def _voz_estado() -> dict[str, Any]:
    """O que este motor consegue fazer com voz agora. transcrever: o provedor que o Hermes escolheria (local, se a imagem
    traz o Whisper; um provedor com chave; ou None). falar: o provedor configurado, se o Hermes diz que dá."""
    out: dict[str, Any] = {"transcrever": None, "falar": None}
    try:
        from tools.transcription_tools import _get_provider, _load_stt_config  # módulos do Hermes
        p = _get_provider(_load_stt_config())
        out["transcrever"] = str(p)[:30] if p and p != "none" else None
    except Exception:  # noqa: BLE001
        pass
    try:
        from tools.tts_tool import _get_provider as _tts_provider, _load_tts_config, check_tts_requirements
        if check_tts_requirements():
            prov: str | None = str(_tts_provider(_load_tts_config()))[:30]
            # o Edge (padrão, grátis) precisa do pacote edge_tts na imagem; sem ele, o Hermes diz que dá e falha na hora
            if prov == "edge":
                import importlib.util
                prov = prov if importlib.util.find_spec("edge_tts") else None
            out["falar"] = prov
    except Exception:  # noqa: BLE001
        pass
    return out


def _navegador_estado() -> dict[str, Any]:
    """O navegador da imagem (Chromium) e se o Hermes consegue dirigir um navegador agora (o programa que o dirige)."""
    caminho = ""
    try:
        with open("/etc/hermes/agent-browser-executable-path", encoding="utf-8") as f:
            caminho = f.read().strip()
    except Exception:  # noqa: BLE001
        pass
    pronto = False
    try:
        from tools.browser_tool_install import check_browser_requirements  # módulo do Hermes
        pronto = bool(check_browser_requirements())
    except Exception:  # noqa: BLE001
        pass
    return {"chromium": bool(caminho) and os.path.isfile(caminho), "pronto": pronto}


def recursos_estado() -> dict[str, Any]:
    cfg = _config()
    plugins = _plugins_ligados(cfg)
    cp = cfg.get("checkpoints") if isinstance(cfg.get("checkpoints"), dict) else {}
    tools = cfg.get("tools") if isinstance(cfg.get("tools"), dict) else {}
    ts = tools.get("tool_search") if isinstance(tools.get("tool_search"), dict) else {}
    busca = str(ts.get("enabled", "auto")).lower()
    return {
        "checkpoints": _ligado(cp.get("enabled")),
        "codigo_inseguro": _PLUGINS_DO_MOTOR["codigo_inseguro"] in plugins,
        "limpeza": _PLUGINS_DO_MOTOR["limpeza"] in plugins,
        "busca_ferramentas": busca not in ("off", "false", "0", "no"),
        "conectores": _conectores_ligados(cfg),
        "voz": _voz_estado(),
        "navegador": _navegador_estado(),
    }


def _gravar_config(parte: dict[str, Any]) -> tuple[int, bytes]:
    return _dash_call("PUT", "/api/config", "", {"config": parte})


def _busca_de_ferramentas(ligada: bool) -> tuple[int, bytes]:
    return _gravar_config({"tools": {"tool_search": {"enabled": "on" if ligada else "off"}}})


def _sem_conectores_nos_canais(cfg: dict[str, Any]) -> None:
    """Teams e WhatsApp diretos (sem agente do Ergon por trás) não ganham os conectores: a marca "no_mcp" do Hermes
    (hermes_cli/tools_config.py, _merge_mcp_servers) tira todos daquela plataforma."""
    pt = cfg.get("platform_toolsets") if isinstance(cfg.get("platform_toolsets"), dict) else {}
    novo = {}
    for plat in _PLATFORMS:
        atual = pt.get(plat)
        if isinstance(atual, list) and "no_mcp" not in atual:
            novo[plat] = [*[str(x) for x in atual], "no_mcp"]
    if novo:
        _gravar_config({"platform_toolsets": novo})


def _conselho_sanear(body: dict[str, Any]) -> dict[str, Any]:
    """O conselho que a tela monta: quem opina (2 a 6 modelos) e quem junta as opiniões. Um preset só ("default")."""
    def vaga(v: Any) -> dict[str, str]:
        v = v if isinstance(v, dict) else {}
        prov, modelo = str(v.get("provider") or "").strip(), str(v.get("model") or "").strip()
        if not re.fullmatch(r"[a-z0-9][a-z0-9_.-]{0,40}", prov) or prov == "moa" or not re.fullmatch(r"[\w./:@+-]{1,160}", modelo):
            raise ValueError("provedor ou modelo inválido")
        return {"provider": prov, "model": modelo}
    refs = body.get("opinam")
    if not isinstance(refs, list) or not 2 <= len(refs) <= 6:
        raise ValueError("escolha de 2 a 6 modelos para opinar")
    preset = {"enabled": True, "reference_models": [{**vaga(r), "enabled": True} for r in refs], "aggregator": vaga(body.get("agrega"))}
    return {"default_preset": "default", "active_preset": "", "presets": {"default": preset}}


def _conselho_resumo(j: dict[str, Any]) -> dict[str, Any]:
    nome = str(j.get("default_preset") or "default")
    p = j.get("presets").get(nome) if isinstance(j.get("presets"), dict) else None
    p = p if isinstance(p, dict) else {}

    def vaga(v: Any) -> dict[str, str]:
        v = v if isinstance(v, dict) else {}
        return {"provider": str(v.get("provider") or ""), "model": str(v.get("model") or "")}
    return {"preset": nome, "ligado": p.get("enabled", True) is not False,
            "opinam": [vaga(r) for r in (p.get("reference_models") or []) if isinstance(r, dict) and r.get("enabled", True) is not False][:6],
            "agrega": vaga(p.get("aggregator"))}


def _competencia_da_loja(m: dict[str, Any], instaladas: dict[str, Any]) -> dict[str, Any]:
    ident = str(m.get("identifier") or "")
    return {"id": ident[:200], "nome": str(m.get("name") or "")[:80], "descricao": str(m.get("description") or "")[:400],
            "fonte": str(m.get("source") or "")[:30], "confianca": str(m.get("trust_level") or "")[:20],
            "categoria": str(m.get("category") or "")[:40], "instalada": bool(m.get("installed")) or ident in instaladas}


def _varredura(j: dict[str, Any]) -> dict[str, Any]:
    achados = [{"gravidade": str(f.get("severity") or "")[:10], "arquivo": str(f.get("file") or "")[:160], "linha": f.get("line") if isinstance(f.get("line"), int) else None,
                "descricao": str(f.get("description") or "")[:300]} for f in (j.get("findings") or []) if isinstance(f, dict)][:40]
    return {"id": str(j.get("identifier") or "")[:200], "nome": str(j.get("name") or "")[:80], "confianca": str(j.get("trust_level") or "")[:20],
            "veredito": str(j.get("verdict") or "")[:20], "politica": str(j.get("policy") or "")[:10], "motivo": str(j.get("policy_reason") or "")[:300],
            "resumo": str(j.get("summary") or "")[:400], "achados": achados}


def loja_instalar(ident: str) -> tuple[bool, str]:
    """Instala a competência pelo próprio Hermes ("hermes skills install <id> --yes": quarentena, varredura e a política
    de instalação dele, sem --force). Direto, e não pela rota do painel, que só dispara em segundo plano e, na imagem,
    sai com "no dependency environment is committed" (conferido na v0.22.2): aqui a resposta já diz se instalou."""
    import subprocess
    import sys
    cli = os.path.join(os.path.dirname(sys.executable), "hermes")
    try:
        r = subprocess.run([cli if os.path.isfile(cli) else "hermes", "skills", "install", ident, "--yes"], capture_output=True, text=True, timeout=240,
                           stdin=subprocess.DEVNULL, env={**os.environ, "NO_COLOR": "1"})
    except Exception as exc:  # noqa: BLE001
        return False, type(exc).__name__
    saida = (r.stdout or "")[-600:]
    return r.returncode == 0 and "Installed:" in (r.stdout or ""), saida


def _conector(e: dict[str, Any]) -> dict[str, Any]:
    env = [{"nome": str(x.get("name") or "")[:60], "pergunta": str(x.get("prompt") or "")[:200], "obrigatorio": x.get("required") is not False}
           for x in (e.get("required_env") or []) if isinstance(x, dict)][:8]
    return {"nome": str(e.get("name") or "")[:60], "descricao": str(e.get("description") or "")[:300], "entrada": str(e.get("auth_type") or "none")[:10],
            "transporte": str(e.get("transport") or "")[:10], "campos": env, "depois": str(e.get("post_install") or "")[:600],
            "instalado": bool(e.get("installed")), "ligado": bool(e.get("enabled"))}


def _json_de(data: bytes) -> dict[str, Any]:
    try:
        j = json.loads(data or b"{}")
    except Exception:  # noqa: BLE001
        return {}
    return j if isinstance(j, dict) else {"lista": j}


def _voz_pasta() -> str:
    d = os.path.join(os.environ.get("HERMES_HOME", "/opt/data"), "cache", "ergon-voz")
    os.makedirs(d, exist_ok=True)
    return d


def voz_transcrever(audio: bytes, nome: str) -> dict[str, Any]:
    """Um áudio vira texto pelo Hermes (o Whisper local, se a imagem traz; ou o provedor com chave). O arquivo fica só o
    tempo da transcrição, dentro do cofre."""
    ext = os.path.splitext(nome or "")[1].lower()
    if ext not in _AUDIO_EXT:
        return {"ok": False, "motivo": "formato"}
    if not audio or len(audio) > _VOZ_MAX:
        return {"ok": False, "motivo": "tamanho"}
    if not _voz_estado()["transcrever"]:
        return {"ok": False, "motivo": "componente"}
    caminho = os.path.join(_voz_pasta(), f"t-{hashlib.sha256(audio).hexdigest()[:24]}{ext}")
    r: Any = None
    try:
        with open(caminho, "wb") as f:
            f.write(audio)
        from tools.transcription_tools import transcribe_audio  # módulo do Hermes
        r = transcribe_audio(caminho)
    except Exception as exc:  # noqa: BLE001
        r = {"error": type(exc).__name__}
    finally:
        try:
            os.remove(caminho)
        except OSError:
            pass
    if isinstance(r, dict) and r.get("success") and isinstance(r.get("transcript"), str):
        return {"ok": True, "texto": r["transcript"][:200000], "provedor": str(r.get("provider") or "")[:30]}
    return {"ok": False, "motivo": "falhou", "detalhe": str(r.get("error") or "")[:300] if isinstance(r, dict) else ""}


def voz_falar(texto: str) -> dict[str, Any]:
    """Um texto vira áudio pelo Hermes (o provedor de voz configurado; o padrão, Edge, é grátis e usa a internet)."""
    if not _voz_estado()["falar"]:
        return {"ok": False, "motivo": "componente"}
    import base64
    pasta = os.path.realpath(_voz_pasta())
    saida = os.path.join(pasta, f"f-{hashlib.sha256(texto.encode('utf-8', 'replace')).hexdigest()[:24]}.mp3")
    feitos = [saida]
    try:
        from tools.tts_tool import text_to_speech_tool  # módulo do Hermes
        r = json.loads(text_to_speech_tool(texto, output_path=saida))
        r = r if isinstance(r, dict) else {}
        real = os.path.realpath(str(r.get("file_path") or saida))
        feitos.append(real)
        if not r.get("success") or os.path.commonpath([real, pasta]) != pasta or not os.path.isfile(real) or not 0 < os.path.getsize(real) <= _VOZ_MAX:
            return {"ok": False, "motivo": "falhou", "detalhe": str(r.get("error") or "")[:300]}
        with open(real, "rb") as f:
            dados = f.read()
        tipo = {".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".wav": "audio/wav"}.get(os.path.splitext(real)[1].lower(), "audio/mpeg")
        return {"ok": True, "audio": base64.b64encode(dados).decode("ascii"), "tipo": tipo}
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "motivo": "falhou", "detalhe": type(exc).__name__}
    finally:
        for p in feitos:
            try:
                if os.path.commonpath([os.path.realpath(p), pasta]) == pasta:
                    os.remove(p)
            except (OSError, ValueError):
                pass


def checkpoints_listar() -> list[dict[str, Any]]:
    from tools.checkpoint_manager import CheckpointManager  # módulo do Hermes
    out = []
    for c in CheckpointManager(enabled=True).list_all_checkpoints()[:60]:
        out.append({"id": str(c.get("hash") or "")[:64], "quando": str(c.get("timestamp") or "")[:40], "pasta": str(c.get("workdir") or "")[:300],
                    "motivo": str(c.get("reason") or "")[:120], "arquivos": c.get("files_changed") if isinstance(c.get("files_changed"), int) else 0})
    return out


def checkpoints_voltar(pasta: str, ident: str) -> dict[str, Any]:
    """Volta a pasta de trabalho ao estado guardado (o /rollback do Hermes). Só um ponto que o próprio Hermes lista."""
    from tools.checkpoint_manager import CheckpointManager  # módulo do Hermes
    m = CheckpointManager(enabled=True)
    if not any(c.get("hash") == ident and c.get("workdir") == pasta for c in m.list_all_checkpoints()):
        return {"ok": False, "motivo": "nao_achei"}
    # antes de voltar, guarda o estado de agora: a volta também pode ser desfeita
    try:
        m.new_turn()
        m.ensure_checkpoint(pasta, "antes de voltar atrás (Ergon)")
    except Exception:  # noqa: BLE001
        pass
    r = m.restore(pasta, ident)
    ok = isinstance(r, dict) and bool(r.get("success"))
    return {"ok": ok, "motivo": "" if ok else str((r or {}).get("error") or "falhou")[:200] if isinstance(r, dict) else "falhou"}


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
        # /p/<perfil>/<rota de modelo>: a mesma rota, no perfil pedido (só as rotas de modelo; o resto é do motor)
        perfil = ""
        com_perfil = re.fullmatch(rf"/p/({_PERFIL})(/.+)", path)
        if com_perfil:
            perfil, path = com_perfil.group(1), com_perfil.group(2)
            if path not in _ROTAS_COM_PERFIL:
                return self._json(404, {"error": "rota não liberada pela ponte do Ergon"})
        try:
            # Treinar: o pedido (com o texto dos documentos) e as versões guardadas são maiores
            body = self._body(36 * 1024 * 1024 if path == "/ergon/v1/voz/transcrever"
                              else 1024 * 1024 if path in ("/ergon/v1/learn-prompt", "/ergon/v1/skills/restore") or path.startswith("/ergon/v1/perfis/")
                              else 256 * 1024 if path in _ROTAS_GRANDES else _MAX_BODY)
        except Exception:  # noqa: BLE001
            return self._json(400, {"error": "corpo inválido"})
        if path.startswith("/ergon/v1/learn-prompt") or path.startswith("/ergon/v1/skills/"):
            return self._training(method, path, body or {})
        if path == "/ergon/v1/perfis" or path.startswith("/ergon/v1/perfis/"):
            return self._perfis(method, path, body or {})
        if path == "/ergon/v1/rotinas" or path.startswith("/ergon/v1/rotinas/"):
            return self._rotinas(method, path, dict(urllib.parse.parse_qsl(parts.query)), body or {})
        if path == "/ergon/v1/health" and method == "GET":
            return self._health()
        if re.match(r"/ergon/v1/(recursos|conselho|loja|conectores|conquistas|checkpoints|voz)(/|-|$)", path):
            return self._recursos(method, path, dict(urllib.parse.parse_qsl(parts.query)), body or {})
        if path == "/ergon/v1/api-toolsets" and method == "GET":
            return self._api_toolsets_get()
        if path == "/ergon/v1/api-toolsets" and method == "PUT":
            return self._api_toolsets_put(body or {})
        if path == "/ergon/v1/medicao" and method == "GET":
            return self._medicao_get(dict(urllib.parse.parse_qsl(parts.query)))
        if path == "/ergon/v1/passos" and method == "GET":
            return self._passos_get()
        if path == "/ergon/v1/passos" and method == "PUT":
            return self._passos_put(body or {})
        if path == "/ergon/v1/compactacao" and method == "GET":
            return self._compactacao_get()
        if path == "/ergon/v1/compactacao" and method == "PUT":
            return self._compactacao_put(body or {})
        if path == "/ergon/v1/delegacao" and method == "GET":
            return self._delegacao_get(perfil)
        if path == "/ergon/v1/delegacao" and method == "PUT":
            return self._delegacao_put(body or {}, perfil)
        if path == "/ergon/v1/modelos/visao" and method == "POST":
            return self._json(200, {"visao": modelos_visao((body or {}).get("modelos"))})
        if path == "/ergon/v1/ajustes" and method == "GET":
            return self._ajustes_get()
        if path == "/ergon/v1/ajustes" and method == "PUT":
            return self._ajustes_put(body or {})
        if path == "/ergon/v1/cota" and method == "GET":
            return self._cota_get(dict(urllib.parse.parse_qsl(parts.query)))
        if path == "/ergon/v1/pausa" and method == "GET":
            return self._pausa_get()
        if path == "/ergon/v1/pausa" and method == "PUT":
            return self._pausa_put(body or {})
        if path == "/ergon/v1/media" and method == "GET":
            return self._media_get(dict(urllib.parse.parse_qsl(parts.query)).get("path", ""))
        if path == "/ergon/v1/canais" or path.startswith("/ergon/v1/canais/"):
            return self._canais(method, path, body or {})
        if path == "/ergon/v1/byok" or path.startswith("/ergon/v1/byok/"):
            return self._byok(method, path, body or {})
        if path == "/ergon/v1/chaves" or path.startswith("/ergon/v1/chaves/"):
            return self._chaves(method, path, body or {})
        if path in _ROTAS_GRANDES and method == "POST":
            return self._comandos(path, body or {})
        for m, rx, allowed_q in _ROUTES:
            if m == method and rx.fullmatch(path):
                q = urllib.parse.parse_qsl(parts.query)
                query = urllib.parse.urlencode([(k, v) for k, v in q if k in allowed_q and re.fullmatch(r"[a-z0-9_]{1,20}", v)]
                                               + ([("profile", perfil)] if perfil else []))
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
                if status == 200 and perfil and path == "/api/model/set" and body.get("scope") == "auxiliary":
                    _lembrar_modelo_do_perfil(perfil, "auxiliary", body)
                return self._send(status, data)
        return self._json(404, {"error": "rota não liberada pela ponte do Ergon"})

    def _recursos(self, method: str, path: str, q: dict[str, str], body: dict[str, Any]) -> None:
        """Capacidades da equipe (rc.27): rotas fechadas sobre o painel e os módulos do Hermes. Nunca derruba a ponte."""
        try:
            return self._recursos_rota(method, path, q, body)
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            return self._json(503, {"error": f"a equipe de IA não concluiu o pedido ({type(exc).__name__})"})

    def _painel(self, method: str, path: str, query: str = "", body: dict[str, Any] | None = None) -> dict[str, Any] | None:
        """Chama o painel do Hermes; fora do 200, responde o erro à tela e devolve None."""
        status, data = _dash_call(method, path, query, body)
        if status != 200:
            self._send(status, data)
            return None
        return _json_de(data)

    def _recursos_rota(self, method: str, path: str, q: dict[str, str], body: dict[str, Any]) -> None:
        sub = path[len("/ergon/v1/"):]
        # ---- o que está ligado no motor e o que ele consegue fazer
        if sub == "recursos" and method == "GET":
            return self._json(200, recursos_estado())
        if sub == "recursos" and method == "PUT":
            pedidos = {k: v for k, v in body.items() if k in ("checkpoints", "codigo_inseguro", "limpeza", "busca_ferramentas")}
            if not pedidos or not all(isinstance(v, bool) for v in pedidos.values()):
                raise ValueError("envie checkpoints, codigo_inseguro, limpeza ou busca_ferramentas: true ou false")
            if "checkpoints" in pedidos and self._painel("PUT", "/api/config", "", {"config": {"checkpoints": {"enabled": pedidos["checkpoints"]}}}) is None:
                return None
            if "busca_ferramentas" in pedidos and self._painel("PUT", "/api/config", "", {"config": {"tools": {"tool_search": {"enabled": "on" if pedidos["busca_ferramentas"] else "off"}}}}) is None:
                return None
            reiniciar = False
            for chave, nome in _PLUGINS_DO_MOTOR.items():
                if chave in pedidos:
                    r = self._painel("POST", f"/api/dashboard/agent-plugins/{nome}/{'enable' if pedidos[chave] else 'disable'}", "", {})
                    if r is None:
                        return None
                    reiniciar = reiniciar or bool(r.get("restart_required"))
            return self._json(200, {"ok": True, "reiniciar": reiniciar, **recursos_estado()})
        # ---- conselho de modelos
        if sub == "conselho" and method == "GET":
            j = self._painel("GET", "/api/model/moa")
            return None if j is None else self._json(200, _conselho_resumo(j))
        if sub == "conselho" and method == "PUT":
            j = self._painel("PUT", "/api/model/moa", "", _conselho_sanear(body))
            return None if j is None else self._json(200, {"ok": True, **_conselho_resumo(j)})
        # ---- loja de competências
        if sub == "loja" and method == "GET":
            busca = (q.get("q") or "").strip()[:80]
            if busca:
                j = self._painel("GET", "/api/skills/hub/search", urllib.parse.urlencode({"q": busca, "source": "all", "limit": "30"}))
                lista = (j or {}).get("results")
            else:
                j = self._painel("GET", "/api/skills/hub/official")
                lista = (j or {}).get("skills")
            if j is None:
                return None
            inst = j.get("installed") if isinstance(j.get("installed"), dict) else {}
            return self._json(200, {"competencias": [_competencia_da_loja(m, inst) for m in (lista or []) if isinstance(m, dict)][:200],
                                    "sem_resposta": [str(x)[:30] for x in (j.get("timed_out") or [])][:10]})
        if sub in ("loja/previa", "loja/varredura") and method == "GET":
            ident = q.get("id", "")
            if not _ID_COMPETENCIA.fullmatch(ident):
                raise ValueError("competência inválida")
            alvo = "preview" if sub.endswith("previa") else "scan"
            j = self._painel("GET", f"/api/skills/hub/{alvo}", urllib.parse.urlencode({"identifier": ident}))
            if j is None:
                return None
            if alvo == "scan":
                return self._json(200, _varredura(j))
            return self._json(200, {"id": ident, "nome": str(j.get("name") or "")[:80], "descricao": str(j.get("description") or "")[:400],
                                    "texto": str(j.get("skill_md") or "")[:60000], "arquivos": [str(x)[:200] for x in (j.get("files") or [])][:80]})
        if sub == "loja/instalar" and method == "POST":
            ident = str(body.get("id") or "")
            if not _ID_COMPETENCIA.fullmatch(ident):
                raise ValueError("competência inválida")
            # a varredura de segurança do Hermes roda de novo aqui: o que ela barra não instala, com ou sem o clique da pessoa
            v = self._painel("GET", "/api/skills/hub/scan", urllib.parse.urlencode({"identifier": ident}))
            if v is None:
                return None
            if str(v.get("policy") or "") == "block":
                return self._json(409, {"error": "a varredura de segurança barrou esta competência", "varredura": _varredura(v)})
            feito, saida = loja_instalar(ident)
            if not feito:
                return self._json(502, {"error": "a instalação da competência não terminou", "detalhe": saida})
            return self._json(200, {"ok": True, "varredura": _varredura(v)})
        # ---- conectores prontos (MCP)
        if sub == "conectores" and method == "GET":
            cat = self._painel("GET", "/api/mcp/catalog")
            if cat is None:
                return None
            srv = self._painel("GET", "/api/mcp/servers")
            if srv is None:
                return None
            servidores = [{"nome": str(s.get("name") or "")[:60], "ligado": bool(s.get("enabled")), "entrada": str(s.get("auth") or "")[:10],
                           "ferramentas": len(s.get("tools")) if isinstance(s.get("tools"), list) else None}
                          for s in (srv.get("servers") or []) if isinstance(s, dict) and s.get("source") != "plugin"][:100]
            return self._json(200, {"catalogo": [_conector(e) for e in (cat.get("entries") or []) if isinstance(e, dict)][:200], "servidores": servidores,
                                    "busca_ferramentas": recursos_estado()["busca_ferramentas"]})
        if sub == "conectores/instalar" and method == "POST":
            nome = str(body.get("nome") or "")
            env = body.get("campos") if isinstance(body.get("campos"), dict) else {}
            if not _NOME.fullmatch(nome) or len(env) > 8 or not all(re.fullmatch(r"[A-Z][A-Z0-9_]{1,60}", str(k)) and isinstance(v, str) and 0 < len(v) <= 2000 for k, v in env.items()):
                raise ValueError("conector ou campos inválidos")
            # a volta da entrada (OAuth) passa pelo Ergon, que a pessoa alcança; o painel do Hermes só existe dentro do motor
            retorno = str(body.get("retorno") or "")
            if retorno and not re.fullmatch(r"https?://[A-Za-z0-9.\[\]:-]{1,200}(/[A-Za-z0-9._~/-]{0,200})?", retorno):
                raise ValueError("endereço de retorno inválido")
            primeiro = not _conectores_ligados(_config())
            j = self._painel("POST", "/api/mcp/catalog/install", "", {"name": nome, "env": env, "enable": True})
            if j is None:
                return None
            if retorno:
                _gravar_config({"mcp_servers": {nome: {"oauth": {"redirect_uri": retorno}}}})
            cfg = _config()
            _sem_conectores_nos_canais(cfg)
            if primeiro:
                _busca_de_ferramentas(True)
            return self._json(200, {"ok": True, "segundo_plano": bool(j.get("background")), "busca_ferramentas": recursos_estado()["busca_ferramentas"]})
        m = re.fullmatch(r"conectores/([a-z0-9][a-z0-9_.-]{0,60})(/entrar)?", sub)
        if m and m.group(2) and method == "POST":
            j = self._painel("POST", f"/api/mcp/servers/{urllib.parse.quote(m.group(1), safe='')}/auth", "", {})
            if j is None:
                return None
            return self._json(200, {"fluxo": str(j.get("flow_id") or "")[:80], "situacao": str(j.get("status") or "")[:40],
                                    "endereco": str(j.get("authorization_url") or "")[:4000], "erro": str(j.get("error") or "")[:300]})
        if m and not m.group(2) and method == "PUT":
            if not isinstance(body.get("ligado"), bool):
                raise ValueError("envie ligado: true ou false")
            if self._painel("PUT", f"/api/mcp/servers/{urllib.parse.quote(m.group(1), safe='')}/enabled", "", {"enabled": body["ligado"]}) is None:
                return None
            if not _conectores_ligados(_config()):
                _busca_de_ferramentas(False)  # sem conector ligado, as Conexões voltam à vista do modelo
            return self._json(200, {"ok": True, "ligado": body["ligado"], "busca_ferramentas": recursos_estado()["busca_ferramentas"]})
        if m and not m.group(2) and method == "DELETE":
            if self._painel("DELETE", f"/api/mcp/servers/{urllib.parse.quote(m.group(1), safe='')}") is None:
                return None
            if not _conectores_ligados(_config()):
                _busca_de_ferramentas(False)
            return self._json(200, {"ok": True})
        m = re.fullmatch(r"conectores-entrada/([A-Za-z0-9_-]{8,80})", sub)
        if m and method in ("GET", "DELETE"):
            j = self._painel(method, f"/api/mcp/oauth/flows/{m.group(1)}")
            if j is None:
                return None
            return self._json(200, {"situacao": str(j.get("status") or "")[:40], "erro": str(j.get("error") or "")[:300],
                                    "ferramentas": len(j.get("tools")) if isinstance(j.get("tools"), list) else None})
        m = re.fullmatch(r"conectores-retorno/([a-z0-9][a-z0-9_.-]{0,60})", sub)
        if m and method == "POST":
            # o Ergon recebeu a volta do provedor no navegador da pessoa e repassa: o Hermes confere o "state" da entrada
            campos = {k: str(body.get(k))[:4000] for k in ("code", "state", "error", "iss") if isinstance(body.get(k), str) and body.get(k)}
            status, _ = _dash_call("GET", f"/api/mcp/oauth/callback/{urllib.parse.quote(m.group(1), safe='')}", urllib.parse.urlencode(campos), None)
            return self._json(200, {"ok": status == 200, "situacao": status})
        # ---- conquistas (plugin hermes-achievements do Hermes: lê só o histórico do próprio motor)
        if sub == "conquistas" and method == "GET":
            j = self._painel("GET", "/api/plugins/hermes-achievements/achievements")
            if j is None:
                return None
            itens = [{"id": str(a.get("id") or "")[:60], "nome": str(a.get("name") or "")[:80], "descricao": str(a.get("description") or "")[:240],
                      "categoria": str(a.get("category") or "")[:40], "nivel": str(a.get("tier") or "")[:20], "conquistada": bool(a.get("unlocked")),
                      "progresso": a.get("progress_pct") if isinstance(a.get("progress_pct"), int) else 0, "icone": str(a.get("icon") or "")[:30]}
                     for a in (j.get("achievements") or []) if isinstance(a, dict) and (a.get("discovered", True) or a.get("unlocked"))][:200]
            return self._json(200, {"conquistas": itens})
        # ---- voltar atrás (checkpoints)
        if sub == "checkpoints" and method == "GET":
            return self._json(200, {"pontos": checkpoints_listar()})
        if sub == "checkpoints/voltar" and method == "POST":
            pasta, ident = str(body.get("pasta") or ""), str(body.get("id") or "")
            if not pasta.startswith("/") or len(pasta) > 300 or not re.fullmatch(r"[0-9a-f]{7,64}", ident):
                raise ValueError("ponto inválido")
            return self._json(200, checkpoints_voltar(pasta, ident))
        # ---- voz
        if sub == "voz/transcrever" and method == "POST":
            import base64
            try:
                audio = base64.b64decode(str(body.get("audio") or ""), validate=True)
            except Exception:  # noqa: BLE001
                raise ValueError("áudio inválido") from None
            return self._json(200, voz_transcrever(audio, str(body.get("nome") or "")[:200]))
        if sub == "voz/falar" and method == "POST":
            texto = str(body.get("texto") or "").strip()
            if not texto or len(texto) > 12000:
                raise ValueError("texto vazio ou longo demais")
            return self._json(200, voz_falar(texto))
        return self._json(404, {"error": "rota não liberada pela ponte do Ergon"})

    def _byok(self, method: str, path: str, body: dict[str, Any]) -> None:
        """Chave própria: GET (catálogo do Hermes e o que está ligado), PUT (confere no provedor e grava), DELETE
        /<provedor>; endpoints próprios: POST /custom (confere o endereço, lista os modelos e cadastra) e DELETE
        /custom/<id>."""
        try:
            if method == "GET" and path == "/ergon/v1/byok":
                cat = _byok_catalog()
                status, data = _dash_call("GET", "/api/providers/custom-endpoints", "", None)
                eps = (json.loads(data or b"{}").get("endpoints") or []) if status == 200 else []
                return self._json(200, {
                    "providers": [{"id": p, "name": c["name"], "url": c["url"], "connected": c["set"]} for p, c in sorted(cat.items(), key=lambda x: x[1]["name"].lower())],
                    "custom": [{"id": str(e.get("id")), "name": str(e.get("name") or e.get("id")), "baseUrl": str(e.get("base_url") or ""), "model": str(e.get("model") or "")}
                               for e in eps if _BYOK_CUSTOM_ID.fullmatch(str(e.get("id") or ""))],
                })
            if method == "PUT" and path == "/ergon/v1/byok":
                var, key = _sanitize_byok(body)
                status, data = _dash_call("POST", "/api/providers/validate", "", {"key": var, "value": key})
                check = json.loads(data or b"{}") if status == 200 else {}
                if check.get("reachable") and not check.get("ok"):
                    return self._json(400, {"error": "o provedor recusou essa chave; confira e tente de novo"})
                status, data = _dash_call("PUT", "/api/env", "", {"key": var, "value": key, "provider_setup": True})
                if status != 200:
                    return self._send(status, data)
                return self._json(200, {"ok": True, "verified": bool(check.get("reachable"))})
            if method == "POST" and path == "/ergon/v1/byok/custom":
                kind = str(body.get("kind") or "")
                if kind not in _BYOK_CUSTOM:
                    raise ValueError("tipo de endpoint desconhecido")
                name = re.sub(r"\s+", " ", str(body.get("name") or "")).strip()[:40] or {"outro": "Outro", "lmstudio": "LM Studio", "ollama": "Ollama"}[kind]
                base = _byok_url(kind, str(body.get("baseUrl") or ""))
                key = str(body.get("key") or "").strip()
                if key and not _BYOK_KEY.fullmatch(key):
                    raise ValueError("a chave não tem o formato de uma chave de API")
                status, data = _dash_call("POST", "/api/providers/validate", "", {"key": "OPENAI_BASE_URL", "value": base, "api_key": key})
                check = json.loads(data or b"{}") if status == 200 else {}
                models = [m for m in (check.get("models") or []) if isinstance(m, str) and re.fullmatch(r"[\w./:@+-]{1,160}", m)][:100]
                if not check.get("ok") or not models:
                    return self._json(400, {"error": "o endereço não respondeu com modelos (" + str(check.get("message") or "sem resposta") + ")"})
                slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:30] or kind
                ep = {"id": f"byok-{slug}", "name": name, "base_url": str(check.get("resolved_base_url") or base), "model": models[0], "models": models,
                      "api_mode": "chat_completions", "discover_models": True, "make_default": False, **({"api_key": key} if key else {})}
                status, data = _dash_call("POST", "/api/providers/custom-endpoints", "", ep)
                if status != 200:
                    return self._send(status, data)
                return self._json(200, {"ok": True, "id": ep["id"], "models": len(models)})
            m = re.fullmatch(r"/ergon/v1/byok/custom/(byok-[a-z0-9-]{1,40})", path)
            if method == "DELETE" and m:
                status, data = _dash_call("DELETE", f"/api/providers/custom-endpoints/{m.group(1)}", "", None)
                return self._json(200, {"ok": True}) if status in (200, 404) else self._send(status, data)
            m = re.fullmatch(r"/ergon/v1/byok/([a-z0-9][a-z0-9_.-]{1,40})", path)
            if method == "DELETE" and m:
                cat = _byok_catalog()
                if m.group(1) not in cat:
                    return self._json(404, {"error": "provedor desconhecido"})
                status, data = _dash_call("DELETE", "/api/env", "", {"key": cat[m.group(1)]["var"]})
                return self._json(200, {"ok": True}) if status in (200, 404) else self._send(status, data)
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        except RuntimeError as exc:
            return self._json(503, {"error": str(exc)})
        return self._json(404, {"error": "rota não liberada pela ponte do Ergon"})

    def _perfis(self, method: str, path: str, body: dict[str, Any]) -> None:
        """Equipe nativa: GET /ergon/v1/perfis (os nomes); PUT /ergon/v1/perfis/<nome> (cria ou atualiza);
        GET …/<nome>/memoria; POST …/<nome>/memoria/pendentes {id, aprovar}."""
        try:
            if path == "/ergon/v1/perfis" and method == "GET":
                return self._json(200, {"perfis": perfis_listar()})
            m = re.fullmatch(r"/ergon/v1/perfis/(erg-[0-9a-f]{20})(/memoria(/pendentes)?)?", path)
            if not m:
                return self._json(404, {"error": "rota não liberada pela ponte do Ergon"})
            nome = m.group(1)
            if not m.group(2) and method == "PUT":
                return self._json(200, perfil_garantir(nome, body))
            if m.group(2) == "/memoria" and method == "GET":
                return self._json(200, perfil_memoria(nome))
            if m.group(3) and method == "POST":
                pid = str(body.get("id") or "")
                if not re.fullmatch(r"[A-Za-z0-9_-]{1,40}", pid) or not isinstance(body.get("aprovar"), bool):
                    return self._json(400, {"error": "envie id e aprovar: true ou false"})
                return self._json(200, perfil_memoria_decidir(nome, pid, body["aprovar"]))
        except ValueError as exc:
            return self._json(400, {"error": str(exc)[:300]})
        except RuntimeError as exc:
            return self._json(409, {"error": str(exc)[:300]})
        except Exception as exc:  # noqa: BLE001
            return self._json(500, {"error": f"falha no perfil ({type(exc).__name__})"})
        return self._json(405, {"error": "método não aceito nesta rota"})

    def _rotinas(self, method: str, path: str, query: dict[str, str], body: dict[str, Any]) -> None:
        """Rotinas no agendador do motor: GET /ergon/v1/rotinas?perfil= (os jobs das rotinas no perfil); PUT …/<rotina>
        (cria ou atualiza o job); DELETE …/<rotina>?perfil= (tira); POST …/<rotina>/rodar {perfil} (rodar agora)."""
        try:
            if path == "/ergon/v1/rotinas" and method == "GET":
                perfil = str(query.get("perfil") or "")
                if not _PERFIL_NOME.fullmatch(perfil):
                    return self._json(400, {"error": "perfil inválido"})
                if not _perfil_dir(perfil).is_dir():
                    return self._json(200, {"rotinas": []})
                return self._json(200, {"rotinas": rotinas_listar(perfil)})
            m = re.fullmatch(r"/ergon/v1/rotinas/(rtn_[0-9a-f]{32})(/rodar)?", path)
            if not m:
                return self._json(404, {"error": "rota não liberada pela ponte do Ergon"})
            rid = m.group(1)
            perfil = str(body.get("perfil") or query.get("perfil") or "")
            if not _PERFIL_NOME.fullmatch(perfil):
                return self._json(400, {"error": "perfil inválido"})
            if m.group(2) and method == "POST":
                return self._json(200, rotina_rodar(rid, perfil))
            if not m.group(2) and method == "PUT":
                return self._json(200, rotina_garantir(rid, body))
            if not m.group(2) and method == "DELETE":
                return self._json(200, rotina_remover(rid, perfil))
        except LookupError as exc:
            return self._json(404, {"error": str(exc)[:300]})
        except ValueError as exc:
            return self._json(400, {"error": str(exc)[:300]})
        except Exception as exc:  # noqa: BLE001
            return self._json(500, {"error": f"falha no agendador ({type(exc).__name__})"})
        return self._json(405, {"error": "método não aceito nesta rota"})

    def _chaves(self, method: str, path: str, body: dict[str, Any]) -> None:
        """Chaves guardadas para a equipe por um cartão: GET (só nomes), PUT (grava o valor que o Ergon recebeu da pessoa),
        DELETE /<NOME>. O valor entra e nunca mais sai por aqui; nenhuma resposta nem mensagem de erro o repete."""
        try:
            if method == "GET" and path == "/ergon/v1/chaves":
                return self._json(200, chaves_listar())
            if method == "PUT" and path == "/ergon/v1/chaves":
                sudo = body.get("sudo") is True
                nome = _SUDO if sudo else str(body.get("nome") or "")
                chave_guardar(nome, str(body.get("valor") or ""), str(body.get("motivo") or ""), str(body.get("agente") or ""), sudo=sudo)
                return self._json(200, {"ok": True, "guardada_como": nome})
            m = re.fullmatch(r"/ergon/v1/chaves/([A-Z][A-Z0-9_]{2,60})", path)
            if method == "DELETE" and m:
                return self._json(200, {"ok": True, "apagada": chave_apagar(m.group(1))})
        except ValueError as exc:
            return self._json(400, {"error": str(exc)[:300]})
        except RuntimeError as exc:
            return self._json(503, {"error": str(exc)[:300]})
        except Exception as exc:  # noqa: BLE001 - só o tipo: a mensagem de uma exceção poderia repetir o valor
            return self._json(500, {"error": f"não consegui gravar a chave ({type(exc).__name__})"})
        return self._json(404, {"error": "rota não liberada pela ponte do Ergon"})

    def _comandos(self, path: str, body: dict[str, Any]) -> None:
        """O juiz da meta e o pedido de revisão do próprio Hermes, para o Ergon conduzir /goal e /review."""
        try:
            if path == "/ergon/v1/meta/julgar":
                return self._json(200, meta_julgar(str(body.get("meta") or ""), str(body.get("resposta") or "")))
            msgs = body.get("mensagens") if isinstance(body.get("mensagens"), list) else []
            return self._json(200, revisao_pedido(msgs, str(body.get("foco") or "")))
        except Exception as exc:  # noqa: BLE001
            return self._json(503, {"error": f"o motor não conseguiu agora ({type(exc).__name__})"})

    def _canais(self, method: str, path: str, body: dict[str, Any]) -> None:
        """Conversar pelo Telegram e pelo Discord: GET (situação), PUT /<canal> (guarda o código do bot no .env do motor e
        reinicia o gateway), POST /<canal>/parear (confirma o código que a pessoa recebeu no canal: o pareamento nativo do
        gateway) e DELETE /<canal> (apaga o código do bot e desfaz as ligações). O código do bot nunca volta por aqui."""
        try:
            from gateway.pairing import PairingStore  # módulos do Hermes
            from hermes_cli.config import remove_env_value, save_env_value
            if method == "GET" and path == "/ergon/v1/canais":
                return self._json(200, {"canais": _canal_estado()})
            m = re.fullmatch(r"/ergon/v1/canais/(telegram|discord)(/parear)?", path)
            if not m:
                return self._json(404, {"error": "rota não liberada pela ponte do Ergon"})
            canal, parear = m.group(1), bool(m.group(2))
            store = PairingStore()
            if method == "PUT" and not parear:
                token = str(body.get("token") or "").strip()
                if not _CANAL_TOKEN[canal].fullmatch(token):
                    return self._json(400, {"error": "o código do bot não tem o formato esperado", "code": "formato"})
                save_env_value(_CANAL_ENV[canal], token)
                # bot novo: as ligações e os pedidos de código de antes não valem para ele
                _canal_limpar(store, canal)
                store.clear_pending(canal)
                _canal_zerar_espera(store, canal)
                return self._json(200, {"ok": True, "reiniciando": _canal_reiniciar()})
            if method == "POST" and parear:
                codigo = "".join(str(body.get("codigo") or "").upper().split())[:16]
                if not re.fullmatch(r"[A-Z0-9]{8}", codigo):
                    return self._json(400, {"error": "código inválido", "code": "codigo"})
                if store._is_locked_out(canal):
                    return self._json(429, {"error": "muitas tentativas; espere uma hora", "code": "tentativas"})
                r = store.approve_code(canal, codigo)
                if not r:
                    return self._json(404, {"error": "código não encontrado ou vencido", "code": "codigo"})
                user_id = str(r.get("user_id") or "")
                _canal_limpar(store, canal, manter=user_id)  # uma conta por canal: a de quem acabou de confirmar
                lembrado = (_canal_lembrados().get(canal) or {}).get(user_id) or {}
                return self._json(200, {"ok": True, "user_id": user_id, "user_name": str(r.get("user_name") or "")[:120],
                                        "chat_id": str(lembrado.get("chat_id") or user_id)})
            if method == "DELETE" and not parear:
                _canal_limpar(store, canal)
                store.clear_pending(canal)
                _canal_zerar_espera(store, canal)
                remove_env_value(_CANAL_ENV[canal])
                return self._json(200, {"ok": True, "reiniciando": _canal_reiniciar()})
        except Exception as exc:  # noqa: BLE001
            return self._json(503, {"error": f"não consegui mexer nos canais ({type(exc).__name__})"})
        return self._json(405, {"error": "método não aceito"})

    def _training(self, method: str, path: str, body: dict[str, Any]) -> None:
        """Rotas do Treinar (só POST): o turno do /learn e as escritas de competência em espera. Com "perfil" no corpo
        (rc.27), tudo vale na pasta do perfil do agente: a competência mora com ele."""
        if method != "POST":
            return self._json(405, {"error": "use POST"})
        perfil = str(body.get("perfil") or "")
        if perfil:
            try:
                with _no_perfil(perfil):
                    return self._training_em(path, body)
            except ValueError as exc:
                return self._json(409, {"error": str(exc)[:300]})
        return self._training_em(path, body)

    def _training_em(self, path: str, body: dict[str, Any]) -> None:
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
                    r = skills_remove(name)
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

    def _health(self) -> None:
        """Contrato com o servidor: versão do plugin, migração de configuração do cofre e o que este motor sabe fazer."""
        status, _ = _dash_call("GET", "/api/model/info", "", None)
        return self._json(200, {"ok": True, "dashboard": status == 200, "plugin_version": PLUGIN_VERSION,
                                "vault_config": _vault_config(), "capacidades": list(CAPACIDADES),
                                "dados_antigos": _dados_antigos()})

    def _medicao_get(self, q: dict[str, str]) -> None:
        """As chamadas medidas de uma sessão (só tamanhos e o total informado pelo provedor), desde um instante."""
        sessao = q.get("sessao", "")
        if not sessao or len(sessao) > 300 or any(ord(c) < 32 for c in sessao):
            return self._json(400, {"error": "sessão inválida"})
        try:
            desde = max(0.0, float(q.get("desde") or 0))
        except ValueError:
            return self._json(400, {"error": "instante inválido"})
        # "agora": o relógio do motor, para o Ergon compensar a diferença para o relógio do computador (custo.ts)
        return self._json(200, {"chamadas": medicao(sessao, desde), "agora": round(time.time(), 3)})

    def _passos_get(self) -> None:
        try:
            from hermes_cli.config import load_config  # módulo do Hermes
            agent = load_config().get("agent")
            v = agent.get("max_turns") if isinstance(agent, dict) else None
        except Exception as exc:  # noqa: BLE001
            return self._json(503, {"error": f"não consegui ler a configuração ({type(exc).__name__})"})
        return self._json(200, {"max_turns": v if isinstance(v, int) and not isinstance(v, bool) else None})

    def _passos_put(self, body: dict[str, Any]) -> None:
        v = body.get("max_turns")
        if not isinstance(v, int) or isinstance(v, bool) or not PASSOS_MIN <= v <= PASSOS_MAX:
            return self._json(400, {"error": f"envie max_turns entre {PASSOS_MIN} e {PASSOS_MAX}"})
        # o painel do Hermes grava por cima do que está no disco (mescla), com a trava de escrita dele
        status, data = _dash_call("PUT", "/api/config", "", {"config": {"agent": {"max_turns": v}}})
        if status != 200:
            return self._send(status, data)
        return self._json(200, {"ok": True, "max_turns": v})

    def _delegacao_get(self, perfil: str) -> None:
        """O modelo dos ajudantes temporários (delegation.provider/model), do motor ou de um perfil; vazio = o de quem pediu."""
        status, data = _dash_call("GET", "/api/config", urllib.parse.urlencode({"profile": perfil}) if perfil else "", None)
        if status != 200:
            return self._send(status, data)
        try:
            d = json.loads(data).get("delegation")
        except Exception:  # noqa: BLE001
            return self._json(503, {"error": "não consegui ler a configuração"})
        d = d if isinstance(d, dict) else {}
        return self._json(200, {"provider": str(d.get("provider") or ""), "model": str(d.get("model") or "")})

    def _delegacao_put(self, body: dict[str, Any], perfil: str) -> None:
        try:
            d = _sanitize_delegacao(body)
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        # o painel do Hermes mescla no que está no disco (o resto de delegation fica como está), com a trava de escrita dele
        status, data = _dash_call("PUT", "/api/config", urllib.parse.urlencode({"profile": perfil}) if perfil else "", {"config": {"delegation": d}})
        if status != 200:
            return self._send(status, data)
        if perfil:
            _lembrar_modelo_do_perfil(perfil, "delegation", d)
        return self._json(200, {"ok": True, **d})

    def _compactacao_get(self) -> None:
        """Ligada = o resumo da conversa está ligado no Hermes e com o teto mais cedo (qualquer número; o do Ergon é 150 mil)."""
        try:
            from hermes_cli.config import load_config  # módulo do Hermes
            comp = load_config().get("compression")
        except Exception as exc:  # noqa: BLE001
            return self._json(503, {"error": f"não consegui ler a configuração ({type(exc).__name__})"})
        comp = comp if isinstance(comp, dict) else {}
        limite = comp.get("threshold_tokens")
        limite = limite if isinstance(limite, int) and not isinstance(limite, bool) and limite > 0 else None
        ligada = comp.get("enabled", True) not in (False, "false", "off", "no", 0) and limite is not None
        return self._json(200, {"ligada": ligada, "limite": limite})

    def _compactacao_put(self, body: dict[str, Any]) -> None:
        v = body.get("ligada")
        if not isinstance(v, bool):
            return self._json(400, {"error": "envie ligada: true ou false"})
        # ligada: o resumo ligado e o teto do Ergon; desligada: sem teto (null), só o limite do Hermes perto do fim da janela
        comp = {"enabled": True, "threshold_tokens": COMPACTAR_LIMITE} if v else {"threshold_tokens": None}
        status, data = _dash_call("PUT", "/api/config", "", {"config": {"compression": comp}})
        if status != 200:
            return self._send(status, data)
        return self._json(200, {"ok": True, "ligada": v, "limite": COMPACTAR_LIMITE if v else None})

    def _ajustes_get(self) -> None:
        try:
            from hermes_cli.config import load_config  # módulo do Hermes
            atual = ajustes_ler(load_config())
        except Exception as exc:  # noqa: BLE001
            return self._json(503, {"error": f"não consegui ler a configuração ({type(exc).__name__})"})
        return self._json(200, {**atual, "fixadas": fixar_treinadas()})

    def _ajustes_put(self, body: dict[str, Any]) -> None:
        try:
            config = ajustes_config(body)
        except LookupError as exc:
            return self._json(409, {"error": str(exc), "codigo": "busca_privada_indisponivel"})
        except ValueError as exc:
            return self._json(400, {"error": str(exc)})
        # antes de ligar a arrumação automática: as competências treinadas no Ergon ficam fixadas (ela pula as fixadas)
        if config.get("curator", {}).get("enabled") is True:
            fixar_treinadas()
        status, data = _dash_call("PUT", "/api/config", "", {"config": config})
        if status != 200:
            return self._send(status, data)
        global _nao_treinar_cache
        _nao_treinar_cache = (0.0, False)
        return self._ajustes_get()

    def _cota_get(self, q: dict[str, str]) -> None:
        try:
            return self._json(200, cota(q.get("atualizar") == "1"))
        except Exception as exc:  # noqa: BLE001
            return self._json(503, {"error": f"não consegui ler os limites da conta ({type(exc).__name__})"})

    def _pausa_get(self) -> None:
        try:
            from agent import estop  # módulo do Hermes: a parada geral ("hermes pause")
            st = estop.get_state()
        except Exception as exc:  # noqa: BLE001
            return self._json(503, {"error": f"não consegui ler a pausa ({type(exc).__name__})"})
        return self._json(200, {"pausada": st is not None, "desde": (st or {}).get("engaged_at")})

    def _pausa_put(self, body: dict[str, Any]) -> None:
        v = body.get("pausada")
        if not isinstance(v, bool):
            return self._json(400, {"error": "envie pausada: true ou false"})
        try:
            from agent import estop  # módulo do Hermes
            if v:
                if not estop.is_engaged():
                    estop.engage(reason="Ergon")
            else:
                estop.disengage()
            st = estop.get_state()
        except Exception as exc:  # noqa: BLE001
            return self._json(503, {"error": f"não consegui mudar a pausa ({type(exc).__name__})"})
        return self._json(200, {"ok": True, "pausada": st is not None, "desde": (st or {}).get("engaged_at")})

    def _api_toolsets_get(self) -> None:
        try:
            from hermes_cli.config import load_config  # módulo do Hermes
            from hermes_cli.tools_config import _get_platform_tools
            cfg = load_config()
            enabled = sorted(_get_platform_tools(cfg, "api_server", include_default_mcp_servers=False))
        except Exception as exc:  # noqa: BLE001
            return self._json(503, {"error": f"não consegui ler a configuração ({type(exc).__name__})"})
        return self._json(200, {"enabled": enabled, "safe": sorted(_SAFE_TOOLSETS), "guarded": sorted(_GUARDED_TOOLSETS),
                                "known": _known(cfg, "api_server")})

    def _api_toolsets_put(self, body: dict[str, Any]) -> None:
        raw = body.get("enabled")
        if not isinstance(raw, list):
            return self._json(400, {"error": "envie enabled: [...]"})
        wanted = sorted({str(x) for x in raw} & (_SAFE_TOOLSETS | _GUARDED_TOOLSETS) | _SEMPRE_TOOLSETS)
        # Conjunto de plugin fora da lista só fica desligado se o Hermes o "conhece" nesta plataforma
        # (hermes_cli/tools_config.py, _enabled_plugin_toolsets); o seletor do próprio Hermes grava isso a cada salvamento.
        # A lista também é do Hermes (hermes_cli/left_core_migration.py): grava a união com o que já está lá. Sem ler o
        # que está lá, não grava nada (o PUT troca a lista inteira).
        try:
            from hermes_cli.config import load_config  # módulo do Hermes
            known = sorted(set(_known(load_config(), "api_server")) | set(_ERGON_PLUGIN_TOOLSETS))
        except Exception as exc:  # noqa: BLE001
            return self._json(503, {"error": f"não consegui ler a configuração ({type(exc).__name__})"})
        status, data = _dash_call("PUT", "/api/config", "", {"config": {
            "platform_toolsets": {"api_server": wanted}, "known_plugin_toolsets": {"api_server": known}}})
        if status != 200:
            return self._send(status, data)
        return self._json(200, {"ok": True, "enabled": wanted, "known": known})

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
    # um processo só (o da ponte) acompanha a configuração da equipe e refaz os perfis dos agentes quando ela muda
    threading.Thread(target=_perfis_laco, name="ergon-perfis", daemon=True).start()
    _control_started = True
    logger.info("ergon_bridge: ponte de controle na porta %s (rede interna)", port)


def register(ctx) -> None:
    ctx.register_hook("post_gateway_admission", on_admission)
    ctx.register_hook("pre_gateway_dispatch", on_pre_dispatch)
    # botões dos cartões e o adaptador vivo (só no processo do gateway, quando o canal conecta)
    for _plataforma, _fabrica in (("telegram", _fabrica_telegram), ("discord", _fabrica_discord)):
        try:
            ctx.register_platform_handler(_plataforma, _fabrica)
        except Exception:  # noqa: BLE001 - Hermes sem esse registro: os canais ficam sem botões, o resto segue
            logger.warning("ergon_bridge: sem registro de botões para %s", _plataforma, exc_info=False)
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("post_tool_call", on_post_tool_call)
    ctx.register_hook("pre_api_request", on_pre_api_request)
    ctx.register_hook("post_api_request", on_post_api_request)
    ctx.register_hook("subagent_start", on_subagent_start)
    ctx.register_hook("subagent_stop", on_subagent_stop)
    # "Não treinar com os meus dados" em cada chamada pelo OpenRouter (Hermes sem intermediários: fica só a configuração)
    try:
        if hasattr(ctx, "register_middleware"):
            ctx.register_middleware("llm_request", on_llm_request)
    except Exception:  # noqa: BLE001
        logger.warning("ergon_bridge: intermediário de requisição não registrado", exc_info=False)
    ctx.register_tool(name="conexoes_listar", toolset=_TS_CONEXOES, schema=_CONEXOES_LISTAR, handler=tool_conexoes_listar)
    ctx.register_tool(name="conexoes_executar", toolset=_TS_CONEXOES, schema=_CONEXOES_EXECUTAR, handler=tool_conexoes_executar)
    # cartões: perguntar de volta, pedido seguro de chave e senha de administrador
    ctx.register_hook("on_human_input_request", on_human_input_request)
    ctx.register_hook("on_human_input_resolved", on_human_input_resolved)
    ctx.register_hook("transform_tool_result", on_transform_tool_result)
    ctx.register_hook("post_llm_call", on_post_llm_call)
    ctx.register_tool(name="perguntar", toolset=_TS_CARTOES, schema=_perguntar_schema(), handler=tool_perguntar)
    ctx.register_tool(name="pedir_chave", toolset=_TS_CARTOES, schema=_PEDIR_CHAVE, handler=tool_pedir_chave)
    ctx.register_tool(name="pedir_senha_admin", toolset=_TS_CARTOES, schema=_PEDIR_SENHA_ADMIN, handler=tool_pedir_senha_admin)
    _mascarar_guardadas()
    _chaves_no_terminal()
    try:
        _iniciar_disparos()
    except Exception:  # noqa: BLE001 - o entregador dos avisos das rotinas nunca derruba o Hermes
        logger.warning("ergon_bridge: entregador das rotinas não iniciou", exc_info=False)
    try:
        _start_control()
    except Exception:  # noqa: BLE001 - a ponte de controle nunca derruba o Hermes
        logger.warning("ergon_bridge: ponte de controle não iniciou", exc_info=False)
