"""Observability wiring for the STT server: file logging + optional Sentry.

This module owns BOTH the stdlib ``logging`` configuration (root logger,
console handler, and an optional ``RotatingFileHandler``) AND the
``sentry_sdk`` initialization. It is intentionally placed under
``src/stt_server/`` (the entry-point package) so it is excluded from the
coverage gate, and so the hexagonal architecture rule "domain knows nothing
about infrastructure" is preserved — nothing in ``src/recorder/`` imports
from here.

The Electron frontend spawns ``stt-server.exe`` and passes a log directory
via the ``--log-dir`` CLI flag (or the ``WINSTT_LOG_DIR`` env var); we
write a rotating log file there so users have a real on-disk artifact to
attach to bug reports. Sentry is opt-in via ``SENTRY_DSN`` and scrubs
transcript text + audio metadata before sending events upstream.
"""

from __future__ import annotations

import logging
import logging.handlers
import os
from pathlib import Path
from typing import TYPE_CHECKING, Any

import sentry_sdk

if TYPE_CHECKING:
    from sentry_sdk._types import Breadcrumb, Event, Hint


# ---------------------------------------------------------------------------
# Internal markers / constants
# ---------------------------------------------------------------------------

# Custom attribute we tag our handlers with so a second
# ``configure_observability`` call (e.g. on reload) can detect and skip
# already-installed handlers instead of stacking duplicates.
_HANDLER_MARK = "_winstt_observability_handler"

# Conservative rotation budget — 5 MB per file x 2 backups ~= 15 MB total.
# Big enough to hold a busy debug session, small enough that bundling the
# logs in a bug report stays painless.
_MAX_LOG_BYTES = 5_000_000
_BACKUP_COUNT = 2

_LOG_FORMAT = "%(asctime)s [%(levelname)s] [%(name)s] %(message)s"
_LOG_DATEFMT = "%Y-%m-%d %H:%M:%S"

# Heuristic threshold for "looks like a transcript". Real transcript chunks
# in this codebase tend to be sentences (>30 chars); short status strings
# are safe to leave alone.
_TRANSCRIPT_LEN_THRESHOLD = 30

# Substrings that mark a key as carrying user content. We compare lowercase.
_TRANSCRIPT_KEY_SUBSTRINGS = ("transcript", "text", "sentence", "audio", "pcm", "wav")

# What we replace scrubbed values with — keeping the key visible so the
# stacktrace still makes sense in the Sentry UI.
_SCRUB_PLACEHOLDER = "[scrubbed]"


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------


def _has_marked_handler(logger: logging.Logger, kind: str) -> bool:
    """Return True if the logger already owns one of our handlers of ``kind``."""
    return any(getattr(h, _HANDLER_MARK, None) == kind for h in logger.handlers)


def _build_stream_handler(level: int) -> logging.StreamHandler[Any]:
    handler: logging.StreamHandler[Any] = logging.StreamHandler()
    handler.setLevel(level)
    handler.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_LOG_DATEFMT))
    # Tag so idempotency checks can recognize this as ours.
    handler.__dict__[_HANDLER_MARK] = "stream"
    return handler


def _build_rotating_file_handler(log_dir: Path, level: int) -> logging.handlers.RotatingFileHandler:
    log_dir.mkdir(parents=True, exist_ok=True)
    log_path = log_dir / "stt-server.log"
    handler = logging.handlers.RotatingFileHandler(
        filename=str(log_path),
        maxBytes=_MAX_LOG_BYTES,
        backupCount=_BACKUP_COUNT,
        encoding="utf-8",
    )
    handler.setLevel(level)
    handler.setFormatter(logging.Formatter(_LOG_FORMAT, datefmt=_LOG_DATEFMT))
    handler.__dict__[_HANDLER_MARK] = "file"
    return handler


def _configure_logging(*, log_dir: Path | None, debug: bool) -> None:
    """Attach (idempotently) console + rotating file handlers to the root logger."""
    level = logging.DEBUG if debug else logging.INFO
    root = logging.getLogger()
    root.setLevel(level)

    if not _has_marked_handler(root, "stream"):
        root.addHandler(_build_stream_handler(level))
    else:
        # Update the existing marked stream handler's level so toggling
        # ``--debug`` between calls actually takes effect.
        for h in root.handlers:
            if getattr(h, _HANDLER_MARK, None) == "stream":
                h.setLevel(level)

    if log_dir is not None and not _has_marked_handler(root, "file"):
        try:
            root.addHandler(_build_rotating_file_handler(log_dir, level))
        except OSError as exc:
            # Don't fail server startup just because the log dir is read-only —
            # the stream handler still gets us stdout logs.
            root.warning("Could not open log file in %s: %s", log_dir, exc)


