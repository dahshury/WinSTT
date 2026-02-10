"""E2E test: verify Rich progress bar fires during model download.

Run manually after clearing the HF cache for the target model:
    rmdir /s /q %USERPROFILE%\\.cache\\huggingface\\hub\\models--Systran--faster-whisper-tiny
    uv run python tests/integration/test_download_progress_e2e.py
"""

from __future__ import annotations

import sys

sys.path.insert(0, "src")

from rich.console import Console
from rich.progress import (
    BarColumn,
    DownloadColumn,
    Progress,
    SpinnerColumn,
    TaskID,
    TextColumn,
    TimeElapsedColumn,
    TransferSpeedColumn,
)

from src.recorder.domain.events import DownloadProgress

console = Console()

events: list[DownloadProgress] = []
_dl_bar: Progress | None = None
_dl_task_id: TaskID | None = None


def _fmt_eta(seconds: float) -> str:
    if seconds <= 0 or seconds > 86400:
        return "--:--"
    m, s = divmod(int(seconds), 60)
    if m >= 60:
        h, m = divmod(m, 60)
        return f"{h}:{m:02d}:{s:02d}"
    return f"{m}:{s:02d}"


def on_start(model_name: str) -> None:
    global _dl_bar, _dl_task_id
    if _dl_bar is not None:
        return
    console.print(f"[bold blue]Download started: {model_name}[/bold blue]")
    _dl_bar = Progress(
        SpinnerColumn(),
        TextColumn("[bold blue]{task.description}"),
        BarColumn(bar_width=30),
        TextColumn("[progress.percentage]{task.percentage:>3.1f}%"),
        DownloadColumn(),
        TransferSpeedColumn(),
        TextColumn("eta"),
        TextColumn("{task.fields[eta]}"),
        TimeElapsedColumn(),
        console=console,
    )
    _dl_bar.start()
    _dl_task_id = _dl_bar.add_task(model_name, total=0, eta="--:--")


def on_progress(info: DownloadProgress) -> None:
    events.append(info)
    if _dl_bar is not None and _dl_task_id is not None:
        _dl_bar.update(
            _dl_task_id,
            total=info.total_bytes,
            completed=info.downloaded_bytes,
            eta=_fmt_eta(info.eta_seconds),
        )


def on_complete(model_name: str) -> None:
    global _dl_bar, _dl_task_id
    console.print(f"\n[bold green]Download complete: {model_name}[/bold green]")
    if _dl_bar is not None:
        if _dl_task_id is not None:
            _dl_bar.update(_dl_task_id, completed=_dl_bar.tasks[_dl_task_id].total, eta="done")
        _dl_bar.stop()
    _dl_bar = None
    _dl_task_id = None


if __name__ == "__main__":
    from src.recorder import AudioToTextRecorder

    console.print("[bold yellow]Creating recorder with 'tiny' model...[/bold yellow]")
    console.print("[dim](If model is cached, no download bar will appear — clear cache first)[/dim]\n")

    recorder = AudioToTextRecorder(
        model="tiny",
        use_microphone=False,  # no hardware needed
        spinner=False,
        no_log_file=True,
        on_model_download_start=on_start,
        on_model_download_progress=on_progress,
        on_model_download_complete=on_complete,
    )

    # Trigger lazy init (downloads model if not cached)
    _ = recorder.post_speech_silence_duration

    console.print(f"\n[bold]Progress events received: {len(events)}[/bold]")
    if events:
        console.print(f"  First: {events[0]}")
        console.print(f"  Last:  {events[-1]}")
        progress_only = [e.progress for e in events]
        console.print(f"  All values: {[f'{p:.4f}' for p in progress_only]}")
        unique = sorted({round(p, 2) for p in progress_only if 0.0 < p < 1.0})
        console.print(f"  Unique intermediates (rounded): {unique}")
        # Show speed stats
        speeds = [e.speed_bps for e in events if e.speed_bps > 0]
        if speeds:
            avg_speed = sum(speeds) / len(speeds)
            console.print(f"  Avg speed: {avg_speed / 1_000_000:.1f} MB/s")
        console.print("[bold green]SUCCESS — progress bar worked![/bold green]")
    else:
        console.print("[bold yellow]No download events — model was already cached.[/bold yellow]")
        console.print("[dim]Delete cache and re-run to test download progress.[/dim]")

    recorder.shutdown()
