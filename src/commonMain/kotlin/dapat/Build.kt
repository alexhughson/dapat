package dapat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlin.time.TimeSource

/**
 * The build orchestrator.
 *
 * Register tasks, then run. The build system automatically:
 * - Determines task order from input/output relationships (DAG)
 * - Detects what needs to rebuild (change detection)
 * - Runs tasks in parallel when possible
 * - Fails fast if any task fails
 *
 * Example:
 * ```
 * val build = Build()
 *
 * build.task("compile") {
 *     input(file("src/main.kt"))
 *     output(file("build/main.js"))
 *     action { /* compile */ }
 * }
 *
 * val result = build.run()
 * ```
 */
class Build(private val state: State = MemoryState()) {

    private val tasks = mutableListOf<Task>()
    private var parallelism = 4

    /**
     * Callback invoked when a task completes (or is skipped).
     * Parameters: task, whether it was actually executed (vs skipped)
     */
    var onTaskDone: (suspend (Task, executed: Boolean) -> Unit)? = null

    // ===== Task Registration =====

    /**
     * Register a task directly.
     */
    fun task(
        id: String,
        inputs: Set<Artifact>,
        outputs: Set<Artifact>,
        action: suspend () -> Unit
    ) {
        tasks += Task(id, inputs, outputs, action)
    }

    /**
     * Register a task using the builder DSL.
     */
    fun task(id: String, block: TaskBuilder.() -> Unit) {
        tasks += TaskBuilder(id).apply(block).build()
    }

    /**
     * Builder for creating tasks with a nice DSL.
     */
    class TaskBuilder(private val id: String) {
        private val inputs = mutableSetOf<Artifact>()
        private val outputs = mutableSetOf<Artifact>()
        private var action: suspend () -> Unit = {}
        private var onDone: (suspend (executed: Boolean) -> Unit)? = null

        fun input(a: Artifact) = apply { inputs += a }
        fun inputs(vararg artifacts: Artifact) = apply { inputs += artifacts }

        fun output(a: Artifact) = apply { outputs += a }
        fun outputs(vararg artifacts: Artifact) = apply { outputs += artifacts }

        fun action(block: suspend () -> Unit) = apply { action = block }

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
     * All outputs that would be produced by this build.
     */
    fun outputs(): Set<Artifact> = tasks.flatMap { it.outputs }.toSet()

    /**
     * All inputs required by this build.
     */
    fun inputs(): Set<Artifact> = tasks.flatMap { it.inputs }.toSet()

    /**
     * Inputs not produced by any task (external dependencies).
     * These must exist before the build can run.
     */
    fun externalInputs(): Set<Artifact> {
        val producedIds = outputs().map { it.id }.toSet()
        return inputs().filter { it.id !in producedIds }.toSet()
    }

    /**
     * Get execution order (topological sort).
     * Tasks earlier in the list must complete before later tasks.
     */
    fun plan(): List<Task> {
        val deps = buildDependencyMap()
        val result = mutableListOf<Task>()
        val done = mutableSetOf<Task>()

        while (done.size < tasks.size) {
            val ready = tasks.filter { it !in done && deps[it]!!.all { d -> d in done } }
            if (ready.isEmpty()) {
                val remaining = tasks.filter { it !in done }.map { it.id }
                error("Cycle detected in task graph. Remaining tasks: $remaining")
            }
            result += ready
            done += ready
        }

        return result
    }

    // ===== Execution =====

    /**
     * Run the build.
     *
     * Tasks are executed in dependency order, with maximum parallelism.
     * Returns a Result with outcomes for each task.
     */
    suspend fun run(): Result = coroutineScope {
        val start = TimeSource.Monotonic.markNow()

        // Build dependency map
        val deps = buildDependencyMap()

        // Each task has a CompletableDeferred that signals when it's done
        val completions = tasks.associateWith { CompletableDeferred<Outcome>() }

        // Limit parallelism
        val semaphore = Semaphore(parallelism)

        // Launch a coroutine for each task
        // Each coroutine waits for its dependencies, then runs
        val jobs = tasks.map { task ->
            async {
                // Wait for all dependencies to complete
                for (dep in deps[task]!!) {
                    val outcome = completions[dep]!!.await()
                    // Fail fast: if dependency failed, propagate
                    if (outcome is Outcome.Failed) {
                        val result = Outcome.Failed(
                            Exception("Dependency '${dep.id}' failed", outcome.error)
                        )
                        completions[task]!!.complete(result)
                        return@async task to result
                    }
                }

                // All dependencies succeeded - acquire semaphore and run
                semaphore.withPermit {
                    val outcome = runTask(task)
                    completions[task]!!.complete(outcome)
                    task to outcome
                }
            }
        }

        // Wait for all tasks and collect results
        val outcomes = jobs.awaitAll().toMap()
        val duration = start.elapsedNow().inWholeMilliseconds

        Result(outcomes, duration)
    }

    private suspend fun runTask(task: Task): Outcome {
        return if (needsRebuild(task)) {
            try {
                task.action()
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

    // ===== Internal: DAG Construction =====

    /**
     * Build a map from each task to the set of tasks it depends on.
     * A task depends on another if it has an input that the other produces.
     */
    private fun buildDependencyMap(): Map<Task, Set<Task>> {
        // Map: output artifact ID -> task that produces it
        val producers = mutableMapOf<String, Task>()
        for (task in tasks) {
            for (output in task.outputs) {
                producers[output.id] = task
            }
        }

        // For each task, find which tasks produce its inputs
        return tasks.associateWith { task ->
            task.inputs.mapNotNull { input ->
                findProducer(input, producers)
            }.toSet()
        }
    }

    /**
     * Find the task that produces a given input artifact.
     * Handles exact matches and prefix matching.
     */
    private fun findProducer(input: Artifact, producers: Map<String, Task>): Task? {
        // Exact match first
        producers[input.id]?.let { return it }

        // Prefix match: input is a prefix, find any output under it
        if (input.isPrefix) {
            for ((id, task) in producers) {
                if (id.startsWith(input.id)) return task
            }
        }

        // Prefix match: output is a prefix, input is under it
        for (task in tasks) {
            for (output in task.outputs) {
                if (output.isPrefix && input.id.startsWith(output.id)) {
                    return task
                }
            }
        }

        return null // External input (not produced by any task)
    }

    // ===== Internal: Change Detection =====

    /**
     * Determine if a task needs to be rebuilt.
     *
     * A task needs rebuild if:
     * - It has never run before
     * - The set of inputs changed (added/removed)
     * - Any input's content changed (signature differs)
     */
    private suspend fun needsRebuild(task: Task): Boolean {
        val stored = state.get(task.id)
            ?: return true // Never run before

        // Input set changed?
        val currentIds = task.inputs.map { it.id }.toSet()
        if (currentIds != stored.keys) return true

        // Any input content changed?
        for (input in task.inputs) {
            val current = input.signature() ?: ""
            val previous = stored[input.id] ?: ""
            if (current != previous) return true
        }

        return false // Up to date
    }

    /**
     * Record input signatures after a successful task run.
     */
    private suspend fun recordSignatures(task: Task) {
        val sigs = task.inputs.associate { input ->
            input.id to (input.signature() ?: "")
        }
        state.set(task.id, sigs)
    }
}
