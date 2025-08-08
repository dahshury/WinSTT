"""
Recording State Entity

Manages the current state of audio recording with business rules.
Extracted from utils/listener.py key handling and recording logic.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import TYPE_CHECKING, Any

from src_refactored.domain.common.abstractions import Entity
from src_refactored.domain.common.domain_utils import DomainIdentityGenerator
from src_refactored.domain.common.events import DomainEvent

if TYPE_CHECKING:
    from src_refactored.domain.common.ports.time_management_port import TimeManagementPort

if TYPE_CHECKING:
    from src_refactored.domain.settings.value_objects.key_combination import KeyCombination


class RecordingPhase(Enum):
    """Phases of the recording process."""
    IDLE = "idle"
    KEY_PRESSED = "key_pressed"
    STARTING = "starting"
    ACTIVE = "active"
    STOPPING = "stopping"
    FINALIZING = "finalizing"


@dataclass(frozen=True)
class RecordingStateChangedEvent(DomainEvent):
    """Domain event fired when recording state changes."""
    entity_id: str
    old_phase: RecordingPhase
    new_phase: RecordingPhase
    trigger_keys: set[str]


@dataclass(frozen=True)
class HotkeyDetectedEvent(DomainEvent):
    """Domain event fired when recording hotkey is detected."""
    entity_id: str
    key_combination: KeyCombination
    keys_pressed: set[str]


class RecordingState(Entity):
    """
    Entity representing the current state of audio recording.
    
    Manages key combination detection and recording phase transitions
    extracted from AudioToText key handling logic.
    """
    
    def __init__(self, entity_id: str, hotkey_combination: KeyCombination, **kwargs: Any) -> None:
        """Initialize recording state."""
        super().__init__(entity_id)
        self.hotkey_combination = hotkey_combination
        self.current_phase = kwargs.get("current_phase", RecordingPhase.IDLE)
        self.keys_currently_pressed = kwargs.get("keys_currently_pressed", set())
        self.last_state_change = kwargs.get("last_state_change", DomainIdentityGenerator.generate_timestamp())
        self.recording_session_id = kwargs.get("recording_session_id")
        self.sound_enabled = kwargs.get("sound_enabled", True)
        self.paste_enabled = kwargs.get("paste_enabled", True)
        self.last_playback_time = kwargs.get("last_playback_time", DomainIdentityGenerator.generate_timestamp())
        self._time_port: TimeManagementPort | None = kwargs.get("time_port")

    def handle_key_down(self, key_name: str,
    ) -> None:
        """
        Handle key press event.
        Business rule: Track pressed keys and detect hotkey combinations.
        """
        # Normalize key name and add to pressed keys
        normalized_key = self._normalize_key_name(key_name)
        self.keys_currently_pressed.add(normalized_key)

        # Check if hotkey combination is complete
        if self._is_hotkey_combination_pressed():
            if self.current_phase == RecordingPhase.IDLE:
                self._transition_to_phase(RecordingPhase.KEY_PRESSED)

                # Raise hotkey detected event
                HotkeyDetectedEvent(
                    event_id="",
                    timestamp=0.0,
                    source="RecordingState",
                    entity_id=self.entity_id,
                    key_combination=self.hotkey_combination,
                    keys_pressed=self.keys_currently_pressed.copy(),
                )
                # Note: In real implementation, this would be added to an event collection

    def handle_key_up(self, key_name: str,
    ) -> None:
        """
        Handle key release event.
        Business rule: Remove key from pressed set and check for recording stop.
        """
        normalized_key = self._normalize_key_name(key_name)
        self.keys_currently_pressed.discard(normalized_key)

        # Check if hotkey combination is no longer pressed
        if not self._is_hotkey_combination_pressed():
            if self.current_phase in [RecordingPhase.KEY_PRESSED, RecordingPhase.STARTING, RecordingPhase.ACTIVE]:
                self._transition_to_phase(RecordingPhase.STOPPING)

    def start_recording(self, session_id: str,
    ) -> None:
        """
        Start recording process.
        Business rule: Can only start from KEY_PRESSED phase.
        """
        if self.current_phase != RecordingPhase.KEY_PRESSED:
            msg = f"Cannot start recording from phase: {self.current_phase}"
            raise ValueError(msg)

        self.recording_session_id = session_id
        self._transition_to_phase(RecordingPhase.STARTING)

        # Brief transition to active phase
        self._transition_to_phase(RecordingPhase.ACTIVE)

    def stop_recording(self) -> None:
        """
        Stop recording process.
        Business rule: Can only stop from ACTIVE phase via STOPPING.
        """
        if self.current_phase != RecordingPhase.STOPPING:
            msg = f"Cannot stop recording from phase: {self.current_phase}"
            raise ValueError(msg)

        self._transition_to_phase(RecordingPhase.FINALIZING)

    def complete_recording(self) -> None:
        """
        Complete recording and return to idle.
        Business rule: Final transition back to idle state.
        """
        if self.current_phase != RecordingPhase.FINALIZING:
            msg = f"Cannot complete recording from phase: {self.current_phase}"
            raise ValueError(msg)

        self.recording_session_id = None
        self._transition_to_phase(RecordingPhase.IDLE,
    )

    def update_hotkey(self, new_combination: KeyCombination,
    ) -> None:
        """
        Update the hotkey combination.
        Business rule: Can only update when idle.
        """
        if self.current_phase != RecordingPhase.IDLE:
            msg = f"Cannot update hotkey while recording (phase: {self.current_phase})"
            raise ValueError(msg)

        self.hotkey_combination = new_combination
        self.keys_currently_pressed.clear()  # Clear any stale key states
        self.update_timestamp()

    def _transition_to_phase(self, new_phase: RecordingPhase,
    ) -> None:
        """Transition to a new recording phase."""
        old_phase = self.current_phase
        self.current_phase = new_phase
        self.last_state_change = DomainIdentityGenerator.generate_timestamp()
        self.update_timestamp()

        # Raise state change event
        RecordingStateChangedEvent(
            event_id="",
            timestamp=0.0,
            source="RecordingState",
            entity_id=self.entity_id,
            old_phase=old_phase,
            new_phase=new_phase,
            trigger_keys=self.keys_currently_pressed.copy(),
        )
        # Note: In real implementation, this would be added to an event collection

    def _is_hotkey_combination_pressed(self) -> bool:
        """Check if the configured hotkey combination is currently pressed."""
        # Convert hotkey combination to normalized key names
        required_keys = set()

        # Add modifiers
        for modifier in self.hotkey_combination.modifiers:
            normalized_modifier = self._normalize_key_name(modifier)
            required_keys.add(normalized_modifier)

        # Add main key
        normalized_key = self._normalize_key_name(self.hotkey_combination.key)
        required_keys.add(normalized_key)

        # Check if all required keys are pressed
        return required_keys.issubset(self.keys_currently_pressed)

    def _normalize_key_name(self, key_name: str,
    ) -> str:
        """
        Normalize key names for consistent comparison.
        Extracted from AudioToText._normalize_key_names method.
        """
        # Mapping from configuration names to standard names
        key_mapping = {
            "CTRL": "ctrl",
            "ALT": "alt",
            "SHIFT": "shift",
            "WIN": "windows",
            "CMD": "cmd",
            "META": "windows",  # Treat META as Windows key
        }

        key_upper = key_name.strip().upper()
        return key_mapping.get(key_upper, key_name.lower())

    @property
    def is_recording(self) -> bool:
        """Check if currently in a recording state."""
        return bool(self.current_phase in [
            RecordingPhase.STARTING,
            RecordingPhase.ACTIVE,
            RecordingPhase.STOPPING,
            RecordingPhase.FINALIZING,
        ])

    @property
    def is_idle(self) -> bool:
        """Check if in idle state."""
        return bool(self.current_phase == RecordingPhase.IDLE)

    @property
    def can_start_recording(self) -> bool:
        """Check if recording can be started."""
        return bool(self.current_phase == RecordingPhase.KEY_PRESSED)

    @property
    def time_since_last_change(self) -> float:
        """Get time in seconds since last state change."""
        if self._time_port is not None:
            ts = self._time_port.get_current_timestamp_ms()
            if ts.is_success and ts.value is not None:
                return max(0.0, (float(ts.value) / 1000.0) - float(self.last_state_change))
        return float(DomainIdentityGenerator.generate_timestamp() - float(self.last_state_change))

    @property
    def hotkey_display_string(self) -> str:
        """Get display string for the current hotkey."""
        return self.hotkey_combination.to_string()

    def should_play_start_sound(self) -> bool:
        """
        Check if start sound should be played.
        Business rule: Play sound on recording start with debounce.
        """
        if not self.sound_enabled:
            return False

        if self.current_phase != RecordingPhase.STARTING:
            return False

        # Debounce: Don't play sound too frequently using port if available
        if self._time_port is not None:
            ts = self._time_port.get_current_timestamp_ms()
            now_val: float = (
                float(ts.value) / 1000.0 if ts.is_success and ts.value is not None else DomainIdentityGenerator.generate_timestamp()
            )
        else:
            now_val = DomainIdentityGenerator.generate_timestamp()
        time_since_last = float(now_val - float(self.last_playback_time))
        return time_since_last > 1.0

    def mark_sound_played(self) -> None:
        """Mark that start sound was played."""
        self.last_playback_time = DomainIdentityGenerator.generate_timestamp()