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

val build = Build(JsonState(Path(".dapat-state.json")))

build.task("compile") {
    input(file("src/main.kt"))
    output(file("build/main.js"))
    action { /* compile */ }
    onDone { executed -> println("compile: ${if (executed) "ran" else "skipped"}") }
}

build.task("bundle") {
    input(directory("build/"))  // depends on anything in build/
    output(file("dist/bundle.js"))
    action { /* bundle */ }
}

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
