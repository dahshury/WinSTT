#!/usr/bin/env bash
# Bench our Rust stt_spike for one (catalog_id, provider, quant, audio) config.
# Runs the spike 3× (fresh process each = own cold→warm), extracts the WARM timing
# (steady-state inference, kernel-compile excluded), prints median + a transcript snippet.
#
# Usage: bench_spike.sh <catalog_id> <cpu|dml> <quant|none> <audio.f32>
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
EXE="$REPO_ROOT/src-tauri/target/release/examples/stt_spike.exe"
ID="$1"; PROV="$2"; QUANT="${3:-none}"; AUDIO="$4"
[ "$QUANT" = "none" ] && QUANT=""
DUR=$(python -c "import os;print(f'{os.path.getsize(\"$AUDIO\")/4/16000:.2f}')")

warms=()
text=""
for i in 1 2 3; do
  out=$(SPIKE_PROVIDER="$PROV" SPIKE_QUANT="$QUANT" SPIKE_AUDIO="$AUDIO" SPIKE_CACHE_ONLY=1 \
        "$EXE" --catalog "$ID" 2>/dev/null)
  # warm timing line: "=== CATALOG TRANSCRIPT (id, warm 109.12ms) ==="
  w=$(printf '%s\n' "$out" | grep -oE "warm [0-9.]+(ms|µs|s)\)" | head -1 | grep -oE "[0-9.]+(ms|µs|s)")
  # normalize to ms
  ms=$(python -c "
s='$w'
import re
m=re.match(r'([0-9.]+)(ms|µs|s)',s)
v=float(m.group(1)); u=m.group(2)
print(f'{v*1000 if u==\"s\" else v/1000 if u==\"µs\" else v:.1f}')" 2>/dev/null)
  warms+=("$ms")
  # capture transcript from run 1 (line after the warm TRANSCRIPT header)
  if [ "$i" = "1" ]; then
    text=$(printf '%s\n' "$out" | awk '/CATALOG TRANSCRIPT.*warm/{getline; print; exit}')
  fi
done
median=$(printf '%s\n' "${warms[@]}" | sort -n | sed -n '2p')
echo "RESULT impl=ours model=$ID provider=$PROV quant=${QUANT:-none} audio=$(basename "$AUDIO") dur=$DUR warm_ms=$median rtf=$(python -c "print(f'{$median/1000/$DUR:.4f}')") runs=[${warms[*]}]"
echo "  TEXT: ${text:0:90}"
