# Dapat

Minimal programmatic build library for Kotlin.

## Install

```kotlin
// build.gradle.kts
dependencies {
    implementation("com.dapat:dapat:0.1.0")
}
```

## Usage

```kotlin
import dapat.*
import kotlinx.io.files.Path

// Create tasks as objects
val compile = Task(
    id = "compile",
    inputs = setOf(file("src/main.kt")),
    outputs = setOf(file("build/main.js")),
    action = { /* compile */ }
)

val bundle = Task(
    id = "bundle",
    inputs = setOf(directory("build/")),  // depends on anything in build/
    outputs = setOf(file("dist/bundle.js")),
    action = { /* bundle */ }
)

// Add to build
val build = Build(JsonState(Path(".dapat-state.json")))
build.addTask(compile)
build.addTask(bundle)

// Query
build.outputs()         // all outputs
build.externalInputs()  // inputs not produced by tasks
build.plan()            // execution order

// Run
runBlocking {
    val result = build.run()
    println("${result.executed.size} executed, ${result.skipped.size} skipped")
}
```

### DSL Alternative

```kotlin
build.task("compile") {
    input(file("src/main.kt"))
    output(file("build/main.js"))
    action { /* compile */ }
    onDone { executed -> println(if (executed) "ran" else "skipped") }
}
```

## Concepts

- **Artifact**: Something with identity that can change (file, S3 object, DB record)
- **Task**: Unit of work with inputs, outputs, and an action
- **Build**: Orchestrator that builds the DAG and runs tasks in parallel

## Custom Artifacts

Subclass `Artifact` for custom resources:

```kotlin
class S3Artifact(bucket: String, key: String, private val s3: S3Client)
    : Artifact("s3://$bucket/$key") {
    override suspend fun signature() = s3.headObject(bucket, key)?.etag
    override suspend fun exists() = s3.exists(bucket, key)
}
```

## License

MIT
