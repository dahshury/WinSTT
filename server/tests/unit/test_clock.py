from __future__ import annotations

import time

from src.building_blocks.clock import Clock


class TestSystemClock:
    def test_returns_near_current_time(self) -> None:
        clock = Clock.system_clock()
        before = time.time()
        result = clock.get_current_time()
        after = time.time()
        assert before <= result <= after

    def test_successive_calls_increase(self) -> None:
        clock = Clock.system_clock()
        t1 = clock.get_current_time()
        t2 = clock.get_current_time()
        assert t2 >= t1


class TestFixedClock:
    def test_returns_fixed_time(self) -> None:
        clock = Clock.fixed_clock(1234567890.0)
        assert clock.get_current_time() == 1234567890.0

    def test_deterministic(self) -> None:
        clock = Clock.fixed_clock(42.0)
        assert clock.get_current_time() == clock.get_current_time()
