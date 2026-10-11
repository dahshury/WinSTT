"""Refresh immutable Hub revisions and LFS SHA-256s for the shipped STT catalog.

Metadata only: never downloads model weights. Review the resulting manifest before shipping.
Run with Python 3 from the repository root. Custom/local models remain user controlled.
"""
import concurrent.futures
import json
import re
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GLOBS = (ROOT / "src-tauri/src/winstt/stt/resolver/globs.rs").read_text(encoding="utf-8")
CATALOG = (ROOT / "src-tauri/src/winstt/catalog/data.rs").read_text(encoding="utf-8")
ALIASES = dict(re.findall(r'\("([^"]+)",\s*"([^"]+)"\)',
                         GLOBS.split("pub const MODEL_REPOS:")[1].split("];", 1)[0]))
# Include multi-line tuples too.
ALIASES.update(dict(re.findall(r'\(\s*"([^"]+)",\s*"([^"]+)"\s*,?\s*\)',
                              GLOBS.split("pub const MODEL_REPOS:")[1].split("];", 1)[0])))
NAMES = re.findall(r'onnx_model_name:\s*"([^"]+)"', CATALOG)
REPOS = {ALIASES.get(name, name) for name in NAMES}
OVERRIDES = GLOBS.split("const QUANT_REPO_OVERRIDES:")[1].split("];", 1)[0]
REPOS.update(re.findall(r'Quantization::\w+,\s*"([^"]+/[^"]+)"', OVERRIDES))
assert len(NAMES) == 84, "catalog changed; review generator coverage"
assert all(re.fullmatch(r"[\w.-]+/[\w.-]+", repo) for repo in REPOS), "unresolved alias"


def fetch(repo):
    url = f"https://huggingface.co/api/models/{repo}?blobs=true"
    request = urllib.request.Request(url, headers={"User-Agent": "WinSTT-model-pin-generator"})
    with urllib.request.urlopen(request, timeout=90) as response:
        info = json.load(response)
    revision = info["sha"]
    assert re.fullmatch(r"[a-f0-9]{40}", revision)
    files = {}
    for sibling in info["siblings"]:
        name = sibling["rfilename"]
        # Preserve every sibling: ONNX external data may use arbitrary safe names
        # (.weights, .data, .bin, numbered shards), not just .onnx_data.
        lfs = sibling.get("lfs") or {}
        checksum = lfs.get("sha256")
        entry = {"size": sibling.get("size", lfs.get("size"))}
        if checksum:
            assert re.fullmatch(r"[a-f0-9]{64}", checksum)
            entry["sha256"] = checksum
        files[name] = entry
    print(f"{repo}: {revision} ({len(files)} files)", flush=True)
    return repo, {"revision": revision, "files": files}


if __name__ == "__main__":
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        pins = dict(pool.map(fetch, sorted(REPOS)))
    output = ROOT / "src-tauri/src/winstt/stt/resolver/model-pins.json"
    output.write_text(json.dumps(pins, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"Pinned {len(pins)} repositories for {len(NAMES)} catalog entries")
