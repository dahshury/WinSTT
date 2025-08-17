"""Whisper artifacts loader service.

Loads tokenizer, feature extractor, and model configs from a provided
cache directory (or remote fallback). This keeps artifact initialization
out of the transcriber to improve separation of concerns.
"""

from __future__ import annotations

from pathlib import Path

from transformers import WhisperFeatureExtractor, WhisperTokenizerFast


class WhisperArtifactsService:
    """Loads Whisper tokenizer and feature extractor along with configs."""

    def get_artifacts(
        self,
        model_cache_dir: str,
    ) -> tuple[WhisperTokenizerFast, WhisperFeatureExtractor, dict, dict]:
        """Load artifacts from cache or remote.

        Args:
            model_cache_dir: Directory where Whisper configs/tokenizer may exist.

        Returns:
            (tokenizer, feature_extractor, config_dict, generation_config_dict)
        """
        cache_dir = Path(model_cache_dir)

        # Tokenizer
        if (cache_dir / "tokenizer_config.json").exists():
            tokenizer = WhisperTokenizerFast.from_pretrained(str(cache_dir))
        else:
            tokenizer = WhisperTokenizerFast.from_pretrained("openai/whisper-large-v3-turbo")

        # Feature extractor
        if (cache_dir / "preprocessor_config.json").exists():
            feature_extractor = WhisperFeatureExtractor.from_pretrained(str(cache_dir))
        else:
            feature_extractor = WhisperFeatureExtractor.from_pretrained("openai/whisper-large-v3-turbo")

        # Config files
        config: dict = {}
        generation_config: dict = {}
        try:
            import json as _json
            cfg_path = cache_dir / "config.json"
            gen_path = cache_dir / "generation_config.json"
            if cfg_path.exists():
                with open(cfg_path, encoding="utf-8") as f:
                    config = _json.load(f)
            if gen_path.exists():
                with open(gen_path, encoding="utf-8") as f:
                    generation_config = _json.load(f)
        except Exception:
            # Best-effort; configs are optional for basic decode
            pass

        return tokenizer, feature_extractor, config, generation_config