# ---------------------------------------------------------------------------
# Sentry scrubbing
# ---------------------------------------------------------------------------

# Sentry's event payload is a deeply heterogeneous JSON-shaped dict. The
# upstream type hint is ``dict[str, Any]`` (``sentry_sdk._types.Event``), so
# ``Any`` here is the documented contract, not a strict-mode escape hatch.


def _looks_like_user_content(key: str, value: object) -> bool:
    """Heuristic: does this (key, value) pair look like transcript / audio data?"""
    if isinstance(value, (bytes, bytearray)):
        # Raw audio frames are always bytes — never let them leave the machine.
        return True
    if not isinstance(value, str):
        return False
    lowered_key = key.lower()
    if any(token in lowered_key for token in _TRANSCRIPT_KEY_SUBSTRINGS):
        return True
    # Generic long-text guard: if the value is a long mostly-alphabetic
    # run, treat it as a likely transcript even when the key is anonymous.
    if len(value) > _TRANSCRIPT_LEN_THRESHOLD:
        alpha = sum(1 for c in value if c.isalpha() or c.isspace())
        if alpha / len(value) >= 0.7:
            return True
    return False


def _scrub_mapping(mapping: dict[str, Any]) -> None:
    """In-place: replace any user-content values inside ``mapping`` with a placeholder."""
    for key, value in list(mapping.items()):
        if _looks_like_user_content(key, value):
            mapping[key] = _SCRUB_PLACEHOLDER


def _scrub(event: Event, _hint: Hint) -> Event | None:
    """Sentry ``before_send`` hook — strips PII and transcript content."""
    # Hostname leaks the user's identity on desktop installs.
    event.pop("server_name", None)

    user = event.get("user")
    if isinstance(user, dict):
        user.pop("ip_address", None)

    extra = event.get("extra")
    if isinstance(extra, dict):
        _scrub_mapping(extra)

    contexts = event.get("contexts")
    if isinstance(contexts, dict):
        for ctx in contexts.values():
            if isinstance(ctx, dict):
                _scrub_mapping(ctx)

    breadcrumbs = event.get("breadcrumbs")
    if isinstance(breadcrumbs, dict):
        values = breadcrumbs.get("values")
        if isinstance(values, list):
            for crumb in values:
                if isinstance(crumb, dict):
                    data = crumb.get("data")
                    if isinstance(data, dict):
                        _scrub_mapping(data)

    return event


def _scrub_breadcrumb(crumb: Breadcrumb, _hint: Hint) -> Breadcrumb | None:
    """Sentry ``before_breadcrumb`` hook — strips transcript content from breadcrumbs."""
    data = crumb.get("data")
    if isinstance(data, dict):
        _scrub_mapping(data)
    return crumb


# ---------------------------------------------------------------------------
# Sentry init
# ---------------------------------------------------------------------------


def _configure_sentry(*, release: str | None) -> None:
    """Initialize Sentry if ``SENTRY_DSN`` is set; otherwise log + no-op."""
    logger = logging.getLogger(__name__)
    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        logger.info("Sentry disabled (no SENTRY_DSN)")
        return

    sentry_sdk.init(
        dsn=dsn,
        environment=os.environ.get("SENTRY_ENVIRONMENT", "production"),
        release=release,
        send_default_pii=False,
        # Error monitoring only — no tracing, no profiling, no log forwarding.
        traces_sample_rate=0,
        enable_logs=False,
        before_send=_scrub,
        before_breadcrumb=_scrub_breadcrumb,
        # No explicit ``integrations=[]`` — let Sentry's auto-enabled defaults
        # (LoggingIntegration, StdlibIntegration, etc.) handle stdlib bridging.
    )
    logger.info("Sentry initialized (release=%s)", release or "unset")


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------


def configure_observability(
    *,
    log_dir: Path | None,
    debug: bool,
    release: str | None = None,
) -> None:
    """Configure stdlib logging and (optionally) Sentry.

    Idempotent — safe to call more than once. The first call installs
    handlers and (if ``SENTRY_DSN`` is set) inits Sentry. Subsequent calls
    only update existing handler levels.

    Args:
        log_dir: Directory to write ``stt-server.log`` into. If ``None``,
            only the stdout/stderr stream handler is installed. The
            directory is created if it does not exist.
        debug: If ``True``, root logger and our handlers are set to DEBUG
            instead of INFO.
        release: Release identifier passed to Sentry (e.g.
            ``"winstt-server@0.1.0"``). Ignored when Sentry is disabled.
    """
    _configure_logging(log_dir=log_dir, debug=debug)
    _configure_sentry(release=release)
