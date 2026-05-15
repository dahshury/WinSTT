"""Generate Windows ICO + PNG app icons from the light-mode logo."""

from __future__ import annotations

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "docs" / "identity" / "material" / "logo-light.png"
ICO_TARGETS = [
    ROOT / "frontend" / "build" / "icon.ico",
    ROOT / "frontend" / "public" / "icon.ico",
]
PNG_TARGET = ROOT / "frontend" / "build" / "icon.png"

# Standard ICO resolutions including HiDPI Windows sizes.
ICO_SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]


def main() -> None:
    src = Image.open(SRC).convert("RGBA")

    base = src
    if base.width != base.height:
        side = max(base.size)
        canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
        canvas.paste(base, ((side - base.width) // 2, (side - base.height) // 2), base)
        base = canvas

    base_256 = base.resize((256, 256), Image.Resampling.LANCZOS)
    for target in ICO_TARGETS:
        target.parent.mkdir(parents=True, exist_ok=True)
        base_256.save(target, format="ICO", sizes=ICO_SIZES)
        print(f"Wrote {target} ({target.stat().st_size / 1024:.1f} KB)")

    PNG_TARGET.parent.mkdir(parents=True, exist_ok=True)
    base.resize((512, 512), Image.Resampling.LANCZOS).save(PNG_TARGET, format="PNG", optimize=True)
    print(f"Wrote {PNG_TARGET} ({PNG_TARGET.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
