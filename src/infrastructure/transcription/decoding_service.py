"""Enhanced ONNX decoder runner for Whisper models with optimizations."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

import numpy as np
from onnxruntime import OrtValue

if TYPE_CHECKING:
    from src.infrastructure.transcription.model_runtime_sessions import OptimizedInferenceSession


class WhisperOnnxDecodingService:
    """Runs the Whisper decoder ONNX session with memory optimizations and IO binding."""

    def __init__(
        self,
        decoder_session: OptimizedInferenceSession,
        fallback_decoder_session: OptimizedInferenceSession | None,
        model_config: dict[str, Any] | None,
        generation_config: dict[str, Any] | None,
    ) -> None:
        self._decoder = decoder_session
        self._fallback_decoder = fallback_decoder_session
        self._model_config = model_config or {}
        self._generation_config = generation_config or {}
        self._device_type = decoder_session.device_type
        self._device_id = decoder_session.device_id

    def decode(self, encoder_hidden_states: np.ndarray | OrtValue) -> np.ndarray:
        """Decode with optimized memory management and IO binding."""
        start_token_id = int(self._generation_config.get("decoder_start_token_id", 50258))
        eos_token_id = int(self._generation_config.get("eos_token_id", 50257))
        max_length = int(self._generation_config.get("max_length", 64))

        # Convert to OrtValue for better memory management
        if not isinstance(encoder_hidden_states, OrtValue):
            encoder_ortvalue = OrtValue.ortvalue_from_numpy(encoder_hidden_states.astype(np.float32))
            batch_size = encoder_hidden_states.shape[0]
        else:
            encoder_ortvalue = encoder_hidden_states
            batch_size = encoder_ortvalue.shape()[0]

        return self._decode_with_io_binding(encoder_ortvalue, batch_size, start_token_id, eos_token_id, max_length)

    def _decode_with_io_binding(
        self, 
        encoder_ortvalue: OrtValue, 
        batch_size: int, 
        start_token_id: int, 
        eos_token_id: int, 
        max_length: int
    ) -> np.ndarray:
        """Optimized decoding using IO binding when available."""
        decoder_input_ids = np.array([[start_token_id]] * batch_size, dtype=np.int64)
        
        # Initialize past key values as OrtValues for better memory management
        past_key_values = self._create_initial_past_key_values(batch_size)
        output_ids: list[np.ndarray] = []

        for step in range(max_length):
            use_cache = step > 0
            
            try:
                # Try IO binding first for better performance
                logits, past_key_values = self._decode_step_with_io_binding(
                    decoder_input_ids, encoder_ortvalue, past_key_values, use_cache
                )
            except Exception:
                # Fallback to standard inference
                logits, past_key_values = self._decode_step_standard(
                    decoder_input_ids, encoder_ortvalue, past_key_values, use_cache
                )

            next_tokens = np.argmax(logits[:, -1, :], axis=-1).astype(np.int64)
            output_ids.append(next_tokens)

            decoder_input_ids = np.concatenate([decoder_input_ids, next_tokens[:, None]], axis=-1)
            if np.all(next_tokens == eos_token_id):
                break

        if not output_ids:
            return np.zeros((batch_size, 0), dtype=np.int64)

        return np.array(output_ids, dtype=np.int64).T

    def _create_initial_past_key_values(self, batch_size: int) -> dict[str, OrtValue]:
        """Create initial past key values as OrtValues."""
        num_layers = int(self._model_config.get("decoder_layers", 2))
        num_attention_heads = int(self._model_config.get("decoder_attention_heads", 16))
        d_model = int(self._model_config.get("d_model", 1280))
        head_dim = d_model // max(1, num_attention_heads)

        past_key_values = {}
        for layer in range(num_layers):
            for key_type in ["decoder.key", "decoder.value", "encoder.key", "encoder.value"]:
                empty_tensor = np.zeros((batch_size, num_attention_heads, 0, head_dim), dtype=np.float32)
                past_key_values[f"past_key_values.{layer}.{key_type}"] = OrtValue.ortvalue_from_numpy(empty_tensor)
        
        return past_key_values

    def _decode_step_with_io_binding(
        self, 
        decoder_input_ids: np.ndarray, 
        encoder_ortvalue: OrtValue, 
        past_key_values: dict[str, OrtValue],
        use_cache: bool
    ) -> tuple[np.ndarray, dict[str, OrtValue]]:
        """Single decode step using IO binding."""
        input_bindings = {
            "input_ids": decoder_input_ids[:, -1:] if use_cache else decoder_input_ids,
            "encoder_hidden_states": encoder_ortvalue,
            "use_cache_branch": np.array([use_cache], dtype=bool),
        }
        
        # Add past key values
        input_bindings.update(past_key_values)
        
        # Define output names
        output_names = ["logits"]
        for key in past_key_values:
            present_key = key.replace("past_key_values.", "present.")
            output_names.append(present_key)
        
        outputs = self._decoder.run_with_io_binding(input_bindings, output_names)
        
        # Extract logits
        logits = outputs[0].numpy() if hasattr(outputs[0], 'numpy') else outputs[0]
        
        # Update past key values
        updated_past = {}
        for i, key in enumerate(past_key_values.keys()):
            present_key = key.replace("past_key_values.", "present.")
            if i + 1 < len(outputs):
                updated_past[key] = outputs[i + 1] if isinstance(outputs[i + 1], OrtValue) else OrtValue.ortvalue_from_numpy(outputs[i + 1])
            else:
                updated_past[key] = past_key_values[key]
        
        return logits, updated_past

    def _decode_step_standard(
        self, 
        decoder_input_ids: np.ndarray, 
        encoder_ortvalue: OrtValue, 
        past_key_values: dict[str, OrtValue],
        use_cache: bool
    ) -> tuple[np.ndarray, dict[str, OrtValue]]:
        """Fallback standard decoding step."""
        # Convert OrtValues to numpy for standard inference
        encoder_hidden_states = encoder_ortvalue.numpy() if hasattr(encoder_ortvalue, 'numpy') else encoder_ortvalue
        
        decoder_inputs = {
            "input_ids": decoder_input_ids[:, -1:] if use_cache else decoder_input_ids,
            "encoder_hidden_states": encoder_hidden_states.astype(np.float32),
            "use_cache_branch": np.array([use_cache], dtype=bool),
        }
        
        # Add past key values as numpy arrays
        for key, ortvalue in past_key_values.items():
            decoder_inputs[key] = ortvalue.numpy() if hasattr(ortvalue, 'numpy') else ortvalue
        
        try:
            decoder_outputs = self._decoder.run(None, decoder_inputs)
        except Exception:
            if self._fallback_decoder is None:
                raise
            decoder_outputs = self._fallback_decoder.run(
                None,
                {"input_ids": decoder_input_ids, "encoder_hidden_states": encoder_hidden_states},
            )
        
        logits = decoder_outputs[0]
        
        # Update past key values
        updated_past = {}
        output_idx = 1
        for key in past_key_values:
            if output_idx < len(decoder_outputs):
                updated_past[key] = OrtValue.ortvalue_from_numpy(decoder_outputs[output_idx])
                output_idx += 1
            else:
                updated_past[key] = past_key_values[key]
        
        return logits, updated_past


