from __future__ import annotations

import time
from abc import ABC, abstractmethod

from typing_extensions import override


class Clock(ABC):
    @abstractmethod
    def get_current_time(self) -> float: ...

    @staticmethod
    def system_clock() -> Clock:
        return SystemClock()

    @staticmethod
    def fixed_clock(fixed_time: float) -> Clock:
        return FixedClock(fixed_time)


class SystemClock(Clock):
    @override
    def get_current_time(self) -> float:
        return time.time()


class FixedClock(Clock):
    def __init__(self, fixed_time: float) -> None:
        self._fixed_time = fixed_time

    @override
    def get_current_time(self) -> float:
        return self._fixed_time
