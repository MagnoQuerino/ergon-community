#!/usr/bin/env bash
# Compilação cruzada (Linux → Windows, MinGW) para testes locais. Recebe o repositório em /repo (só leitura) e
# entrega em /out o executável e, se o NSIS do contêiner conseguir, o instalador. Não é o artefato oficial.
set -euo pipefail
rm -rf /work && mkdir -p /work /out
cp /repo/package.json /work/
cp -r /repo/desktop /work/desktop
rm -rf /work/desktop/node_modules
[ -d /cache/target ] && ln -sfn /cache/target /work/desktop/src-tauri/target
cd /work/desktop
npm ci --no-audit --no-fund --loglevel=error
npx tauri build --target x86_64-pc-windows-gnu --bundles nsis ${TAURI_ARGS:-} \
  || npx tauri build --target x86_64-pc-windows-gnu --no-bundle ${TAURI_ARGS:-}
cp src-tauri/target/x86_64-pc-windows-gnu/release/ergon-desktop.exe /out/
cp src-tauri/target/x86_64-pc-windows-gnu/release/bundle/nsis/*.exe /out/ 2>/dev/null || true
ls -la /out
