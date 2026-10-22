# API reference

Look up the signature and members of any export of dapat here, or the exact text of an [error message](#error-messages). Read part 1 of the [guide](guide.md) first. [How a build works](semantics.md) gives when the build calls your code, and which errors are fatal.

## Imports

Import each export from `"dapat"` or `"dapat/contrib"`, for example `import { Build, Task } from "dapat"`. Bun and tsc cannot find other paths, such as `dapat/contrib/fs`. Bun gives `Cannot find module 'dapat/contrib/fs'`, and tsc gives error TS2307.

This table lists every export. Use the Extend dapat column when you write an [artifact type](write-an-artifact.md), a [store](write-an-artifact.md#the-store), a [matcher](guide.md#buildeach) ([walkthrough](write-a-matcher.md)) or an `S3Client`. Also use it to [subclass `Build`](semantics.md#subclass-build-settasksofgroups).

| From | Kind | Write a build | Extend dapat |
| --- | --- | --- | --- |
| `dapat` | class | [`Build`](#build), [`IdPrefix`](#prefix), [`MemoryStore`](#store), [`Result`](#result), [`Task`](#task) | [`Artifact`](#artifact) (abstract), [`Emitter`](#emitter), [`Matcher`](#matcher) (abstract), [`Prefix`](#prefix) (abstract), [`TaskGroup`](#build) |
| `dapat` | function, constant | [`isArtifact`](#task), [`isPrefix`](#task), [`SEND_LIMIT`](#build) | – |
| `dapat` | type | [`ArtifactEvent`](#build), [`Context`](#task), [`JoinedVars`](#taskmaterializerconfig), [`MatchedArtifact`](#matcher), [`MatchedByName`](#taskmaterializerconfig), [`Ref`](#task), [`TaskInit`](#task), [`TaskMaterializerConfig`](#taskmaterializerconfig), [`Vars`](#matcher) | [`AnyMatcher`](#matcher), [`GroupTasks`](#build), [`MatchedArtifactEvent`](#matcher), [`MatchedData`](#matcher), [`Outcome`](#result), [`Store`](#store), [`TaskState`](#store) |
| `dapat/contrib` | class | [`FileArtifact`](#fileartifact), [`FileGroupMatcher`](#filegroupmatcher), [`FileMatcher`](#filematcher), [`FilesystemPrefix`](#filesystemprefix), [`JsonStore`](#jsonstore), [`MemoryS3`](#memorys3), [`MemoryStore`](#store) (the same class as in `dapat`), [`S3ObjectArtifact`](#s3objectartifact), [`S3Prefix`](#s3prefix), [`SqliteStore`](#sqlitestore) | – |
| `dapat/contrib` | type | [`FileStampMode`](#fileartifact), [`FileStampOptions`](#fileartifact) | [`S3Client`](#s3client), [`S3Head`](#s3client), [`S3ListEntry`](#s3client) |

`fileId`, `dirId`, `sha256Hex`, `hashLines`, `KeyPattern`, `FileMatchStates` and `TaskMaterializer` are in the source, but neither module exports them. For the id of a file or folder, read the `id` of a `FileArtifact` or `FilesystemPrefix`. For `sha256Hex`, call `Bun.SHA256.hash(text, "hex")`. For `hashLines`, hash the sorted lines joined with `"\n"`. In a [custom matcher](write-a-matcher.md), write your own pattern code.

## Core entries

These are the exports of `"dapat"`. The [Imports](#imports) table links each name to the entry that holds it.

### Build

A `Build` holds tasks, runs each task after its producers, and saves a record of each successful run in its store ([What a build does](guide.md#what-a-build-does)). It is an [`Emitter`](#emitter): it sends each `ArtifactEvent` below to its subscribers ([Events](guide.md#events)).

<!-- no-run -->
```ts
class Build extends Emitter<ArtifactEvent> {
  constructor(opts?: { store?: Store; sendLimit?: number }) // no store: the build calls no stamp(), and no task skips
  add(task: Task): void // adds the task, or replaces the task with the same id
  remove(id: string): void // removes the task, and starts store.delete(id); an unknown id does nothing
  each<M, const R>(config: TaskMaterializerConfig<M, R>): void
  run(): Promise<Result> // only the first call scans; a later call starts only tasks that did not start
  protected setTasksOfGroups(changes: readonly GroupTasks[]): void // gives each group its whole task list (see TaskGroup)
  protected override rejected(): void // does nothing: the build already failed with the error that send threw
}
type ArtifactEvent =
  | { kind: "promised"; output: Ref; taskId: string }
  | { kind: "produced"; artifact: Artifact; taskId: string }
  | { kind: "deleted"; artifact: Artifact; taskId: string }
  | { kind: "withdrawn"; output: Ref; taskId: string }
const SEND_LIMIT = 10_000 // the default sendLimit
```

- `sendLimit` caps the events that subscribers cause in one [pass](semantics.md#terms), and the passes in one drain ([The send limit](semantics.md#the-send-limit)). The constructor throws `sendLimit must be a positive integer, not <v>`.
- `add` throws and changes nothing in these cases:

  | Case | Message |
  | --- | --- |
  | Another task has an exact output of the task | `duplicate output '<artifact id>': claimed by '<a>' and '<b>'` |
  | The task declares one exact output twice | `task '<id>' declares output '<artifact id>' twice` |
  | `build.each` or `setTasksOfGroups` already gave a task with this id | `task '<id>' is in two groups: '<group>' and 'build.add <id>'` |

- After the first `run()` starts, `add` starts the task at once, but not while the scans run ([The order rule](semantics.md#the-order-rule)).
- [`each`](build-each.md) makes tasks for each [joined set](guide.md#buildeach) of matches. After the first `run()` starts, it throws `build.each must come before the first build.run()`. A bad config also throws ([Error messages](#error-messages)).
- `run()` rejects with the first [fatal error](semantics.md#fatal-errors). [build.run()](semantics.md#buildrun) gives the order of its calls and events.

### TaskGroup

A `TaskGroup` names one [task group](semantics.md#subclass-build-settasksofgroups) for `setTasksOfGroups` in a subclass of `Build`. Outside an [open step](semantics.md#terms), `setTasksOfGroups` throws and changes nothing when the call has one group twice, a group gives one id twice, one id is in two groups, or one exact output has two declarations ([Error messages](#error-messages)).

<!-- no-run -->
```ts
class TaskGroup { constructor(readonly label: string) } // each object is one group; the label shows only in error messages
type GroupTasks = { group: TaskGroup; tasks: readonly Task[] } // one group and its whole new task list
```

### Task

A `Task` has an id, inputs, outputs and a `run` function ([Tasks and dependencies](guide.md#tasks-and-dependencies)). `run` gets [`ctx`](guide.md#outputs-with-unknown-names), a `Context`. In a [stopped run](semantics.md#terms), `ctx.signal` aborts, and `ctx.produced` and `ctx.deleted` do nothing. But `ctx.add` and `ctx.remove` still act, and `ctx.produced` still acts after `run` returns. `TaskInit` takes only mutable arrays ([Known issues](limits.md#known-issues-in-010)).

<!-- no-run -->
```ts
type Ref = Artifact | Prefix // an input or an output
function isArtifact(ref: Ref): ref is Artifact // ref instanceof Artifact
function isPrefix(ref: Ref): ref is Prefix // ref instanceof Prefix
interface TaskInit { id: string; inputs?: Ref[]; outputs?: Ref[]; run: (ctx: Context) => Promise<void> }
class Task {
  constructor(init: TaskInit) // copies the arrays ([] when missing), and checks nothing
  readonly id: string
  readonly inputs: readonly Ref[]
  readonly outputs: readonly Ref[]
  readonly run: (ctx: Context) => Promise<void>
}
interface Context {
  readonly signal: AbortSignal // aborts with an AbortError, also on a fatal error
  add(task: Task): void // build.add
  remove(id: string): void // build.remove
  produced(artifact: Artifact): void // sends a produced event
  deleted(artifact: Artifact): void // sends a deleted event
}
```

- `ctx.produced` throws `task '<id>' produced '<artifact id>', which no output covers`. For `ctx.deleted`, the message says `deleted`.

### Artifact

Extend `Artifact` for one value that a task reads or writes ([Write an artifact type](write-an-artifact.md)). [How the build uses your classes](write-an-artifact.md#how-the-build-uses-your-classes) gives the order of the calls.

<!-- no-run -->
```ts
abstract class Artifact<T = unknown> {
  abstract readonly id: string // the build finds the producers of an input by this string
  abstract stamp(): Promise<string | null> // null: missing; compared with ===; a throw fails the task
  abstract read(): Promise<T> // your task code calls it; the build never does
}
```

### Prefix

Extend `Prefix` for the artifacts whose ids start with one id, such as the files in one folder ([Folders: prefixes](guide.md#folders-prefixes), [walkthrough](write-an-artifact.md#step-2-a-prefix-for-keys-with-unknown-names)). [What you write](write-an-artifact.md#what-you-write) tells which `covers` and `overlaps` the build calls. [`IdPrefix`](builtins.md#idprefix) is a `Prefix` that has only an id.

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

A `Store` keeps one record, a `TaskState`, for each task id ([Stores](builtins.md#stores), [the store contract](write-an-artifact.md#the-store)).

<!-- no-run -->
```ts
interface TaskState { inputStamps: Record<string, string | null>; outputStamps: Record<string, string | null> }
interface Store {
  get(taskId: string): Promise<TaskState | null>
  set(taskId: string, state: TaskState): Promise<void>
  delete(taskId: string): Promise<void>
  clear(): Promise<void>
}
class MemoryStore implements Store { constructor() } // a Map in this process; also in dapat/contrib
```

### Result

`build.run()` resolves with a `Result` ([Results and failure](guide.md#results-and-failure)). Its fields also hold the outcomes and errors of earlier `run()` calls.

<!-- no-run -->
```ts
type Outcome = { type: "executed" } | { type: "skipped" } | { type: "failed"; error: Error }
  | { type: "cancelled"; reason: "replaced" | "removed" } // the end state of one task
class Result {
  constructor(outcomes: ReadonlyMap<Task, Outcome>, errors: readonly Error[]) // the only member that takes an Outcome
  readonly success: boolean // failed and errors are empty
  readonly executed: readonly Task[] // each list and map is in the order the tasks first finished
  readonly skipped: readonly Task[]
  readonly failed: ReadonlyMap<Task, Error>
  readonly cancelled: readonly Task[] // replaced or removed; the reason is not kept
  readonly errors: readonly Error[] // errors that belong to no task
}
```

### Emitter

An `Emitter` calls its subscribers with each event, one at a time, in the order in which they subscribed. `Build` and `Matcher` extend it. A subscriber must be synchronous. If it returns a promise, `send` throws `subscriber returned a promise; subscribers must be synchronous`, and passes the rejection reason of that promise to `rejected`.

<!-- no-run -->
```ts
class Emitter<E> {
  subscribe(listener: (event: E) => void): void // there is no unsubscribe; a subscriber added during a send gets the next event
  protected send(event: E): void // a subscriber that throws stops the send, and the caller gets the error
  protected rejected(reason: unknown): void // default: throws reason again
}
```

### Matcher

Extend `Matcher` to find artifacts for `build.each` ([Write a matcher](write-a-matcher.md#what-you-write)). `D` is the data of each match.

<!-- no-run -->
```ts
type Vars = Readonly<Record<string, string>> // the values of one match by var name; tsc does not check the var names
type MatchedData = Artifact | readonly Artifact[]
type MatchedArtifact<D extends MatchedData = MatchedData> = { vars: Vars; data: D } // one match
type MatchedArtifactEvent<D extends MatchedData = MatchedData> =
  | { kind: "found"; matched: MatchedArtifact<D> } // a new match, or new data for known vars
  | { kind: "gone"; vars: Vars }
abstract class Matcher<D extends MatchedData = MatchedData> extends Emitter<MatchedArtifactEvent<D>> {
  abstract readonly varNames: readonly string[] // each found and gone has exactly these names, else run() rejects
  abstract scan(signal: AbortSignal): Promise<void> // the first run() calls it; signal aborts on a fatal error
  receiveArtifactEvent(event: ArtifactEvent): void // gets each ArtifactEvent of the build; default: does nothing
}
type AnyMatcher = Matcher<any> // tsc does not accept a Matcher<FileArtifact> as a Matcher<MatchedData>
```

### TaskMaterializerConfig

`TaskMaterializerConfig` is the type of the `build.each` config ([The config](build-each.md#the-config), [optional matchers](build-each.md#required)).

<!-- no-run -->
```ts
type TaskMaterializerConfig<M extends Record<string, AnyMatcher>, R extends keyof M & string = keyof M & string> = {
  matchersByName: M
  required?: readonly R[]
  tasks: (vars: JoinedVars<M, R>, matched: MatchedByName<M, R>) => Iterable<Task>
}
type JoinedVars<M, R> // Vars when every matcher is required; else each var is string | undefined
type MatchedByName<M, R> // the MatchedArtifact of each matcher, by name; undefined for an optional matcher with no match
```

## Contrib entries

These are the exports of `"dapat/contrib"`: the artifacts, prefixes and matchers for files, the stores, and the S3 interfaces and classes. `FileStampMode` and `FileStampOptions` are in [FileArtifact](#fileartifact). `S3Head` and `S3ListEntry` are in [S3Client](#s3client). `MemoryStore` is the same class as in `dapat` ([Store](#store)).

This program prints the ids and stamps of a missing file and folder, a `FileMatcher` pattern, and three `S3Prefix` ids.

```ts
import { FileArtifact, FileMatcher, FilesystemPrefix, MemoryS3, S3Prefix } from "dapat/contrib"

function short(id: string) {
  return id.replace(process.cwd(), ".")
}

const file = new FileArtifact("pages/")
const folder = new FilesystemPrefix("pages")
const fileStamp = await file.stamp()
const folderStamp = await folder.stamp()
console.log(short(file.id), fileStamp)
console.log(short(folder.id), folderStamp === null)

const matcher = new FileMatcher("./content//<lang>/<slug>-<lang>.md")
console.log(matcher.pattern, matcher.varNames)

const s3 = new MemoryS3()
const whole = new S3Prefix(s3, "b", "")
const pages = new S3Prefix(s3, "b", "pages")
const pagesSlash = new S3Prefix(s3, "b", "pages/")
console.log(whole.id, pages.id, pagesSlash.id)
```

<!-- output -->
```text
file:./pages null
file:./pages/ false
content/<lang>/<slug>-<lang>.md [ "lang", "slug" ]
s3://b/ s3://b/pages/ s3://b/pages/
```

### FileArtifact

`new FileArtifact(p, opts)` is the artifact for one file ([Files](builtins.md#files)). The `opts` of `FileArtifact`, `FilesystemPrefix`, `FileMatcher` and `FileGroupMatcher` is a `FileStampOptions`. With no `stamp`, the [stamp mode](guide.md#artifacts-and-stamps) is `"hash"` ([Hash or time](builtins.md#hash-or-time)). For another value, such as `"md5"`, each constructor throws `stamp must be "time" or "hash", not "md5"`.

<!-- no-run -->
```ts
type FileStampMode = "time" | "hash"
interface FileStampOptions { stamp?: FileStampMode }
class FileArtifact extends Artifact<Uint8Array> {
  constructor(p: string, opts?: FileStampOptions)
  readonly path: string // p, resolved at construction, with no "/" at the end
  readonly id: string // "file:" + path
  readonly stampMode: FileStampMode
  stamp(): Promise<string | null> // null for a missing file; throws `not a file: <path>` for a path that is not a regular file
  read(): Promise<Uint8Array> // for a missing file, it throws ENOENT
}
```

### FilesystemPrefix

`new FilesystemPrefix(p, opts)` is the [prefix](guide.md#folders-prefixes) for a folder ([Folders](builtins.md#folders)). It has the `path`, `id` and `stampMode` members of `FileArtifact`, but its `path` ends with a `/`. Its `stamp()` never returns `null`. It also has `list(): Promise<string[]>`, which returns the absolute path of each file at any depth, not sorted. The build never calls `list()`. When `p` is a file, `stamp()` and `list()` throw `ENOTDIR`.

### FileMatcher

`new FileMatcher(pattern, opts)` takes a pattern such as `content/<lang>/<slug>.md` ([FileMatcher](build-each.md#filematcher)). It makes one match for each file that fits the pattern: a file on disk, or a file that a task declares as an output. The data of a match is a `FileArtifact` with the stamp mode of the matcher.

<!-- no-run -->
```ts
class FileMatcher extends Matcher<FileArtifact> {
  constructor(pattern: string, opts?: FileStampOptions) // throws for a bad pattern; see Error messages
  readonly pattern: string // the pattern after path.posix.normalize
  readonly root: string // the current folder at construction, or "/" for an absolute pattern
  readonly varNames: readonly string[] // each var one time, in the order of the pattern
}
```

### FileGroupMatcher

`new FileGroupMatcher(pattern, opts)` takes a pattern with a `*` or `**`, such as `site/<lang>/**/*.html`. It makes one match for each value of its vars. The data is the list of the files that fit, sorted by path ([FileGroupMatcher](build-each.md#filegroupmatcher)). It is a `Matcher<readonly FileArtifact[]>` with the members of `FileMatcher`.

### JsonStore

`new JsonStore(path: string)` is a [Store](#store) that keeps all records in one JSON file ([Stores](builtins.md#stores)). Its `path` member keeps the string that you give. Each `get`, `set`, `delete` and `clear` resolves it against the current folder.

### SqliteStore

`new SqliteStore(db: Database | string)` is a [Store](#store) that keeps each record in one row of the SQLite table `dapat_task_state` ([Stores](builtins.md#stores)). `db` is a `Database` from `bun:sqlite`, a file path, or `":memory:"`. The store also has `close(): void`, which closes the database only when `db` is a string. After that, each method throws `Cannot use a closed database`.

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

`new S3ObjectArtifact(client: S3Client, bucket: string, key: string)` is the artifact for one S3 object ([S3](builtins.md#s3)). It keeps the three arguments as `readonly` members with the same names. Its `id` is `s3://<bucket>/<key>`. `stamp()` returns the `etag` that `client.head` gives, or `null` for a missing object.

### S3Prefix

`new S3Prefix(client: S3Client, bucket: string, keyPrefix: string)` is the [prefix](guide.md#folders-prefixes) for the keys of one bucket under `keyPrefix` ([S3](builtins.md#s3)). It keeps the three arguments as `readonly` members with the same names. Its `id` is `s3://<bucket>/<keyPrefix>/`. dapat adds no `/` to an empty `keyPrefix` or to one that ends with `/`. `stamp()` calls `client.list` one time. The prefix argument is the id after `s3://<bucket>/`, such as `pages/`. It never returns `null`. For an entry that is not a `{ key, etag }` object, it throws `S3Client.list must return { key, etag } objects, not <entry as JSON> (<prefix id>)`. It has no `list()` method.

### MemoryS3

`new MemoryS3()` is an `S3Client` that keeps the objects in a `Map` in this process, for tests ([S3](builtins.md#s3)). `get` throws `missing s3://<bucket>/<key>` for a missing key. `list` returns the entries sorted by key.

## Error messages

This table gives the exact text of each error message of dapat, and of some messages from Bun. Search the page for a fixed part of the text. `<…>` stands for a value from your build, and `<class>` is `FileMatcher` or `FileGroupMatcher`. `<group>` is the label of a [task group](semantics.md#subclass-build-settasksofgroups): `build.add <id>` for a task that `build.add` adds, or the [label](build-each.md#the-config) of a joined set, such as `build.each 1 lang=en`. `<n>` is the number of the `build.each` call ([build.each internals](semantics.md#buildeach-internals)). The Where column tells where your code gets the error, and the rows go in the order of this list:

- call throws: the call changes nothing.
- call throws, or `run()` rejects: `build.add`, `ctx.add`, or `setTasksOfGroups` with no open step throws and changes nothing. For the tasks that `build.each` gives, or a `setTasksOfGroups` call in an [open step](semantics.md#steps), `run()` rejects.
- task fails: `result.failed` holds the error.
- `run()` rejects: the error is a [fatal error](guide.md#results-and-failure).
- `result.errors`: `result.errors` holds the error, and no task fails.

| Message | Where | Cause | See |
| --- | --- | --- | --- |
| `sendLimit must be a positive integer, not <v>` | call throws | – | [Build](#build) |
| `stamp must be "time" or "hash", not <v>` | call throws | `new FileArtifact`, `new FilesystemPrefix`, `new FileMatcher` or `new FileGroupMatcher` got another `stamp` value | [Hash or time](builtins.md#hash-or-time) |
| `duplicate output '<artifact id>': claimed by '<id>' and '<id>'`<br>`task '<id>' declares output '<artifact id>' twice` | call throws, or `run()` rejects | two tasks declare one exact output, or one task lists it twice | [Tasks and dependencies](guide.md#tasks-and-dependencies) |
| `task '<id>' is in two groups: '<group>' and '<group>'`<br>`group '<group>' gives task '<id>' twice` | call throws, or `run()` rejects | for example, two [joined sets](guide.md#buildeach) give one id, or `build.add` and a `build.each` do | [The config](build-each.md#the-config) |
| `group '<group>' is in one setTasksOfGroups step twice` | call throws | a `setTasksOfGroups` call names one `TaskGroup` twice | [Subclass Build](semantics.md#subclass-build-settasksofgroups) |
| `build.each must come before the first build.run()`<br>`build.each <n> has no matcher; build.each needs at least one matcher`<br>`build.each <n>: '<name>' and '<name>' are one matcher object; give each name its own matcher`<br>`build.each <n>: its matcher '<name>' belongs to another Build; make a new matcher for each Build` | call throws | – | [Errors](build-each.md#errors) |
| `build.each <n>: required is empty; name at least one matcher, or leave required out to require every matcher`<br>`build.each <n>: required names '<name>', which is not a name in matchersByName`<br>`build.each <n>: the required matchers ['<name>', …] share no var name with required matcher '<name>' or its required partners; each required matcher must share a var name with another required matcher, and a matcher that is not required does not connect them` | call throws | – | [required](build-each.md#required), [Joins](build-each.md#joins) |
| `<class>: the pattern is empty`<br>`<class> pattern '<pattern>' names no file`<br>`<class> pattern '<pattern>': a '..' part is not allowed; for a folder above the working directory, use path.resolve to make the pattern absolute`<br>`<class> pattern '<pattern>': each '<' and '>' must enclose a var name of letters, digits, and '_' that does not start with a digit` | call throws | for the second message: a pattern such as `.` or `/` names no file | [FileMatcher](build-each.md#filematcher) |
| `<class> pattern '<pattern>': '**' must be a whole part, as in 'a/**/b'`<br>`<class> pattern '<pattern>': the last part must name files, not '**'; use '**/*' for every file`<br>`FileMatcher pattern '<pattern>': '*' and '**' are not allowed; use a <name> var for each part that changes, or FileGroupMatcher for one match with a list of files`<br>`FileGroupMatcher pattern '<pattern>' has no '*' or '**'; use FileMatcher for one match for each file`<br>`FileGroupMatcher pattern '<pattern>': a var must come in a part before the first '*' or '**'; read the other names from the path of each file` | call throws | in the `FileMatcher` message, `<name>` is part of the text | [FileGroupMatcher](build-each.md#filegroupmatcher) |
| `pattern '<pattern>': the var <x> comes twice with nothing between`<br>`pattern '<pattern>': the vars <x> and <y> have nothing between them, so a key has no single split` | call throws | `<x>` and `<y>` are the vars as you wrote them, with their brackets, such as `<slug>`. `<pattern>` is your pattern without its `.` and empty parts, such as `a/<x><y>.md` for `a/./<x><y>.md` | [FileMatcher](build-each.md#filematcher) |
| `task '<id>' produced '<artifact id>', which no output covers` | task fails | `ctx.produced` threw it, and the task's `run` did not catch it. For `ctx.deleted`, the message says `deleted` | [Outputs with unknown names](guide.md#outputs-with-unknown-names) |
| `dependency of '<id>' failed` | task fails | `<id>` is the waiting task, not the task that failed | [Results and failure](guide.md#results-and-failure), [known issue 6](limits.md#known-issues-in-010) |
| `deadlock waiting for inputs of '<id>'` | task fails | the task is in a cycle of tasks that wait for each other, or it waits for a task in such a cycle | [Tasks and dependencies](guide.md#tasks-and-dependencies) |
| `not a file: <path>` | task fails | a build with a store stamps a `FileArtifact` whose path is not a regular file, such as a folder or a FIFO | [Files](builtins.md#files) |
| `ENOENT: no such file or directory, open '<path>'` | task fails | `FileArtifact.read()` found no file | [Files](builtins.md#files) |
| `EACCES: permission denied, <call> '<path>'` | task fails | a hash `stamp()` or `read()` found a file with no read permission (`open`), or a folder `stamp()` or `list()` found a folder with no read permission (`scandir`). A time stamp of a file needs no read permission | [Files](builtins.md#files), [Folders](builtins.md#folders) |
| `ENOTDIR: not a directory, lstat '<path>/'` | task fails | a build with a store stamps a `FilesystemPrefix` whose path is a file, or a task calls its `list()` | [Folders](builtins.md#folders) |
| `JSON Parse error: <detail>`<br>`Cannot use a closed database` | task fails | the `JsonStore` file is not valid JSON, such as an empty file (`Unexpected EOF`), or the `SqliteStore` is closed | [Stores](builtins.md#stores) |
| `missing s3://<bucket>/<key>`<br>`S3Client.list must return { key, etag } objects, not <entry as JSON> (<prefix id>)` | task fails | `MemoryS3.get` found no object for the key, or, in a build with a store, the `list` of your `S3Client` returned an entry with no string `key` or `etag` | [S3](builtins.md#s3) |
| *the thrown error* | task fails | the `run` of the task, a `stamp()`, `store.get` or `store.set` threw it | [Results and failure](guide.md#results-and-failure) |
| `send limit: subscribers caused <sendLimit> events in one pass of a drain, and more wait; the last sent was '<kind> <id> by <task id>'`<br>`send limit: <sendLimit> passes in one drain, and more task changes wait; a build.each can feed itself` | `run()` rejects | a subscriber or a `build.each` feeds itself with no end | [The send limit](semantics.md#the-send-limit), [Loops](build-each.md#loops) |
| `matcher '<name>' of build.each <n> sent vars [<var>, …]; its varNames are [<var>, …]` | `run()` rejects | – | [Checklist](write-a-matcher.md#checklist) |
| `subscriber returned a promise; subscribers must be synchronous` | `run()` rejects | for example, a subscriber is an `async` function in `build.subscribe` | [Emitter](#emitter) |
| `undefined is not an object (evaluating 'task of this.config.tasks(set.vars, matched)')`<br>`<value> is not iterable` | `run()` rejects | `tasks()` returned no iterable. `undefined` gives the first message, and `null` gives it with `null` at the start. An `async tasks()`, or one `Task` in place of a list, gives `{} is not iterable` | [The config](build-each.md#the-config) |
| *the thrown error* | `run()` rejects | a subscriber, a scan, `tasks()` or `receiveArtifactEvent` threw it, for example `EACCES` on a folder in a scan | [Fatal errors](semantics.md#fatal-errors) |
| *the thrown error* | `result.errors` | `store.delete` threw it, or a [stopped run](semantics.md#terms) threw an error whose name is not `AbortError` | [Replacement and removal](semantics.md#replacement-and-removal) |
