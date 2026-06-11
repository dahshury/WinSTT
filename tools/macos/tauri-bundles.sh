#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <rust-target> <artifact-arch>" >&2
  exit 2
fi

target="$1"
arch="$2"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../.." && pwd)"
output_dir="$repo_root/dist/macos/$arch"
bundle_dir="$repo_root/src-tauri/target/$target/release/bundle"

cd "$repo_root"

rm -rf "$bundle_dir/macos" "$bundle_dir/dmg"
bun run tauri build --target "$target" --bundles app,dmg

rm -rf "$output_dir"
mkdir -p "$output_dir"

copy_artifact() {
  local artifact="$1"
  local name
  local dest
  name="$(basename "$artifact")"

  case "$name" in
    *"$arch"*)
      dest="$name"
      ;;
    *.app.tar.gz.sig)
      dest="${name%.app.tar.gz.sig}-$arch.app.tar.gz.sig"
      ;;
    *.app.tar.gz)
      dest="${name%.app.tar.gz}-$arch.app.tar.gz"
      ;;
    *.dmg)
      dest="${name%.dmg}-$arch.dmg"
      ;;
    *)
      dest="$name"
      ;;
  esac

  cp "$artifact" "$output_dir/$dest"
}

artifact_count=0
while IFS= read -r artifact; do
  copy_artifact "$artifact"
  artifact_count=$((artifact_count + 1))
done < <(
  find "$bundle_dir" -type f \
    \( -name '*.dmg' -o -name '*.app.tar.gz' -o -name '*.app.tar.gz.sig' \) |
    sort
)

if [ "$artifact_count" -eq 0 ]; then
  echo "No macOS bundle artifacts were produced for $target." >&2
  exit 1
fi

printf 'macOS artifacts written to %s:\n' "$output_dir"
find "$output_dir" -maxdepth 1 -type f -print | sort | sed 's#^#  #'
