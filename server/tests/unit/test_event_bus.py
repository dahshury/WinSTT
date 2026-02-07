from __future__ import annotations

import threading
from dataclasses import dataclass

from src.building_blocks.event_bus import EventBus


@dataclass(frozen=True)
class SampleEvent:
    value: int


@dataclass(frozen=True)
class OtherEvent:
    message: str


class TestEventBus:
    def test_subscribe_and_publish(self) -> None:
        bus = EventBus()
        received: list[SampleEvent] = []
        bus.subscribe(SampleEvent, received.append)
        bus.publish(SampleEvent(value=42))
        assert len(received) == 1
        assert received[0].value == 42

    def test_multiple_subscribers(self) -> None:
        bus = EventBus()
        received_a: list[SampleEvent] = []
        received_b: list[SampleEvent] = []
        bus.subscribe(SampleEvent, received_a.append)
        bus.subscribe(SampleEvent, received_b.append)
        bus.publish(SampleEvent(value=1))
        assert len(received_a) == 1
        assert len(received_b) == 1

    def test_unsubscribe(self) -> None:
        bus = EventBus()
        received: list[SampleEvent] = []
        bus.subscribe(SampleEvent, received.append)
        bus.unsubscribe(SampleEvent, received.append)
        bus.publish(SampleEvent(value=1))
        assert len(received) == 0

    def test_unsubscribe_nonexistent_is_noop(self) -> None:
        bus = EventBus()
        bus.unsubscribe(SampleEvent, lambda e: None)  # no error

    def test_exception_isolation(self) -> None:
        bus = EventBus()
        received: list[SampleEvent] = []

        def bad_handler(event: SampleEvent) -> None:
            raise RuntimeError("oops")

        bus.subscribe(SampleEvent, bad_handler)
        bus.subscribe(SampleEvent, received.append)
        bus.publish(SampleEvent(value=99))
        assert len(received) == 1
        assert received[0].value == 99

    def test_different_event_types_isolated(self) -> None:
        bus = EventBus()
        sample_received: list[SampleEvent] = []
        other_received: list[OtherEvent] = []
        bus.subscribe(SampleEvent, sample_received.append)
        bus.subscribe(OtherEvent, other_received.append)
        bus.publish(SampleEvent(value=1))
        assert len(sample_received) == 1
        assert len(other_received) == 0

    def test_thread_safety(self) -> None:
        bus = EventBus()
        received: list[SampleEvent] = []
        lock = threading.Lock()

        def safe_append(event: SampleEvent) -> None:
            with lock:
                received.append(event)

        bus.subscribe(SampleEvent, safe_append)

        threads = [threading.Thread(target=bus.publish, args=(SampleEvent(value=i),)) for i in range(100)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(received) == 100

    def test_duplicate_subscribe_ignored(self) -> None:
        bus = EventBus()
        received: list[SampleEvent] = []
        bus.subscribe(SampleEvent, received.append)
        bus.subscribe(SampleEvent, received.append)
        bus.publish(SampleEvent(value=1))
        assert len(received) == 1
