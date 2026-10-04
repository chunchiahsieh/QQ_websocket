"""Independent MT/DG/AB task supervision driven by viewer demand."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable

from lifecycle import Action, ViewerLifecycle

Worker = Callable[[], Awaitable[None]]
Status = Callable[[str, str], None]


class CollectorSupervisor:
    def __init__(self, workers: dict[str, Worker], status: Status,
                 idle_seconds: float = 300, retry_seconds: float = 5):
        if set(workers) != {"MT", "DG", "AB"}:
            raise ValueError("workers must contain MT, DG and AB")
        self.workers = workers
        self.status = status
        self.presence = ViewerLifecycle(idle_seconds=idle_seconds)
        self.retry_seconds = retry_seconds
        self.tasks: dict[str, asyncio.Task[None]] = {}

    def start(self) -> None:
        for platform in ("MT", "DG", "AB"):
            if platform not in self.tasks or self.tasks[platform].done():
                self.tasks[platform] = asyncio.create_task(self._run_one(platform))

    async def stop(self) -> None:
        tasks = list(self.tasks.values())
        self.tasks = {}
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def observe(self, viewer_count: int, now: float | None = None) -> Action:
        action = self.presence.observe(viewer_count, time.monotonic() if now is None else now)
        if action is Action.START:
            self.start()
        elif action is Action.STOP:
            await self.stop()
        return action

    async def _run_one(self, platform: str) -> None:
        while True:
            try:
                self.status(platform, "connecting")
                await self.workers[platform]()
                self.status(platform, "disconnected")
            except asyncio.CancelledError:
                self.status(platform, "stopped")
                raise
            except Exception:
                # Do not log exception text: upstream errors can contain token URLs.
                self.status(platform, "retrying")
            await asyncio.sleep(self.retry_seconds)
