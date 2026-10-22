# API reference

Look up the signature and members of any export of dapat here, or the exact text of an [error message](#error-messages). Read part 1 of the [guide](guide.md) first.

## Imports

Import each export from `"dapat"` or `"dapat/contrib"`. Other paths, such as `dapat/contrib/fs`, fail: Bun gives `Cannot find module 'dapat/contrib/fs'`, and tsc gives error TS2307.

This table lists every export. Use the Extend dapat column to write an [artifact type](write-an-artifact.md), an [output template](build-each.md#output-templates) of your own type, a [store](builtins.md#write-a-store), a [matcher](write-a-matcher.md) or an `S3Client`, or to [subclass `Build`](semantics.md#subclass-build-settasksofgroups).

| From | Kind | Write a build | Extend dapat |
| --- | --- | --- | --- |
| `dapat` | class | [`Build`](#build), [`IdPrefix`](#prefix), [`MemoryStore`](#store), [`Result`](#result), [`Task`](#task) | [`Artifact`](#artifact) (abstract), [`Emitter`](#emitter), [`Matcher`](#matcher) (abstract), [`Prefix`](#prefix) (abstract), [`TaskGroup`](#taskgroup) |
| `dapat` | function, constant | [`isArtifact`](#task), [`isPrefix`](#task), [`SEND_LIMIT`](#build) | – |
| `dapat` | type | [`ArtifactEvent`](#build), [`Context`](#task), [`JoinedVars`](#taskmaterializerconfig), [`MatchedArtifact`](#matcher), [`MatchedByName`](#taskmaterializerconfig), [`Outcome`](#result), [`OutputsByName`](#taskmaterializerconfig), [`Ref`](#task), [`RunArgs`](#taskmaterializerconfig), [`RunConfig`](#taskmaterializerconfig), [`RunReason`](#result), [`TaskInit`](#task), [`TaskMaterializerConfig`](#taskmaterializerconfig), [`TasksConfig`](#taskmaterializerconfig), [`Vars`](#matcher) | [`AnyMatcher`](#matcher), [`ArtifactTemplate`](#artifacttemplate), [`GroupTasks`](#taskgroup), [`MatchedArtifactEvent`](#matcher), [`MatchedData`](#matcher), [`Store`](#store), [`TaskState`](#store) |
| `dapat/contrib` | class | [`FileArtifact`](#fileartifact), [`FileGroupMatcher`](#filegroupmatcher), [`FileMatcher`](#filematcher), [`FilesystemPrefix`](#filesystemprefix), [`FileTemplate`](#filetemplate), [`FolderTemplate`](#filetemplate), [`JsonStore`](#jsonstore), [`MemoryS3`](#memorys3), [`MemoryStore`](#store) (the same class as in `dapat`), [`S3ObjectArtifact`](#s3objectartifact), [`S3Prefix`](#s3prefix), [`SqliteStore`](#sqlitestore) | – |
| `dapat/contrib` | type | [`FilePatternOptions`](#filematcher), [`FilePatternSyntax`](#filematcher), [`FileStampMode`](#fileartifact), [`FileStampOptions`](#fileartifact) | [`S3Client`](#s3client), [`S3Head`](#s3client), [`S3ListEntry`](#s3client) |

## Exports of dapat

### Build

A `Build` holds tasks, runs each task after its producers, and saves a record of each successful run in its store ([What a build does](guide.md#what-a-build-does)). It sends each `ArtifactEvent` below to its subscribers ([Events](guide.md#events)).

<!-- no-run -->
```ts
class Build extends Emitter<ArtifactEvent> {
  constructor(opts?: { store?: Store; sendLimit?: number }) // no store: the build calls no stamp(), and no task skips
  add(task: Task): void // adds the task, or replaces the task with the same id
  remove(id: string): void // removes the task; with a store, starts store.delete(id); an unknown id does nothing; a build.each task comes back only when build.each makes the tasks of its set again
  each<M extends Record<string, AnyMatcher>, const R extends keyof M & string = keyof M & string, O extends Record<string, ArtifactTemplate> = {}>(config: TaskMaterializerConfig<M, R, O>): void
  run(): Promise<Result> // only the first call scans; each call starts the tasks that did not start, waits until no task waits or runs, and resolves with every outcome so far
  subscribe(listener: (event: ArtifactEvent) => void): void // from Emitter; the listener gets only events sent after this call, so call it before the first run() to get them all
  protected setTasksOfGroups(changes: readonly GroupTasks[]): void // gives each group its whole task list (see TaskGroup)
  protected send(event: ArtifactEvent): void // from Emitter; the build calls it for each event of its queue; a call from a subclass skips the queue and the send limit
  protected override rejected(): void // does nothing: the build already failed with the error that send threw
}
type ArtifactEvent =
  | { kind: "promised"; output: Ref; taskId: string }
  | { kind: "produced"; artifact: Artifact; taskId: string }
  | { kind: "deleted"; artifact: Artifact; taskId: string }
  | { kind: "withdrawn"; output: Ref; taskId: string }
const SEND_LIMIT = 10_000 // the default sendLimit
```

- `sendLimit` caps the events that subscribers cause in one [pass](semantics.md#the-event-queue), and the passes in one [drain](semantics.md#the-event-queue) ([The send limit](semantics.md#the-send-limit)). It must be a positive integer, or the constructor throws.
- `add` throws and changes nothing in these cases ([Error messages](#error-messages)):
  - Another task has an [exact output](guide.md#tasks-and-dependencies) of the task.
  - The task declares one exact output two times.
  - `build.each` or `setTasksOfGroups` already gave a task with this id.
- After the first `run()` starts its tasks, `add` starts the task immediately, unless the build has a fatal error. Before that, the task waits, with one exception ([The order rule](semantics.md#the-order-rule)).
- [`each`](build-each.md) makes tasks for each [joined set](guide.md#buildeach) of matches. It throws after the first `run()` starts, or for a bad config ([Error messages](#error-messages)).
- A task that `remove` takes from a joined set comes back only when `build.each` makes the tasks of that set again ([build.each internals](semantics.md#buildeach-internals)).
- `run()` rejects with the first [fatal error](semantics.md#fatal-errors). [build.run()](semantics.md#buildrun) gives the order of its calls and events.

### Task

A `Task` has an id, inputs, outputs and a `run` function that gets `ctx`, a `Context` ([Tasks and dependencies](guide.md#tasks-and-dependencies), [Outputs with unknown names](guide.md#outputs-with-unknown-names)). [Replacement and removal](semantics.md#replacement-and-removal) tells what `ctx` does in a stopped run. After `run` returns, `ctx.produced` and `ctx.deleted` still send events ([known issue 2](limits.md#known-issues-in-010)). Each input and output must be an instance of a subclass of `Artifact` or `Prefix`, not a plain object ([known issue 4](limits.md#known-issues-in-010)).

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
  readonly signal: AbortSignal // aborts with an AbortError when the build replaces or removes the task, or on a fatal error
  produced(artifact: Artifact): void // sends a produced event; throws when no output covers the artifact
  deleted(artifact: Artifact): void // sends a deleted event; throws when no output covers the artifact
}
```

### Artifact

Extend `Artifact` for one value that a task reads or writes ([artifacts](guide.md#what-a-build-does), [Write an artifact type](write-an-artifact.md)). [One task](semantics.md#one-task) gives the order of the calls.

<!-- no-run -->
```ts
abstract class Artifact<T = unknown> {
  abstract readonly id: string // the build finds the producers of an input by this string
  abstract stamp(): Promise<string | null> // null: missing; compared with ===; a throw fails the task
  abstract read(): Promise<T> // your task code calls it; the build never does
}
```

### Prefix

Extend `Prefix` for a group of artifacts, usually the artifacts whose ids start with one id, such as the files in one folder ([Folders: prefixes](guide.md#folders-prefixes), [walkthrough](write-an-artifact.md#step-2-a-prefix-for-keys-with-unknown-names)). [How the build uses your classes](write-an-artifact.md#how-the-build-uses-your-classes) tells which `covers` and `overlaps` the build calls, and that they must not throw. [`IdPrefix`](builtins.md#idprefix) has only an id.

<!-- no-run -->
```ts
abstract class Prefix {
  abstract readonly id: string
  stamp(): Promise<string | null> // default: null, so no task that has the prefix skips
  covers(artifact: Artifact): boolean // default: artifact.id starts with this.id; an override costs more, as an input and as an output
  overlaps(other: Prefix): boolean // default: one id starts with the other; an override costs more as an input
}
class IdPrefix extends Prefix { constructor(readonly id: string) } // keeps the null stamp
```

### Store

A [store](guide.md#what-a-build-does) keeps one record, a `TaskState`, for each task id ([Stores](builtins.md#stores), [Write a store](builtins.md#write-a-store)).

<!-- no-run -->
```ts
interface TaskState { inputStamps: Record<string, string | null>; outputStamps: Record<string, string | null> } // each key is "artifact <id>" or "prefix <id>"; a prefix with a null stamp has no key
interface Store {
  get(taskId: string): Promise<TaskState | null>
  set(taskId: string, state: TaskState): Promise<void>
  delete(taskId: string): Promise<void>
  clear(): Promise<void>
}
class MemoryStore implements Store { constructor() } // a Map in this process
```

### Result

`build.run()` resolves with a `Result` ([Results and failure](guide.md#results-and-failure)). Its fields also hold the outcomes and errors of earlier `run()` calls. A `RunReason` is the [reason](guide.md#the-store-and-the-skip-rule) why a task ran: the first skip check that failed ([exact order](semantics.md#the-skip-check)). Its `id` is the id of that input or output, not its record key.

<!-- no-run -->
```ts
type RunReason = // why an executed task ran; the kinds go in the order of the checks
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
  subscribe(listener: (event: E) => void): void // there is no unsubscribe; a subscriber added during a send gets the next event
  protected send(event: E): void // a subscriber that throws stops the send, and the caller gets the error
  protected rejected(reason: unknown): void // default: throws reason again
}
```

### Matcher

Extend `Matcher` to find artifacts for [`build.each`](guide.md#buildeach) ([Write a matcher](write-a-matcher.md#what-you-write)). `D` is the data of each match.

<!-- no-run -->
```ts
type Vars = Readonly<Record<string, string>> // the values of one match by var name; tsc does not check the var names
type MatchedData = Artifact | readonly Artifact[]
type MatchedArtifact<D extends MatchedData = MatchedData> = { vars: Vars; data: D } // one match
type MatchedArtifactEvent<D extends MatchedData = MatchedData> =
  | { kind: "found"; matched: MatchedArtifact<D> } // a new match, or new data for known vars
  | { kind: "gone"; vars: Vars }
abstract class Matcher<D extends MatchedData = MatchedData> extends Emitter<MatchedArtifactEvent<D>> {
  abstract readonly varNames: readonly string[] // the vars of each event that it sends have exactly these names, else run() rejects; build.each reads it when you call build.each
  abstract scan(signal: AbortSignal): Promise<void> // the first run() calls it; signal aborts on a fatal error; a throw makes run() reject
  receiveArtifactEvent(event: ArtifactEvent): void // gets each ArtifactEvent of the build; default: does nothing; a throw makes run() reject
  subscribe(listener: (event: MatchedArtifactEvent<D>) => void): void // from Emitter; for example, to log each event
  protected send(event: MatchedArtifactEvent<D>): void // from Emitter: sends one event
}
type AnyMatcher = Matcher<any> // tsc does not accept a Matcher<FileArtifact> as a Matcher<MatchedData>
```

### TaskMaterializerConfig

`TaskMaterializerConfig` is the type of the `build.each` config ([The config](build-each.md#the-config), [the one-task form](build-each.md#the-one-task-form), [output templates](build-each.md#output-templates)). tsc rejects a config with both `tasks` and `run`, with neither, or with `run` and no `name`.

<!-- no-run -->
```ts
type TaskMaterializerConfig<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string, O extends Record<string, ArtifactTemplate> = {}> =
  TasksConfig<M, R, O> | RunConfig<M, R, O> // build.each throws for both, for neither, and for run with no name
type TasksConfig<M extends Record<string, AnyMatcher>, R extends keyof M & string, O extends Record<string, ArtifactTemplate>> = {
  matchersByName: M
  required?: readonly R[] // left out: every matcher is required
  outputsByName?: O // output templates by name
  tasks: (vars: JoinedVars<M, R>, matched: MatchedByName<M, R>, outputs: OutputsByName<O>) => Iterable<Task> // called for each new or changed joined set; can return no task
  name?: never
  run?: never
}
type RunConfig<M extends Record<string, AnyMatcher>, R extends keyof M & string, O extends Record<string, ArtifactTemplate>> = { // one task for each set
  matchersByName: M
  required?: readonly R[]
  outputsByName?: O
  name: string // the start of each task id
  run: (args: RunArgs<M, R, O>) => Promise<void>
  tasks?: never
}
type RunArgs<M extends Record<string, AnyMatcher>, R extends keyof M & string, O extends Record<string, ArtifactTemplate>> = {
  vars: JoinedVars<M, R>
  matched: MatchedByName<M, R>
  outputs: OutputsByName<O>
  ctx: Context
}
type JoinedVars<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string> // Vars when R names every matcher; else Readonly<Record<string, string | undefined>>
type MatchedByName<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string> // readonly; for each name, a MatchedArtifact with the data type of that matcher (FileArtifact for a FileMatcher); | undefined for a name not in R
type OutputsByName<O extends Record<string, ArtifactTemplate>> // readonly; for each name, the type that its template gives, such as FileArtifact for a FileTemplate
```

### ArtifactTemplate

Write an `ArtifactTemplate` for an output of your own artifact type in `outputsByName` ([Output templates](build-each.md#output-templates)).

<!-- no-run -->
```ts
interface ArtifactTemplate<R extends Ref = Ref> {
  readonly varNames: readonly string[] // build.each calls expand only for a set with a value for each name
  expand(vars: Vars): R // build.each calls it with every var of the joined set, not only varNames, and does not check the values; a throw makes run() reject
}
```

### TaskGroup

A `TaskGroup` names one [task group](semantics.md#subclass-build-settasksofgroups) for `setTasksOfGroups` in a subclass of `Build`.

<!-- no-run -->
```ts
class TaskGroup { constructor(readonly label: string) } // each object is one group; the label shows only in error messages
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
  readonly path: string // p, resolved at construction, with no "/" at the end
  readonly id: string // "file:" + path
  readonly stampMode: FileStampMode
  stamp(): Promise<string | null> // null for a missing file; throws `not a file: <path>` for a folder or a FIFO; throws ENOTDIR for a path through a file, such as out.txt/x
  read(): Promise<Uint8Array> // for a missing file, it throws ENOENT
}
```

### FilesystemPrefix

`new FilesystemPrefix(p, opts)` is the [prefix](guide.md#folders-prefixes) for a folder ([Folders](builtins.md#folders)).

<!-- no-run -->
```ts
class FilesystemPrefix extends Prefix {
  constructor(p: string, opts?: FileStampOptions)
  readonly path: string // p, resolved at construction, with a "/" at the end
  readonly id: string // "file:" + path
  readonly stampMode: FileStampMode
  stamp(): Promise<string | null> // never null; throws ENOTDIR when p is a file
  list(): Promise<string[]> // the absolute path of each file at any depth, not sorted; [] for a missing folder; throws ENOTDIR when p is a file; the build never calls it
}
```

### FileMatcher

`new FileMatcher(pattern, opts)` makes one match for each file that fits a pattern such as `content/<lang>/<slug>.md` ([FileMatcher](build-each.md#filematcher)). A file gets its match when the scan finds it, a task reports it, or a task declares it as an exact output ([Matches during the run](build-each.md#matches-during-the-run)). The data of a match is a `FileArtifact` with the stamp mode of the matcher. `syntax` sets other pattern markers ([Names that hold markers](build-each.md#names-that-hold-markers)).

<!-- no-run -->
```ts
interface FilePatternSyntax { varStart?: string; varEnd?: string; anyName?: string; anyFolders?: string } // defaults "<", ">", "*", "**"
interface FilePatternOptions extends FileStampOptions { syntax?: FilePatternSyntax }
class FileMatcher extends Matcher<FileArtifact> {
  constructor(pattern: string, opts?: FilePatternOptions) // throws for a bad pattern, syntax or stamp; see Error messages
  readonly pattern: string // the pattern after path.posix.normalize
  readonly root: string // the current folder at construction, or "/" for an absolute pattern
  readonly varNames: readonly string[] // each var one time, in the order of the pattern
  scan(signal: AbortSignal): Promise<void> // sends found for each file that fits
  receiveArtifactEvent(event: ArtifactEvent): void // promised or produced of a FileArtifact that fits makes a match; deleted or withdrawn ends it, unless the file is still on disk or a task still declares it
}
```

### FileGroupMatcher

`new FileGroupMatcher(pattern, opts)` takes a pattern with a `*` or `**` (the `anyName` or `anyFolders` of its syntax), such as `content/<lang>/**/*.md`. It makes one match for each value of its vars. The data is the list of the files that fit, sorted by path ([FileGroupMatcher](build-each.md#filegroupmatcher)).

<!-- no-run -->
```ts
class FileGroupMatcher extends Matcher<readonly FileArtifact[]> {
  constructor(pattern: string, opts?: FilePatternOptions) // throws for a bad pattern, syntax or stamp, for a pattern with no * or **, and for a var at or after the first * or **; see Error messages
  readonly pattern: string // the pattern after path.posix.normalize
  readonly root: string // the current folder at construction, or "/" for an absolute pattern
  readonly varNames: readonly string[] // each var one time, in the order of the pattern
  scan(signal: AbortSignal): Promise<void> // sends one found for each group after the whole scan
  receiveArtifactEvent(event: ArtifactEvent): void // the FileMatcher rules for each file; sends the new list of the group, or gone when the list is empty
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
  expand(vars: Vars): FileArtifact // throws for a var value that is empty, ".", ".." or holds "/", for a missing var, and for a bad stamp
}
class FolderTemplate implements ArtifactTemplate<FilesystemPrefix> {
  constructor(pattern: string, opts?: FilePatternOptions) // as FileTemplate
  readonly pattern: string // the pattern after path.posix.normalize
  readonly varNames: readonly string[] // each var one time, in the order of the pattern
  expand(vars: Vars): FilesystemPrefix // throws as FileTemplate.expand does
}
```

### JsonStore

`new JsonStore(path)` is a [Store](#store) that keeps all records in one JSON file ([Stores](builtins.md#stores)).

<!-- no-run -->
```ts
class JsonStore implements Store { constructor(readonly path: string) } // each call resolves path against the current folder
```

### SqliteStore

`new SqliteStore(db)` is a [Store](#store) that keeps each record in one row of the SQLite table `dapat_task_state` ([Stores](builtins.md#stores)).

<!-- no-run -->
```ts
class SqliteStore implements Store {
  constructor(db: Database | string) // a Database from bun:sqlite, a file path, or ":memory:"
  close(): void // closes the database only when db is a string
}
```

### S3Client

An `S3Client` is the object that `S3ObjectArtifact` and `S3Prefix` call to reach S3. Write one for your S3 library, or use [`MemoryS3`](#memorys3). [S3](builtins.md#s3) gives the rules for each method.

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
```

### S3ObjectArtifact

`new S3ObjectArtifact(client, bucket, key)` is the artifact for one S3 object ([S3](builtins.md#s3)).

<!-- no-run -->
```ts
class S3ObjectArtifact extends Artifact<Uint8Array> {
  constructor(readonly client: S3Client, readonly bucket: string, readonly key: string)
  readonly id: string // "s3://" + bucket + "/" + key
  stamp(): Promise<string | null> // the etag that client.head gives; null for a missing object
  read(): Promise<Uint8Array> // client.get(bucket, key)
}
```

### S3Prefix

`new S3Prefix(client, bucket, keyPrefix)` is the [prefix](guide.md#folders-prefixes) for the keys of one bucket under `keyPrefix` ([S3](builtins.md#s3)).

<!-- no-run -->
```ts
class S3Prefix extends Prefix {
  constructor(readonly client: S3Client, readonly bucket: string, readonly keyPrefix: string)
  readonly id: string // "s3://<bucket>/<keyPrefix>/"; the constructor adds no "/" to "" or to a keyPrefix that ends with "/"
  stamp(): Promise<string | null> // never null; one client.list call, with the id after "s3://<bucket>/" as the prefix; throws for an entry that is not a { key, etag } object
}
```

### MemoryS3

`new MemoryS3()` is an `S3Client` that keeps the objects in a `Map` in this process, for tests ([S3](builtins.md#s3)).

<!-- no-run -->
```ts
class MemoryS3 implements S3Client {
  head(bucket: string, key: string): Promise<S3Head | null> // null for a missing key
  get(bucket: string, key: string): Promise<Uint8Array> // the array that put got, not a copy; throws `missing s3://<bucket>/<key>`
  put(bucket: string, key: string, body: Uint8Array): Promise<S3Head> // the etag is the SHA-256 hash of body, in hex
  list(bucket: string, prefix: string): Promise<S3ListEntry[]> // sorted by key
}
```

## Error messages

This table gives the exact text of each error message of dapat, and of some messages from Bun. In the messages:

- `<…>` is a value from your build.
- `<class>` is `FileMatcher`, `FileGroupMatcher`, `FileTemplate` or `FolderTemplate`.
- In the pattern messages, `'<'`, `'>'`, `'*'`, `'**'` and `<name>` are the default markers. A [`syntax`](build-each.md#names-that-hold-markers) option puts its own markers there.
- `<group>` is the label of a [task group](semantics.md#subclass-build-settasksofgroups), such as `build.add <id>` or `build.each 1 lang=en`.
- `<n>` is the number of the `build.each` call ([The config](build-each.md#the-config)).

The Where column tells where your code gets the error, and the rows go in the order of this list:

- call throws: the call changes nothing.
- call throws, or `run()` rejects: `build.add`, or `setTasksOfGroups` with no open step, throws and changes nothing. For the tasks that `build.each` gives, or a `setTasksOfGroups` call in an [open step](semantics.md#steps), `run()` rejects.
- task fails: `result.failed` holds the error.
- `run()` rejects: the error is a [fatal error](guide.md#results-and-failure).
- `result.errors`: `result.errors` holds the error, and no task fails.

| Message | Where | Cause | See |
| --- | --- | --- | --- |
| `sendLimit must be a positive integer, not <v>` | call throws | – | [Build](#build) |
| `stamp must be "time" or "hash", not <v>` | call throws | for a `FileTemplate` or `FolderTemplate`, `expand` throws it, so in `build.each`, `run()` rejects | [Hash or time](builtins.md#hash-or-time) |
| `group '<group>' is in one setTasksOfGroups step twice` | call throws | with no open step, a `setTasksOfGroups` call names one `TaskGroup` two times. In an open step there is no error, and the later list wins | [Subclass Build](semantics.md#subclass-build-settasksofgroups) |
| `build.each must come before the first build.run()`<br>`build.each <n> has no matcher; build.each needs at least one matcher`<br>`build.each <n>: '<name>' and '<name>' are one matcher object; give each name its own matcher`<br>`build.each <n>: its matcher '<name>' belongs to another Build; make a new matcher for each Build`<br>`build.each <n> has both tasks and run; give tasks, or name and run`<br>`build.each <n> has no tasks and no run; give tasks, or name and run`<br>`build.each <n>: run needs a name, the start of each task id` | call throws | – | [The config](build-each.md#the-config), [build.each](guide.md#buildeach) |
| `build.each <n>: required is empty; name at least one matcher, or leave required out to require every matcher`<br>`build.each <n>: required names '<name>', which is not a name in matchersByName`<br>`build.each <n>: the required matchers ['<name>', …] share no var name with required matcher '<name>' or its required partners; each required matcher must share a var name with another required matcher, and a matcher that is not required does not connect them`<br>`build.each <n>: the output template '<name>' uses the var '<var>', which no matcher has` | call throws | – | [required](build-each.md#required), [Joins](build-each.md#joins), [Output templates](build-each.md#output-templates) |
| `<class>: the pattern is empty`<br>`<class> pattern '<pattern>' names no file`<br>`<class> pattern '<pattern>': a '..' part is not allowed; for a folder above the working directory, use path.resolve to make the pattern absolute`<br>`<class> pattern '<pattern>': each '<' and '>' must enclose a var name of letters, digits, and '_' that does not start with a digit` | call throws | second message: for example, `.` or `/` | [FileMatcher](build-each.md#filematcher) |
| `<class> pattern '<pattern>': '**' must be a whole part, as in 'a/**/b'`<br>`<class> pattern '<pattern>': the last part must name files, not '**'; use '**/*' for every file`<br>`FileMatcher pattern '<pattern>': '*' and '**' are not allowed; use a var such as <name> for each part that changes, or FileGroupMatcher for one match with a list of files`<br>`<class> pattern '<pattern>': '*' and '**' are not allowed; an output names one path, so use a var such as <name> for each part that changes`<br>`FileGroupMatcher pattern '<pattern>' has no '*' or '**'; use FileMatcher for one match for each file`<br>`FileGroupMatcher pattern '<pattern>': a var must come in a part before the first '*' or '**'; read the other names from the path of each file` | call throws | the first two messages come only from a matcher, and the fourth only from a template. In the third and fourth, `<name>` is part of the text, with the var markers of the syntax | [FileGroupMatcher](build-each.md#filegroupmatcher), [Output templates](build-each.md#output-templates) |
| `pattern '<pattern>': the var <x> comes twice with nothing between`<br>`pattern '<pattern>': the vars <x> and <y> have nothing between them, so a key has no single split` | call throws | `<x>` and `<y>` keep the var markers of the syntax, such as `<slug>`. `<pattern>` has no `.` or empty parts: `a/./<x><y>.md` gives `a/<x><y>.md` | [FileMatcher](build-each.md#filematcher) |
| `pattern '<pattern>' missing vars to render` | call throws | a direct `expand` call got no value for a var of the pattern. `build.each` never calls `expand` so | [Output templates](build-each.md#output-templates) |
| `<class> syntax: <key> must be a string, not <type>`<br>`<class> syntax: <key> is empty`<br>`<class> syntax: <key> '<marker>' holds '/', which separates the parts of a path`<br>`<class> syntax: <key> cannot be '<marker>', because it is a part of a path`<br>`<class> syntax: <key> and <key> are both '<marker>'`<br>`<class> syntax: <key> '<marker>' holds <key> '<marker>', so a pattern has no single parse` | call throws | `<key>` is `varStart`, `varEnd`, `anyName` or `anyFolders`. The constructor checks `syntax` before the pattern | [Names that hold markers](build-each.md#names-that-hold-markers) |
| `duplicate output '<artifact id>': claimed by '<id>' and '<id>'`<br>`task '<id>' declares output '<artifact id>' twice` | call throws, or `run()` rejects | for example, two joined sets fill one `FileTemplate` with one path | [Tasks and dependencies](guide.md#tasks-and-dependencies) |
| `task '<id>' is in two groups: '<group>' and '<group>'`<br>`group '<group>' gives task '<id>' twice` | call throws, or `run()` rejects | for example, two [joined sets](guide.md#buildeach) give one id, also in the one-task form, or `build.add` and a `build.each` do. The second message: one `tasks()` call, or the list of one group in `setTasksOfGroups`, gives two tasks with one id | [The config](build-each.md#the-config), [The one-task form](build-each.md#the-one-task-form) |
| `task '<id>' produced '<artifact id>', which no output covers` | task fails | `ctx.produced` threw it. For `ctx.deleted`, the message says `deleted` | [Outputs with unknown names](guide.md#outputs-with-unknown-names) |
| `dependency of '<id>' failed` | task fails | `<id>` is the waiting task, not the task that failed | [Results and failure](guide.md#results-and-failure), [known issue 5](limits.md#known-issues-in-010) |
| `deadlock waiting for inputs of '<id>'` | task fails | the task is in a cycle of tasks that wait for each other, or it waits for a task in such a cycle | [Tasks and dependencies](guide.md#tasks-and-dependencies) |
| `not a file: <path>` | task fails | a build with a store stamps a `FileArtifact` whose path is not a regular file, such as a folder or a FIFO | [Files](builtins.md#files) |
| `ENOENT: no such file or directory, open '<path>'` | task fails | `FileArtifact.read()` found no file | [Files](builtins.md#files) |
| `EACCES: permission denied, <call> '<path>'` | task fails | `open`: a hash `stamp()` or `read()` found a file with no read permission. `scandir`: a folder `stamp()` or `list()` found a folder with no read permission | [Files](builtins.md#files), [Folders](builtins.md#folders) |
| `ENOTDIR: not a directory, lstat '<path>/'`<br>`ENOTDIR: not a directory, stat '<path>'` | task fails | a build with a store stamps a `FilesystemPrefix` whose path is a file, or a task calls its `list()` (`lstat`). Or a build with a store stamps a `FileArtifact` whose path goes through a file, such as `out.txt/x` (`stat`) | [Folders](builtins.md#folders), [Files](builtins.md#files) |
| `JSON Parse error: <detail>`<br>`Cannot use a closed database` | task fails | the `JsonStore` file is not valid JSON, such as an empty file (`Unexpected EOF`), or the `SqliteStore` is closed. From `store.delete`, it goes to `result.errors`, and no task fails | [Stores](builtins.md#stores) |
| `missing s3://<bucket>/<key>`<br>`S3Client.list must return { key, etag } objects, not <entry as JSON> (<prefix id>)` | task fails | First message: `MemoryS3.get` found no object for the key. Second message: in a build with a store, the `list` of your `S3Client` returned an entry with no string `key` or `etag` | [S3](builtins.md#s3) |
| *the thrown error* | task fails | the `run` of the task, a `stamp()`, `store.get` or `store.set` threw it | [Results and failure](guide.md#results-and-failure) |
| `send limit: subscribers caused <sendLimit> events in one pass of a drain, and more wait; the last sent was '<kind> <id> by <task id>'`<br>`send limit: <sendLimit> passes in one drain, and more task changes wait; a build.each can feed itself` | `run()` rejects | a subscriber or a `build.each` adds tasks with no end | [The send limit](semantics.md#the-send-limit), [Loops](build-each.md#loops) |
| `matcher '<name>' of build.each <n> sent vars [<var>, …]; its varNames are [<var>, …]` | `run()` rejects | – | [Checklist](write-a-matcher.md#checklist) |
| `subscriber returned a promise; subscribers must be synchronous` | `run()` rejects | for example, a subscriber is an `async` function in `build.subscribe` | [Emitter](#emitter) |
| `undefined is not an object (evaluating 'task of config.tasks(vars, matchedByName, outputs)')`<br>`<value> is not iterable` | `run()` rejects | `tasks()` returned no iterable. `undefined` gives the first message, and `null` gives it with `null` at the start. An `async tasks()`, or one `Task` in place of a list, gives `{} is not iterable`. A number gives `number is not iterable` | [The config](build-each.md#the-config) |
| `<class> pattern '<pattern>': the var <x> is '<value>'; a var value must be one path part, not empty, '.', '..', or a value with '/'` | `run()` rejects | the `expand` of a template threw it in `build.each`. A direct `expand` call throws it | [Output templates](build-each.md#output-templates), [known issue 8](limits.md#known-issues-in-010) |
| *the thrown error* | `run()` rejects | a subscriber, a scan, `tasks()`, `receiveArtifactEvent` or the `expand` of an output template threw it, for example `EACCES` on a folder in a scan | [Fatal errors](semantics.md#fatal-errors) |
| *the thrown error* | `result.errors` | `store.delete` threw it, or a [stopped run](semantics.md#replacement-and-removal) threw an error whose name is not `AbortError` | [Replacement and removal](semantics.md#replacement-and-removal) |
