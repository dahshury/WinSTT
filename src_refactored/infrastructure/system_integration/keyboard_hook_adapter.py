"""Keyboard Hook Adapter.

Thin facade over KeyboardService to expose a minimal hotkey API to callers.
"""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING

from src_refactored.domain.settings.value_objects.key_combination import (
    KeyCombination,
)
from src_refactored.infrastructure.audio.keyboard_service import (
    KeyboardService,
    KeyboardServiceConfiguration,
)

if TYPE_CHECKING:
    from collections.abc import Callable


class KeyboardHookAdapter:
    """Facade for starting/stopping keyboard hook and hotkey registration."""

    def __init__(self, service: KeyboardService | None = None) -> None:
        self._service = service or KeyboardService(
            KeyboardServiceConfiguration(
                enable_key_normalization=True,
                track_key_states=True,
                enable_event_logging=False,
            ),
        )

    def start(self) -> bool:
        return self._service.start_hook().value == "success"

    def stop(self) -> bool:
        return self._service.stop_hook().value == "success"

    def shutdown(self) -> None:
        with contextlib.suppress(Exception):
            self._service.shutdown()

    def register_hotkey(
        self,
        hotkey_id: str,
        combination_str: str,
        on_pressed: Callable[[KeyCombination], None],
        on_released: Callable[[KeyCombination], None],
    ) -> bool:
        combination = KeyCombination.from_string(combination_str)
        if not combination:
            return False

        class _Handler:
            def on_hotkey_pressed(self, combination_obj: KeyCombination) -> None:  # type: ignore[override]
                on_pressed(combination_obj)

            def on_hotkey_released(self, combination_obj: KeyCombination) -> None:  # type: ignore[override]
                on_released(combination_obj)

        result = self._service.register_hotkey(hotkey_id, combination, _Handler())
        return result.value == "success"

    def unregister_hotkey(self, hotkey_id: str) -> bool:
        result = self._service.unregister_hotkey(hotkey_id)
        return result.value == "success"


