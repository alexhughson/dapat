package dapat

/**
 * Context available during task execution.
 * Allows tasks to dynamically add new tasks to the build.
 */
interface BuildContext {
    /**
     * Add a new task to the build during execution.
     *
     * The task will be scheduled immediately. Its dependencies are computed
     * based on the current graph state - it can depend on any task that
     * exists when addTask is called.
     *
     * Constraints:
     * - New task's outputs must not duplicate existing outputs
     * - New tasks extend the graph forward (existing tasks won't depend on them)
     */
    fun addTask(task: Task)

    /**
     * Add a new task using the builder DSL.
     */
    fun task(id: String, block: Build.TaskBuilder.() -> Unit)
}
