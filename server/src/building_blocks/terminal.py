"""Shared terminal utilities for colored output and timestamp formatting."""

from __future__ import annotations

from datetime import datetime


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


def debug_print(message: str, *, enabled: bool) -> None:
    """Print a debug message to stderr if enabled."""
    if not enabled:
        return
    import sys
    import threading
    import time

    from colorama import Fore, Style

    timestamp = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())
    thread_name = threading.current_thread().name
    print(
        f"{Fore.CYAN}[DEBUG][{timestamp}][{thread_name}] {message}{Style.RESET_ALL}",
        file=sys.stderr,
    )
