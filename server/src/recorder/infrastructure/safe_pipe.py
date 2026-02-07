from __future__ import annotations

import contextlib
import logging
import multiprocessing as mp
import queue
import threading
from typing import Literal, TypedDict

logger = logging.getLogger(__name__)


class _SendRequest(TypedDict):
    type: Literal["SEND"]
    data: object
    result_queue: queue.Queue[object]


class _RecvRequest(TypedDict):
    type: Literal["RECV"]
    result_queue: queue.Queue[object]


class _PollRequest(TypedDict):
    type: Literal["POLL"]
    timeout: float
    result_queue: queue.Queue[object]


class _CloseRequest(TypedDict):
    type: Literal["CLOSE"]
    result_queue: queue.Queue[object]


_PipeRequest = _SendRequest | _RecvRequest | _PollRequest | _CloseRequest


class ParentPipe:
    def __init__(self, parent_pipe: mp.connection.PipeConnection[object, object]) -> None:
        self._pipe = parent_pipe
        self._closed = False
        self._request_queue: queue.Queue[_PipeRequest] = queue.Queue()
        self._stop_event = threading.Event()
        self._worker_thread = threading.Thread(target=self._pipe_worker, name="ParentPipe_Worker", daemon=True)
        self._worker_thread.start()

    def _pipe_worker(self) -> None:
        while not self._stop_event.is_set():
            try:
                request = self._request_queue.get(timeout=0.1)
            except queue.Empty:
                continue

            if request["type"] == "CLOSE":
                break

            try:
                if request["type"] == "SEND":
                    self._pipe.send(request["data"])
                    request["result_queue"].put(None)
                elif request["type"] == "RECV":
                    data = self._pipe.recv()
                    request["result_queue"].put(data)
                elif request["type"] == "POLL":
                    poll_timeout: float = request["timeout"]
                    result = self._pipe.poll(poll_timeout)
                    request["result_queue"].put(result)
            except (EOFError, BrokenPipeError, OSError) as e:
                logger.debug("ParentPipe worker: pipe error %s", e)
                request["result_queue"].put(None)
                break
            except Exception:
                logger.exception("ParentPipe worker: unexpected error")
                request["result_queue"].put(None)
                break

        with contextlib.suppress(Exception):
            self._pipe.close()

    def send(self, data: object) -> None:
        if self._closed:
            return
        result_queue: queue.Queue[object] = queue.Queue()
        self._request_queue.put({"type": "SEND", "data": data, "result_queue": result_queue})
        result_queue.get()

    def recv(self) -> object:
        if self._closed:
            return None
        result_queue: queue.Queue[object] = queue.Queue()
        self._request_queue.put({"type": "RECV", "result_queue": result_queue})
        return result_queue.get()

    def poll(self, timeout: float = 0.0) -> bool:
        if self._closed:
            return False
        result_queue: queue.Queue[object] = queue.Queue()
        self._request_queue.put({"type": "POLL", "timeout": timeout, "result_queue": result_queue})
        try:
            result = result_queue.get(timeout=timeout + 0.1)
        except queue.Empty:
            result = False
        return bool(result)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._request_queue.put({"type": "CLOSE", "result_queue": queue.Queue[object]()})
        self._stop_event.set()
        self._worker_thread.join()


def create_safe_pipe() -> tuple[ParentPipe, mp.connection.PipeConnection[object, object]]:
    parent_conn, child_conn = mp.Pipe()
    parent_pipe = ParentPipe(parent_conn)
    return parent_pipe, child_conn
