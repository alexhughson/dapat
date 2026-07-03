from abc import ABC, abstractmethod
from pathlib import Path
import hashlib
import asyncio
from typing import Callable, Awaitable


class Artifact(ABC):
    """Base class for all artifacts (inputs/outputs of tasks)."""

    @property
    @abstractmethod
    def id(self) -> str:
        """Unique identifier for this artifact."""
        ...

    @property
    def is_prefix(self) -> bool:
        """True if this artifact represents a prefix (e.g., directory)."""
        return False

    async def signature(self) -> str | None:
        """Returns a signature for change detection. None if artifact doesn't exist."""
        return None


class FileArtifact(Artifact):
    """A single file on the filesystem."""

    def __init__(self, path: Path):
        self._path = path

    @property
    def id(self) -> str:
        return str(self._path)

    @property
    def path(self) -> Path:
        return self._path

    async def signature(self) -> str | None:
        if not self._path.exists():
            return None
        content = self._path.read_bytes()
        return hashlib.sha256(content).hexdigest()


class DirectoryArtifact(Artifact):
    """A directory on the filesystem (prefix artifact)."""

    def __init__(self, path: Path):
        self._path = path

    @property
    def id(self) -> str:
        return str(self._path)

    @property
    def path(self) -> Path:
        return self._path

    @property
    def is_prefix(self) -> bool:
        return True

    async def signature(self) -> str | None:
        if not self._path.exists():
            return None
        # Hash all file paths and mtimes in the directory
        entries: list[str] = []
        for p in sorted(self._path.rglob("*")):
            if p.is_file():
                entries.append(f"{p}:{p.stat().st_mtime_ns}")
        combined = "\n".join(entries)
        return hashlib.sha256(combined.encode()).hexdigest()


class VirtualArtifact(Artifact):
    """A virtual artifact with an optional custom signature function."""

    def __init__(
        self,
        id: str,
        signature_fn: Callable[[], str | None] | Callable[[], Awaitable[str | None]] | None = None,
        is_prefix: bool = False,
    ):
        self._id = id
        self._signature_fn = signature_fn
        self._is_prefix = is_prefix

    @property
    def id(self) -> str:
        return self._id

    @property
    def is_prefix(self) -> bool:
        return self._is_prefix

    async def signature(self) -> str | None:
        if self._signature_fn:
            result = self._signature_fn()
            if asyncio.iscoroutine(result):
                return await result
            return result  # type: ignore
        return None


# Convenience constructors
def file(path: str | Path) -> FileArtifact:
    return FileArtifact(Path(path) if isinstance(path, str) else path)


def directory(path: str | Path) -> DirectoryArtifact:
    return DirectoryArtifact(Path(path) if isinstance(path, str) else path)


def virtual(
    id: str,
    signature_fn: Callable[[], Awaitable[str | None]] | None = None,
    is_prefix: bool = False,
) -> VirtualArtifact:
    return VirtualArtifact(id, signature_fn, is_prefix)
