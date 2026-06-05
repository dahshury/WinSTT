FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive
ENV CARGO_HOME=/cargo
ENV RUSTUP_HOME=/rustup
ENV BUN_INSTALL=/bun
ENV PATH=/cargo/bin:/bun/bin:$PATH
ENV CI=1
ENV NO_AT_BRIDGE=1
ENV WEBKIT_DISABLE_COMPOSITING_MODE=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    clang \
    cmake \
    curl \
    dbus-x11 \
    file \
    fuse \
    git \
    libasound2-dev \
    libayatana-appindicator3-dev \
    libclang-dev \
    libevdev-dev \
    libfuse2t64 \
    libgtk-3-dev \
    libgtk-layer-shell-dev \
    librsvg2-dev \
    libssl-dev \
    libudev-dev \
    libvulkan-dev \
    libwebkit2gtk-4.1-dev \
    libx11-dev \
    libxdo-dev \
    ninja-build \
    patchelf \
    pkg-config \
    rpm \
    unzip \
    wget \
    xdg-utils \
    xauth \
    xvfb \
  && rm -rf /var/lib/apt/lists/*

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain stable \
  && rustup component add rustfmt clippy

RUN curl -fsSL https://bun.sh/install | bash -s "bun-v1.3.6"

WORKDIR /work
