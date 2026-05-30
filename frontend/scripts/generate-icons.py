#!/usr/bin/env python3
"""Generate every WinSTT app + tray icon from one source illustration.

Source: build/icon-source-raw.png — the WinSTT brand mark (a hooded figure
wearing an audio visor whose lens shows a rainbow waveform; full-bleed, opaque,
square). The kept transparent master build/icon-source.png is derived from it.

Outputs (one source → identical mark everywhere):
  build/icon.png                 1024x1024 (electron-builder mac/png + docs logo)
  build/icon.ico                 multi-size Windows icon (window + taskbar + NSIS)
  build/icon.icns                macOS icon (best-effort)
  public/icon.ico                served to the renderer (TitleBar top-left mark)
  public/icon.png                256 png fallback
  electron/resources/tray/       state x theme tray PNGs

The system-tray IDLE glyph is a tight crop of the bright rainbow waveform visor
(auto-detected by colour density) so it stays legible and on-brand at 16 px on
any taskbar theme — the dark hoodie/background would otherwise vanish into a
dark taskbar. The recording / transcribing tray frames are driven by the LIVE
procedural visualizer in electron/lib/recording-indicator.ts; the red-dot /
three-dot PNGs written here are only menu-label fallbacks, never the live paint.

If a legacy white-background render is supplied instead, the script falls back to
the old flood-fill cleanup + monochrome mic silhouette tray (see remove_white_bg
/ tray_mic).

Usage:  python scripts/generate-icons.py   (bun run icon:generate)
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent  # frontend/
MASTER = ROOT / "build" / "icon-source.png"
# The brand illustration as authored (full-bleed). Master is derived from it.
RAW = ROOT / "build" / "icon-source-raw.png"

# Tray theme inks (mirror recording-indicator.ts) — used by the legacy
# silhouette path and the recording/transcribing fallback dots.
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


def has_white_border(im: Image.Image, tol: int = 36) -> bool:
    """True when the outer frame is mostly near-white (a removable studio bg)."""
    arr = np.array(im.convert("RGBA"))
    rgb = arr[:, :, :3].astype(np.int16)
    nearwhite = (255 - rgb).max(axis=2) <= tol
    border = np.concatenate(
        [nearwhite[0, :], nearwhite[-1, :], nearwhite[:, 0], nearwhite[:, -1]]
    )
    return bool(border.mean() > 0.5)


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


def square(im: Image.Image) -> Image.Image:
    """Pad to a transparent square without scaling (full-bleed art kept intact)."""
    im = im.convert("RGBA")
    w, h = im.size
    if w == h:
        return im
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas


def crop_visor(im: Image.Image) -> Image.Image:
    """Tight square crop around the brightest, most saturated colour cluster
    (the rainbow waveform inside the visor)."""
    rgb = np.asarray(im.convert("RGB")).astype(np.float32)
    mx = rgb.max(axis=2)
    mn = rgb.min(axis=2)
    val = mx / 255.0
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1), 0)
    vivid = (sat > 0.55) & (val > 0.6)
    # Smooth into a density field, then keep the single densest blob so sparse
    # coloured speckles in the background "code rain" don't widen the crop.
    dens = ndimage.gaussian_filter(vivid.astype(np.float32), sigma=max(im.size) / 110)
    core = dens > dens.max() * 0.30
    labels, n = ndimage.label(core)
    w, h = im.size
    if n == 0:  # no vivid cluster — fall back to a centre crop
        side = min(w, h) // 2
        box = ((w - side) // 2, (h - side) // 2, (w + side) // 2, (h + side) // 2)
        return im.convert("RGBA").crop(box)
    sizes = ndimage.sum(np.ones_like(labels), labels, range(1, n + 1))
    biggest = int(np.argmax(sizes)) + 1
    ys, xs = np.where(labels == biggest)
    x0, x1, y0, y1 = int(xs.min()), int(xs.max()), int(ys.min()), int(ys.max())
    # The waveform cluster is wide but short — grow more vertically to bring the
    # whole goggle/visor frame into the glyph.
    pad_x = int((x1 - x0) * 0.18)
    pad_y = int((y1 - y0) * 0.45)
    x0, x1, y0, y1 = x0 - pad_x, x1 + pad_x, y0 - pad_y, y1 + pad_y
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    half = max(x1 - x0, y1 - y0) / 2
    box = (
        int(max(0, cx - half)),
        int(max(0, cy - half)),
        int(min(w, cx + half)),
        int(min(h, cy + half)),
    )
    return im.convert("RGBA").crop(box)


def rounded(im: Image.Image, radius_frac: float = 0.18) -> Image.Image:
    """Mask `im` with rounded corners so it reads as a polished chip in the tray."""
    im = im.convert("RGBA")
    w, h = im.size
    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, w - 1, h - 1), radius=max(1, round(min(w, h) * radius_frac)), fill=255
    )
    arr = np.array(im)
    arr[:, :, 3] = np.minimum(arr[:, :, 3], np.array(mask))
    return Image.fromarray(arr, "RGBA")


def build_master() -> tuple[Image.Image, Image.Image, Image.Image | None]:
    """Return (square master, tight crop, visor glyph|None).

    Full-bleed art → master is the art itself + a visor-crop tray glyph.
    Legacy white-bg render → flood-fill cleanup + None (silhouette tray).
    """
    src = Image.open(RAW if RAW.exists() else MASTER).convert("RGBA")
    if has_white_border(src):
        cleaned = remove_white_bg(src)
        tight = autocrop(cleaned)
        return square_pad(tight), tight, None
    master = square(src)
    return master, master, crop_visor(src)


def save_app_icons(master: Image.Image) -> None:
    build = ROOT / "build"
    public = ROOT / "public"
    big = master.resize((1024, 1024), Image.LANCZOS)
    big.save(build / "icon.png")
    public.mkdir(parents=True, exist_ok=True)
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
    """Legacy themed monochrome silhouette (only used for a white-bg source)."""
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


def tray_visor(visor: Image.Image, size: int) -> Image.Image:
    """Full-colour rounded crop of the rainbow waveform visor (idle glyph)."""
    return rounded(visor.resize((size, size), Image.LANCZOS))


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


def idle_glyph(theme: str, tight: Image.Image, visor: Image.Image | None, size: int) -> Image.Image:
    if visor is not None:  # full-colour visor reads on every theme — theme-agnostic
        return tray_visor(visor, size)
    return tray_mic(tight, THEME_INK[theme], size)


def save_tray_icons(tight: Image.Image, visor: Image.Image | None) -> None:
    out = ROOT / "electron" / "resources" / "tray"
    out.mkdir(parents=True, exist_ok=True)
    for theme, ink in THEME_INK.items():
        for size, suffix in ((16, ""), (32, "@2x")):
            # idle = the brand glyph (visor crop, or legacy mic silhouette)
            idle_glyph(theme, tight, visor, size).save(out / f"tray_idle_{theme}{suffix}.png")
            # recording = red dot across every theme (universal "live" cue)
            tray_dot(RECORDING_RED, size).save(out / f"tray_recording_{theme}{suffix}.png")
            # transcribing = three dots in the theme ink
            tray_three_dots(ink, size).save(out / f"tray_transcribing_{theme}{suffix}.png")


def save_preview(master: Image.Image, tight: Image.Image, visor: Image.Image | None) -> Path:
    """A verification montage: app icon on backgrounds, ico sizes, tray glyphs."""
    pad, cell, cols, rows = 16, 96, 8, 3
    width = pad + cols * (cell + pad)
    height = pad + rows * (cell + pad) + 40
    sheet = Image.new("RGBA", (width, height), (24, 24, 27, 255))

    def place(img: Image.Image, col: int, row: int, bg: tuple[int, int, int, int] | None = None) -> None:
        x = pad + col * (cell + pad)
        y = pad + row * (cell + pad)
        if bg:
            sheet.alpha_composite(Image.new("RGBA", (cell, cell), bg), (x, y))
        sheet.alpha_composite(img.resize((cell, cell), Image.LANCZOS), (x, y))

    # Row 0: app icon on dark / light / mid backgrounds + ico sizes
    place(master, 0, 0, (12, 12, 16, 255))
    place(master, 1, 0, (245, 245, 245, 255))
    place(master, 2, 0, (90, 110, 150, 255))
    for i, s in enumerate((16, 32, 48, 64)):
        place(master.resize((s, s), Image.LANCZOS).resize((cell, cell), Image.NEAREST), 3 + i, 0, (40, 40, 46, 255))
    # Row 1: tray idle glyph per theme bg + real 16/32 sizes (nearest-upscaled)
    place(idle_glyph("dark", tight, visor, 64), 0, 1, (20, 20, 24, 255))
    place(idle_glyph("light", tight, visor, 64), 1, 1, (235, 235, 238, 255))
    place(idle_glyph("color", tight, visor, 64), 2, 1, (30, 30, 36, 255))
    place(idle_glyph("dark", tight, visor, 16).resize((cell, cell), Image.NEAREST), 3, 1, (20, 20, 24, 255))
    place(idle_glyph("dark", tight, visor, 32).resize((cell, cell), Image.NEAREST), 4, 1, (20, 20, 24, 255))
    # Row 2: live-visualizer fallback states
    place(tray_dot(RECORDING_RED, 64), 0, 2, (20, 20, 24, 255))
    place(tray_three_dots(THEME_INK["dark"], 64), 1, 2, (20, 20, 24, 255))

    dest = Path(tempfile.gettempdir()) / "icon-preview.png"
    sheet.convert("RGBA").save(dest)
    return dest


def main() -> None:
    master, tight, visor = build_master()
    MASTER.parent.mkdir(parents=True, exist_ok=True)
    master.save(MASTER)  # persist the square master as the kept source
    save_app_icons(master)
    save_tray_icons(tight, visor)
    preview = save_preview(master, tight, visor)
    mode = "visor crop" if visor is not None else "mic silhouette (legacy)"
    print(f"Master {master.size} -> app icons + tray icons ({mode}) regenerated.")
    print(f"Preview: {preview}")


if __name__ == "__main__":
    main()
