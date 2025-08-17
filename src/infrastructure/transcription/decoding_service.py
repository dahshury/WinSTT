"""ONNX decoder runner for Whisper models (greedy with past-kv when available)."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import numpy as np

if TYPE_CHECKING:
    import onnxruntime as ort


class WhisperOnnxDecodingService:
    """Runs the Whisper decoder ONNX session including past key/value handling."""

    def __init__(
        self,
        decoder_session: ort.InferenceSession,
        fallback_decoder_session: ort.InferenceSession | None,
        model_config: dict[str, Any] | None,
        generation_config: dict[str, Any] | None,
    ) -> None:
        self._decoder = decoder_session
        self._fallback_decoder = fallback_decoder_session
        self._model_config = model_config or {}
        self._generation_config = generation_config or {}

    def decode(self, encoder_hidden_states: np.ndarray) -> np.ndarray:
        start_token_id = int(self._generation_config.get("decoder_start_token_id", 50258))
        eos_token_id = int(self._generation_config.get("eos_token_id", 50257))
        max_length = int(self._generation_config.get("max_length", 64))

        num_layers = int(self._model_config.get("decoder_layers", 2))
        num_attention_heads = int(self._model_config.get("decoder_attention_heads", 16))
        d_model = int(self._model_config.get("d_model", 1280))
        head_dim = d_model // max(1, num_attention_heads)

        batch_size = encoder_hidden_states.shape[0]
        decoder_input_ids = np.array([[start_token_id]] * batch_size, dtype=np.int64)

        past_key_values: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = []
        for _ in range(num_layers):
            past_decoder_key = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
            past_decoder_value = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
            past_encoder_key = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
            past_encoder_value = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
            past_key_values.append((past_decoder_key, past_decoder_value, past_encoder_key, past_encoder_value))

        output_ids: list[np.ndarray] = []

        for _ in range(max_length):
            decoder_inputs: dict[str, np.ndarray] = {
                "input_ids": decoder_input_ids,
                "use_cache_branch": np.array([False], dtype=bool),
                "encoder_hidden_states": encoder_hidden_states.astype(np.float32),
            }

            # Provide past key values
            for layer in range(num_layers):
                pkv = past_key_values[layer]
                decoder_inputs[f"past_key_values.{layer}.decoder.key"] = pkv[0]
                decoder_inputs[f"past_key_values.{layer}.decoder.value"] = pkv[1]
                decoder_inputs[f"past_key_values.{layer}.encoder.key"] = pkv[2]
                decoder_inputs[f"past_key_values.{layer}.encoder.value"] = pkv[3]

            try:
                decoder_outputs = self._decoder.run(None, decoder_inputs)
            except Exception as _err:
                if self._fallback_decoder is None:
                    raise
                decoder_outputs = self._fallback_decoder.run(
                    None,
                    {"input_ids": decoder_input_ids, "encoder_hidden_states": encoder_hidden_states},
                )

            logits = decoder_outputs[0]
            next_tokens = np.argmax(logits[:, -1, :], axis=-1).astype(np.int64)
            output_ids.append(next_tokens)

            updated_past: list[tuple[np.ndarray, np.ndarray, np.ndarray, np.ndarray]] = []
            idx = 1
            for layer in range(num_layers):
                try:
                    updated_past.append((
                        decoder_outputs[idx + 0],
                        decoder_outputs[idx + 1],
                        decoder_outputs[idx + 2],
                        decoder_outputs[idx + 3],
                    ))
                    idx += 4
                except Exception:
                    updated_past.append(past_key_values[layer])
            past_key_values = updated_past

            decoder_input_ids = np.concatenate([decoder_input_ids, next_tokens[:, None]], axis=-1)
            if np.all(next_tokens == eos_token_id):
                break

        if not output_ids:
            return np.zeros((batch_size, 0), dtype=np.int64)

        return np.array(output_ids, dtype=np.int64).T


