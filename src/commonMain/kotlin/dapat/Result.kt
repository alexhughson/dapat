package dapat

/**
 * Result of running a build.
 */
data class Result(
    /** Outcome for each task */
    val outcomes: Map<Task, Outcome>,
    /** Total build duration in milliseconds */
    val durationMs: Long
) {
    /** True if no tasks failed */
    val success: Boolean
        get() = outcomes.values.none { it is Outcome.Failed }

    /** Tasks that were executed (inputs changed) */
    val executed: Set<Task>
        get() = outcomes.filterValues { it == Outcome.Executed }.keys

    /** Tasks that were skipped (up-to-date) */
    val skipped: Set<Task>
        get() = outcomes.filterValues { it == Outcome.Skipped }.keys

    /** Tasks that failed */
    val failed: Set<Task>
        get() = outcomes.filterValues { it is Outcome.Failed }.keys
}

/**
 * Outcome of running a single task.
 */
sealed interface Outcome {
    /** Task was executed (inputs changed or never run before) */
    data object Executed : Outcome

    /** Task was skipped (inputs unchanged, already up-to-date) */
    data object Skipped : Outcome

    /** Task failed with an error */
    data class Failed(val error: Throwable) : Outcome
}
