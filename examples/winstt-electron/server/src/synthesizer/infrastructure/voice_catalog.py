"""Static catalog of Kokoro v1.0 voices.

Mirrors the voicepack set published in hexgrad/Kokoro-82M/VOICES.md as of
the v1.0 release (54 voices across 9 languages). The labels are the
display names the renderer shows in the voice picker.

Source of truth: https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md
"""

from __future__ import annotations

from src.synthesizer.domain.ports.synthesizer import VoiceInfo

# Format: (id, label, lang code, gender). Lang codes are the same strings
# kokoro_onnx.Kokoro accepts ("en-us", "en-gb", "ja", "cmn", "es", "fr",
# "hi", "it", "pt-br"). Gender is informational only — used by the
# renderer to group voices.
KOKORO_VOICE_CATALOG: tuple[VoiceInfo, ...] = (
    # American English — Female (11)
    VoiceInfo(id="af_heart", label="Heart (US)", language="en-us", gender="female"),
    VoiceInfo(id="af_alloy", label="Alloy (US)", language="en-us", gender="female"),
    VoiceInfo(id="af_aoede", label="Aoede (US)", language="en-us", gender="female"),
    VoiceInfo(id="af_bella", label="Bella (US)", language="en-us", gender="female"),
    VoiceInfo(id="af_jessica", label="Jessica (US)", language="en-us", gender="female"),
    VoiceInfo(id="af_kore", label="Kore (US)", language="en-us", gender="female"),
    VoiceInfo(id="af_nicole", label="Nicole (US)", language="en-us", gender="female"),
    VoiceInfo(id="af_nova", label="Nova (US)", language="en-us", gender="female"),
    VoiceInfo(id="af_river", label="River (US)", language="en-us", gender="female"),
    VoiceInfo(id="af_sarah", label="Sarah (US)", language="en-us", gender="female"),
    VoiceInfo(id="af_sky", label="Sky (US)", language="en-us", gender="female"),
    # American English — Male (9)
    VoiceInfo(id="am_adam", label="Adam (US)", language="en-us", gender="male"),
    VoiceInfo(id="am_echo", label="Echo (US)", language="en-us", gender="male"),
    VoiceInfo(id="am_eric", label="Eric (US)", language="en-us", gender="male"),
    VoiceInfo(id="am_fenrir", label="Fenrir (US)", language="en-us", gender="male"),
    VoiceInfo(id="am_liam", label="Liam (US)", language="en-us", gender="male"),
    VoiceInfo(id="am_michael", label="Michael (US)", language="en-us", gender="male"),
    VoiceInfo(id="am_onyx", label="Onyx (US)", language="en-us", gender="male"),
    VoiceInfo(id="am_puck", label="Puck (US)", language="en-us", gender="male"),
    VoiceInfo(id="am_santa", label="Santa (US)", language="en-us", gender="male"),
    # British English — Female (4)
    VoiceInfo(id="bf_alice", label="Alice (UK)", language="en-gb", gender="female"),
    VoiceInfo(id="bf_emma", label="Emma (UK)", language="en-gb", gender="female"),
    VoiceInfo(id="bf_isabella", label="Isabella (UK)", language="en-gb", gender="female"),
    VoiceInfo(id="bf_lily", label="Lily (UK)", language="en-gb", gender="female"),
    # British English — Male (4)
    VoiceInfo(id="bm_daniel", label="Daniel (UK)", language="en-gb", gender="male"),
    VoiceInfo(id="bm_fable", label="Fable (UK)", language="en-gb", gender="male"),
    VoiceInfo(id="bm_george", label="George (UK)", language="en-gb", gender="male"),
    VoiceInfo(id="bm_lewis", label="Lewis (UK)", language="en-gb", gender="male"),
    # Japanese (5)
    VoiceInfo(id="jf_alpha", label="Alpha (JP)", language="ja", gender="female"),
    VoiceInfo(id="jf_gongitsune", label="Gongitsune (JP)", language="ja", gender="female"),
    VoiceInfo(id="jf_nezumi", label="Nezumi (JP)", language="ja", gender="female"),
    VoiceInfo(id="jf_tebukuro", label="Tebukuro (JP)", language="ja", gender="female"),
    VoiceInfo(id="jm_kumo", label="Kumo (JP)", language="ja", gender="male"),
    # Mandarin Chinese (8)
    VoiceInfo(id="zf_xiaobei", label="Xiaobei (ZH)", language="cmn", gender="female"),
    VoiceInfo(id="zf_xiaoni", label="Xiaoni (ZH)", language="cmn", gender="female"),
    VoiceInfo(id="zf_xiaoxiao", label="Xiaoxiao (ZH)", language="cmn", gender="female"),
    VoiceInfo(id="zf_xiaoyi", label="Xiaoyi (ZH)", language="cmn", gender="female"),
    VoiceInfo(id="zm_yunjian", label="Yunjian (ZH)", language="cmn", gender="male"),
    VoiceInfo(id="zm_yunxi", label="Yunxi (ZH)", language="cmn", gender="male"),
    VoiceInfo(id="zm_yunxia", label="Yunxia (ZH)", language="cmn", gender="male"),
    VoiceInfo(id="zm_yunyang", label="Yunyang (ZH)", language="cmn", gender="male"),
    # Spanish (3)
    VoiceInfo(id="ef_dora", label="Dora (ES)", language="es", gender="female"),
    VoiceInfo(id="em_alex", label="Alex (ES)", language="es", gender="male"),
    VoiceInfo(id="em_santa", label="Santa (ES)", language="es", gender="male"),
    # French (1)
    VoiceInfo(id="ff_siwis", label="Siwis (FR)", language="fr", gender="female"),
    # Hindi (4)
    VoiceInfo(id="hf_alpha", label="Alpha (HI)", language="hi", gender="female"),
    VoiceInfo(id="hf_beta", label="Beta (HI)", language="hi", gender="female"),
    VoiceInfo(id="hm_omega", label="Omega (HI)", language="hi", gender="male"),
    VoiceInfo(id="hm_psi", label="Psi (HI)", language="hi", gender="male"),
    # Italian (2)
    VoiceInfo(id="if_sara", label="Sara (IT)", language="it", gender="female"),
    VoiceInfo(id="im_nicola", label="Nicola (IT)", language="it", gender="male"),
    # Brazilian Portuguese (3)
    VoiceInfo(id="pf_dora", label="Dora (BR)", language="pt-br", gender="female"),
    VoiceInfo(id="pm_alex", label="Alex (BR)", language="pt-br", gender="male"),
    VoiceInfo(id="pm_santa", label="Santa (BR)", language="pt-br", gender="male"),
)


# Languages the model can render; surfaced to the UI for the language picker.
SUPPORTED_LANGUAGES: tuple[tuple[str, str], ...] = (
    ("en-us", "English (US)"),
    ("en-gb", "English (UK)"),
    ("ja", "Japanese"),
    ("cmn", "Mandarin"),
    ("es", "Spanish"),
    ("fr", "French"),
    ("hi", "Hindi"),
    ("it", "Italian"),
    ("pt-br", "Portuguese (BR)"),
)
