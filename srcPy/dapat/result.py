from __future__ import annotations
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .task import Task


@dataclass
class Outcome:
    """Result of executing a single task."""

    type: str  # "executed" | "skipped" | "failed"
    error: Exception | None = None

    @staticmethod
    def executed() -> Outcome:
        return Outcome("executed")

    @staticmethod
    def skipped() -> Outcome:
        return Outcome("skipped")

    @staticmethod
    def failed(error: Exception) -> Outcome:
        return Outcome("failed", error)


class Result:
    """Result of running a build."""

    def __init__(self, outcomes: dict[Task, Outcome], duration_ms: int) -> None:
        self._outcomes = outcomes
        self._duration_ms = duration_ms

    @property
    def outcomes(self) -> dict[Task, Outcome]:
        return self._outcomes

    @property
    def duration_ms(self) -> int:
        return self._duration_ms

    @property
    def success(self) -> bool:
        return all(o.type != "failed" for o in self._outcomes.values())

    @property
    def executed(self) -> set[Task]:
        return {t for t, o in self._outcomes.items() if o.type == "executed"}

    @property
    def skipped(self) -> set[Task]:
        return {t for t, o in self._outcomes.items() if o.type == "skipped"}

    @property
    def failed(self) -> set[Task]:
        return {t for t, o in self._outcomes.items() if o.type == "failed"}
