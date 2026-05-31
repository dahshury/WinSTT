"""Split docs/identity/material/logo.png into dark/light variants with bg removed."""

from __future__ import annotations

from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "docs" / "identity" / "material" / "logo.png"
OUT_DIR = ROOT / "docs" / "identity" / "material"


def flood_fill_transparent(img: Image.Image, seeds: list[tuple[int, int]], tolerance: int) -> Image.Image:
    """Flood fill from given seeds: pixels within `tolerance` of seed color become transparent."""
    img = img.convert("RGBA")
    px = img.load()
    w, h = img.size
    assert px is not None

    visited = bytearray(w * h)
    queue: deque[tuple[int, int]] = deque()

    def color_dist(a: tuple[int, int, int, int], b: tuple[int, int, int, int]) -> int:
        return max(abs(a[0] - b[0]), abs(a[1] - b[1]), abs(a[2] - b[2]))

    seed_colors: list[tuple[int, int, int, int]] = []
    for sx, sy in seeds:
        seed_colors.append(px[sx, sy])
        queue.append((sx, sy))
        visited[sy * w + sx] = 1

    while queue:
        x, y = queue.popleft()
        cur = px[x, y]
        if not any(color_dist(cur, sc) <= tolerance for sc in seed_colors):
            continue
        px[x, y] = (0, 0, 0, 0)
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not visited[ny * w + nx]:
                visited[ny * w + nx] = 1
                queue.append((nx, ny))
    return img


def crop_to_content(img: Image.Image, pad: int = 0) -> Image.Image:
    bbox = img.getbbox()
    if bbox is None:
        return img
    left, top, right, bottom = bbox
    left = max(0, left - pad)
    top = max(0, top - pad)
    right = min(img.width, right + pad)
    bottom = min(img.height, bottom + pad)
    return img.crop((left, top, right, bottom))


def square_pad(img: Image.Image) -> Image.Image:
    w, h = img.size
    size = max(w, h)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, ((size - w) // 2, (size - h) // 2), img)
    return out


def main() -> None:
    src = Image.open(SRC).convert("RGBA")
    w, h = src.size
    mid = w // 2

    # The source has "Dark Mode"/"Light Mode" labels at top and bottom (~150px strips).
    # Crop them off before flood filling so the labels don't survive as foreground.
    label_strip = 170
    left = src.crop((0, label_strip, mid, h - label_strip))
    right = src.crop((mid, label_strip, w, h - label_strip))

    # Seeds: each corner of the half. Tolerance is tight (~18) so the fill stays
    # in the panel background and doesn't leak into the icon's near-white interior
    # via the soft anti-aliased edge.
    def corner_seeds(im: Image.Image) -> list[tuple[int, int]]:
        ww, hh = im.size
        return [(5, 5), (ww - 6, 5), (5, hh - 6), (ww - 6, hh - 6)]

    dark = flood_fill_transparent(left, corner_seeds(left), tolerance=22)
    light = flood_fill_transparent(right, corner_seeds(right), tolerance=18)

    dark = square_pad(crop_to_content(dark, pad=8))
    light = square_pad(crop_to_content(light, pad=8))

    dark_path = OUT_DIR / "logo-dark.png"
    light_path = OUT_DIR / "logo-light.png"
    dark.save(dark_path, optimize=True)
    light.save(light_path, optimize=True)
    print(f"Wrote {dark_path} ({dark.size})")
    print(f"Wrote {light_path} ({light.size})")


if __name__ == "__main__":
    main()
