"""Bytes IO Adapter.

Wrap raw bytes in a file-like object.
"""

from __future__ import annotations

import io


class BytesIOAdapter:
    def from_bytes(self, data: bytes) -> io.BytesIO:
        buf = io.BytesIO(data)
        # Help libraries infer format when reading from memory
        try:
            if not hasattr(buf, "name"):
                buf.name = "audio.wav"  # type: ignore[attr-defined]
            if not hasattr(buf, "original_filename"):
                buf.original_filename = "audio.wav"  # type: ignore[attr-defined]
        except Exception:
            pass
        return buf


