#!/usr/bin/env python3
"""Send dictation-prompt cases (from `cargo run --example dictation_prompt_cases`) to a local
Ollama model and check the cleaned output against expectations.

Usage:
    cargo run --example dictation_prompt_cases > cases.json      # from src-tauri/
    python tools/bench/run_dictation_cases.py cases.json [model]

Verifies the LLM-only dictionary: real words preserved (video), near-misses fixed (veet->Vite,
oh llama->ollama), replacement pairs applied (github->GitHub), no false insertions.
"""
import json
import sys
import urllib.request

OLLAMA = "http://localhost:11434/api/chat"


def chat(model: str, system: str, user: str) -> str:
    body = json.dumps({
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "stream": False,
        "think": False,
        "options": {"temperature": 0},
    }).encode()
    req = urllib.request.Request(OLLAMA, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.load(resp)["message"]["content"].strip()


def main() -> int:
    cases_path = sys.argv[1] if len(sys.argv) > 1 else "cases.json"
    model = sys.argv[2] if len(sys.argv) > 2 else "gemma4:e4b"
    with open(cases_path, encoding="utf-8") as f:
        cases = json.load(f)

    print(f"model: {model}   cases: {len(cases)}\n" + "=" * 72)
    passed = 0
    for c in cases:
        out = chat(model, c["system"], c["user"])
        low = out.lower()
        miss = [s for s in c["expect_contains"] if s.lower() not in low]
        bad = [s for s in c["expect_absent"] if s.lower() in low]
        ok = not miss and not bad
        passed += ok
        print(f"[{'PASS' if ok else 'FAIL'}] {c['name']}")
        print(f"   in : {c['raw']}")
        print(f"   out: {out}")
        if miss:
            print(f"   !! missing expected: {miss}")
        if bad:
            print(f"   !! present but forbidden: {bad}")
        print("-" * 72)

    print(f"\n{passed}/{len(cases)} passed")
    return 0 if passed == len(cases) else 1


if __name__ == "__main__":
    raise SystemExit(main())
