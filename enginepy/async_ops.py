from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional, Any, List
import threading
import time


@dataclass
class AsyncResult:
    id: int
    _result: Optional[Any] = None
    _error: Optional[str] = None
    _done: bool = False
    _callbacks: List[Callable[["AsyncResult"], None]] = None

    def __post_init__(self) -> None:
        if self._callbacks is None:
            self._callbacks = []

    def set_result(self, value: Any) -> None:
        self._result = value
        self._done = True
        self._notify()

    def set_error(self, error: str) -> None:
        self._error = error
        self._done = True
        self._notify()

    def add_done_callback(self, cb: Callable[["AsyncResult"], None]) -> None:
        self._callbacks.append(cb)
        if self._done:
            cb(self)

    def result(self) -> Optional[Any]:
        return self._result

    def error(self) -> Optional[str]:
        return self._error

    def done(self) -> bool:
        return self._done

    def _notify(self) -> None:
        for cb in list(self._callbacks):
            cb(self)


def run_async(fn: Callable[[], Any]) -> AsyncResult:
    """Run fn in a background thread and return an AsyncResult."""
    result = AsyncResult(id=int(time.time() * 1000) % 1_000_000_000)

    def _runner() -> None:
        try:
            value = fn()
            result.set_result(value)
        except Exception as exc:  # pragma: no cover - defensive
            result.set_error(str(exc))

    thread = threading.Thread(target=_runner, daemon=True)
    thread.start()
    return result