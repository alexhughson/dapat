package dapat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.TimeSource

/**
 * The build orchestrator.
 *
 * Register tasks, then run. The build system automatically:
 * - Determines task order from input/output relationships (DAG)
 * - Detects what needs to rebuild (change detection)
 * - Runs tasks in parallel when possible
 * - Fails fast if any task fails
 * - Supports dynamic task addition during execution
 *
 * Example:
 * ```
 * val build = Build()
 *
 * build.task("discover") {
 *     input(directory("src/"))
 *     output(virtual("discovery-done"))
 *     action {
 *         // Dynamically add tasks based on discovered files
 *         findSourceFiles().forEach { file ->
 *             task("compile-${file.name}") {
 *                 input(file)
 *                 output(file.compiled())
 *                 action { compile(file) }
 *             }
 *         }
 *     }
 * }
 *
 * val result = build.run()
 * ```
 */
class Build(private val state: State = MemoryState()) {

    private val initialTasks = mutableListOf<Task>()
    private var parallelism = 4

    /**
     * Callback invoked when a task completes (or is skipped).
     * Parameters: task, whether it was actually executed (vs skipped)
     */
    var onTaskDone: (suspend (Task, executed: Boolean) -> Unit)? = null

    // ===== Task Registration =====

    /**
     * Add a task to the build.
     */
    fun addTask(task: Task) {
        initialTasks += task
    }

    /**
     * Register a task using the builder DSL.
     */
    fun task(id: String, block: TaskBuilder.() -> Unit) {
        initialTasks += TaskBuilder(id).apply(block).build()
    }

    /**
     * Builder for creating tasks with a nice DSL.
     */
    class TaskBuilder(private val id: String) {
        private val inputs = mutableSetOf<Artifact>()
        private val outputs = mutableSetOf<Artifact>()
        private var action: suspend BuildContext.() -> Unit = {}
        private var onDone: (suspend (executed: Boolean) -> Unit)? = null

        fun input(a: Artifact) = apply { inputs += a }
        fun inputs(vararg artifacts: Artifact) = apply { inputs += artifacts }

        fun output(a: Artifact) = apply { outputs += a }
        fun outputs(vararg artifacts: Artifact) = apply { outputs += artifacts }

        fun action(block: suspend BuildContext.() -> Unit) = apply { action = block }

        /** Hook that runs when task completes (whether executed or skipped) */
        fun onDone(block: suspend (executed: Boolean) -> Unit) = apply { onDone = block }

        fun build() = Task(id, inputs.toSet(), outputs.toSet(), action, onDone)
    }

    /**
     * Set maximum number of parallel tasks.
     */
    fun parallelism(n: Int) = apply { parallelism = n }

    // ===== Query API (no execution) =====

    /**
     * All outputs that would be produced by initial tasks.
     * Note: Does not include dynamically added tasks.
     */
    fun outputs(): Set<Artifact> = initialTasks.flatMap { it.outputs }.toSet()

    /**
     * All inputs required by initial tasks.
     */
    fun inputs(): Set<Artifact> = initialTasks.flatMap { it.inputs }.toSet()

    /**
     * Inputs not produced by any initial task (external dependencies).
     */
    fun externalInputs(): Set<Artifact> {
        val producedIds = outputs().map { it.id }.toSet()
        return inputs().filter { it.id !in producedIds }.toSet()
    }

    /**
     * Get execution order for initial tasks (topological sort).
     * Note: Dynamic tasks are not included.
     */
    fun plan(): List<Task> {
        val deps = buildDependencyMap(initialTasks)
        val result = mutableListOf<Task>()
        val done = mutableSetOf<Task>()

        while (done.size < initialTasks.size) {
            val ready = initialTasks.filter { it !in done && deps[it]!!.all { d -> d in done } }
            if (ready.isEmpty()) {
                val remaining = initialTasks.filter { it !in done }.map { it.id }
                error("Cycle detected in task graph. Remaining tasks: $remaining")
            }
            result += ready
            done += ready
        }

        return result
    }

    private fun buildDependencyMap(tasks: List<Task>): Map<Task, Set<Task>> {
        val producers = mutableMapOf<String, Task>()
        for (task in tasks) {
            for (output in task.outputs) {
                producers[output.id] = task
            }
        }

        return tasks.associateWith { task ->
            task.inputs.mapNotNull { input ->
                findProducerStatic(input, producers, tasks)
            }.toSet()
        }
    }

    private fun findProducerStatic(
        input: Artifact,
        producers: Map<String, Task>,
        tasks: List<Task>
    ): Task? {
        producers[input.id]?.let { return it }

        if (input.isPrefix) {
            for ((id, task) in producers) {
                if (id.startsWith(input.id)) return task
            }
        }

        for (task in tasks) {
            for (output in task.outputs) {
                if (output.isPrefix && input.id.startsWith(output.id)) {
                    return task
                }
            }
        }

        return null
    }

    // ===== Execution =====

    /**
     * Run the build.
     *
     * Tasks are executed in dependency order, with maximum parallelism.
     * Tasks can dynamically add new tasks during execution.
     * Returns a Result with outcomes for each task (including dynamic ones).
     */
    suspend fun run(): Result {
        return kotlinx.coroutines.coroutineScope {
            val executor = Executor(
                state = state,
                parallelism = parallelism,
                onTaskDone = onTaskDone,
                scope = this
            )

            // Add initial tasks
            initialTasks.forEach { executor.addTask(it) }

            // Wait for all tasks (including dynamically added ones)
            executor.awaitCompletion()
        }
    }
}

