from __future__ import annotations
import asyncio
import time
from dataclasses import dataclass, field
from typing import Callable, Awaitable

from .artifact import Artifact
from .task import Task, BuildContext
from .state import State, MemoryState
from .result import Outcome, Result


# ============================================
# Graph Resolution
# ============================================
# Pure functions that analyze tasks to build a dependency graph.
# All outputs are indexed first, then dependencies are resolved.
# This ensures order of task addition doesn't affect correctness.


@dataclass
class OutputIndex:
    exact: dict[str, Task] = field(default_factory=dict)
    prefixes: list[tuple[str, Task]] = field(default_factory=list)


@dataclass
class TaskGraph:
    tasks: list[Task]
    dependencies: dict[Task, set[Task]]
    outputs: OutputIndex


def build_output_index(tasks: list[Task]) -> OutputIndex:
    exact: dict[str, Task] = {}
    prefixes: list[tuple[str, Task]] = []

    for task in tasks:
        for output in task.outputs:
            if output.is_prefix:
                prefixes.append((output.id, task))
            else:
                existing = exact.get(output.id)
                if existing:
                    raise ValueError(
                        f"Duplicate output '{output.id}': produced by both '{existing.id}' and '{task.id}'"
                    )
                exact[output.id] = task

    return OutputIndex(exact, prefixes)


def find_producer(input: Artifact, index: OutputIndex) -> Task | None:
    # Exact match by ID
    exact_match = index.exact.get(input.id)
    if exact_match:
        return exact_match

    # Input is a prefix (e.g., directory) - find any output under it
    if input.is_prefix:
        for id, task in index.exact.items():
            if id.startswith(input.id):
                return task

    # Check if input falls under a prefix output
    for prefix, task in index.prefixes:
        if input.id.startswith(prefix):
            return task

    return None


def resolve_dependencies(tasks: list[Task]) -> TaskGraph:
    # Phase 1: Index all outputs (must complete before phase 2)
    outputs = build_output_index(tasks)

    # Phase 2: Resolve dependencies (now all producers are known)
    dependencies: dict[Task, set[Task]] = {}

    for task in tasks:
        deps: set[Task] = set()
        for input in task.inputs:
            producer = find_producer(input, outputs)
            if producer:
                deps.add(producer)
        dependencies[task] = deps

    return TaskGraph(tasks, dependencies, outputs)


def topological_sort(graph: TaskGraph) -> list[Task]:
    result: list[Task] = []
    done: set[Task] = set()

    while len(done) < len(graph.tasks):
        ready = [
            t
            for t in graph.tasks
            if t not in done and all(d in done for d in graph.dependencies[t])
        ]
        if not ready:
            remaining = [t.id for t in graph.tasks if t not in done]
            raise ValueError(
                f"Cycle detected in task graph. Remaining tasks: {', '.join(remaining)}"
            )
        result.extend(ready)
        done.update(ready)

    return result


# ============================================
# Build (User API)
# ============================================


class Build:
    def __init__(
        self,
        state: State | None = None,
        parallelism: int = 4,
        on_task_done: Callable[[Task, bool], Awaitable[None]] | None = None,
    ) -> None:
        self._tasks: list[Task] = []
        self._state = state or MemoryState()
        self._parallelism = parallelism
        self._on_task_done = on_task_done

    def add(self, task: Task) -> None:
        self._tasks.append(task)

    def outputs(self) -> set[Artifact]:
        return {output for task in self._tasks for output in task.outputs}

    def inputs(self) -> set[Artifact]:
        return {input for task in self._tasks for input in task.inputs}

    def external_inputs(self) -> set[Artifact]:
        produced_ids = {a.id for a in self.outputs()}
        return {a for a in self.inputs() if a.id not in produced_ids}

    def plan(self) -> list[Task]:
        graph = resolve_dependencies(self._tasks)
        return topological_sort(graph)

    async def run(self) -> Result:
        graph = resolve_dependencies(self._tasks)
        executor = _Executor(graph, self._state, self._parallelism, self._on_task_done)
        return await executor.run()


# ============================================
# Executor (Internal)
# ============================================
# Executes a resolved task graph with parallelism and change detection.
# Supports dynamic task addition during execution.


def _to_error(e: BaseException) -> Exception:
    return e if isinstance(e, Exception) else Exception(str(e))


async def _maybe_await(result):
    """Await if result is a coroutine, otherwise return as-is."""
    if asyncio.iscoroutine(result):
        return await result
    return result


@dataclass
class _Completion:
    future: asyncio.Future[Outcome]


