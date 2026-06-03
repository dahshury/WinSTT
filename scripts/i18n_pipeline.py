"""
Internal translation pipeline for messages/*.json (not shipped — a dev helper).

Subcommands:
  extract  -> writes .i18n-work/<loc>.todo.json = {keyPath: englishValue} for
              every key that is MISSING or English-equal in <loc> (brand/tech
              keys in IDENTICAL_BY_DESIGN are skipped — they stay English).
  merge    -> rebuilds messages/<loc>.json from en.json's structure/order using
              .i18n-work/<loc>.done.json (translator output) layered over the
              existing translations. Drops stale keys, guarantees exact parity.

Run from repo root:  python scripts/i18n_pipeline.py extract
                     python scripts/i18n_pipeline.py merge
"""
import json
import os
import sys
from collections import OrderedDict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MSG = os.path.join(ROOT, "messages")
WORK = os.path.join(ROOT, ".i18n-work")

# Keep in sync with scripts/check-i18n.ts IDENTICAL_BY_DESIGN.
IDENTICAL_BY_DESIGN = {
    "titleBar.appName",
    "about.appInfoTitle",
    "about.appVersion",
    "about.frameworkVersion",
    "about.webview2Version",
    "settings.tabLlm",
    "integrations.openai",
    "integrations.groupOpenai",
    "integrations.elevenlabs",
    "integrations.groupElevenlabs",
    "llm.providerAppleIntelligence",
    "mainPage.pttButton",
    "tray.modePtt",
    "model.deviceCpuLabel",
    "general.autoSubmitKeyEnter",
    "general.autoSubmitKeyCtrlEnter",
    "integrations.openaiApiKeyPlaceholder",
    "integrations.elevenlabsApiKeyPlaceholder",
    "llm.openrouterApiKeyPlaceholder",
    "llm.pullProgress",
    "llm.modelSizeLabel",
    "model.resourceWarning.rowHintOk",
}


def load(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f, object_pairs_hook=OrderedDict)


def flatten(obj, prefix="", out=None):
    if out is None:
        out = OrderedDict()
    if isinstance(obj, dict):
        for k, v in obj.items():
            flatten(v, f"{prefix}.{k}" if prefix else k, out)
    else:
        out[prefix] = obj
    return out


def locales():
    return sorted(
        f[:-5]
        for f in os.listdir(MSG)
        if f.endswith(".json") and f != "en.json"
    )


def cmd_extract():
    os.makedirs(WORK, exist_ok=True)
    en = flatten(load(os.path.join(MSG, "en.json")))
    summary = []
    for loc in locales():
        cur = flatten(load(os.path.join(MSG, f"{loc}.json")))
        todo = OrderedDict()
        for k, env in en.items():
            if not isinstance(env, str) or env.strip() == "":
                continue
            if k in IDENTICAL_BY_DESIGN:
                continue
            v = cur.get(k)
            if k not in cur or (isinstance(v, str) and v == env):
                todo[k] = env
        with open(os.path.join(WORK, f"{loc}.todo.json"), "w", encoding="utf-8") as f:
            json.dump(todo, f, ensure_ascii=False, indent=2)
        summary.append((loc, len(todo)))
    for loc, n in summary:
        print(f"{loc}: {n} strings to translate")
    print(f"\nTotal: {sum(n for _, n in summary)} strings across {len(summary)} locales")
    print(f"Work dir: {WORK}")


def unflatten(flat):
    """Rebuild a nested OrderedDict from {a.b.c: v} preserving insertion order."""
    root = OrderedDict()
    for key, val in flat.items():
        parts = key.split(".")
        node = root
        for p in parts[:-1]:
            node = node.setdefault(p, OrderedDict())
        node[parts[-1]] = val
    return root


def cmd_merge():
    en = flatten(load(os.path.join(MSG, "en.json")))
    for loc in locales():
        cur = flatten(load(os.path.join(MSG, f"{loc}.json")))
        done_path = os.path.join(WORK, f"{loc}.done.json")
        done = {}
        if os.path.exists(done_path):
            done = load(done_path)
        # Rebuild in en.json key order → exact parity, stale keys dropped.
        merged = OrderedDict()
        applied = 0
        kept = 0
        fallback = 0
        for k, env in en.items():
            if k in done and isinstance(done[k], str) and done[k].strip() != "":
                merged[k] = done[k]
                applied += 1
            elif k in cur:
                merged[k] = cur[k]
                kept += 1
            else:
                merged[k] = env
                fallback += 1
        nested = unflatten(merged)
        with open(os.path.join(MSG, f"{loc}.json"), "w", encoding="utf-8") as f:
            json.dump(nested, f, ensure_ascii=False, indent=2)
            f.write("\n")
        print(f"{loc}: applied {applied} translations, kept {kept} existing, {fallback} en-fallback")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "extract":
        cmd_extract()
    elif cmd == "merge":
        cmd_merge()
    else:
        print(__doc__)
        sys.exit(1)
