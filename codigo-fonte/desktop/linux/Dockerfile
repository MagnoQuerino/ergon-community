# Ergon Desktop — ambiente de compilação e de teste no Linux (Ubuntu 22.04: a base mínima homologada).
# Compila o .deb e o AppImage com as mesmas versões da CI e roda o aplicativo sob Xvfb para os testes de interface.
#   docker build -t ergon-desktop-linux desktop/linux
FROM ubuntu:22.04@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956

ENV DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl wget file ca-certificates pkg-config xz-utils git \
      libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
      xvfb xauth x11-utils imagemagick dbus-x11 fonts-dejavu-core fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/*

# Node (o mesmo do projeto) e Rust fixados
RUN curl -fsSL https://nodejs.org/dist/v24.18.1/node-v24.18.1-linux-x64.tar.xz | tar -xJ -C /opt \
    && ln -s /opt/node-v24.18.1-linux-x64/bin/node /usr/local/bin/node \
    && ln -s /opt/node-v24.18.1-linux-x64/bin/npm /usr/local/bin/npm \
    && ln -s /opt/node-v24.18.1-linux-x64/bin/npx /usr/local/bin/npx
ENV RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain 1.98.0 && rustc --version

WORKDIR /src
