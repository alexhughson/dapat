# Examples

Each example is one TypeScript program in this folder. Read the [README example](../README.md#example) and part 1 of the [guide](../docs/guide.md) first. Read [part 2](../docs/guide.md#events) before `file-pipeline.ts` and `book-chapters.ts`.

| Example | What it shows |
| --- | --- |
| [first-build.ts](first-build.ts) | The tasks `upper` and `wrap` make `out.txt` from `in.txt`, as in the [README example](../README.md#example). |
| [file-pipeline.ts](file-pipeline.ts) | A [`build.each`](../docs/guide.md#buildeach) [joins](../docs/build-each.md#joins) each `content/<lang>/<slug>.md` to `templates/<lang>.html`. A second `build.each` uses a [`FileGroupMatcher`](../docs/build-each.md#filegroupmatcher) to write one sitemap for each `<lang>` that has `.md` files in `content/<lang>/`. |
| [book-chapters.ts](book-chapters.ts) | Split tasks write a folder of chapters and [report](../docs/guide.md#outputs-with-unknown-names) each chapter. A `build.each` makes a summary task for each chapter [during the same run](../docs/build-each.md#matches-during-the-run). A [subscriber](../docs/guide.md#events) prints each summary task when the build adds it. |

Each example reads and writes files in the current folder. Run it from an empty folder. Give bun the path of the example in your dapat checkout:

```sh
mkdir try && cd try
bun path/to/dapat/examples/file-pipeline.ts
```

- `file-pipeline.ts` and `book-chapters.ts` write their own sample input when `content/` or `books/` is missing. `first-build.ts` writes none, so write `in.txt` first, for example with `printf hello > in.txt`. Without it, both tasks fail, but the example prints only two empty lists and no error.
- Each example prints the `executed` and `skipped` lists in [finish order](../docs/guide.md#results-and-failure), so their order can change between runs.
- Run it again: every task skips. `book-chapters.ts` still prints its `new task` lines, because the new build adds each summary task again and sends its `promised` event ([events](../docs/guide.md#events)).
- tsc rejects `inputs: sources` in `file-pipeline.ts` ([known issue 7](../docs/limits.md#known-issues-in-010)).
