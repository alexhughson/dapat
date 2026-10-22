# Built-in artifacts and stores

This page gives the details and edge cases of the artifacts, prefixes and stores that ship with dapat. `FileMatcher` and `FileGroupMatcher` are in [build.each](build-each.md). Read part 1 of the [guide](guide.md) first.

## Files

`new FileArtifact(path, { stamp })` from `dapat/contrib` is the artifact for one file. The `stamp` option sets the [stamp mode](guide.md#artifacts-and-stamps): `"hash"` (the default) or `"time"`. Any other value makes the constructor throw ([error messages](api.md#error-messages)). `read()` returns the bytes as a `Uint8Array`, and it throws `ENOENT` for a missing file.

- The id is `file:` plus the absolute path. The constructor resolves and normalizes `path` one time, so a later `process.chdir` does not change the id. For example, `new FileArtifact("sub/../dir/")` in `/home/me/project` has the id `file:/home/me/project/dir`.
- After you move the project folder, each `FileArtifact` and `FilesystemPrefix` in it gets a new id, so each task with an input or an output in the folder runs again ([the skip rule](guide.md#the-store-and-the-skip-rule)). In CI, check out the project at the same path ([Run in CI](recipes.md#run-in-ci)).

When `stamp()` throws, the task fails ([known issue 3](limits.md#known-issues-in-010)).

| The path is | `stamp()` |
| --- | --- |
| a file | Hash stamp: the SHA-256 hash of the bytes, in hex. Time stamp: `<mtime in ns>:<size>` |
| a symlink | the stamp of its target |
| missing (the error `ENOENT`) | `null` |
| not a regular file, such as a folder or a FIFO | throws `not a file: <path>` |
| a file with no read permission | With hash stamps: throws `EACCES`, unless the process runs as root. With time stamps: `<mtime in ns>:<size>` |
| any other error | throws |

## Hash or time

With [time stamps](guide.md#artifacts-and-stamps), a `touch`, a git checkout or a rewrite with the same bytes makes the tasks that read the file run. A time stamp also stays the same when the bytes change but the size and the mtime do not. For example, a tool sets the old mtime again (`touch -r`), or two writes of the same size come in one mtime tick. Then those tasks skip, and their outputs are out of date. Use time stamps only for a large file that nothing touches, rewrites with the same bytes, or writes without a new mtime.

With hash stamps, `FileArtifact` and `FilesystemPrefix` share one cache of file hashes in a process, so `stamp()` hashes an unchanged file one time. In the 2 s after a file changes, each `stamp()` call hashes it again ([time for a large file](limits.md#stamps-and-matchers)).

## Folders

`new FilesystemPrefix(path, { stamp })` from `dapat/contrib` is the [prefix](guide.md#folders-prefixes) for a folder. The `stamp` option sets the mode of each file stamp under the folder ([Hash or time](#hash-or-time)).

| Member | Value or return |
| --- | --- |
| `path` | The argument, resolved against the current folder at construction, with a `/` at the end |
| `id` | `file:` plus `path`, for example `file:/home/me/project/pages/` |
| `stamp()` | The SHA-256 hash, in hex, of the lines `<relative path>=<file stamp>`, sorted and joined with newlines. Each file at any depth under `path` gives one line, with its path relative to `path` |
| `list()` | The absolute path of each file under the folder, at any depth |

- The stamp is never `null`. A missing folder and an empty folder have the same stamp: the SHA-256 hash of an empty string. So a task that has an input and a folder output can skip when it writes nothing in the folder ([layout rules](guide.md#layout-rules)).
- A file at `path` makes `stamp()` and `list()` throw `ENOTDIR` ([error messages](api.md#error-messages)).
- With a store, dapat reads each folder at or under `path` to make the stamp, and with hash stamps each file too. If one of them has no read permission, each task that has the prefix as an input or output fails, unless the process runs as root. For an output, the failure can come after the task ran.
- `list()` returns `[]` for a missing folder. Its paths are in file-system order, not sorted. To [report](guide.md#outputs-with-unknown-names) a path, wrap it in `new FileArtifact(path)`. The build never calls `list()`.
- `new FilesystemPrefix("out")` does not cover `new FileArtifact("out")`: that id has no `/` at the end. So a task that has the prefix as an input does not wait for the task that writes the file `out`.

| Entry under the folder | What `list()` and `stamp()` do |
| --- | --- |
| a symlink to a file | add the target file, at the path through the symlink |
| a symlink to a folder | walk the folder, at paths through the symlink |
| a symlink to a folder that contains the symlink, such as `path` | do not walk it again |
| a broken symlink, a symlink that leads back to itself, a FIFO, a socket or a device | add no file |

A task that has the prefix as an input does not wait for a task that writes in a symlinked folder outside `path`, because the real files have other ids.

## IdPrefix

`new IdPrefix(id)` from `dapat` is a [prefix](guide.md#folders-prefixes) with only an id and the stamp `null`, so a task that has it as an input or output [never skips](guide.md#the-store-and-the-skip-rule). To let such a task skip, write a `Prefix` subclass that has a `stamp()` ([step 2](write-an-artifact.md#step-2-a-prefix-for-keys-with-unknown-names)).

`new IdPrefix("")` covers every artifact and overlaps every prefix. Use it as an input for a task that must run last: the task waits for every other task that has an output. Use it as an output for a task that must run first: every other task that has an input waits for it. Two tasks wait for each other when both have it as an input and both have an output, or both have it as an output and both have an input. Both fail with `deadlock waiting for inputs of '<id>'` ([error messages](api.md#error-messages)).

## S3

`S3ObjectArtifact` is the artifact for one S3 object. `S3Prefix` is the [prefix](guide.md#folders-prefixes) for the keys in one bucket that start with one string, such as `pages/`. Both come from `dapat/contrib`. Each one calls the [`S3Client`](api.md#s3client) that you give to its constructor. dapat has no `S3Client` for the AWS SDK, so you write one. `MemoryS3` is an `S3Client` that keeps the objects in memory, for tests. In this program, a `put` writes the missing object `pages/b.md`:

```ts
import { MemoryS3, S3ObjectArtifact, S3Prefix } from "dapat/contrib"

const s3 = new MemoryS3()
const b = new S3ObjectArtifact(s3, "site", "pages/b.md")
const prefix = new S3Prefix(s3, "site", "pages")
const stamp = await b.stamp()
console.log(`${b.id} stamp: ${stamp}`)
const before = await prefix.stamp()
await s3.put("site", "pages/b.md", Buffer.from("B"))
const after = await prefix.stamp()
const changed = before !== after
console.log(`${prefix.id} stamp changed: ${changed}`)
```

<!-- output -->
```text
s3://site/pages/b.md stamp: null
s3://site/pages/ stamp changed: true
```

- `new S3ObjectArtifact(client, bucket, key)` has the id `s3://<bucket>/<key>`. Its stamp is the `etag`, or `null` for a missing object.
- `new S3Prefix(client, bucket, keyPrefix)` has the id `s3://<bucket>/<keyPrefix>/`. dapat adds no `/` to an empty `keyPrefix`, or to one that ends with `/`. Its stamp, never `null`, is the SHA-256 hash of the sorted lines `<key>=<etag>` from one `client.list` call.
- `S3Prefix` has no `list()` method. To get the keys, call `client.list(bucket, "pages/")`, with the `/` at the end.

Your `S3Client` must do these things:

| Method | Called by | Your method must |
| --- | --- | --- |
| `head(bucket, key)` | `S3ObjectArtifact.stamp()` | return `{ lastModified, etag }`. dapat reads only `etag`. For a missing object, return `null` and do not throw |
| `get(bucket, key)` | `S3ObjectArtifact.read()` | return the bytes as a `Uint8Array` |
| `list(bucket, prefix)` | `S3Prefix.stamp()` | return `{ key, etag }`, with the full key, for each key that starts with `prefix`. Follow every page of list results, or a change to a later key does not change the stamp. Another shape makes `stamp()` throw ([error messages](api.md#error-messages)) |
| `put(bucket, key, body)` | no dapat code | return `{ lastModified, etag }`. The type requires `put` |

`S3Client` and `MemoryS3` have no delete method, so a task deletes an object with your S3 library.

`MemoryS3` sets the etag at `put`, to the SHA-256 hash of the bytes. It keeps that array, and `get` returns it, not a copy. So a change to the array changes the object but not its etag. Copy the array before you change it.

## Stores

dapat has three [stores](guide.md#what-a-build-does):

| Store | It keeps the records in | Use it for |
| --- | --- | --- |
| `MemoryStore` from `dapat` | a `Map` in this process | tests, and several builds in one process |
| `JsonStore(path)` from `dapat/contrib` | one JSON file: `{"tasks":{"<task id>":<record>}}` | builds with fewer than a thousand tasks |
| `SqliteStore(db)` from `dapat/contrib` | the SQLite table `dapat_task_state (task_id TEXT PRIMARY KEY, payload TEXT NOT NULL)` | builds with a thousand tasks or more ([Scale](limits.md#scale)) |

Each store has the four methods of [`Store`](api.md#store): `get`, `set`, `delete` and `clear`. `store.clear()` removes all records, also those of tasks that a build no longer adds ([Force a rerun](recipes.md#force-a-rerun)). To write your own store, see [The store](write-an-artifact.md#the-store).

`MemoryStore` keeps the object that `set` gets, and `get` returns it, with no copy. Do not change it.

`JsonStore`:
- `get` reads the whole file, and `set` and `delete` also write it again. So each call takes longer as the store gets more records.
- Each write goes to a temporary file in the same folder, then a rename replaces the store file. So when the process stops during a write, the store file keeps its last complete content.
- A missing file is a store with no records. The first write makes the file and its parent folders.
- Use one `JsonStore` object for each file. Two objects or two processes that write one file at the same time can lose records. The task of a lost record runs again on the next build.
- The store resolves a relative path at each call, not at construction, so a `process.chdir` makes it use a different file. If your program calls `process.chdir`, give an absolute path, such as `new JsonStore(resolve(".dapat/state.json"))` with `resolve` from `node:path`.
- An empty file or a file that is not valid JSON makes `get`, `set` and `delete` throw `JSON Parse error: …` ([error messages](api.md#error-messages)). A task with no inputs or an `IdPrefix` input runs, then fails at `set` ([skip checks 1 and 2](guide.md#the-store-and-the-skip-rule)). Each other task fails before it runs. To fix the store, delete the file or call `store.clear()`.

`SqliteStore`:
- `db` is a file path, `":memory:"` (no file), or a `Database` from `bun:sqlite`. For a file path, the constructor makes the parent folder and opens the database. So a later `process.chdir` does not change the file.
- Each `get`, `set` or `delete` reads or writes one row, with the record as JSON in `payload`.
- `close()` closes the database only when `db` is a string. After that, each `get`, `set` and `delete` throws `Cannot use a closed database`, so each task fails ([error messages](api.md#error-messages)).
