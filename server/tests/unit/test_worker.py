from __future__ import annotations

import time

from typing_extensions import override

from src.building_blocks.worker import Worker


class CountingWorker(Worker):
    def __init__(self) -> None:
        super().__init__()
        self.count = 0

    @override
    def _run(self) -> None:
        while not self.should_stop:
            self.count += 1
            time.sleep(0.01)


class TestWorker:
    def test_start_and_stop(self) -> None:
        worker = CountingWorker()
        worker.start()
        assert worker.is_alive
        time.sleep(0.05)
        worker.stop(timeout=2.0)
        assert not worker.is_alive
        assert worker.count > 0

    def test_context_manager(self) -> None:
        worker = CountingWorker()
        with worker:
            assert worker.is_alive
            time.sleep(0.05)
        assert not worker.is_alive
        assert worker.count > 0

    def test_stop_with_timeout(self) -> None:
        worker = CountingWorker()
        worker.start()
        worker.stop(timeout=2.0)
        assert not worker.is_alive

    def test_double_start_is_noop(self) -> None:
        worker = CountingWorker()
        worker.start()
        thread_id = worker._thread
        worker.start()  # second start should be noop
        assert worker._thread is thread_id
        worker.stop(timeout=2.0)

    def test_stop_without_start_is_safe(self) -> None:
        worker = CountingWorker()
        worker.stop()  # should not raise
