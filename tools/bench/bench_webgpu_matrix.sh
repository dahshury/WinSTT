#!/usr/bin/env bash
# WebGPU-vs-CPU matrix for the DML-incompatible engine bucket (the models the app
# currently pins to CPU because the DirectML EP crashes/hangs on them — see
# EngineKind::is_dml_incompatible). Runs bench_stt_decode.sh per (model, quant,
# provider) and prints a comparison table plus a transcript-parity check (the
# WebGPU EP is experimental; a fast-but-wrong transcript must not count as a win).
#
# Prereq: stt_decode_bench built WITH the webgpu feature:
#   tools/windows/cargo-env.bat build --release --features webgpu --example stt_decode_bench
#
# Usage: bench_webgpu_matrix.sh [audio.f32]   (default tools/bench/audio/jfk_short_3s.f32)
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AUDIO="${1:-$SCRIPT_DIR/audio/jfk_short_3s.f32}"

# model:quant pairs — the DML-incompatible bucket that is locally cached.
# (qwen3-asr excluded: not cached on this machine; add "qwen3-asr-0.6b:int4" once pulled.)
CONFIGS=(
  "cohere-transcribe:none"
  "nemo-canary-180m-flash:int8"
  "nemo-canary-1b-v2:int8"
  "sense-voice-small:int8"
  "dolphin-base-ctc:int8"
  "zipformer-en:none"
  "streaming-zipformer-en:int8"
)

declare -A WARM TEXT
for cfg in "${CONFIGS[@]}"; do
  id="${cfg%%:*}"; quant="${cfg##*:}"
  for prov in cpu webgpu; do
    out=$(bash "$SCRIPT_DIR/bench_stt_decode.sh" "$id" "$prov" "$quant" "$AUDIO")
    echo "$out"
    WARM["$id/$prov"]=$(printf '%s\n' "$out" | grep -oE "warm_ms=[0-9.]+" | cut -d= -f2)
    TEXT["$id/$prov"]=$(printf '%s\n' "$out" | sed -n 's/^  TEXT: //p')
  done
done

echo
echo "==================== WEBGPU vs CPU MATRIX ===================="
printf "%-28s %10s %10s %8s  %s\n" "model" "cpu_ms" "webgpu_ms" "speedup" "transcripts"
for cfg in "${CONFIGS[@]}"; do
  id="${cfg%%:*}"
  cpu="${WARM[$id/cpu]:-}"; gpu="${WARM[$id/webgpu]:-}"
  if [ -n "$cpu" ] && [ -n "$gpu" ]; then
    speed=$(python -c "print(f'{$cpu/$gpu:.2f}x')" 2>/dev/null || echo "?")
  else
    speed="?"
  fi
  if [ "${TEXT[$id/cpu]:-a}" = "${TEXT[$id/webgpu]:-b}" ]; then parity="MATCH"; else parity="DIFF <- verify!"; fi
  printf "%-28s %10s %10s %8s  %s\n" "$id" "${cpu:-fail}" "${gpu:-fail}" "$speed" "$parity"
done
