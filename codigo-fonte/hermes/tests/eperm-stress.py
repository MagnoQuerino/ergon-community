"""Criação de arquivos em paralelo no cofre do motor: aparece EPERM? (rodar como o usuário hermes)."""
import os
import shutil
import sys
import tempfile
import threading
from collections import Counter

base = sys.argv[1] if len(sys.argv) > 1 else "/opt/data/cache/ergon-stress"
threads = int(sys.argv[2]) if len(sys.argv) > 2 else 16
per = int(sys.argv[3]) if len(sys.argv) > 3 else 150
os.makedirs(base, exist_ok=True)
errs: Counter = Counter()
ok = [0]
lock = threading.Lock()


def work(i: int) -> None:
    d = os.path.join(base, f"t{i}")
    os.makedirs(d, exist_ok=True)
    for _ in range(per):
        try:
            fd, p = tempfile.mkstemp(dir=d, prefix=".tmp")
            os.write(fd, b"x" * 64)
            os.close(fd)
            os.replace(p, os.path.join(d, "alvo"))
            with lock:
                ok[0] += 1
        except OSError as e:
            with lock:
                errs[f"[{e.errno}] {e.strerror}"] += 1


ts = [threading.Thread(target=work, args=(i,)) for i in range(threads)]
for t in ts:
    t.start()
for t in ts:
    t.join()
shutil.rmtree(base, ignore_errors=True)
print(f"{threads} threads x {per}: ok={ok[0]} erros={sum(errs.values())} {dict(errs)}")
