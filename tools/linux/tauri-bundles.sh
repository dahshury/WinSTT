#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
config="$repo_root/tools/tauri-ci-artifacts.conf.json"
output_dir="$repo_root/dist/linux"

cd "$repo_root"

export APPIMAGE_EXTRACT_AND_RUN="${APPIMAGE_EXTRACT_AND_RUN:-1}"
export LD_LIBRARY_PATH="$repo_root/src-tauri/target/release:${LD_LIBRARY_PATH:-}"

bun run tauri build --bundles appimage,deb,rpm --config "$config"

rm -rf "$output_dir"
mkdir -p "$output_dir"

mapfile -d '' artifacts < <(
  find "$repo_root/src-tauri/target/release/bundle" -type f \
    \( -name '*.AppImage' -o -name '*.deb' -o -name '*.rpm' \) \
    -print0
)

if [ "${#artifacts[@]}" -eq 0 ]; then
  echo "No Linux bundle artifacts were produced." >&2
  exit 1
fi

for artifact in "${artifacts[@]}"; do
  cp "$artifact" "$output_dir/"
done

printf 'Linux artifacts written to %s:\n' "$output_dir"
find "$output_dir" -maxdepth 1 -type f -printf '  %f\n' | sort
