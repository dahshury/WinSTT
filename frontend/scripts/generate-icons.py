#!/usr/bin/env python3
"""
Generates every WinSTT app icon from a single source illustration.

Source: build/icon-source.png  (the silver-microphone illustration; this script
also (re)derives it from a raw render if the transparent master is missing —
see RAW_FALLBACK).

Outputs (all derived from the one master so the brand mark is identical
everywhere):
  build/icon.png                 1024x1024 transparent (electron-builder mac/png)
  build/icon.ico                 multi-size Windows icon (window + taskbar + NSIS)
  build/icon.icns                macOS icon (best-effort)
  public/icon.ico                served to the renderer (TitleBar top-left mark)
  public/icon.png                256 png fallback
  electron/resources/tray/       state x theme tray PNGs (idle = the mic glyph;
                                 recording = red dot; transcribing = three dots)

The background is removed by flood-filling the border-connected near-white
region to transparent (so the mic's interior highlights are preserved), then
feathering the cut edge.

Usage:  python scripts/generate-icons.py
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent  # frontend/
MASTER = ROOT / "build" / "icon-source.png"
# Raw render still carrying its white background (used only to (re)build MASTER).
RAW_FALLBACK = ROOT / "build" / "icon-source-raw.png"

# Tray theme inks (mirror generate-tray-icons.ts / recording-indicator.ts).
THEME_INK = {
    "dark": (0xF4, 0xF4, 0xF5),   # light glyph on a dark system tray (Win11 default)
    "light": (0x18, 0x18, 0x1B),  # near-black glyph on a light tray
    "color": (0xA7, 0x8B, 0xFA),  # WinSTT accent (Linux)
}
RECORDING_RED = (0xEF, 0x44, 0x44)


def remove_white_bg(im: Image.Image, tol: int = 36, feather: float = 0.8) -> Image.Image:
    """Flood-fill the border-connected near-white region to transparent."""
    im = im.convert("RGBA")
    arr = np.array(im)
    rgb = arr[:, :, :3].astype(np.int16)
    white_dist = (255 - rgb).max(axis=2)  # 0 == pure white
    nearwhite = white_dist <= tol
    labels, _ = ndimage.label(nearwhite)
    border = (
        set(labels[0, :]) | set(labels[-1, :]) | set(labels[:, 0]) | set(labels[:, -1])
    )
    border.discard(0)
    bg = np.isin(labels, list(border))
    alpha = arr[:, :, 3].copy()
    alpha[bg] = 0
    if feather > 0:
        alpha = ndimage.gaussian_filter(alpha.astype(np.float32), sigma=feather)
        alpha = np.clip(alpha, 0, 255).astype(np.uint8)
    arr[:, :, 3] = alpha
    return Image.fromarray(arr, "RGBA")


def autocrop(im: Image.Image, thresh: int = 8) -> Image.Image:
    a = np.array(im)[:, :, 3]
    ys, xs = np.where(a > thresh)
    if len(xs) == 0:
        return im
    return im.crop((int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1))


def square_pad(im: Image.Image, margin: float = 0.08) -> Image.Image:
    w, h = im.size
    side = round(max(w, h) * (1 + margin * 2))
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas


def build_master() -> tuple[Image.Image, Image.Image]:
    """Return (square padded master, tight crop) — both transparent RGBA."""
    if MASTER.exists():
        src = Image.open(MASTER).convert("RGBA")
        # If the saved master still has an opaque white field, clean it again.
        if np.array(src)[:, :, 3].min() == 255:
            src = remove_white_bg(src)
    else:
        src = remove_white_bg(Image.open(RAW_FALLBACK))
    tight = autocrop(src)
    master = square_pad(tight)
    return master, tight


def save_app_icons(master: Image.Image) -> None:
    build = ROOT / "build"
    public = ROOT / "public"
    big = master.resize((1024, 1024), Image.LANCZOS)
    big.save(build / "icon.png")
    (public).mkdir(parents=True, exist_ok=True)
    master.resize((256, 256), Image.LANCZOS).save(public / "icon.png")

    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    members = [master.resize((s, s), Image.LANCZOS) for s in ico_sizes]
    base = members[-1]  # 256
    for path in (build / "icon.ico", public / "icon.ico"):
        base.save(
            path,
            format="ICO",
            sizes=[(s, s) for s in ico_sizes],
            append_images=members[:-1],
        )
    try:
        big.save(build / "icon.icns", format="ICNS")
    except Exception as exc:  # noqa: BLE001 - macOS icon is best-effort
        print(f"  (icns skipped: {exc})")


def tray_mic(tight: Image.Image, ink: tuple[int, int, int], size: int, fill: float = 0.86) -> Image.Image:
    """Themed monochrome mic silhouette filling ~`fill` of a `size` canvas."""
    w, h = tight.size
    scale = (size * fill) / max(w, h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = tight.resize((nw, nh), Image.LANCZOS)
    a = np.array(resized)[:, :, 3]
    glyph = np.zeros((nh, nw, 4), np.uint8)
    glyph[:, :, 0], glyph[:, :, 1], glyph[:, :, 2] = ink
    glyph[:, :, 3] = a
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(Image.fromarray(glyph, "RGBA"), ((size - nw) // 2, (size - nh) // 2))
    return canvas


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


def save_tray_icons(tight: Image.Image) -> None:
    out = ROOT / "electron" / "resources" / "tray"
    out.mkdir(parents=True, exist_ok=True)
    for theme, ink in THEME_INK.items():
        for size, suffix in ((16, ""), (32, "@2x")):
            # idle = the mic (the standby brand mark)
            tray_mic(tight, ink, size).save(out / f"tray_idle_{theme}{suffix}.png")
            # recording = red dot across every theme (universal "live" cue)
            tray_dot(RECORDING_RED, size).save(out / f"tray_recording_{theme}{suffix}.png")
            # transcribing = three dots in the theme ink
            tray_three_dots(ink, size).save(out / f"tray_transcribing_{theme}{suffix}.png")


def save_preview(master: Image.Image, tight: Image.Image) -> None:
    """A verification montage: mic on dark/light, ico sizes, tray glyphs."""
    pad = 16
    cell = 96
    cols = 8
    rows = 3
    W = pad + cols * (cell + pad)
    H = pad + rows * (cell + pad) + 40
    sheet = Image.new("RGBA", (W, H), (24, 24, 27, 255))

    def place(img, col, row, bg=None):
        x = pad + col * (cell + pad)
        y = pad + row * (cell + pad)
        if bg:
            patch = Image.new("RGBA", (cell, cell), bg)
            sheet.alpha_composite(patch, (x, y))
        thumb = img.resize((cell, cell), Image.LANCZOS)
        sheet.alpha_composite(thumb, (x, y))

    # Row 0: app icon on dark, light, mid backgrounds + 1024 master
    place(master, 0, 0, (12, 12, 16, 255))
    place(master, 1, 0, (245, 245, 245, 255))
    place(master, 2, 0, (90, 110, 150, 255))
    # ico sizes (upscaled nearest to inspect crispness)
    for i, s in enumerate((16, 32, 48, 64)):
        place(master.resize((s, s), Image.LANCZOS).resize((cell, cell), Image.NEAREST), 3 + i, 0, (40, 40, 46, 255))
    # Row 1: tray idle (mic) per theme on its matching tray bg
    place(tray_mic(tight, THEME_INK["dark"], 64), 0, 1, (20, 20, 24, 255))
    place(tray_mic(tight, THEME_INK["light"], 64), 1, 1, (235, 235, 238, 255))
    place(tray_mic(tight, THEME_INK["color"], 64), 2, 1, (30, 30, 36, 255))
    # tray idle at real 16/32 sizes (nearest-upscaled to inspect)
    place(tray_mic(tight, THEME_INK["dark"], 16).resize((cell, cell), Image.NEAREST), 3, 1, (20, 20, 24, 255))
    place(tray_mic(tight, THEME_INK["dark"], 32).resize((cell, cell), Image.NEAREST), 4, 1, (20, 20, 24, 255))
    # Row 2: other tray states
    place(tray_dot(RECORDING_RED, 64), 0, 2, (20, 20, 24, 255))
    place(tray_three_dots(THEME_INK["dark"], 64), 1, 2, (20, 20, 24, 255))

    sheet.convert("RGBA").save(Path("/tmp/icon-preview.png"))


def main() -> None:
    master, tight = build_master()
    MASTER.parent.mkdir(parents=True, exist_ok=True)
    master.save(MASTER)  # persist the transparent master as the kept source
    save_app_icons(master)
    save_tray_icons(tight)
    save_preview(master, tight)
    print(f"Master {master.size} -> app icons + tray icons regenerated.")
    print("Preview: /tmp/icon-preview.png")


if __name__ == "__main__":
    main()
