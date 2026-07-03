from typing import Protocol
from pathlib import Path
import json


class State(Protocol):
    """Persistent storage for task input signatures (enables incremental builds)."""

    async def get(self, task_id: str) -> dict[str, str] | None:
        """Get stored signatures for a task. Returns None if not found."""
        ...

    async def set(self, task_id: str, signatures: dict[str, str]) -> None:
        """Store signatures for a task."""
        ...

    async def clear(self) -> None:
        """Clear all stored state."""
        ...


class MemoryState:
    """In-memory state storage (lost on process exit)."""

    def __init__(self) -> None:
        self._store: dict[str, dict[str, str]] = {}

    async def get(self, task_id: str) -> dict[str, str] | None:
        return self._store.get(task_id)

    async def set(self, task_id: str, signatures: dict[str, str]) -> None:
        self._store[task_id] = dict(signatures)

    async def clear(self) -> None:
        self._store.clear()


class JsonState:
    """JSON file-based state storage."""

    def __init__(self, path: str | Path) -> None:
        self._path = Path(path)
        self._data: dict[str, dict[str, str]] = {}
        self._loaded = False

    async def _load(self) -> None:
        if self._loaded:
            return
        if self._path.exists():
            try:
                content = self._path.read_text()
                data = json.loads(content)
                self._data = data.get("tasks", {})
            except (json.JSONDecodeError, OSError):
                self._data = {}
        self._loaded = True

    async def _save(self) -> None:
        content = json.dumps({"tasks": self._data}, indent=2)
        tmp_path = self._path.with_suffix(".tmp")
        tmp_path.write_text(content)
        tmp_path.rename(self._path)

    async def get(self, task_id: str) -> dict[str, str] | None:
        await self._load()
        return self._data.get(task_id)

    async def set(self, task_id: str, signatures: dict[str, str]) -> None:
        await self._load()
        self._data[task_id] = dict(signatures)
        await self._save()

    async def clear(self) -> None:
        self._data = {}
        self._loaded = True
        try:
            self._path.unlink()
        except FileNotFoundError:
            pass
