"""Derive the two landing tiles that aren't direct panel captures.

The docs landing showcase (docs/src/routes/index.tsx) uses six uniform 3:2
`feat-*` tiles. Four are captured by `shoot-landing.mjs`; the other two are
cropped/padded from screenshots produced by `capture.mjs interactive`:

  feat-tts   ← section-tts.png   padded top/bottom to 3:2 (TTS is a short, wide
                                  section; padding with its own bg keeps the
                                  Local/Cloud toggle + voice + speed centred and
                                  un-clipped)
  feat-model ← model-dropdown.png cropped to the open picker's cards (sidebar +
                                  redundant Source/Model header removed) at 3:2

Run after `capture.mjs interactive`:  python scripts/docs-shots/derive-landing-tiles.py
Requires Pillow.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

SHOTS = Path(__file__).resolve().parents[2].parent / "docs" / "public" / "screenshots"
ASPECT = 1.5  # 3:2


def derive_tts() -> None:
    src = Image.open(SHOTS / "section-tts.png").convert("RGB")
    w, h = src.size
    target_h = round(w / ASPECT)
    bg = src.getpixel((3, 3))  # panel background sample
    canvas = Image.new("RGB", (w, target_h), bg)
    canvas.paste(src, (0, (target_h - h) // 2))
    canvas.save(SHOTS / "feat-tts.png")
    print(f"  [ok] feat-tts.png {canvas.size}")


def derive_model() -> None:
    src = Image.open(SHOTS / "model-dropdown.png").convert("RGB")
    # Tuned for the 1880x2080 model-dropdown capture: drop the left settings
    # sidebar (~x348) and the dimmed panel behind the popup (~x1200), start at
    # the search box (~y452) so the tile is the model CARDS, not the form.
    x0, x1, y0 = 348, 1200, 452
    cw = x1 - x0
    ch = round(cw / ASPECT)
    src.crop((x0, y0, x1, y0 + ch)).save(SHOTS / "feat-model.png")
    print(f"  [ok] feat-model.png ({cw}x{ch})")


if __name__ == "__main__":
    derive_tts()
    derive_model()
    print("Done.")
