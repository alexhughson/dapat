package dapat

import kotlinx.io.buffered
import kotlinx.io.files.FileSystem
import kotlinx.io.files.Path
import kotlinx.io.files.SystemFileSystem
import kotlinx.io.readByteArray

/**
 * Something that exists and can change.
 *
 * This is the core abstraction of the build system. An artifact has:
 * - An identity (id) - typically a path or URI
 * - A signature - content hash for change detection
 * - Existence check - does it currently exist?
 *
 * Subclass for custom resources: S3 buckets, database records, APIs, etc.
 */
abstract class Artifact(val id: String) {

    /**
     * If true, this artifact matches any artifact whose id starts with this id.
     * Used for directory dependencies: depend on "build/" to depend on anything in build/.
     */
    open val isPrefix: Boolean = false

    /**
     * Compute a content signature for change detection.
     * Returns null if the artifact doesn't exist.
     */
    abstract suspend fun signature(): String?

    /**
     * Check if this artifact currently exists.
     */
    abstract suspend fun exists(): Boolean

    /**
     * Check if this artifact matches another (for DAG construction).
     * Matching happens when:
     * - IDs are equal (exact match)
     * - This is a prefix and other's ID starts with this ID
     * - Other is a prefix and this ID starts with other's ID
     */
    fun matches(other: Artifact): Boolean = when {
        id == other.id -> true
        isPrefix && other.id.startsWith(id) -> true
        other.isPrefix && id.startsWith(other.id) -> true
        else -> false
    }

    override fun equals(other: Any?) = other is Artifact && id == other.id
    override fun hashCode() = id.hashCode()
    override fun toString() = id
}

/**
 * A file on the filesystem.
 */
class FileArtifact(
    path: String,
    private val fs: FileSystem = SystemFileSystem
) : Artifact(path) {

    private val path get() = Path(id)

    override suspend fun signature(): String? {
        if (!exists()) return null
        val bytes = fs.source(path).buffered().readByteArray()
        return bytes.sha256Hex()
    }

    override suspend fun exists(): Boolean = fs.exists(path)
}

/**
 * A directory (prefix artifact).
 * Matches anything under this path and depends on all outputs under it.
 */
class DirectoryArtifact(
    path: String,
    private val fs: FileSystem = SystemFileSystem
) : Artifact(if (path.endsWith("/")) path else "$path/") {

    override val isPrefix = true

    private val dirPath get() = Path(id.trimEnd('/'))

    override suspend fun signature(): String? {
        if (!fs.exists(dirPath)) return null
        // Hash based on list of files in directory
        val entries = fs.list(dirPath).map { it.toString() }.sorted()
        return entries.joinToString("\n").encodeToByteArray().sha256Hex()
    }

    override suspend fun exists(): Boolean = fs.exists(dirPath)
}

/**
 * A virtual artifact - not backed by the filesystem.
 * Useful for computed values, configuration, or external state.
 */
class VirtualArtifact(
    id: String,
    private val sig: suspend () -> String? = { null }
) : Artifact(id) {

    override suspend fun signature(): String? = sig()

    override suspend fun exists(): Boolean = true
}

// ===== Convenience Functions =====

/** Create a file artifact */
fun file(path: String): Artifact = FileArtifact(path)

/** Create a directory artifact (prefix matching) */
fun directory(path: String): Artifact = DirectoryArtifact(path)

/** Create a virtual artifact */
fun virtual(id: String, sig: suspend () -> String? = { null }): Artifact = VirtualArtifact(id, sig)

// ===== Internal: SHA-256 Hashing =====

/**
 * Compute SHA-256 hash and return as hex string.
 */
internal fun ByteArray.sha256Hex(): String {
    val digest = java.security.MessageDigest.getInstance("SHA-256")
    val hash = digest.digest(this)
    return hash.joinToString("") { "%02x".format(it) }
}
