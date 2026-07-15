#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -gt 1 ]; then
  echo "usage: $0 [artifact-directory]" >&2
  exit 2
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
artifact_dir="${1:-$repo_root/dist/macos/aarch64}"
if [ ! -d "$artifact_dir" ]; then echo "Artifact directory does not exist: $artifact_dir" >&2; exit 1; fi
artifact_dir="$(cd "$artifact_dir" && pwd)"
temp_parent="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
audit_root="$(mktemp -d "$temp_parent/winstt-package-audit.XXXXXX")"
mounted="false"
mountpoint="$audit_root/dmg"

cleanup() {
  if [ "$mounted" = true ]; then hdiutil detach "$mountpoint" -quiet || true; fi
  case "$audit_root" in
    "$temp_parent"/winstt-package-audit.*) rm -rf -- "$audit_root" ;;
    *) echo "Refusing to clean unexpected audit path: $audit_root" >&2; return 1 ;;
  esac
}
trap cleanup EXIT

require_one() {
  local pattern="$1"
  local label="$2"
  local matches=()
  while IFS= read -r -d '' match; do matches+=("$match"); done < <(
    find "$artifact_dir" -maxdepth 1 -type f -name "$pattern" -print0
  )
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

audit_app() {
  local app="$1"
  local label="$2"
  local main
  main="$(find "$app/Contents/MacOS" -type f -perm -111 \( -name winstt -o -name WinSTT \) -print -quit)"
  if [ -z "$main" ]; then
    echo "Missing executable in $label app bundle" >&2
    exit 1
  fi

  assert_named_file "$app" winstt_context "$label context sidecar"
  assert_named_file "$app" recording_sound_default.wav "$label recording sound"
  assert_named_file "$app" error_sound.wav "$label error sound"
  assert_named_file "$app" marimba_start.wav "$label startup sound"
  assert_named_file "$app" recording.png "$label recording image"
  assert_named_file "$app" tray_idle.png "$label tray image"
  assert_named_file "$app" silero_vad_v4.onnx "$label VAD runtime model"
  assert_named_file "$app" gigaam_vocab.txt "$label GigaAM vocabulary"

  local sidecar
  sidecar="$(find "$app" -type f -name winstt_context -perm -111 -print -quit)"
  if [ -z "$sidecar" ]; then
    echo "$label context sidecar is not executable." >&2
    exit 1
  fi

  codesign --verify --deep --strict "$app"
  local dependencies="$audit_root/${label//[^a-zA-Z0-9]/-}-otool.txt"
  otool -L "$main" >"$dependencies"
  otool -L "$sidecar" >>"$dependencies"
  if grep -E '[[:space:]]+(/usr/local/|/opt/homebrew/|/Users/|/private/tmp/)' "$dependencies"; then
    echo "$label contains a non-portable native runtime dependency." >&2
    exit 1
  fi

  local output="$audit_root/${label//[^a-zA-Z0-9]/-}.json"
  local error="$output.stderr"
  python3 - "$main" "$output" "$error" <<'PY'
import json
import os
import pathlib
import subprocess
import sys

executable, output_name, error_name = sys.argv[1:]
home = pathlib.Path(output_name).with_suffix(".home")
home.mkdir()
environment = os.environ.copy()
environment["HOME"] = str(home)
try:
    result = subprocess.run(
        [executable, "--list-models", "--json"],
        capture_output=True,
        env=environment,
        text=True,
        timeout=60,
        check=False,
    )
except subprocess.TimeoutExpired as error:
    raise SystemExit(f"headless smoke timed out: {error}") from error
path = pathlib.Path(output_name)
path.write_text(result.stdout, encoding="utf-8")
pathlib.Path(error_name).write_text(result.stderr, encoding="utf-8")
if result.returncode:
    raise SystemExit(f"headless smoke failed ({result.returncode}): {result.stderr}")
if not result.stdout.strip():
    raise SystemExit("empty JSON smoke output")
json.loads(result.stdout)
PY
  printf 'OK: %s --list-models --json\n' "$label"
}

dmg="$(require_one '*.dmg' 'DMG')"
app_archive="$(require_one '*.app.tar.gz' 'app archive')"

mkdir "$mountpoint"
hdiutil attach "$dmg" -readonly -nobrowse -mountpoint "$mountpoint" -quiet
mounted="true"
dmg_app="$(find "$mountpoint" -maxdepth 2 -type d -name '*.app' -print -quit)"
if [ -z "$dmg_app" ]; then
  echo "DMG does not contain an app bundle." >&2
  exit 1
fi
audit_app "$dmg_app" DMG
hdiutil detach "$mountpoint" -quiet
mounted="false"

archive_root="$audit_root/archive"
mkdir "$archive_root"
tar -xzf "$app_archive" -C "$archive_root"
archive_app="$(find "$archive_root" -maxdepth 3 -type d -name '*.app' -print -quit)"
if [ -z "$archive_app" ]; then
  echo "App archive does not contain an app bundle." >&2
  exit 1
fi
audit_app "$archive_app" app-archive

echo "macOS package audit passed."
