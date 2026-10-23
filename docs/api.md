# API reference

Look up the signature and members of any export of dapat here, or the exact text of an [error message](#error-messages). Read part 1 of the [guide](guide.md) first.

## Imports

Import each export from `"dapat"` or `"dapat/contrib"`. Other paths, such as `dapat/contrib/fs`, fail: Bun gives `Cannot find module 'dapat/contrib/fs'`, and tsc gives error TS2307.

This table lists every export. Use the Extend dapat column to write an [artifact type](write-an-artifact.md), an [output template](build-each.md#output-templates) of your own type, a [store](builtins.md#write-a-store), a [matcher](write-a-matcher.md) or an `S3Client`, or to [subclass `Build`](semantics.md#subclass-build-settasksofgroups). A name with no link is in the section of a related class, such as `Context` under `Task` and `IdPrefix` under `Prefix`.

| From | Kind | Write a build | Extend dapat |
| --- | --- | --- | --- |
| `dapat` | class | [`Build`](#build), `IdPrefix`, `MemoryStore`, [`Result`](#result), [`Task`](#task) | [`Artifact`](#artifact) (abstract), [`Emitter`](#emitter), [`Matcher`](#matcher) (abstract), [`Prefix`](#prefix) (abstract), [`TaskGroup`](#taskgroup) |
| `dapat` | function, constant | `isArtifact`, `isPrefix`, `SEND_LIMIT` | – |
| `dapat` | type | `ArtifactEvent`, `Context`, `JoinedVars`, `MatchedArtifact`, `MatchedByName`, `Outcome`, `OutputsByName`, `Ref`, `RunArgs`, `RunConfig`, `RunReason`, `TaskInit`, [`TaskMaterializerConfig`](#taskmaterializerconfig), `TasksConfig`, `Vars` | `AnyMatcher`, [`ArtifactTemplate`](#artifacttemplate), `GroupTasks`, `MatchedArtifactEvent`, `MatchedData`, [`Store`](#store), `TaskState` |
| `dapat/contrib` | class | [`FileArtifact`](#fileartifact), [`FileGroupMatcher`](#filegroupmatcher), [`FileMatcher`](#filematcher), [`FilesystemPrefix`](#filesystemprefix), [`FileTemplate`](#filetemplate), `FolderTemplate`, [`JsonStore`](#jsonstore-and-sqlitestore), `MemoryS3`, `MemoryStore` (the same class as in `dapat`), [`S3ObjectArtifact`](#s3), `S3Prefix`, `SqliteStore` | – |
| `dapat/contrib` | type | `FilePatternOptions`, `FilePatternSyntax`, `FileStampMode`, `FileStampOptions` | `S3Client`, `S3Head`, `S3ListEntry` |

## Exports of dapat

### Build

A `Build` holds tasks, runs each task after its producers, and saves a record of each successful run in its store ([What a build does](guide.md#what-a-build-does)). It sends each `ArtifactEvent` below to its subscribers ([Events](guide.md#events)).

<!-- no-run -->
```ts
class Build extends Emitter<ArtifactEvent> {
  constructor(opts?: { store?: Store; sendLimit?: number })
  add(task: Task): void
  remove(id: string): void
  each<M extends Record<string, AnyMatcher>, const R extends keyof M & string = keyof M & string, O extends Record<string, ArtifactTemplate> = {}>(config: TaskMaterializerConfig<M, R, O>): void
  run(): Promise<Result>
  subscribe(listener: (event: ArtifactEvent) => void): void // from Emitter; gets only the events sent after the call
  protected setTasksOfGroups(changes: readonly GroupTasks[]): void // gives each group its whole task list (see TaskGroup)
  protected send(event: ArtifactEvent): void // from Emitter; a direct call skips the queue and send limit
  protected override rejected(): void // does nothing: the build failed when send threw
}
type ArtifactEvent =
  | { kind: "promised"; output: Ref; taskId: string }
  | { kind: "produced"; artifact: Artifact; taskId: string }
  | { kind: "deleted"; artifact: Artifact; taskId: string }
  | { kind: "withdrawn"; output: Ref; taskId: string }
const SEND_LIMIT = 10_000 // the default sendLimit
```

- `constructor`: with no `store`, the build calls no `stamp()`, and no task skips. `sendLimit` caps the events that subscribers cause in one pass, and the passes in one drain ([The event queue](semantics.md#the-event-queue), [The send limit](semantics.md#the-send-limit)). It must be a positive integer, or the constructor throws.
- `add` adds the task, or replaces the task that has its id. Once the first `run()` has started its tasks, `add` starts the task immediately ([The order rule](semantics.md#the-order-rule) gives each case). It throws and changes nothing in these cases ([Error messages](#error-messages)):
  - Another task has an [exact output](guide.md#layout-rules) of the task.
  - The task declares one exact output two times.
  - `build.each` or `setTasksOfGroups` gave the task that has its id.
- `remove` removes the task, and with a store it starts `store.delete(id)`. An unknown id does nothing. A removed `build.each` task comes back only when `build.each` makes the tasks of its set again.
- [`each`](build-each.md) makes tasks for each [joined set](guide.md#buildeach) of matches. It throws after the first `run()` starts, or for a bad config.
- `run()` scans the matchers on the first call only. Each call starts the tasks that have not started, waits until no task waits or runs and no `store.delete` is pending, and resolves with every outcome so far. It rejects with the first [fatal error](semantics.md#fatal-errors). [build.run()](semantics.md#buildrun) gives the order of its calls and events.

### Task

A `Task` has an id, inputs, outputs and a `run` function that gets `ctx`, a `Context` ([What a build does](guide.md#what-a-build-does)). To add or remove a task from inside `run`, call `build.add` or `build.remove` on the `Build` that runs the task. [Replacement and removal](semantics.md#replacement-and-removal) tells what `ctx` does in a stopped run, and [ctx still sends events after run returns](limits.md#ctx-still-sends-events-after-run-returns) gives a known issue. Each input and output must be an instance of a subclass of `Artifact` or `Prefix` ([What you write](write-an-artifact.md#what-you-write)).

<!-- no-run -->
```ts
type Ref = Artifact | Prefix // an input or an output
function isArtifact(ref: Ref): ref is Artifact // ref instanceof Artifact
function isPrefix(ref: Ref): ref is Prefix // ref instanceof Prefix
interface TaskInit { id: string; inputs?: readonly Ref[]; outputs?: readonly Ref[]; run: (ctx: Context) => Promise<void> }
class Task {
  constructor(init: TaskInit) // copies the arrays ([] when missing), and checks nothing
  readonly id: string
  readonly inputs: readonly Ref[]
  readonly outputs: readonly Ref[]
  readonly run: (ctx: Context) => Promise<void>
}
interface Context {
  readonly signal: AbortSignal // aborts on replacement, removal or a fatal error
  produced(artifact: Artifact): void // sends a produced event; throws if no output is the artifact or covers it
  deleted(artifact: Artifact): void // sends a deleted event; throws if no output is the artifact or covers it
}
```

### Artifact

Extend `Artifact` for one value that a task reads or writes ([artifacts](guide.md#what-a-build-does), [Write an artifact type](write-an-artifact.md)). [One task](semantics.md#one-task) gives the order of the calls.

<!-- no-run -->
```ts
abstract class Artifact<T = unknown> {
  abstract readonly id: string // the build finds the producers of an input by this string
  abstract stamp(): Promise<string | null> // null if missing; compared with ===; a throw fails the task
  abstract read(): Promise<T> // your task code calls it; the build never does
}
```

### Prefix

Extend `Prefix` for a group of artifacts, usually the artifacts whose ids start with one id, such as the files in one folder ([Folders: prefixes](guide.md#folders-prefixes), [A prefix for keys with unknown names](write-an-artifact.md#step-2-a-prefix-for-keys-with-unknown-names)). [How the build uses your classes](write-an-artifact.md#how-the-build-uses-your-classes) tells which `covers` and `overlaps` the build calls and what an override costs. [`IdPrefix`](builtins.md#idprefix) has only an id.

<!-- no-run -->
```ts
abstract class Prefix {
  abstract readonly id: string
  stamp(): Promise<string | null> // default: null, so no task that has the prefix skips
  covers(artifact: Artifact): boolean // default: artifact.id starts with this.id
  overlaps(other: Prefix): boolean // default: one id starts with the other
}
class IdPrefix extends Prefix { constructor(readonly id: string) } // keeps the null stamp
```

### Store

A [store](guide.md#what-a-build-does) keeps one record, a `TaskState`, for each task id ([Stores](builtins.md#stores), [Write a store](builtins.md#write-a-store)).

<!-- no-run -->
```ts
interface TaskState { inputStamps: Record<string, string | null>; outputStamps: Record<string, string | null> } // each key is "artifact <id>" or "prefix <id>"
interface Store {
  get(taskId: string): Promise<TaskState | null>
  set(taskId: string, state: TaskState): Promise<void>
  delete(taskId: string): Promise<void>
  clear(): Promise<void>
}
class MemoryStore implements Store { constructor() } // a Map in this process
```

### Result

`build.run()` resolves with a `Result` ([Results and failure](guide.md#results-and-failure)). Its fields also hold the outcomes and errors of earlier `run()` calls. A `RunReason` is the reason why a task ran: `no-store`, or the first check of the [skip rule](guide.md#the-skip-rule) that failed ([exact checks](semantics.md#the-skip-rule-exact-checks)). Its `id` is the id of that input or output, not its record key.

<!-- no-run -->
```ts
type RunReason = // the kinds go in the order of the checks
  | { kind: "no-store" } | { kind: "no-inputs" } | { kind: "input-unstamped"; id: string } | { kind: "no-record" }
  | { kind: "input-ids-changed" } | { kind: "input-changed"; id: string }
  | { kind: "output-unstamped"; id: string } | { kind: "output-ids-changed" }
  | { kind: "output-missing"; id: string } | { kind: "output-changed"; id: string }
type Outcome = { type: "executed"; reason: RunReason } | { type: "skipped" } | { type: "failed"; error: Error }
  | { type: "cancelled"; reason: "replaced" | "removed" } // the outcome of one task
class Result {
  constructor(outcomes: ReadonlyMap<Task, Outcome>, errors: readonly Error[]) // build.run() makes each Result; you do not call it
  readonly outcomes: ReadonlyMap<Task, Outcome> // every task of the lists below, in the same order
  readonly success: boolean // failed and errors are empty
  readonly executed: readonly Task[] // each list and map is in the order the tasks first finished
  readonly skipped: readonly Task[]
  readonly failed: ReadonlyMap<Task, Error>
  readonly cancelled: readonly Task[] // replaced or removed; outcomes keeps which
  readonly errors: readonly Error[] // errors that belong to no task
}
```

### Emitter

An `Emitter` calls its [subscribers](guide.md#events) with each event, one at a time, in the order in which they subscribed. A subscriber must be synchronous. If a subscriber returns a promise, `send` throws immediately. When that promise rejects, the emitter passes the reason to `rejected`.

<!-- no-run -->
```ts
class Emitter<E> {
  constructor()
  subscribe(listener: (event: E) => void): void // a subscriber added during a send gets the next event
  protected send(event: E): void // a subscriber's throw stops the send and goes to the caller
  protected rejected(reason: unknown): void // default: throws reason again
}
```

### Matcher

Extend `Matcher` to find artifacts for [`build.each`](guide.md#buildeach) ([Write a matcher](write-a-matcher.md#what-you-write)). `D` is the data of each match.

<!-- no-run -->
```ts
type Vars = Readonly<Record<string, string>> // var values by name; tsc does not check the names
type MatchedData = Artifact | readonly Artifact[]
type MatchedArtifact<D extends MatchedData = MatchedData> = { vars: Vars; data: D } // one match
type MatchedArtifactEvent<D extends MatchedData = MatchedData> =
  | { kind: "found"; matched: MatchedArtifact<D> } // a new match, or new data for known vars
  | { kind: "gone"; vars: Vars }
abstract class Matcher<D extends MatchedData = MatchedData> extends Emitter<MatchedArtifactEvent<D>> {
  abstract readonly varNames: readonly string[]
  abstract scan(signal: AbortSignal): Promise<void> // the first run() calls it; signal aborts on a fatal error
  receiveArtifactEvent(event: ArtifactEvent): void // default: does nothing; a throw makes run() reject
  subscribe(listener: (event: MatchedArtifactEvent<D>) => void): void // from Emitter; for example, to log each event
  protected send(event: MatchedArtifactEvent<D>): void // from Emitter: sends one event
}
type AnyMatcher = Matcher<any> // any matcher; a FileMatcher is not a Matcher<MatchedData>
```

- `varNames`: `build.each` reads it when you call `build.each`. The vars of each event that the matcher sends must have exactly these names, or `run()` rejects.

### TaskMaterializerConfig

`TaskMaterializerConfig` is the type of the `build.each` config ([The config](build-each.md#the-config)). For a config with both `tasks` and `run`, with neither, or with `run` and no `name`, tsc gives an error, and `build.each` throws.

<!-- no-run -->
```ts
type TaskMaterializerConfig<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string, O extends Record<string, ArtifactTemplate> = {}> =
  TasksConfig<M, R, O> | RunConfig<M, R, O>
type TasksConfig<M extends Record<string, AnyMatcher>, R extends keyof M & string, O extends Record<string, ArtifactTemplate>> = {
  matchersByName: M; required?: readonly R[]; outputsByName?: O // with no required list, every matcher is required
  tasks: (vars: JoinedVars<M, R>, matched: MatchedByName<M, R>, outputs: OutputsByName<O>) => Iterable<Task> // for each new or changed joined set; can return no task
  name?: never; run?: never
}
type RunConfig<M extends Record<string, AnyMatcher>, R extends keyof M & string, O extends Record<string, ArtifactTemplate>> = { // one task for each set
  matchersByName: M; required?: readonly R[]; outputsByName?: O // as in TasksConfig
  name: string // the start of each task id
  run: (args: RunArgs<M, R, O>) => Promise<void>
  tasks?: never
}
type RunArgs<M extends Record<string, AnyMatcher>, R extends keyof M & string, O extends Record<string, ArtifactTemplate>> = { vars: JoinedVars<M, R>; matched: MatchedByName<M, R>; outputs: OutputsByName<O>; ctx: Context }
type JoinedVars<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string> // Vars if R names every matcher; else values can be undefined
type MatchedByName<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string>
type OutputsByName<O extends Record<string, ArtifactTemplate>> // readonly; for each name, the type that its template gives
```

- `MatchedByName` has a readonly property for each matcher name. Its type is a `MatchedArtifact` with the data type of that matcher, such as `FileArtifact` for a `FileMatcher`, and it can be `undefined` for a name that is not in `R`.

### ArtifactTemplate

Write an `ArtifactTemplate` for an output of your own artifact type in `outputsByName` ([Output templates](build-each.md#output-templates)).

<!-- no-run -->
```ts
interface ArtifactTemplate<R extends Ref = Ref> {
  readonly varNames: readonly string[] // the var names that expand reads
  expand(vars: Vars): R
}
```

- `expand`: `build.each` calls it only for a joined set that has a value for each name in `varNames`. It gets every var of the set, not only those in `varNames`, and `build.each` does not check the values. A throw makes `run()` reject.

### TaskGroup

A `TaskGroup` names one [task group](semantics.md#subclass-build-settasksofgroups) for `setTasksOfGroups` in a subclass of `Build`.

<!-- no-run -->
```ts
class TaskGroup { constructor(readonly label: string) } // one group per object; the label is for error messages
type GroupTasks = { group: TaskGroup; tasks: readonly Task[] } // one group and its whole new task list
```

## Exports of dapat/contrib

### FileArtifact

`new FileArtifact(p, opts)` is the artifact for one file ([Files](builtins.md#files)). `FilesystemPrefix` takes the same `opts`. With no `stamp`, the [stamp mode](guide.md#artifacts-and-stamps) is `"hash"` ([Hash or time](builtins.md#hash-or-time)). Another value makes the constructor throw ([Error messages](#error-messages)).

<!-- no-run -->
```ts
type FileStampMode = "time" | "hash"
interface FileStampOptions { stamp?: FileStampMode }
class FileArtifact extends Artifact<Uint8Array> {
  constructor(p: string, opts?: FileStampOptions)
  readonly path: string // p resolved at construction, with no "/" at the end
  readonly id: string // "file:" + path
  readonly stampMode: FileStampMode
  stamp(): Promise<string | null> // null for a missing file; throws for a folder or a FIFO
  read(): Promise<Uint8Array> // for a missing file, it throws ENOENT
}
```

### FilesystemPrefix

`new FilesystemPrefix(p, opts)` is the [prefix](guide.md#folders-prefixes) for a folder ([Folders](builtins.md#folders)).

<!-- no-run -->
```ts
class FilesystemPrefix extends Prefix {
  constructor(p: string, opts?: FileStampOptions)
  readonly path: string // p resolved at construction, with a "/" at the end
  readonly id: string // "file:" + path
  readonly stampMode: FileStampMode
  stamp(): Promise<string | null> // never null; throws ENOTDIR when p is a file
  list(): Promise<string[]> // absolute file paths at any depth, unsorted; [] if missing
}
```

### FileMatcher

`new FileMatcher(pattern, opts)` makes one match for each file that fits a pattern such as `content/<lang>/<slug>.md` ([FileMatcher](build-each.md#filematcher)). A file gets its match when the scan finds it, a task reports it, or a task declares it as an exact output ([Matches during the run](build-each.md#matches-during-the-run)). The data of a match is a `FileArtifact` with the stamp mode of the matcher. `syntax` sets other pattern markers ([Names that hold markers](build-each.md#names-that-hold-markers)).

<!-- no-run -->
```ts
interface FilePatternSyntax { varStart?: string; varEnd?: string; anyName?: string; anyFolders?: string } // defaults "<", ">", "*", "**"
interface FilePatternOptions extends FileStampOptions { syntax?: FilePatternSyntax }
class FileMatcher extends Matcher<FileArtifact> {
  constructor(pattern: string, opts?: FilePatternOptions) // throws for a bad pattern, syntax or stamp
  readonly pattern: string // the pattern after path.posix.normalize
  readonly root: string // "/" for an absolute pattern, else the current folder
  readonly varNames: readonly string[] // each var one time, in the order of the pattern
  scan(signal: AbortSignal): Promise<void> // sends found for each file that fits
  receiveArtifactEvent(event: ArtifactEvent): void // starts or ends the match of a FileArtifact that fits
}
```

### FileGroupMatcher

`new FileGroupMatcher(pattern, opts)` takes a pattern with a `*` or `**` (the `anyName` or `anyFolders` of its syntax) and with each var in a part before the first `*` or `**`, such as `content/<lang>/**/*.md`. It makes one match for each value of its vars. The data is the list of the files that fit, sorted by path ([FileGroupMatcher](build-each.md#filegroupmatcher)).

<!-- no-run -->
```ts
class FileGroupMatcher extends Matcher<readonly FileArtifact[]> {
  constructor(pattern: string, opts?: FilePatternOptions) // throws for a bad pattern, syntax or stamp
  readonly pattern: string; readonly root: string; readonly varNames: readonly string[] // as in FileMatcher
  scan(signal: AbortSignal): Promise<void> // sends one found for each list after the whole scan
  receiveArtifactEvent(event: ArtifactEvent): void // sends found with the new list, or gone for an empty one
}
```

### FileTemplate

`new FileTemplate(pattern, opts)` and `new FolderTemplate(pattern, opts)` are [output templates](build-each.md#output-templates) for `outputsByName`. The pattern follows the `FileMatcher` rules, with no `*` or `**`. A relative pattern resolves against the current folder at construction.

<!-- no-run -->
```ts
class FileTemplate implements ArtifactTemplate<FileArtifact> {
  constructor(pattern: string, opts?: FilePatternOptions) // throws for a bad pattern or syntax; does not check stamp
  readonly pattern: string // the pattern after path.posix.normalize
  readonly varNames: readonly string[] // each var one time, in the order of the pattern
  expand(vars: Vars): FileArtifact // throws for a bad var value, a missing var or a bad stamp
}
class FolderTemplate implements ArtifactTemplate<FilesystemPrefix> {
  constructor(pattern: string, opts?: FilePatternOptions) // as FileTemplate
  readonly pattern: string; readonly varNames: readonly string[] // as in FileTemplate
  expand(vars: Vars): FilesystemPrefix // throws as FileTemplate.expand does
}
```

### JsonStore and SqliteStore

`JsonStore` and `SqliteStore` each implement [`Store`](#store) (`get`, `set`, `delete`, `clear`). `new JsonStore(path)` keeps all records in one JSON file, and `new SqliteStore(db)` keeps each record in one row of the SQLite table `dapat_task_state` ([Stores](builtins.md#stores)).

<!-- no-run -->
```ts
class JsonStore implements Store { constructor(readonly path: string) } // each call resolves path against the current folder
class SqliteStore implements Store {
  constructor(db: Database | string) // a Database from bun:sqlite, a file path, or ":memory:"
  close(): void // closes the database only when db is a string
}
```

### S3

An `S3Client` is the object that `S3ObjectArtifact` and `S3Prefix` call to reach S3. Write one for your S3 library, or use `MemoryS3`, which keeps the objects in a `Map` in this process, for tests. [S3](builtins.md#s3) gives the rules for each method.

<!-- no-run -->
```ts
interface S3Head { lastModified: Date; etag: string }
interface S3ListEntry { key: string; etag: string }
interface S3Client {
  head(bucket: string, key: string): Promise<S3Head | null> // S3ObjectArtifact.stamp() calls it
  get(bucket: string, key: string): Promise<Uint8Array> // S3ObjectArtifact.read() calls it
  put(bucket: string, key: string, body: Uint8Array): Promise<S3Head> // dapat never calls it
  list(bucket: string, prefix: string): Promise<S3ListEntry[]> // S3Prefix.stamp() calls it
}
class S3ObjectArtifact extends Artifact<Uint8Array> { // the artifact for one S3 object
  constructor(readonly client: S3Client, readonly bucket: string, readonly key: string)
  readonly id: string // "s3://" + bucket + "/" + key
  stamp(): Promise<string | null> // the etag that client.head gives; null for a missing object
  read(): Promise<Uint8Array> // client.get(bucket, key)
}
class S3Prefix extends Prefix { // the prefix for the keys of one bucket under keyPrefix
  constructor(readonly client: S3Client, readonly bucket: string, readonly keyPrefix: string)
  readonly id: string // "s3://<bucket>/<keyPrefix>", always ending with "/"
  stamp(): Promise<string | null> // never null; one client.list call
}
class MemoryS3 implements S3Client {
  constructor()
  head(bucket: string, key: string): Promise<S3Head | null> // null for a missing key
  get(bucket: string, key: string): Promise<Uint8Array> // the array that put got, not a copy; throws if missing
  put(bucket: string, key: string, body: Uint8Array): Promise<S3Head> // the etag is the SHA-256 hash of body, in hex
  list(bucket: string, prefix: string): Promise<S3ListEntry[]> // sorted by key
}
```

## Error messages

This table gives the exact text of each error message of dapat, and of some messages from Bun. In the messages:

- `<…>` is a value from your build. `<v>` is a bad value, as the message shows it. `<class>` is `FileMatcher`, `FileGroupMatcher`, `FileTemplate` or `FolderTemplate`.
- `<n>` is the number of the `build.each` call. The count starts at 1 and skips each call that threw.
- `<group>` is the label of a [task group](semantics.md#subclass-build-settasksofgroups):
  - `build.add <id>` for a task of `build.add`.
  - `build.each <n>` and the vars of the set for a task of `build.each`, such as `build.each 1 lang=en`.
  - The label of your own `TaskGroup`.
- `<marker name>` is `varStart`, `varEnd`, `anyName` or `anyFolders`, and `<marker>` is its value.
- The pattern messages show the default markers `<`, `>`, `*` and `**`. With a `syntax` option, a message shows your markers. `<x>` and `<y>` stand for vars, such as `<slug>`.

The Where column says how the error reaches your code. The rows are sorted by it, in this order:

- call throws: the call changes nothing.
- call throws, or `run()` rejects:
  - `build.add` throws and changes nothing. So does `setTasksOfGroups` with no open step.
  - For a task of `build.each`, or a `setTasksOfGroups` call in an [open step](semantics.md#steps), `run()` rejects.
- task fails: `result.failed` holds the error.
- `run()` rejects: the error is a [fatal error](semantics.md#fatal-errors).
- `result.errors`: `result.errors` holds the error, and no task fails.

| Message | Where | Cause | See |
| --- | --- | --- | --- |
| `sendLimit must be a positive integer, not <v>` | call throws | `new Build` got a `sendLimit` that is not a positive integer | [Build](#build) |
| `stamp must be "time" or "hash", not <v>` | call throws | a constructor got another `stamp` value. `FileTemplate` and `FolderTemplate` check it only in `expand`, so in `build.each`, `run()` rejects | [Files](builtins.md#files) |
| `group '<group>' is in one setTasksOfGroups step twice` | call throws | with no open step, one `setTasksOfGroups` call names one `TaskGroup` two times. In an open step, the later list wins, and nothing throws | [Subclass Build](semantics.md#subclass-build-settasksofgroups) |
| `build.each must come before the first build.run()` | call throws | a `build.each` call came after the first `build.run()` call | [build.each](guide.md#buildeach) |
| `build.each <n> has no matcher; build.each needs at least one matcher` | call throws | `matchersByName` is empty | [The config](build-each.md#the-config) |
| `build.each <n>: '<name>' and '<name>' are one matcher object; give each name its own matcher` | call throws | two names in `matchersByName` hold the same matcher object | [The config](build-each.md#the-config) |
| `build.each <n>: its matcher '<name>' belongs to another Build; make a new matcher for each Build` | call throws | a `build.each` call of another `Build` already has this matcher object | [The config](build-each.md#the-config) |
| `build.each <n> has both tasks and run; give tasks, or name and run` | call throws | the config has both `tasks` and `run` | [The config](build-each.md#the-config) |
| `build.each <n> has no tasks and no run; give tasks, or name and run` | call throws | the config has neither `tasks` nor `run` | [The config](build-each.md#the-config) |
| `build.each <n>: run needs a name, the start of each task id` | call throws | the config has `run`, but `name` is not a string | [The one-task form](build-each.md#the-one-task-form) |
| `build.each <n>: required is empty; name at least one matcher, or leave required out to require every matcher` | call throws | `required` is `[]` | [required](build-each.md#required) |
| `build.each <n>: required names '<name>', which is not a name in matchersByName` | call throws | `required` holds a name that `matchersByName` does not have | [required](build-each.md#required) |
| `build.each <n>: the output template '<name>' uses the var '<var>', which no matcher has` | call throws | a template in `outputsByName` has a var that no matcher of the call has | [Output templates](build-each.md#output-templates) |
| `<class>: the pattern is empty` | call throws | the pattern is `""` | [FileMatcher](build-each.md#filematcher) |
| `<class> pattern '<pattern>' names no file` | call throws | the pattern has no part after the constructor drops `.` parts and empty parts, as for `.` or `/` | [FileMatcher](build-each.md#filematcher) |
| `<class> pattern '<pattern>': a '..' part is not allowed; for a folder above the working directory, use path.resolve to make the pattern absolute` | call throws | a part of the pattern is `..` | [FileMatcher](build-each.md#filematcher) |
| `<class> pattern '<pattern>': each '<' and '>' must enclose a var name of letters, digits, and '_' that does not start with a digit` | call throws | a `<` or `>` is not part of a var, as in `a<b.md` or `<1x>.md` | [FileMatcher](build-each.md#filematcher) |
| `<class> pattern '<pattern>': '**' must be a whole part, as in 'a/**/b'` | call throws | a part of a matcher pattern has `**` and other text, such as `a**` | [FileGroupMatcher](build-each.md#filegroupmatcher) |
| `<class> pattern '<pattern>': the last part must name files, not '**'; use '**/*' for every file` | call throws | the last part of a matcher pattern is `**` | [FileGroupMatcher](build-each.md#filegroupmatcher) |
| `FileMatcher pattern '<pattern>': '*' and '**' are not allowed; use a var such as <name> for each part that changes, or FileGroupMatcher for one match with a list of files` | call throws | a `FileMatcher` pattern has a `*` or `**`. `<name>` is part of the text | [FileMatcher](build-each.md#filematcher) |
| `<class> pattern '<pattern>': '*' and '**' are not allowed; an output names one path, so use a var such as <name> for each part that changes` | call throws | a `FileTemplate` or `FolderTemplate` pattern has a `*` or `**`. `<name>` is part of the text | [Output templates](build-each.md#output-templates) |
| `FileGroupMatcher pattern '<pattern>' has no '*' or '**'; use FileMatcher for one match for each file` | call throws | the pattern has no `*` or `**` | [FileGroupMatcher](build-each.md#filegroupmatcher) |
| `FileGroupMatcher pattern '<pattern>': a var must come in a part before the first '*' or '**'; read the other names from the path of each file` | call throws | a var is in the part of the first `*` or `**`, or in a later part, as in `a/*/<x>.md` | [FileGroupMatcher](build-each.md#filegroupmatcher) |
| `pattern '<pattern>': the var <x> comes twice with nothing between` | call throws | a var follows itself, as in `<x><x>.md` | [FileMatcher](build-each.md#filematcher) |
| `pattern '<pattern>': the vars <x> and <y> have nothing between them, so a key has no single split` | call throws | two vars follow each other, as in `<x><y>.md` | [FileMatcher](build-each.md#filematcher) |
| `pattern '<pattern>' missing vars to render` | call throws | your code called `expand` with no value for a var of the template | [FileTemplate](#filetemplate) |
| `<class> syntax: <marker name> must be a string, not <type>` | call throws | a marker in `syntax` is not a string. `<type>` is its `typeof` | [Names that hold markers](build-each.md#names-that-hold-markers) |
| `<class> syntax: <marker name> is empty` | call throws | a marker is `""` | [Names that hold markers](build-each.md#names-that-hold-markers) |
| `<class> syntax: <marker name> '<marker>' holds '/', which separates the parts of a path` | call throws | a marker holds a `/` | [Names that hold markers](build-each.md#names-that-hold-markers) |
| `<class> syntax: <marker name> cannot be '<marker>', because it is a part of a path` | call throws | `anyName` or `anyFolders` is `.` or `..` | [Names that hold markers](build-each.md#names-that-hold-markers) |
| `<class> syntax: <marker name> and <marker name> are both '<marker>'` | call throws | two markers are the same | [Names that hold markers](build-each.md#names-that-hold-markers) |
| `<class> syntax: <marker name> '<marker>' holds <marker name> '<marker>', so a pattern has no single parse` | call throws | one marker holds another, as a `varStart` of `<<` holds a `varEnd` of `<`. Only `anyFolders` can hold `anyName`, as `**` holds `*` | [Names that hold markers](build-each.md#names-that-hold-markers) |
| `duplicate output '<artifact id>': claimed by '<id>' and '<id>'` | call throws, or `run()` rejects | two tasks declare one exact output, for example two joined sets that fill a `FileTemplate` with one path | [Layout rules](guide.md#layout-rules) |
| `task '<id>' declares output '<artifact id>' twice` | call throws, or `run()` rejects | the `outputs` of the task hold one exact output two times, for example from two templates in `outputsByName` that give one path | [Build](#build) |
| `task '<id>' is in two groups: '<group>' and '<group>'` | call throws, or `run()` rejects | two groups give a task with one id, for example two joined sets, two `build.each` calls with one `name`, or `build.add` and a `build.each` | [The config](build-each.md#the-config) |
| `group '<group>' gives task '<id>' twice` | call throws, or `run()` rejects | one `tasks()` call, or the list of one group in `setTasksOfGroups`, gives two tasks with one id | [The config](build-each.md#the-config) |
| `task '<id>' produced '<artifact id>', which no output covers` | task fails | `ctx.produced` got an artifact that no output of the task is or covers | [Outputs with unknown names](guide.md#outputs-with-unknown-names) |
| `task '<id>' deleted '<artifact id>', which no output covers` | task fails | `ctx.deleted` got an artifact that no output of the task is or covers | [Outputs with unknown names](guide.md#outputs-with-unknown-names) |
| `dependency of '<id>' failed` | task fails | a producer of an input of the task failed. `<id>` is the waiting task, not the task that failed | [Results and failure](guide.md#results-and-failure) |
| `deadlock waiting for inputs of '<id>'` | task fails | the task is in a cycle of tasks that wait for each other, or it waits for a task in such a cycle | [The order rule](semantics.md#the-order-rule) |
| `not a file: <path>` | task fails | `FileArtifact.stamp()` found a path that is not a regular file, such as a folder or a FIFO | [Files](builtins.md#files) |
| `ENOENT: no such file or directory, open '<path>'` | task fails | `FileArtifact.read()` found no file | [Files](builtins.md#files) |
| `EACCES: permission denied, open '<path>'` | task fails | a hash `stamp()` or a `read()` found a file with no read permission | [Files](builtins.md#files) |
| `EACCES: permission denied, scandir '<path>'` | task fails | `stamp()` or `list()` of a `FilesystemPrefix` found a folder with no read permission. In a scan, `run()` rejects with this error | [Folders](builtins.md#folders), [FileMatcher](build-each.md#filematcher) |
| `ENOTDIR: not a directory, lstat '<path>/'` | task fails | `stamp()` or `list()` of a `FilesystemPrefix` found a file at its path | [Folders](builtins.md#folders) |
| `ENOTDIR: not a directory, stat '<path>'` | task fails | `FileArtifact.stamp()` found a file where its path needs a folder, as in `out.txt/x` | [Files](builtins.md#files) |
| `JSON Parse error: <detail>` | task fails | the `JsonStore` file is not valid JSON, for example an empty file (`Unexpected EOF`). From `store.delete`, the error goes to `result.errors`, and no task fails | [Stores](builtins.md#stores) |
| `Cannot use a closed database` | task fails | the `SqliteStore` is closed. From `store.delete`, the error goes to `result.errors`, and no task fails | [Stores](builtins.md#stores) |
| `missing s3://<bucket>/<key>` | task fails | `S3ObjectArtifact.read()` found no object in a `MemoryS3` | [S3](builtins.md#s3) |
| `S3Client.list must return { key, etag } objects, not <entry as JSON> (<prefix id>)` | task fails | `S3Prefix.stamp()` got an entry with no string `key` or `etag` from the `list` of your `S3Client` | [S3](builtins.md#s3) |
| *the thrown error* | task fails | the `run` of the task, a `stamp()`, `store.get` or `store.set` threw it | [One task](semantics.md#one-task) |
| `send limit: subscribers caused <sendLimit> events in one pass of a drain, and more wait; the last sent was '<kind> <artifact id> by <id>'` | `run()` rejects | subscribers add tasks with no end, for example a subscriber that adds a task with a new output at each `promised` event | [The send limit](semantics.md#the-send-limit) |
| `send limit: <sendLimit> passes in one drain, and more task changes wait; a build.each can feed itself` | `run()` rejects | a `build.each` feeds itself with no end, for example a loop whose task declares its next file as an exact output | [Loops](build-each.md#loops) |
| `matcher '<name>' of build.each <n> sent vars [<var>, …]; its varNames are [<var>, …]` | `run()` rejects | your matcher sent a match whose var names are not exactly its `varNames` | [Checklist](write-a-matcher.md#checklist) |
| `subscriber returned a promise; subscribers must be synchronous` | `run()` rejects | a subscriber returned a promise, for example an `async` function in `build.subscribe` | [Emitter](#emitter) |
| `undefined is not an object (evaluating 'task of config.tasks(vars, matchedByName, outputs)')` | `run()` rejects | `tasks()` returned `undefined` | [The config](build-each.md#the-config) |
| `null is not an object (evaluating 'task of config.tasks(vars, matchedByName, outputs)')` | `run()` rejects | `tasks()` returned `null` | [The config](build-each.md#the-config) |
| `<v> is not iterable` | `run()` rejects | `tasks()` returned a value that is not iterable: `{}` for an object, such as the promise of an `async tasks()` or one `Task`, and `number` for a number | [The config](build-each.md#the-config) |
| `<class> pattern '<pattern>': the var <x> is '<value>'; a var value must be one path part, not empty, '.', '..', or a value with '/'` | `run()` rejects | in `build.each`, a matched var gave an output template such a value. A direct `expand` call throws this error | [A matched var can make an output template reject](limits.md#a-matched-var-can-make-an-output-template-reject) |
| *the thrown error* | `run()` rejects | a subscriber, such as a matcher's `receiveArtifactEvent`, a scan, `tasks()` or the `expand` of an output template threw it | [Fatal errors](semantics.md#fatal-errors) |
| *the thrown error* | `result.errors` | `store.delete` threw it, or a stopped run threw an error whose name is not `AbortError` | [Replacement and removal](semantics.md#replacement-and-removal) |
