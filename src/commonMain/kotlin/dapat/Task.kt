package dapat

/**
 * A unit of work that transforms inputs into outputs.
 *
 * Tasks are the building blocks of a build. Each task:
 * - Has a unique identifier
 * - Declares its input artifacts (what it reads)
 * - Declares its output artifacts (what it produces)
 * - Has an action to execute
 * - Has an optional onDone hook (runs whether action executed or skipped)
 *
 * The build system automatically:
 * - Determines task order based on input/output relationships
 * - Skips tasks whose inputs haven't changed
 * - Runs independent tasks in parallel
 */
data class Task(
    val id: String,
    val inputs: Set<Artifact>,
    val outputs: Set<Artifact>,
    val action: suspend () -> Unit,
    val onDone: (suspend (executed: Boolean) -> Unit)? = null
) {
    override fun toString() = id
}
