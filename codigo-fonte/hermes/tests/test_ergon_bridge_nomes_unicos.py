"""Nenhuma função ou classe do plugin é definida duas vezes no mesmo módulo: a segunda esconderia a primeira em
silêncio (foi assim que `_perfil_dir` da mídia quebrou a criação de perfis na rc.33).

  python3 -I hermes/tests/test_ergon_bridge_nomes_unicos.py
"""
import ast
import collections
import os
import sys

AQUI = os.path.dirname(os.path.abspath(__file__))
PLUGINS = os.environ.get("ERGON_PLUGINS") or ("/p" if os.path.isdir("/p") else os.path.join(AQUI, "..", "plugins"))
ok = True
for raiz, _, arquivos in os.walk(os.path.join(PLUGINS, "ergon_bridge")):
    for nome in arquivos:
        if not nome.endswith(".py"):
            continue
        caminho = os.path.join(raiz, nome)
        arvore = ast.parse(open(caminho, encoding="utf-8").read())
        nomes = collections.Counter(n.name for n in arvore.body if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)))
        repetidos = sorted(k for k, v in nomes.items() if v > 1)
        if repetidos:
            ok = False
            print(f"FALHA {nome}: definidos mais de uma vez: {', '.join(repetidos)}")
        else:
            print(f"ok  {nome}: nenhum nome repetido")
print("TUDO CERTO" if ok else "HOUVE FALHA")
sys.exit(0 if ok else 1)
