#!/usr/bin/env bash
# Build the winstt-apple-llm CLI (Apple Intelligence on-device bridge).
#
# Run this on macOS before invoking electron-builder for a macOS distribution.
# On non-Darwin hosts (Windows / Linux CI) this script is a no-op so it can
# live unconditionally in pre-package hook chains without breaking the build.
#
# Output: frontend/electron/resources/macos/winstt-apple-llm
# That path is picked up by packaging/electron-builder.yml as an
# `extraResources` entry on the `mac` target, landing at
# `Contents/Resources/macos/winstt-apple-llm` inside the .app bundle.
#
# The renderer never touches this file directly — the Electron main process
# resolves `process.resourcesPath/macos/winstt-apple-llm` from
# electron/ipc/apple-intelligence.ts and spawns it via child_process.
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
	echo "winstt-apple-llm: skipping — Apple Intelligence CLI only builds on macOS (host: $(uname -s))." >&2
	exit 0
fi

if [[ "$(uname -m)" != "arm64" ]]; then
	echo "winstt-apple-llm: refusing — Apple Intelligence requires Apple Silicon (host arch: $(uname -m))." >&2
	exit 1
fi

if ! command -v swiftc >/dev/null 2>&1; then
	echo "winstt-apple-llm: swiftc not found in PATH. Install Xcode command-line tools (xcode-select --install)." >&2
	exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUT_DIR="${REPO_ROOT}/frontend/electron/resources/macos"
OUT_BIN="${OUT_DIR}/winstt-apple-llm"

mkdir -p "${OUT_DIR}"

# -target arm64-apple-macos15 — FoundationModels is only present in the
# macOS 15+ SDK (a.k.a. macOS 26/Sequoia internally). swiftc emits a
# weak-linked binary; the runtime #available guard in main.swift handles
# older macOS gracefully.
echo "winstt-apple-llm: compiling Swift CLI → ${OUT_BIN}"
swiftc -O -target arm64-apple-macos15 "${SCRIPT_DIR}/main.swift" -o "${OUT_BIN}"

# Strip debug symbols to shrink the artifact (the bundle is already
# heavy because of the embedded Python runtime).
strip -x "${OUT_BIN}" 2>/dev/null || true

echo "winstt-apple-llm: build complete."