/**
 * Internal executor that handles dynamic task execution.
 */
internal class Executor(
    private val state: State,
    private val parallelism: Int,
    private val onTaskDone: (suspend (Task, Boolean) -> Unit)?,
    private val scope: CoroutineScope
) : BuildContext {

    // Output registry: output ID -> producing task
    private val outputs = ConcurrentHashMap<String, Task>()

    // Prefix outputs need separate tracking for matching
    private val prefixOutputs = CopyOnWriteArrayList<Pair<String, Task>>()

    // Completion signals
    private val completions = ConcurrentHashMap<Task, CompletableDeferred<Outcome>>()

    // Results
    private val results = ConcurrentHashMap<Task, Outcome>()

    // Completion detection via reference counting
    private val pendingCount = AtomicInteger(0)
    private val allDone = CompletableDeferred<Unit>()

    // Parallelism control
    private val semaphore = Semaphore(parallelism)

    // Timing
    private val startTime = TimeSource.Monotonic.markNow()

    // ===== BuildContext Implementation =====

    override fun addTask(task: Task) {
        // Register outputs (detect duplicates)
        for (output in task.outputs) {
            if (output.isPrefix) {
                prefixOutputs.add(output.id to task)
            } else {
                val existing = outputs.putIfAbsent(output.id, task)
                require(existing == null) {
                    "Duplicate output '${output.id}': already produced by '${existing?.id}', " +
                        "cannot add from '${task.id}'"
                }
            }
        }

        // Compute dependencies based on current graph state
        val deps = findDependencies(task)

        // Setup completion tracking
        completions[task] = CompletableDeferred()
        pendingCount.incrementAndGet()

        // Launch task coroutine
        scope.launch {
            executeTask(task, deps)
        }
    }

    override fun task(id: String, block: Build.TaskBuilder.() -> Unit) {
        addTask(Build.TaskBuilder(id).apply(block).build())
    }

    // ===== Dependency Resolution =====

    private fun findDependencies(task: Task): Set<Task> {
        return task.inputs.mapNotNull { input ->
            findProducer(input)
        }.toSet()
    }

    private fun findProducer(input: Artifact): Task? {
        // Exact match
        outputs[input.id]?.let { return it }

        // Input is prefix - find any output under it
        if (input.isPrefix) {
            for ((id, task) in outputs) {
                if (id.startsWith(input.id)) return task
            }
        }

        // Check prefix outputs - input is under a prefix output
        for ((prefix, task) in prefixOutputs) {
            if (input.id.startsWith(prefix)) return task
        }

        return null // External input
    }

    // ===== Task Execution =====

    private suspend fun executeTask(task: Task, deps: Set<Task>) {
        try {
            // Wait for all dependencies
            for (dep in deps) {
                val outcome = completions[dep]!!.await()
                if (outcome is Outcome.Failed) {
                    val result = Outcome.Failed(
                        Exception("Dependency '${dep.id}' failed", outcome.error)
                    )
                    complete(task, result)
                    return
                }
            }

            // Execute with semaphore (limits parallelism)
            semaphore.withPermit {
                val outcome = runTask(task)
                complete(task, outcome)
            }
        } catch (e: Throwable) {
            complete(task, Outcome.Failed(e))
        }
    }

    private suspend fun runTask(task: Task): Outcome {
        val needsRebuild = checkNeedsRebuild(task)

        return if (needsRebuild) {
            try {
                task.action(this) // Execute with BuildContext
                recordSignatures(task)
                task.onDone?.invoke(true)
                onTaskDone?.invoke(task, true)
                Outcome.Executed
            } catch (e: Throwable) {
                Outcome.Failed(e)
            }
        } else {
            task.onDone?.invoke(false)
            onTaskDone?.invoke(task, false)
            Outcome.Skipped
        }
    }

    private fun complete(task: Task, outcome: Outcome) {
        results[task] = outcome
        completions[task]!!.complete(outcome)

        // Check if all tasks are done
        if (pendingCount.decrementAndGet() == 0) {
            allDone.complete(Unit)
        }
    }

    // ===== Change Detection =====

    private suspend fun checkNeedsRebuild(task: Task): Boolean {
        val stored = state.get(task.id)
            ?: return true // Never run before

        val currentIds = task.inputs.map { it.id }.toSet()
        if (currentIds != stored.keys) return true

        for (input in task.inputs) {
            val current = input.signature() ?: ""
            val previous = stored[input.id] ?: ""
            if (current != previous) return true
        }

        return false
    }

    private suspend fun recordSignatures(task: Task) {
        val sigs = task.inputs.associate { input ->
            input.id to (input.signature() ?: "")
        }
        state.set(task.id, sigs)
    }

    // ===== Completion =====

    suspend fun awaitCompletion(): Result {
        // Handle empty build
        if (pendingCount.get() == 0) {
            return Result(emptyMap(), 0)
        }

        allDone.await()

        return Result(
            outcomes = results.toMap(),
            durationMs = startTime.elapsedNow().inWholeMilliseconds
        )
    }
}

