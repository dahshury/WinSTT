#!/usr/bin/env python3
"""Generate every WinSTT app + tray + docs icon from ONE source.

Source: build/icon-source-raw.png — the WinSTT brand mark (a VR/audio visor
headset with a glowing waveform, on a transparent field, square, pre-padded).
One source → the identical mark everywhere (app window, taskbar, installer, mac,
tray, splash, and the docs-site logo).

Outputs:
  build/icon.png      1024  ← mark (electron-builder mac/png + docs logo via @app-icon)
  build/icon-source.png     ← square master (kept, back-compat)
  build/icon.ico      multi ← mark (window + taskbar + NSIS)
  build/icon.icns           ← mark (macOS, best-effort)
  public/icon.ico     multi ← mark (renderer TitleBar top-left)
  public/icon.png     256   ← mark (renderer fallback + installer splash)
  electron/resources/tray/  ← mark (idle) + live-visualizer fallback dots

The system-tray IDLE glyph trims the mark's transparent margin and refits it to
fill the tiny 16/32 px canvas so it stays legible. The recording / transcribing
tray frames are driven by the LIVE procedural visualizer in
electron/lib/recording-indicator.ts; the red-dot / three-dot PNGs written here
are only menu-label fallbacks, never the live paint.

Usage:  python scripts/generate-icons.py   (bun run icon:generate)
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent  # frontend/
RAW = ROOT / "build" / "icon-source-raw.png"   # the one brand source
MASTER = ROOT / "build" / "icon-source.png"    # kept square master (derived)

# Tray inks for the live-visualizer fallback dots (mirror recording-indicator.ts).
THEME_INK = {
    "dark": (0xF4, 0xF4, 0xF5),
    "light": (0x18, 0x18, 0x1B),
    "color": (0xA7, 0x8B, 0xFA),
}
RECORDING_RED = (0xEF, 0x44, 0x44)
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

# Windows scales the notification-area (tray) icon with the display DPI:
# 16px@100%, 20px@125%, 24px@150%, 28px@175%, 32px@200%, 40px@250%, 48px@300%.
# Emitting an exact PNG for every step (loaded as multi-scale nativeImage reps in
# tray-state.ts) means Windows never has to upscale the 16px base → no blur, the
# way desktop apps stay crisp. Suffix "" = the @1x base; the rest mirror
# Electron's "@{scale}x" HiDPI filename convention.
TRAY_IDLE_SCALES: list[tuple[str, int]] = [
    ("", 16),
    ("@1.25x", 20),
    ("@1.5x", 24),
    ("@1.75x", 28),
    ("@2x", 32),
    ("@2.5x", 40),
    ("@3x", 48),
    ("@4x", 64),
]


def load_source() -> Image.Image:
    src = RAW if RAW.exists() else MASTER
    return Image.open(src).convert("RGBA")


def square_pad(im: Image.Image) -> Image.Image:
    """Pad to a transparent square without scaling (keeps the whole mark)."""
    im = im.convert("RGBA")
    w, h = im.size
    if w == h:
        return im
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas


def autocrop(im: Image.Image, thresh: int = 8) -> Image.Image:
    """Crop away the fully/near transparent border."""
    a = np.array(im.convert("RGBA"))[:, :, 3]
    ys, xs = np.where(a > thresh)
    if len(xs) == 0:
        return im.convert("RGBA")
    return im.convert("RGBA").crop(
        (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    )


def fit_canvas(im: Image.Image, size: int, fill: float = 0.98) -> Image.Image:
    """Trim transparent margin, then scale the content to ~`fill` of a square
    `size` canvas, centred — keeps the mark legible at tiny tray sizes."""
    content = autocrop(im)
    w, h = content.size
    scale = (size * fill) / max(w, h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = content.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - nw) // 2, (size - nh) // 2), resized)
    return canvas


def save_app_icons(master: Image.Image) -> None:
    """build/icon.png (+ docs logo), public PNG, ico, icns — the mark as-authored."""
    build = ROOT / "build"
    public = ROOT / "public"
    public.mkdir(parents=True, exist_ok=True)

    big = master.resize((1024, 1024), Image.LANCZOS)
    big.save(build / "icon.png")  # also the docs-site logo via @app-icon
    master.resize((256, 256), Image.LANCZOS).save(public / "icon.png")

    members = [master.resize((s, s), Image.LANCZOS) for s in ICO_SIZES]
    base = members[-1]  # 256
    for path in (build / "icon.ico", public / "icon.ico"):
        base.save(
            path,
            format="ICO",
            sizes=[(s, s) for s in ICO_SIZES],
            append_images=members[:-1],
        )
    try:
        big.save(build / "icon.icns", format="ICNS")
    except Exception as exc:  # noqa: BLE001 - macOS icon is best-effort
        print(f"  (icns skipped: {exc})")


def tray_idle(master: Image.Image, size: int) -> Image.Image:
    """Trim margin + refit the mark to fill the tiny tray canvas."""
    return fit_canvas(master, size)


def tray_dot(ink: tuple[int, int, int], size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    r = size * 0.32
    c = size / 2
    d.ellipse((c - r, c - r, c + r, c + r), fill=(*ink, 255))
    return canvas


def tray_three_dots(ink: tuple[int, int, int], size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    r = max(1, size * 0.09)
    gap = size * 0.22
    c = size / 2
    for cx in (c - gap, c, c + gap):
        d.ellipse((cx - r, c - r, cx + r, c + r), fill=(*ink, 255))
    return canvas


def save_tray_icons(master: Image.Image) -> None:
    out = ROOT / "electron" / "resources" / "tray"
    out.mkdir(parents=True, exist_ok=True)
    for theme, ink in THEME_INK.items():
        # idle = the mark, emitted at the full DPI ladder so Windows picks the
        # exact-pixel bitmap for the current scaling instead of upscaling 16px.
        # Theme-agnostic: the mark carries its own colour and reads on any tray.
        for suffix, size in TRAY_IDLE_SCALES:
            tray_idle(master, size).save(out / f"tray_idle_{theme}{suffix}.png")
        # recording / transcribing are only menu-label fallbacks — the live paint
        # comes from recording-indicator.ts. 16 + @2x is plenty for those.
        for size, suffix in ((16, ""), (32, "@2x")):
            tray_dot(RECORDING_RED, size).save(out / f"tray_recording_{theme}{suffix}.png")
            tray_three_dots(ink, size).save(out / f"tray_transcribing_{theme}{suffix}.png")


def save_preview(master: Image.Image) -> Path:
    """Verification montage: app icon on bgs + ico sizes; tray glyphs."""
    pad, cell, cols, rows = 16, 96, 8, 3
    width = pad + cols * (cell + pad)
    height = pad + rows * (cell + pad) + 40
    sheet = Image.new("RGBA", (width, height), (24, 24, 27, 255))

    def place(img: Image.Image, col: int, row: int, bg: tuple[int, int, int, int] | None = None) -> None:
        x = pad + col * (cell + pad)
        y = pad + row * (cell + pad)
        if bg:
            sheet.alpha_composite(Image.new("RGBA", (cell, cell), bg), (x, y))
        sheet.alpha_composite(img.convert("RGBA").resize((cell, cell), Image.LANCZOS), (x, y))

    # Row 0: app icon on dark / light / mid + real ico sizes (nearest-upscaled)
    place(master, 0, 0, (12, 12, 16, 255))
    place(master, 1, 0, (245, 245, 245, 255))
    place(master, 2, 0, (90, 110, 150, 255))
    for i, s in enumerate((16, 32, 48, 64)):
        place(master.resize((s, s), Image.LANCZOS).resize((cell, cell), Image.NEAREST), 3 + i, 0, (40, 40, 46, 255))
    # Row 1: tray idle per theme bg + real 16/32 sizes
    place(tray_idle(master, 64), 0, 1, (20, 20, 24, 255))
    place(tray_idle(master, 64), 1, 1, (235, 235, 238, 255))
    place(tray_idle(master, 64), 2, 1, (30, 30, 36, 255))
    place(tray_idle(master, 16).resize((cell, cell), Image.NEAREST), 3, 1, (20, 20, 24, 255))
    place(tray_idle(master, 32).resize((cell, cell), Image.NEAREST), 4, 1, (20, 20, 24, 255))
    # Row 2: live-visualizer fallback states
    place(tray_dot(RECORDING_RED, 64), 0, 2, (20, 20, 24, 255))
    place(tray_three_dots(THEME_INK["dark"], 64), 1, 2, (20, 20, 24, 255))

    dest = Path(tempfile.gettempdir()) / "icon-preview.png"
    sheet.convert("RGBA").save(dest)
    return dest


def main() -> None:
    master = square_pad(load_source())
    MASTER.parent.mkdir(parents=True, exist_ok=True)
    master.save(MASTER)  # persist the square master as the kept source
    save_app_icons(master)
    save_tray_icons(master)
    preview = save_preview(master)
    print(f"Master {master.size} -> app + tray + docs icons regenerated (one source).")
    print(f"Preview: {preview}")


if __name__ == "__main__":
    main()