class _Executor(BuildContext):
    def __init__(
        self,
        graph: TaskGraph,
        state: State,
        parallelism: int,
        on_task_done: Callable[[Task, bool], Awaitable[None]] | None,
    ) -> None:
        self._graph = graph
        self._state = state
        self._on_task_done = on_task_done

        # Mutable copy of output index (extended by dynamic tasks)
        self._outputs = OutputIndex(
            exact=dict(graph.outputs.exact),
            prefixes=list(graph.outputs.prefixes),
        )

        # Task completion tracking
        self._completions: dict[Task, _Completion] = {}
        self._results: dict[Task, Outcome] = {}

        # Completion detection
        self._pending_count = 0
        self._all_done: asyncio.Future[None] = asyncio.get_event_loop().create_future()

        # Parallelism and timing
        self._semaphore = asyncio.Semaphore(parallelism)
        self._start_time = 0

    async def run(self) -> Result:
        self._start_time = int(time.time() * 1000)

        # Phase 1: Register completions for all tasks (so any task can await any other)
        loop = asyncio.get_event_loop()
        for task in self._graph.tasks:
            future: asyncio.Future[Outcome] = loop.create_future()
            self._completions[task] = _Completion(future)
            self._pending_count += 1

        # Phase 2: Start all tasks
        for task, deps in self._graph.dependencies.items():
            asyncio.create_task(self._execute_task(task, deps))

        return await self._await_completion()

    # BuildContext: add dynamic task during execution
    def add(self, task: Task) -> None:
        # Register outputs (may throw on duplicate)
        for output in task.outputs:
            if output.is_prefix:
                self._outputs.prefixes.append((output.id, task))
            else:
                existing = self._outputs.exact.get(output.id)
                if existing:
                    raise ValueError(
                        f"Duplicate output '{output.id}': produced by both '{existing.id}' and '{task.id}'"
                    )
                self._outputs.exact[output.id] = task

        # Resolve dependencies against current output index
        deps: set[Task] = set()
        for input in task.inputs:
            producer = find_producer(input, self._outputs)
            if producer:
                deps.add(producer)

        loop = asyncio.get_event_loop()
        future: asyncio.Future[Outcome] = loop.create_future()
        self._completions[task] = _Completion(future)
        self._pending_count += 1
        asyncio.create_task(self._execute_task(task, deps))

    async def _execute_task(self, task: Task, deps: set[Task]) -> None:
        try:
            # Wait for all dependencies
            for dep in deps:
                outcome = await self._completions[dep].future
                if outcome.type == "failed":
                    self._complete(
                        task,
                        Outcome.failed(
                            Exception(f"Dependency '{dep.id}' failed", outcome.error)
                        ),
                    )
                    return

            # Execute with parallelism control
            async with self._semaphore:
                outcome = await self._run_task(task)
            self._complete(task, outcome)
        except Exception as e:
            self._complete(task, Outcome.failed(_to_error(e)))

    async def _run_task(self, task: Task) -> Outcome:
        needs_rebuild = await self._check_needs_rebuild(task)

        if needs_rebuild:
            try:
                await _maybe_await(task.run(self))
                await self._record_signatures(task)
                if task.on_done:
                    await _maybe_await(task.on_done(True))
                if self._on_task_done:
                    await _maybe_await(self._on_task_done(task, True))
                return Outcome.executed()
            except Exception as e:
                return Outcome.failed(_to_error(e))
        else:
            if task.on_done:
                await _maybe_await(task.on_done(False))
            if self._on_task_done:
                await _maybe_await(self._on_task_done(task, False))
            return Outcome.skipped()

    def _complete(self, task: Task, outcome: Outcome) -> None:
        self._results[task] = outcome
        self._completions[task].future.set_result(outcome)
        self._pending_count -= 1
        if self._pending_count == 0 and not self._all_done.done():
            self._all_done.set_result(None)

    async def _check_needs_rebuild(self, task: Task) -> bool:
        stored = await self._state.get(task.id)
        if stored is None:
            return True

        current_ids = {i.id for i in task.inputs}
        if current_ids != set(stored.keys()):
            return True

        for input in task.inputs:
            current = await input.signature() or ""
            previous = stored.get(input.id, "")
            if current != previous:
                return True

        return False

    async def _record_signatures(self, task: Task) -> None:
        sigs: dict[str, str] = {}
        for input in task.inputs:
            sigs[input.id] = await input.signature() or ""
        await self._state.set(task.id, sigs)

    async def _await_completion(self) -> Result:
        if self._pending_count == 0:
            return Result({}, 0)

        await self._all_done
        duration = int(time.time() * 1000) - self._start_time
        return Result(dict(self._results), duration)
