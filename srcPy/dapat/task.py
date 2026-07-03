from __future__ import annotations
from typing import Protocol, Callable, Awaitable, TYPE_CHECKING
from dataclasses import dataclass, field
from .artifact import Artifact

if TYPE_CHECKING:
    pass


class BuildContext(Protocol):
    """Context passed to task run functions for dynamic task addition."""

    def add(self, task: Task) -> None:
        """Add a new task dynamically during execution."""
        ...


@dataclass(eq=False)
class Task:
    """A unit of work in the build system."""

    id: str
    run: Callable[[BuildContext], Awaitable[None]]
    inputs: list[Artifact] = field(default_factory=list)
    outputs: list[Artifact] = field(default_factory=list)
    on_done: Callable[[bool], Awaitable[None]] | None = None

    def __hash__(self) -> int:
        return hash(self.id)
