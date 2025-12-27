package dapat

import kotlinx.io.buffered
import kotlinx.io.files.FileSystem
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.readString
import kotlinx.io.writeString
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

/**
 * Persists build state for incremental rebuilds.
 *
 * State stores the input signatures from the last successful run of each task.
 * This allows the build system to detect when inputs have changed and a task
 * needs to be re-run.
 */
interface State {
    /**
     * Get the stored input signatures for a task.
     * Returns a map of artifact ID to signature, or null if never run.
     */
    suspend fun get(taskId: String): Map<String, String>?

    /**
     * Store input signatures after a successful task run.
     */
    suspend fun set(taskId: String, signatures: Map<String, String>)

    /**
     * Clear all stored state.
     */
    suspend fun clear()
}

/**
 * In-memory state storage.
 * State is lost when the process exits. Useful for testing or one-off builds.
 */
class MemoryState : State {
    private val store = mutableMapOf<String, Map<String, String>>()

    override suspend fun get(taskId: String): Map<String, String>? = store[taskId]

    override suspend fun set(taskId: String, signatures: Map<String, String>) {
        store[taskId] = signatures
    }

    override suspend fun clear() = store.clear()
}

/**
 * Persistent JSON file state storage.
 * State survives process restarts, enabling incremental builds across runs.
 */
class JsonState(
    private val path: Path,
    private val fs: FileSystem = SystemFileSystem
) : State {

    @Serializable
    private data class Data(
        val tasks: Map<String, Map<String, String>> = emptyMap()
    )

    private var data: Data = load()

    private fun load(): Data = try {
        if (fs.exists(path)) {
            val content = fs.source(path).buffered().readString()
            Json.decodeFromString<Data>(content)
        } else {
            Data()
        }
    } catch (_: Exception) {
        // Corrupted or invalid file - start fresh
        Data()
    }

    override suspend fun get(taskId: String): Map<String, String>? = data.tasks[taskId]

    override suspend fun set(taskId: String, signatures: Map<String, String>) {
        data = data.copy(tasks = data.tasks + (taskId to signatures))
        save()
    }

    override suspend fun clear() {
        data = Data()
        if (fs.exists(path)) {
            fs.delete(path)
        }
    }

    private fun save() {
        val content = Json.encodeToString(data)
        // Write to temp file first, then move (atomic on most filesystems)
        val tmp = Path("$path.tmp")
        fs.sink(tmp).buffered().use { it.writeString(content) }
        fs.atomicMove(tmp, path)
    }
}
