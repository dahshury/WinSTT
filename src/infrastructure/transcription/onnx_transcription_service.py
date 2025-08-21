"""Lightweight transcription service backed by onnx-asr.

Replaces the bespoke ONNX pipeline with a minimal wrapper around the
onnx_asr package while preserving the domain-facing contract and
adapter expectations (e.g., is_initialized flag).
"""

from __future__ import annotations

import io
import gc
from collections.abc import Mapping
from typing import Any

import numpy as np

import onnx_asr
import onnxruntime as rt

from src.domain.transcription.ports import TranscriptionOutput
from src.domain.transcription.value_objects.transcription_request import TranscriptionRequest


class OnnxAsrTranscriptionService:
    """Thin wrapper over onnx-asr with optional VAD integration and model alias mapping."""

    def __init__(self, model_name: str = "onnx-community/whisper-large-v3-turbo", use_vad: bool = True,
                 display_message_callback: Any | None = None, quantization: str | None = None) -> None:
        self._model_name = model_name
        self._use_vad = bool(use_vad)
        self._display = display_message_callback
        self._quantization = quantization  # e.g., "int8" or UI values like "Quantized"/"Full"
        self._model = None
        self.is_initialized: bool = False

    async def initialize_async(self) -> bool:
        try:
            # Always unload any previously loaded model to fully free ONNX sessions
            # before initializing a new one (model switch or re-init).
            self._unload_current_model()

            # Determine if a download is needed so we can decide whether to show a progress bar
            needs_download = False
            resolved_name = self._resolve_model_name(self._model_name)
            try:
                try:
                    from huggingface_hub import snapshot_download
                    # If model snapshot is not in cache, this raises LocalEntryNotFoundError with local_files_only=True
                    snapshot_download(repo_id=resolved_name, local_files_only=True)
                except Exception as hf_exc:  # noqa: BLE001
                    # Only treat as download-needed if HF cache explicitly reports missing entry
                    cls_name = type(hf_exc).__name__
                    if cls_name in {"LocalEntryNotFoundError", "EntryNotFoundError"}:
                        needs_download = True
                    else:
                        needs_download = False
            except Exception:
                # If we cannot import or check, default to not showing a progress bar at startup
                needs_download = False

            if self._display:
                if needs_download:
                    # Trigger progress bar via text keyword; initialize to 0%
                    self._display(f"Downloading {resolved_name}...", resolved_name, 0, True, False)
                else:
                    # Quietly prepare without progress bar
                    self._display("", None, None, False, False)
            quant = self._resolve_quantization(self._quantization)
            # Default to int8 on CPU ONLY when no explicit user preference was provided
            # i.e., when self._quantization is None (auto). Respect 'Full' if chosen in settings.
            if quant is None and self._quantization is None:
                try:
                    import onnxruntime as _ort
                    providers = _ort.get_available_providers()
                    using_cpu = True
                    for p in providers:
                        if p not in ("CPUExecutionProvider",):
                            using_cpu = False
                            break
                    if using_cpu:
                        quant = "int8"
                except Exception:
                    pass
            # Load model, relaying per-file byte progress from huggingface_hub http_get
            if needs_download and self._display:
                try:
                    import contextlib as _ctx
                    import threading as _th
                    import huggingface_hub.utils.tqdm as _hf_tqdm_mod
                    import huggingface_hub.file_download as _hf_fd

                    _orig_get_ctx = getattr(_hf_tqdm_mod, "_get_progress_bar_context", None)
                    _orig_tqdm_cls = getattr(_hf_tqdm_mod, "tqdm", None)
                    _orig_dl_to_tmp = getattr(_hf_fd, "_download_to_tmp_and_move", None)

                    aggregator = {"total": 0, "n": 0}
                    display_cb = self._display
                    repo_id_for_msg = resolved_name

                    # Thread-local to propagate expected_size when HTTP headers don't include Content-Length
                    _dl_ctx = _th.local()
                    setattr(_dl_ctx, "expected_total", 0)

                    class _UiTqdm(_orig_tqdm_cls):  # type: ignore[misc]
                        def __init__(self, *args, **kwargs):  # noqa: D401
                            total = 0
                            try:
                                total = int(kwargs.get("total") or 0)
                            except Exception:
                                total = 0
                            initial = 0
                            try:
                                initial = int(kwargs.get("initial") or 0)
                            except Exception:
                                initial = 0
                            super().__init__(*args, **kwargs)
                            try:
                                if total:
                                    aggregator["total"] += total
                                if initial:
                                    aggregator["n"] += initial
                            except Exception:
                                pass

                        def update(self, n=1):  # noqa: D401
                            try:
                                inc = int(n or 0)
                                aggregator["n"] += inc
                                if aggregator["total"]:
                                    pct = int((aggregator["n"] * 100) / aggregator["total"])  # floor
                                    display_cb(f"Downloading {repo_id_for_msg}...", repo_id_for_msg, pct, True, False)
                                else:
                                    # If total unknown, display indeterminate progress as 0 repeatedly suppressed by UI layer
                                    display_cb(f"Downloading {repo_id_for_msg}...", repo_id_for_msg, None, True, False)
                            except Exception:
                                pass
                            return super().update(n)

                    def _wrapped_get_progress_bar_context(*, desc, log_level, total=None, initial=0, unit="B", unit_scale=True, name=None, _tqdm_bar=None):
                        # Only override when no custom bar is provided
                        if _tqdm_bar is not None:
                            return _orig_get_ctx(
                                desc=desc,
                                log_level=log_level,
                                total=total,
                                initial=initial,
                                unit=unit,
                                unit_scale=unit_scale,
                                name=name,
                                _tqdm_bar=_tqdm_bar,
                            )
                        try:
                            disable = _hf_tqdm_mod.is_tqdm_disabled(log_level=log_level)
                        except Exception:
                            disable = None
                        # If HTTP doesn't provide total, fallback to HEAD expected size captured from wrapper
                        try:
                            if (total is None or int(total) == 0) and getattr(_dl_ctx, "expected_total", 0) > 0:
                                total = int(getattr(_dl_ctx, "expected_total", 0))
                        except Exception:
                            pass
                        bar = _UiTqdm(
                            unit=unit,
                            unit_scale=unit_scale,
                            total=total,
                            initial=initial,
                            desc=desc,
                            disable=disable,
                            name=name,
                        )
                        return _ctx.nullcontext(bar)

                    def _wrapped_download_to_tmp_and_move(*args, **kwargs):
                        # args: (incomplete_path, destination_path, url_to_download, proxies, headers, expected_size, filename, force_download, etag, xet_file_data)
                        try:
                            expected_size = kwargs.get("expected_size")
                            if expected_size is None and len(args) >= 7:
                                expected_size = args[6]  # match position by signature
                            try:
                                setattr(_dl_ctx, "expected_total", int(expected_size or 0))
                            except Exception:
                                setattr(_dl_ctx, "expected_total", 0)
                        except Exception:
                            setattr(_dl_ctx, "expected_total", 0)
                        try:
                            return _orig_dl_to_tmp(*args, **kwargs)
                        finally:
                            # Clear after each file to avoid stale values
                            setattr(_dl_ctx, "expected_total", 0)

                    # Patch only the context factory used by per-file HTTP downloads
                    if callable(_orig_get_ctx):
                        _hf_tqdm_mod._get_progress_bar_context = _wrapped_get_progress_bar_context  # type: ignore[assignment]
                    if callable(_orig_dl_to_tmp):
                        _hf_fd._download_to_tmp_and_move = _wrapped_download_to_tmp_and_move  # type: ignore[assignment]

                    try:
                        model = onnx_asr.load_model(resolved_name, quantization=quant) if quant else onnx_asr.load_model(resolved_name)
                    finally:
                        # Restore original factory
                        if callable(_orig_get_ctx):
                            _hf_tqdm_mod._get_progress_bar_context = _orig_get_ctx  # type: ignore[assignment]
                        if callable(_orig_dl_to_tmp):
                            _hf_fd._download_to_tmp_and_move = _orig_dl_to_tmp  # type: ignore[assignment]
                except Exception:
                    # Fallback to loading without progress if patching fails
                    model = onnx_asr.load_model(resolved_name, quantization=quant) if quant else onnx_asr.load_model(resolved_name)
            else:
                model = onnx_asr.load_model(resolved_name, quantization=quant) if quant else onnx_asr.load_model(resolved_name)
            if self._use_vad:
                vad = onnx_asr.load_vad("silero")
                model = model.with_vad(vad)
            self._model = model
            self.is_initialized = True
            if self._display:
                # Hide progress bar by not setting percentage and not using 'downloading' keyword
                self._display("Transcription service ready", None, None, False, True)
            return True
        except Exception as _e:  # best-effort; log delegated to adapter
            self._model = None
            self.is_initialized = False
            if self._display:
                self._display("Failed to initialize ASR model", None, 0, True, True)
            return False

    def _to_numpy_waveform(self, audio_input: Any, target_sr: int = 16000) -> tuple[np.ndarray, int]:
        """Convert file-like or bytes input to mono float32 numpy waveform."""
        try:
            from pydub import AudioSegment
            if isinstance(audio_input, (bytes, bytearray)):
                buf = io.BytesIO(audio_input)
                seg = AudioSegment.from_file(buf)
            else:
                seg = AudioSegment.from_file(audio_input)
            seg = seg.set_frame_rate(target_sr).set_channels(1)
            samples = np.array(seg.get_array_of_samples(), dtype=np.float32)
            sample_width = int(getattr(seg, "sample_width", 2) or 2)
            max_value = float(1 << (8 * sample_width - 1)) if sample_width > 0 else 1.0
            waveform = samples / max_value if max_value > 0 else samples
            return waveform.astype(np.float32, copy=False), target_sr
        except Exception:
            # As a fallback, try Python wave for simple PCM
            import wave
            with (io.BytesIO(audio_input) if isinstance(audio_input, (bytes, bytearray)) else audio_input) as f:  # type: ignore[arg-type]
                with wave.open(f, "rb") as wf:
                    import numpy as _np
                    n_channels = wf.getnchannels()
                    sr = wf.getframerate()
                    frames = wf.readframes(wf.getnframes())
                    data = _np.frombuffer(frames, dtype=_np.int16).astype(_np.float32) / 32768.0
                    if n_channels == 2:
                        data = data.reshape(-1, 2).mean(axis=1)
                    # naive resample if needed
                    if sr != target_sr and sr > 0:
                        import numpy as _n
                        duration = data.shape[0] / float(sr)
                        target_len = int(duration * target_sr)
                        if target_len > 0:
                            x_old = _n.linspace(0.0, 1.0, num=data.shape[0], endpoint=False, dtype=_n.float32)
                            x_new = _n.linspace(0.0, 1.0, num=target_len, endpoint=False, dtype=_n.float32)
                            data = _n.interp(x_new, x_old, data).astype(_n.float32, copy=False)
                    return data.astype(_np.float32, copy=False), target_sr

    async def transcribe_async(self, request: TranscriptionRequest) -> TranscriptionOutput:
        if not self.is_initialized or self._model is None:
            raise RuntimeError("Service not initialized")

        audio_input = request.audio_input
        # Prepare input for onnx_asr
        if isinstance(audio_input, str):
            source = audio_input
            kwargs: dict[str, Any] = {}
        elif isinstance(audio_input, (bytes, bytearray)) or hasattr(audio_input, "read"):
            waveform, sr = self._to_numpy_waveform(audio_input, 16000)
            source = waveform
            kwargs = {"sample_rate": sr}
        else:
            # assume numpy array
            source = audio_input
            kwargs = {}

        # Segments path when VAD is enabled and requested
        if bool(getattr(request, "return_segments", False)):
            segments: list[dict[str, Any]] = []
            text_parts: list[str] = []
            try:
                # Ensure we iterate results; attach VAD if needed just for segmentation
                iterator_model = self._model
                if not self._use_vad:
                    try:
                        vad = onnx_asr.load_vad("silero")
                        iterator_model = self._model.with_vad(vad)
                    except Exception:
                        pass
                for item in iterator_model.recognize(source, **kwargs):
                    # Accept dicts or objects with attributes: start, end, text
                    if isinstance(item, dict):
                        seg = {
                            "start": float(item.get("start", 0.0)),
                            "end": float(item.get("end", 0.0)),
                            "text": str(item.get("text", "")).strip(),
                        }
                    else:
                        seg = {
                            "start": float(getattr(item, "start", 0.0) or 0.0),
                            "end": float(getattr(item, "end", 0.0) or 0.0),
                            "text": str(getattr(item, "text", "") or "").strip(),
                        }
                    segments.append(seg)
                    if seg["text"]:
                        text_parts.append(seg["text"])
                final_text = " ".join(text_parts).strip()
                return TranscriptionOutput(text=final_text, segments=segments or None)
            except Exception:
                # Fallback to plain text
                result_text = str(self._model.recognize(source, **kwargs) or "")
                return TranscriptionOutput(text=result_text, segments=None)

        # Plain text path (no segments)
        try:
            result = self._model.recognize(source, **kwargs)
            # If VAD is enabled, recognize may yield an iterator of segment-like objects
            # Coalesce to pure text
            if hasattr(result, "__iter__") and not isinstance(result, (str, bytes)):
                text_parts: list[str] = []
                for item in result:
                    if isinstance(item, dict):
                        txt = str(item.get("text", "") or "").strip()
                    else:
                        txt = str(getattr(item, "text", "") or "").strip()
                    if txt:
                        text_parts.append(txt)
                return TranscriptionOutput(text=" ".join(text_parts).strip(), segments=None)
            # Else it's already a plain string
            return TranscriptionOutput(text=str(result) if result is not None else "", segments=None)
        except Exception:
            return TranscriptionOutput(text="", segments=None)

    def cleanup(self) -> None:
        """Public cleanup that fully releases ONNX sessions and drops references."""
        self._unload_current_model()

    def _resolve_model_name(self, name: str) -> str:
        aliases = {
            # Legacy aliases kept for backwards compat in existing configs
            "whisper-turbo": "onnx-community/whisper-large-v3-turbo",
            "lite-whisper-turbo": "onnx-community/whisper-small",
            "lite-whisper-turbo-fast": "onnx-community/whisper-tiny",
            # Avoid misnaming: prefer explicit ‘onnx-community/whisper-…’ ids in settings
        }
        return aliases.get(name, name)

    def _resolve_quantization(self, quantization: str | None) -> str | None:
        if quantization is None:
            return None
        q = str(quantization).strip().lower()
        if q in {"int8", "uint8", "fp16"}:
            return q
        if q in {"quantized", "quantisation"}:
            return "int8"
        if q in {"full", "fp32"}:
            return None
        return None

    # -----------------------------
    # Internal resource management
    # -----------------------------
    def _unload_current_model(self) -> None:
        """Release all ONNX Runtime sessions held by the current adapter/model.

        This walks the adapter graph (ASR, preprocessor, resampler, VAD) and
        clears any rt.InferenceSession instances, then forces GC.
        """
        adapter = getattr(self, "_model", None)
        if adapter is None:
            # Nothing to unload
            return

        visited: set[int] = set()

        def _is_session(obj: Any) -> bool:
            return isinstance(obj, rt.InferenceSession)

        def _release_container(container: Any) -> None:
            # Handle common containers that may hold sessions
            if isinstance(container, Mapping):
                for key, value in list(container.items()):
                    if _is_session(value):
                        container[key] = None  # type: ignore[index]
                    else:
                        _release_object(value)
            elif isinstance(container, (list, tuple, set)):
                for value in list(container):
                    _release_object(value)

        def _release_object(obj: Any) -> None:
            if obj is None:
                return
            oid = id(obj)
            if oid in visited:
                return
            visited.add(oid)

            # Release direct session objects
            if _is_session(obj):
                # There is no public close() in Python API; dropping references is sufficient.
                return

            # Try attributes on regular Python objects
            try:
                attrs = vars(obj)
            except Exception:
                attrs = {}

            # Iterate attributes and clear any sessions or nested holders
            for name, value in list(attrs.items()):
                try:
                    if _is_session(value):
                        setattr(obj, name, None)
                        continue
                    if isinstance(value, (dict, list, tuple, set)):
                        _release_container(value)
                        continue
                    # Recurse into nested objects (e.g., preprocessor with _preprocessor session,
                    # models with _encoder/_decoder, adapters with .asr/.vad/.resampler)
                    _release_object(value)
                except Exception:
                    # Best-effort cleanup—ignore non-writable attributes
                    pass

        try:
            _release_object(adapter)
        finally:
            # Drop top-level references and force GC
            try:
                # Clear well-known adapter roots to break ref cycles faster
                for root_attr in ("asr", "resampler", "vad"):
                    try:
                        setattr(adapter, root_attr, None)  # type: ignore[attr-defined]
                    except Exception:
                        pass
            except Exception:
                pass
            self._model = None
            self.is_initialized = False
            # Two GC cycles to ensure timely release of GPU/Ort allocations
            try:
                gc.collect()
                gc.collect()
            except Exception:
                pass
