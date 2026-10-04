"""Viewer-driven lifecycle shared by the future Python MT/DG/AB workers."""

from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


class Action(Enum):
    NONE = "none"
    START = "start"
    STOP = "stop"


@dataclass
class ViewerLifecycle:
    idle_seconds: float = 300
    running: bool = True
    empty_since: float | None = None

    def observe(self, viewer_count: int, now: float) -> Action:
        if viewer_count < 0:
            raise ValueError("viewer_count cannot be negative")
        if viewer_count > 0:
            self.empty_since = None
            if not self.running:
                self.running = True
                return Action.START
            return Action.NONE  # A returning viewer never restarts live workers.
        if self.empty_since is None:
            self.empty_since = now
        if self.running and now - self.empty_since >= self.idle_seconds:
            self.running = False
            return Action.STOP
        return Action.NONE
