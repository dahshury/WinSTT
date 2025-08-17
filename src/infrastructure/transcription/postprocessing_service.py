"""Enhanced token decoding and segmentation for Whisper outputs with onnx_asr optimizations."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING

import numpy as np

from src.domain.transcription.entities.transcription_segment import TranscriptionSegment

if TYPE_CHECKING:
    from transformers import WhisperTokenizerFast


class WhisperPostprocessingService:
    """Converts token IDs/logits to text and segments with enhanced decoding."""

    def __init__(self, tokenizer: WhisperTokenizerFast):
        self._tokenizer = tokenizer
        # Cache special tokens for better performance
        self._special_tokens = set(tokenizer.all_special_tokens)
        self._bos_token_id = getattr(tokenizer, "bos_token_id", None)
        self._eos_token_id = getattr(tokenizer, "eos_token_id", None)
        
        # Cache byte decoder like onnx_asr for better performance
        self._byte_decoder = self._create_byte_decoder()
        
        # Cache common token patterns
        self._timestamp_pattern = re.compile(r"<\|[\d.]+\|>")
        self._special_token_pattern = re.compile(r"<\|[^|]*\|>")

    def _create_byte_decoder(self) -> dict[str, int]:
        """Create byte decoder mapping like onnx_asr for better text processing."""
        # Based on onnx_asr's bytes_to_unicode implementation
        bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
        cs = bs[:]
        n = 0
        for b in range(2**8):
            if b not in bs:
                bs.append(b)
                cs.append(2**8 + n)
                n += 1
        cs = [chr(n) for n in cs]
        byte_to_unicode = dict(zip(bs, cs, strict=True))
        return {v: k for k, v in byte_to_unicode.items()}

    def decode_tokens(self, output_ids: np.ndarray) -> str:
        """Enhanced token decoding using onnx_asr approach for better performance."""
        if output_ids.ndim == 3:
            token_ids = np.argmax(output_ids, axis=-1)
        elif output_ids.ndim == 2:
            token_ids = output_ids.astype(np.int64, copy=False)
        elif output_ids.ndim == 1:
            token_ids = output_ids[None, :].astype(np.int64, copy=False)
        else:
            return ""
        
        ids_seq = token_ids[0].tolist() if hasattr(token_ids, "tolist") else list(token_ids[0])
        if not ids_seq:
            return ""
        
        # Use onnx_asr approach: filter tokens and decode directly
        return self._decode_tokens_onnx_style(ids_seq)

    def _decode_tokens_onnx_style(self, token_ids: list[int]) -> str:
        """Decode tokens using onnx_asr's efficient approach."""
        try:
            # Try to get vocabulary mapping safely
            vocab = None
            if hasattr(self._tokenizer, 'decoder') and hasattr(self._tokenizer.decoder, '__iter__'):
                vocab = self._tokenizer.decoder
            elif hasattr(self._tokenizer, 'get_vocab'):
                # Create reverse mapping from vocab
                forward_vocab = self._tokenizer.get_vocab()
                vocab = {v: k for k, v in forward_vocab.items()}
            
            if vocab and isinstance(vocab, dict):
                # Build text directly like onnx_asr
                text_parts = []
                for token_id in token_ids:
                    if token_id in vocab:
                        token = vocab[token_id]
                        # Skip special tokens (those starting with <|)
                        if not token.startswith("<|"):
                            text_parts.append(token)
                
                if text_parts:
                    # Join and decode using byte decoder
                    raw_text = "".join(text_parts)
                    try:
                        # Use byte decoder for proper UTF-8 handling
                        decoded_bytes = bytearray([self._byte_decoder.get(c, ord(c)) for c in raw_text])
                        text = decoded_bytes.decode("utf-8", errors="replace")
                        return text.removeprefix(" ").strip()
                    except Exception:
                        return self._clean_transcription(raw_text)
        except Exception:
            pass  # Fall through to standard decoding
        
        # Fallback to standard decoding (most reliable)
        filtered_ids = self._filter_special_tokens(token_ids)
        transcription = self._tokenizer.decode(filtered_ids, skip_special_tokens=True)
        return self._clean_transcription(transcription or "")

    def _filter_special_tokens(self, token_ids: list[int]) -> list[int]:
        """Filter out special tokens from token sequence."""
        filtered = []
        for token_id in token_ids:
            # Skip BOS/EOS and other special tokens
            if token_id == self._bos_token_id or token_id == self._eos_token_id:
                continue
            
            # Convert to token and check if it's special
            try:
                token = self._tokenizer.decode([token_id])
                if not token.startswith("<|") and not token.endswith("|>"):
                    filtered.append(token_id)
            except Exception:
                # If decoding fails, skip this token
                continue
        
        return filtered

    def _clean_transcription(self, text: str) -> str:
        """Clean transcription text with better whitespace handling."""
        # Remove leading/trailing whitespace
        text = text.strip()
        
        # Normalize multiple spaces to single space
        text = re.sub(r"\s+", " ", text)
        
        # Remove any remaining special tokens that might have slipped through
        text = re.sub(r"<\|[^|]*\|>", "", text)
        
        return text

    def simple_segments(self, audio_duration: float, transcription: str) -> list[TranscriptionSegment]:
        if not transcription:
            return [TranscriptionSegment.create_simple_segment(0.0, max(0.5, audio_duration), transcription)]
        sentences = re.split(r"(?<=[.!?])\s+", transcription)
        sentences = [s.strip() for s in sentences if s.strip()]
        if not sentences:
            return [TranscriptionSegment.create_simple_segment(0.0, max(0.5, audio_duration), transcription)]
        duration_per_segment = (audio_duration or 30.0) / max(1, len(sentences))
        segments: list[TranscriptionSegment] = []
        for i, sentence in enumerate(sentences):
            start_time = i * duration_per_segment
            end_time = (i + 1) * duration_per_segment
            segments.append(TranscriptionSegment.create_simple_segment(start_time, end_time, sentence, i))
        return segments


