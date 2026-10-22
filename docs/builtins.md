# Built-in artifacts and stores

This page gives the details and edge cases of the artifacts, prefixes and stores that ship with dapat: `FileArtifact`, `FilesystemPrefix`, `IdPrefix`, `S3ObjectArtifact`, `S3Prefix` (with the test client `MemoryS3`), `MemoryStore`, `JsonStore` and `SqliteStore`. `FileMatcher` and `FileGroupMatcher` are in [build.each](build-each.md). Use this page when you choose a class or a stamp mode. Read part 1 of the [guide](guide.md) first, for the terms artifact, stamp, stamp mode, prefix and store.

## Files

`new FileArtifact(path, { stamp })` from `dapat/contrib` is the artifact for one file. The `stamp` option sets the [stamp mode](guide.md#artifacts-and-stamps): `"hash"` (hash mode, the default) or `"time"` (time mode). For any other value, the constructor throws ([error messages](api.md#error-messages)). `read()` returns the bytes as a `Uint8Array`, and it throws `ENOENT` for a missing file.

- The id is `file:` plus the absolute path. The constructor resolves `path` one time, so a later `process.chdir` does not change the id. It also normalizes the path: `new FileArtifact("sub/../dir/")` in `/home/me/project` has the id `file:/home/me/project/dir`, with no `/` at the end.
- After you move the project folder, each `FileArtifact` and `FilesystemPrefix` in it gets a new id. Each [record](guide.md#what-a-build-does) holds the stamps under the old ids, so each task with an input or an output in the folder runs again ([the skip rule](guide.md#the-store-and-the-skip-rule)). In CI, check out the project at the same path ([Run in CI](recipes.md#run-in-ci)).

The table gives `stamp()` for each kind of path. A throw fails the task ([Results and failure](guide.md#results-and-failure), [known issue 3](limits.md#known-issues-in-010)).

| The path is | `stamp()` |
| --- | --- |
| a file | Hash mode: the SHA-256 hash of the bytes, in hex. Time mode: `<mtime in ns>:<size>` |
| a symlink | the stamp of its target |
| missing (the error `ENOENT`) | `null` |
| not a regular file, such as a folder or a FIFO | throws `not a file: <path>` |
| a file with no read permission | Hash mode: throws `EACCES`, unless the process runs as root. Time mode: the time stamp |
| any other error | throws |

## Hash or time

A [hash stamp](guide.md#artifacts-and-stamps) changes only when the bytes change, and hash mode reads every byte. A time stamp changes when the mtime or the size changes, and time mode reads no bytes. So in time mode, a `touch`, a git checkout or a rewrite with the same bytes makes the tasks that read the file run. A time stamp also stays the same when the bytes change but the size and the mtime do not, for example after `cp -p`. Then those tasks skip, and their outputs stay old. Use time mode only for a large file that nothing touches, rewrites with the same bytes, or writes without a new mtime. This program changes the mtime of a file and keeps its bytes:

```ts
import { utimesSync } from "node:fs"
import { FileArtifact } from "dapat/contrib"

await Bun.write("in.txt", "hello")
const hash = new FileArtifact("in.txt")
const time = new FileArtifact("in.txt", { stamp: "time" })
const hashBefore = await hash.stamp()
const timeBefore = await time.stamp()
utimesSync("in.txt", 1, 1) // a new mtime and the same bytes, as after a touch
console.log(`hash stamp changed: ${(await hash.stamp()) !== hashBefore}`)
console.log(`time stamp changed: ${(await time.stamp()) !== timeBefore}`)
```

<!-- output -->
```text
hash stamp changed: false
time stamp changed: true
```

In one process, dapat keeps the hash of each file, and a later `stamp()` call uses it while the file's `stat` values stay the same. But each `stamp()` call on a file that just changed hashes it again. This stops after a hash that starts more than 2 s after the last change of the file's mtime or ctime. A new process hashes each file again ([time for a large file](limits.md#stamps-and-matchers)).

## Folders

`new FilesystemPrefix(path, { stamp })` from `dapat/contrib` is the [prefix](guide.md#folders-prefixes) for a folder. The `stamp` option sets the mode of each file stamp under the folder ([Hash or time](#hash-or-time)).

| Member | Value or return |
| --- | --- |
| `path` | The argument, resolved against the current folder at construction, with a `/` at the end |
| `id` | `file:` plus `path`, for example `file:/home/me/project/pages/` |
| `stampMode` | `"hash"` (the default) or `"time"` |
| `stamp()` | A `Promise<string>`: the SHA-256 hash, in hex, of the lines `<relative path>=<file stamp>`, sorted and joined with newlines. Each file under the folder, at any depth, gives one line. Its relative path starts at `path` |
| `list()` | A `Promise<string[]>` with the absolute path of each file under the folder, at any depth |

- The stamp is never `null`. A missing folder and an empty folder have the same stamp: the SHA-256 hash of an empty string. So a task that has an input and a folder as its output can skip when it writes nothing in the folder ([layout rules](guide.md#layout-rules)).
- A file at `path` makes `stamp()` and `list()` throw `ENOTDIR` ([error messages](api.md#error-messages)).
- With a store, dapat reads each folder at or under `path` to make the stamp, and in hash mode each file too. If one has no read permission, each task that has the prefix as an input or output fails, unless the process runs as root. For an output, the failure can come after the task ran.
- `list()` returns `[]` for a missing folder. It returns strings, so wrap a path in `new FileArtifact(path)` to [report](guide.md#outputs-with-unknown-names) it. The paths are in file-system order. Sort them before you compare or print them. Only your task code calls `list()`. The build does not.
- `new FilesystemPrefix("out")` does not cover `new FileArtifact("out")`: that id has no `/` at the end. So a task that has the prefix as an input does not wait for the task that writes the file `out`.

| Entry under the folder | What `list()` and `stamp()` do |
| --- | --- |
| a link to a file | add the target file, at the path through the link |
| a link to a folder | walk the folder, at paths through the link |
| a link to a folder that contains the link, such as `path` | do not walk it again |
| a broken link, a link that leads back to itself, a FIFO, a socket or a device | add no file |

A link to a folder outside `path` adds the files of that folder, at paths under `path`. So a task that has the prefix as an input does not wait for the task that writes a real file there.

## IdPrefix

`new IdPrefix(id)` from `dapat` is a [prefix](guide.md#folders-prefixes) with only an id. Its stamp is `null`, so a task that has it as an input or output [never skips](guide.md#the-store-and-the-skip-rule). To let such a task skip, write a `Prefix` subclass that has a `stamp()` ([step 2](write-an-artifact.md#step-2-a-prefix-for-keys-with-unknown-names)).

`new IdPrefix("")` covers every artifact and overlaps every prefix. As an input, it makes its task wait for every other task that has an output. As an output, it makes every other task that has an input wait for its task. So use it as an input for a task that must run last, or as an output for a task that must run first. Two tasks in the same role that each have an input and an output wait for each other. Both fail with `deadlock waiting for inputs of '<id>'` ([error messages](api.md#error-messages)).

## S3

`S3ObjectArtifact` is the artifact for one S3 object. `S3Prefix` is the [prefix](guide.md#folders-prefixes) for the keys in one bucket that start with one string, such as `pages/`. Both come from `dapat/contrib`. Each one calls an [`S3Client`](api.md#s3client), which is the object that you give to its constructor. dapat has no `S3Client` for the AWS SDK, so you write one. `MemoryS3` is an `S3Client` that keeps the objects in memory, for tests. In this program, `pages/b.md` is missing at first, then a `put` writes it:

```ts
import { MemoryS3, S3ObjectArtifact, S3Prefix } from "dapat/contrib"

const s3 = new MemoryS3()
const b = new S3ObjectArtifact(s3, "site", "pages/b.md")
const prefix = new S3Prefix(s3, "site", "pages")
const stamp = await b.stamp()
console.log(b.id, stamp)
const before = await prefix.stamp()
await s3.put("site", "pages/b.md", Buffer.from("B"))
const after = await prefix.stamp()
const changed = before !== after
console.log(prefix.id, "changed:", changed)
```

<!-- output -->
```text
s3://site/pages/b.md null
s3://site/pages/ changed: true
```

- `new S3ObjectArtifact(client, bucket, key)` has the id `s3://<bucket>/<key>`. Its stamp is the `etag`, or `null` for a missing object.
- `new S3Prefix(client, bucket, keyPrefix)` has the id `s3://<bucket>/<keyPrefix>/`. dapat adds no `/` to an empty `keyPrefix`, or to one that ends with `/`. Its stamp is the SHA-256 hash of the sorted lines `<key>=<etag>`, from one `client.list` call. The stamp is never `null`.
- `S3Prefix` has no `list()` method. To get the keys, a task calls `client.list(bucket, "pages/")` itself, with the `/` at the end.

`S3Client` and `MemoryS3` have no delete method, so a task deletes an object with your S3 library. Your client must do these things:

| Method | Called by | Your method must |
| --- | --- | --- |
| `head(bucket, key)` | `S3ObjectArtifact.stamp()` | return `{ lastModified, etag }`. dapat reads only `etag`. For a missing object, return `null` and do not throw |
| `get(bucket, key)` | `S3ObjectArtifact.read()` | return the bytes as a `Uint8Array` |
| `list(bucket, prefix)` | `S3Prefix.stamp()` | return `{ key, etag }`, with the full key, for each key that starts with `prefix`. Follow every page of list results. With only the first page, a change to a later key does not change the stamp. Another shape makes `stamp()` throw ([error messages](api.md#error-messages)) |
| `put(bucket, key, body)` | no dapat code | return `{ lastModified, etag }`. The type requires `put`, but dapat never calls it |

`MemoryS3` sets the etag to the SHA-256 hash of the body, in hex. Its `put` keeps the array that you give it, and its `get` returns that array, not a copy. A change to the array changes the object but not its etag. Copy the array before you change it.

## Stores

A [store](guide.md#what-a-build-does) keeps the record of each task between builds. dapat has three stores:

| Store | It keeps the records in | Use it for |
| --- | --- | --- |
| `MemoryStore` from `dapat` | a `Map` in this process | tests, and several builds in one process |
| `JsonStore(path)` from `dapat/contrib` | one JSON file: `{"tasks":{"<task id>":<record>}}` | builds with fewer than a thousand tasks |
| `SqliteStore(db)` from `dapat/contrib` | the SQLite table `dapat_task_state (task_id TEXT PRIMARY KEY, payload TEXT NOT NULL)` | builds with a thousand tasks or more ([Scale](limits.md#scale)) |

Each store has the four methods of [`Store`](api.md#store): `get`, `set`, `delete` and `clear`. When a build does not add a task, its record stays in the store. `store.clear()` removes all records ([layout rules](guide.md#layout-rules), [Force a rerun](recipes.md#force-a-rerun)). To write your own store, see [The store](write-an-artifact.md#the-store).

`MemoryStore` keeps the object that `set` gets, with no copy. `get` returns that object, so do not change it.

`JsonStore`:
- `get` reads the whole file. `set` and `delete` read it and write it again. So each call takes longer as the store gets more records.
- Each write goes to a temporary file in the same folder. A rename then replaces the store file. So when the process stops during a write, the store file keeps its last complete content.
- A missing file is a store with no records. The first write makes the file and its parent folders.
- Use one `JsonStore` object for each file. Two objects or two processes that write one file at the same time can lose records. The task of a lost record runs again on the next build.
- The store resolves a relative path at each call, not at construction. So after a `process.chdir`, it reads and writes a different file. Give an absolute path, for example `new JsonStore(resolve(".dapat/state.json"))` with `resolve` from `node:path`.
- An empty file (for example, after `touch`) or a file that is not valid JSON makes `get`, `set` and `delete` throw `JSON Parse error: …` ([error messages](api.md#error-messages)). The build calls no `get` for a task with no inputs or an `IdPrefix` input ([skip checks 1 and 2](guide.md#the-store-and-the-skip-rule)). So that task runs, and then fails at `set`. Each other task fails before it runs. To fix the store, delete the file or call `store.clear()`. Then every task runs on the next build.

`SqliteStore`:
- `db` is a file path, `":memory:"` (no file), or a `Database` from `bun:sqlite`. For a file path, the constructor makes the parent folder and opens the database. So a later `process.chdir` does not change the file, as it does for `JsonStore`.
- Each `get`, `set` or `delete` reads or writes one row. The `payload` column holds the record as JSON.
- `close()` closes the database only when `db` is a string. After that, each `get`, `set` and `delete` throws `Cannot use a closed database`, so each task fails ([error messages](api.md#error-messages)).
