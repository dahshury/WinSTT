#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
artifact_dir="${1:-$repo_root/dist/linux}"
if [ ! -d "$artifact_dir" ]; then echo "Artifact directory does not exist: $artifact_dir" >&2; exit 1; fi
artifact_dir="$(cd "$artifact_dir" && pwd)"
temp_parent="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
audit_root="$(mktemp -d "$temp_parent/winstt-package-audit.XXXXXX")"

cleanup() {
  case "$audit_root" in
    "$temp_parent"/winstt-package-audit.*) rm -rf -- "$audit_root" ;;
    *) echo "Refusing to clean unexpected audit path: $audit_root" >&2; return 1 ;;
  esac
}
trap cleanup EXIT

require_one() {
  local pattern="$1"
  local label="$2"
  mapfile -d '' matches < <(find "$artifact_dir" -maxdepth 1 -type f -name "$pattern" -print0)
  if [ "${#matches[@]}" -ne 1 ]; then
    echo "Expected exactly one $label ($pattern) in $artifact_dir; found ${#matches[@]}." >&2
    exit 1
  fi
  printf '%s' "${matches[0]}"
}

assert_named_file() {
  local root="$1"
  local name="$2"
  local label="$3"
  if ! find "$root" -type f -name "$name" -size +0c -print -quit | grep -q .; then
    echo "Missing $label ($name) under $root" >&2
    exit 1
  fi
}

find_main_executable() {
  local root="$1"
  find "$root" -type f -perm /111 \( -name winstt -o -name WinSTT \) -print -quit
}

smoke_headless() {
  local executable="$1"
  local label="$2"
  local output="$audit_root/smoke-${label//[^a-zA-Z0-9]/-}.json"
  local error="$output.stderr"
  local home="$audit_root/home-${label//[^a-zA-Z0-9]/-}"
  mkdir -p "$home/config" "$home/data" "$home/cache"
  if ! env \
    HOME="$home" \
    XDG_CONFIG_HOME="$home/config" \
    XDG_DATA_HOME="$home/data" \
    XDG_CACHE_HOME="$home/cache" \
    LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-}" \
    timeout 60s "$executable" --list-models --json >"$output" 2>"$error"; then
    echo "$label headless smoke failed:" >&2
    cat "$error" >&2
    exit 1
  fi
  python3 - "$output" <<'PY'
import json
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
if not path.read_text(encoding="utf-8").strip():
    raise SystemExit(f"empty JSON smoke output: {path}")
with path.open(encoding="utf-8") as stream:
    json.load(stream)
PY
  printf 'OK: %s --list-models --json\n' "$label"
}

audit_tree() {
  local root="$1"
  local label="$2"
  local main
  main="$(find_main_executable "$root")"
  if [ -z "$main" ]; then
    echo "Missing executable WinSTT binary in $label" >&2
    exit 1
  fi

  assert_named_file "$root" winstt_context "$label context sidecar"
  assert_named_file "$root" recording_sound_default.wav "$label recording sound"
  assert_named_file "$root" error_sound.wav "$label error sound"
  assert_named_file "$root" marimba_start.wav "$label startup sound"
  assert_named_file "$root" recording.png "$label recording image"
  assert_named_file "$root" tray_idle.png "$label tray image"
  assert_named_file "$root" silero_vad_v4.onnx "$label VAD runtime model"
  assert_named_file "$root" gigaam_vocab.txt "$label GigaAM vocabulary"

  local sidecar
  sidecar="$(find "$root" -type f -name winstt_context -perm /111 -print -quit)"
  if [ -z "$sidecar" ]; then
    echo "$label context sidecar is not executable." >&2
    exit 1
  fi

  local library_dirs=()
  while IFS= read -r directory; do library_dirs+=("$directory"); done < <(
    find "$root" -type f \( -name '*.so' -o -name '*.so.*' \) -printf '%h\n' | sort -u
  )
  local joined=""
  if [ "${#library_dirs[@]}" -gt 0 ]; then joined="$(IFS=:; printf '%s' "${library_dirs[*]}")"; fi
  if ! LD_LIBRARY_PATH="$joined:${LD_LIBRARY_PATH:-}" ldd "$main" >"$audit_root/ldd.txt"; then
    cat "$audit_root/ldd.txt" >&2
    exit 1
  fi
  if grep -q 'not found' "$audit_root/ldd.txt"; then
    echo "$label has unresolved native runtime dependencies:" >&2
    cat "$audit_root/ldd.txt" >&2
    exit 1
  fi
  if ! LD_LIBRARY_PATH="$joined:${LD_LIBRARY_PATH:-}" ldd "$sidecar" >"$audit_root/ldd-sidecar.txt"; then
    cat "$audit_root/ldd-sidecar.txt" >&2
    exit 1
  fi
  if grep -q 'not found' "$audit_root/ldd-sidecar.txt"; then
    echo "$label context sidecar has unresolved native runtime dependencies:" >&2
    cat "$audit_root/ldd-sidecar.txt" >&2
    exit 1
  fi

  LD_LIBRARY_PATH="$joined:${LD_LIBRARY_PATH:-}" smoke_headless "$main" "$label"
}

appimage="$(require_one '*.AppImage' 'AppImage')"
deb="$(require_one '*.deb' 'Debian package')"
rpm="$(require_one '*.rpm' 'RPM package')"

mkdir "$audit_root/appimage"
chmod +x "$appimage"
(cd "$audit_root/appimage" && "$appimage" --appimage-extract >/dev/null)
audit_tree "$audit_root/appimage/squashfs-root" AppImage

mkdir "$audit_root/deb"
dpkg-deb -x "$deb" "$audit_root/deb"
audit_tree "$audit_root/deb" deb

mkdir "$audit_root/rpm"
(cd "$audit_root/rpm" && rpm2cpio "$rpm" | cpio -idm --quiet)
audit_tree "$audit_root/rpm" rpm

echo "Linux package audit passed."
