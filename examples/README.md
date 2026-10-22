# Examples

Read the [README example](../README.md#example) and part 1 of the [guide](../docs/guide.md) first. Read [part 2](../docs/guide.md#buildeach) before the examples that use `build.each`.

| Example | What it shows |
| --- | --- |
| [first-build.ts](first-build.ts) | The tasks `upper` and `wrap` make `out.txt` from `in.txt`, as in the README example. Write `in.txt` first, for example with `printf hello > in.txt`. |
| [file-pipeline.ts](file-pipeline.ts) | A [`build.each`](../docs/guide.md#buildeach) [joins](../docs/build-each.md#joins) each `content/<lang>/<slug>.md` to `templates/<lang>.html`. A second `build.each` uses a [`FileGroupMatcher`](../docs/build-each.md#filegroupmatcher) to write one sitemap for each `<lang>`. |
| [book-chapters.ts](book-chapters.ts) | Split tasks write a folder of chapters and [report](../docs/guide.md#outputs-with-unknown-names) each chapter. A `build.each` makes a summary task for each chapter [during the same run](../docs/build-each.md#matches-during-the-run). A subscriber prints each summary task when the build adds it. |
| [book/](book/README.md) | `book.ts` makes a picture book with paid model calls. It uses a task that reports each page, two `build.each` calls with [output templates](../docs/build-each.md#output-templates), and an [artifact type](../docs/write-an-artifact.md) for its prompts. One `build.each` call has an [optional](../docs/build-each.md#required) matcher for the notes of a page. |

Run a single-file example from an empty folder, because it reads and writes files in the current folder:

```sh
mkdir try && cd try
bun path/to/dapat/examples/file-pipeline.ts
```

`book/README.md` tells how to run `book.ts` and what each edit costs.
