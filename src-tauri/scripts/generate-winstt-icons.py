#!/usr/bin/env python3
"""Generate the WinSTT Tauri icon + tray set from the ONE WinSTT brand mark.

Mirrors frontend/scripts/generate-icons.py (the reference app's icon pipeline)
so the Rust/Tauri port carries the IDENTICAL VR-visor mascot everywhere:

  src-tauri/icons/        app + installer icons (tauri.conf bundle.icon)
    32x32.png 64x64.png 128x128.png 128x128@2x.png icon.png icon.ico icon.icns

  src-tauri/resources/    system-tray icons read by src/tray.rs get_icon_path()
    tray_idle.png            (dark theme  -> the mark)
    tray_recording.png       (dark theme  -> red dot)
    tray_transcribing.png    (dark theme  -> three dots, light ink)
    tray_idle_dark.png       (light theme -> the mark)
    tray_recording_dark.png  (light theme -> red dot)
    tray_transcribing_dark.png (light theme -> three dots, dark ink)
    handy.png                (colored/linux -> the mark)        [kept name; tray.rs reads it]
    recording.png            (colored/linux -> red dot)
    transcribing.png         (colored/linux -> three dots, accent ink)

Source: frontend/build/icon-source-raw.png — the WinSTT brand mark.
Run once; converge step builds the app. Idempotent.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

# app/src-tauri/scripts/ -> repo root is three parents up
SRC_TAURI = Path(__file__).resolve().parent.parent          # app/src-tauri/
REPO = SRC_TAURI.parent.parent                              # WinSTT/
RAW = REPO / "frontend" / "build" / "icon-source-raw.png"   # the one brand source

ICONS = SRC_TAURI / "icons"
RES = SRC_TAURI / "resources"

# Mirror frontend/scripts/generate-icons.py inks.
THEME_INK = {
    "dark": (0xF4, 0xF4, 0xF5),   # light ink on a dark tray
    "light": (0x18, 0x18, 0x1B),  # dark ink on a light tray
    "color": (0xA7, 0x8B, 0xFA),  # accent ink (linux/colored)
}
RECORDING_RED = (0xEF, 0x44, 0x44)
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
# Tauri tray uses the largest representation and downscales; 64px matches the
# Handy tray PNGs the Rust code already loaded and stays crisp.
TRAY_SIZE = 64


def load_source() -> Image.Image:
    return Image.open(RAW).convert("RGBA")


def square_pad(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    w, h = im.size
    if w == h:
        return im
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas


def autocrop(im: Image.Image, thresh: int = 8) -> Image.Image:
    a = np.array(im.convert("RGBA"))[:, :, 3]
    ys, xs = np.where(a > thresh)
    if len(xs) == 0:
        return im.convert("RGBA")
    return im.convert("RGBA").crop(
        (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1)
    )


def fit_canvas(im: Image.Image, size: int, fill: float = 0.98) -> Image.Image:
    """Trim margin, scale content to ~fill of a square canvas, centred."""
    content = autocrop(im)
    w, h = content.size
    scale = (size * fill) / max(w, h)
    nw, nh = max(1, round(w * scale)), max(1, round(h * scale))
    resized = content.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - nw) // 2, (size - nh) // 2), resized)
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


def save_app_icons(master: Image.Image) -> list[str]:
    ICONS.mkdir(parents=True, exist_ok=True)
    written: list[str] = []

    def emit(img: Image.Image, name: str) -> None:
        img.save(ICONS / name)
        written.append(str(ICONS / name))

    emit(master.resize((32, 32), Image.LANCZOS), "32x32.png")
    emit(master.resize((64, 64), Image.LANCZOS), "64x64.png")
    emit(master.resize((128, 128), Image.LANCZOS), "128x128.png")
    emit(master.resize((256, 256), Image.LANCZOS), "128x128@2x.png")
    emit(master.resize((512, 512), Image.LANCZOS), "icon.png")

    members = [master.resize((s, s), Image.LANCZOS) for s in ICO_SIZES]
    base = members[-1]  # 256
    ico_path = ICONS / "icon.ico"
    base.save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in ICO_SIZES],
        append_images=members[:-1],
    )
    written.append(str(ico_path))

    big = master.resize((1024, 1024), Image.LANCZOS)
    try:
        big.save(ICONS / "icon.icns", format="ICNS")
        written.append(str(ICONS / "icon.icns"))
    except Exception as exc:  # noqa: BLE001
        print(f"  (icns skipped: {exc})")

    return written


def save_tray_icons(master: Image.Image) -> list[str]:
    """Write the tray PNGs under the names src/tray.rs::get_icon_path() reads."""
    RES.mkdir(parents=True, exist_ok=True)
    written: list[str] = []

    idle = fit_canvas(master, TRAY_SIZE)
    rec_red = tray_dot(RECORDING_RED, TRAY_SIZE)

    # (filename, image) per theme bucket the Rust code expects.
    mapping = {
        # dark theme  -> light ink + the mark
        "tray_idle.png": idle,
        "tray_recording.png": rec_red,
        "tray_transcribing.png": tray_three_dots(THEME_INK["dark"], TRAY_SIZE),
        # light theme -> dark ink + the mark
        "tray_idle_dark.png": idle,
        "tray_recording_dark.png": rec_red,
        "tray_transcribing_dark.png": tray_three_dots(THEME_INK["light"], TRAY_SIZE),
        # colored / linux -> accent ink + the mark (filenames kept as tray.rs reads)
        "handy.png": idle,
        "recording.png": rec_red,
        "transcribing.png": tray_three_dots(THEME_INK["color"], TRAY_SIZE),
    }
    for name, img in mapping.items():
        img.save(RES / name)
        written.append(str(RES / name))
    return written


def main() -> None:
    if not RAW.exists():
        raise SystemExit(f"WinSTT brand source missing: {RAW}")
    master = square_pad(load_source())
    written = save_app_icons(master)
    written += save_tray_icons(master)
    print(f"Master {master.size} -> {len(written)} WinSTT Tauri icons written.")
    for w in written:
        print("  " + w)


if __name__ == "__main__":
    main()
