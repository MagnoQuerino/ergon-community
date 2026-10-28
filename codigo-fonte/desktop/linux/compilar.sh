#!/usr/bin/env bash
# Compila e testa o Ergon Desktop para Linux dentro do contêiner ergon-desktop-linux (Ubuntu 22.04).
# Recebe o repositório em /repo (só leitura), trabalha em /work e entrega os pacotes em /out.
set -euo pipefail
rm -rf /work/desktop && mkdir -p /work /out
cp /repo/package.json /work/
cp -r /repo/desktop /work/desktop
rm -rf /work/desktop/node_modules
[ -d /cache/target ] && ln -sfn /cache/target /work/desktop/src-tauri/target
cd /work/desktop
npm ci --no-audit --no-fund --loglevel=error
(cd src-tauri && cargo test ${CARGO_LOCKED:-} --release 2>&1 | tail -25)
npx tauri build --bundles deb,appimage ${TAURI_ARGS:-}
cp src-tauri/Cargo.lock /out/
cp src-tauri/target/release/bundle/deb/*.deb src-tauri/target/release/bundle/appimage/*.AppImage /out/
(cd /out && sha256sum *.deb *.AppImage > SHA256SUMS-linux.txt && cat SHA256SUMS-linux.txt)
