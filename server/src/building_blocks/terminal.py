"""Shared terminal utilities for colored output and timestamp formatting."""

from __future__ import annotations

import sys
from datetime import datetime


def enable_ansi_on_windows() -> None:
    """Enable ANSI escape-sequence processing on legacy Windows consoles.

    Modern Windows Terminal / conhost (≥ Windows 10 1909) handle VT100
    sequences natively. Older or non-default consoles need the
    ``ENABLE_VIRTUAL_TERMINAL_PROCESSING`` flag set on stdout / stderr.

    This used to be ``colorama.init()``; we replicate the relevant bit
    inline so the bundled ``stt-server.exe`` doesn't carry the colorama
    package just for that one call. A no-op on non-Windows platforms and
    if the WinAPI call fails (e.g., stdout redirected to a pipe).
    """
    if sys.platform != "win32":
        return
    try:
        import ctypes

        kernel32 = ctypes.windll.kernel32
        ENABLE_VT = 0x0004
        for std_handle in (-11, -12):  # STD_OUTPUT_HANDLE, STD_ERROR_HANDLE
            handle = kernel32.GetStdHandle(std_handle)
            mode = ctypes.c_ulong()
            if kernel32.GetConsoleMode(handle, ctypes.byref(mode)):
                kernel32.SetConsoleMode(handle, mode.value | ENABLE_VT)
    except Exception:
        pass


def force_utf8_stdio() -> None:
    """Reconfigure ``sys.stdout`` / ``sys.stderr`` to UTF-8 with replacement.

    Default Windows console encoding is cp1252, which can't represent the
    box-drawing characters the server's startup banner uses (``┌``, ``─``,
    ``│``, …) — printing them crashes the recorder thread with
    ``UnicodeEncodeError``. ``errors="replace"`` keeps the process alive
    even on the rare console that can't render some byte; the user sees
    a ``?`` rather than a fatal traceback.

    Safe to call unconditionally: on platforms where stdout is already
    UTF-8, this is a no-op. On any environment where the streams aren't
    ``TextIOWrapper`` (rare — embedded interpreters, some captured-IO
    test runners), the missing ``reconfigure`` attribute is caught and
    skipped silently.
    """
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            # OSError: stream not seekable / line-buffered conflict.
            # ValueError: stream already closed. Either way, fall back
            # to whatever encoding the stream had — no fatal failure.
            continue


class TerminalColors:
    """ANSI color codes for terminal output."""

    HEADER = "\033[95m"  # Magenta
    OKBLUE = "\033[94m"  # Blue
    OKCYAN = "\033[96m"  # Cyan
    OKGREEN = "\033[92m"  # Green
    WARNING = "\033[93m"  # Yellow
    FAIL = "\033[91m"  # Red
    ENDC = "\033[0m"  # Reset to default
    BOLD = "\033[1m"
    UNDERLINE = "\033[4m"


def format_timestamp_ns(timestamp_ns: int) -> str:
    """Format a nanosecond timestamp as HH:MM:SS.mmm."""
    seconds = timestamp_ns // 1_000_000_000
    remainder_ns = timestamp_ns % 1_000_000_000
    dt = datetime.fromtimestamp(seconds)
    time_str = dt.strftime("%H:%M:%S")
    milliseconds = remainder_ns // 1_000_000
    return f"{time_str}.{milliseconds:03d}"


def format_now_hms_ms() -> str:
    """Format the current wall-clock time as HH:MM:SS.mmm (millisecond precision)."""
    return datetime.now().strftime("%H:%M:%S.%f")[:-3]


def debug_print(message: str, *, enabled: bool) -> None:
    """Print a debug message to stderr if enabled."""
    if not enabled:
        return
    import sys
    import threading
    import time

    timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    thread_name = threading.current_thread().name
    print(
        f"{TerminalColors.OKCYAN}[DEBUG][{timestamp}][{thread_name}] {message}{TerminalColors.ENDC}",
        file=sys.stderr,
    )
