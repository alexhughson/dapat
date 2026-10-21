# Children's book example

This example makes a picture book from a text. It cuts the text into pages, one sentence for each page. Then it draws one image for each page and puts the pages and images into one HTML file.

The image step is a substitute for a paid model call. So the important number is how many images a build draws after an edit. dapat draws an image again only when its page, its style, or the image before it changed, or when its image task is new in the build.

`fake-image.ts` is the substitute for the model. It makes an SVG file whose colour is a hash of the prompt and of the image before. It is deterministic, so the same request gives the same bytes.

## Run it

Run it from an empty folder:

```sh
mkdir /tmp/book && cd /tmp/book
bun run <path to dapat>/examples/book/run.ts
```

The first run copies the sample books from `examples/book/books/` into `books/`. It writes `out/hamlet/book.html` and `out/owl/book.html`, and it prints the image calls. Run it again: it draws no image. Then edit `books/hamlet/text.txt` or `books/hamlet/style.txt` and run it again.

## Files

```
books/<book>/text.txt        the story, as plain text (you write it)
books/<book>/style.txt       the look of the images, for example "soft watercolor" (you write it)
out/<book>/pages/<nnn>.txt   one sentence; written only by chunk:<book>
out/<book>/images/<nnn>.svg  the image of page <nnn>; written by image:<book>/<nnn>
out/<book>/book.html         all pages with their images; written by assemble:<book>
.dapat/state.json            the store: the stamps of the last run
```

## How the tasks connect

`pipeline.addBookTasks(build, root, drawImage)` makes three `build.each` calls. Each path is under `root`.

```
build.each 1  text = FileMatcher("books/<book>/text.txt")
  └─ chunk:<book>
       inputs:  books/<book>/text.txt
       outputs: FilesystemPrefix("out/<book>/pages/")
       run:     writes pages/000.txt, 001.txt, ... and calls ctx.produced(page) for each
                deletes the pages of the last run that the text no longer has, and calls ctx.deleted(page)
                fails when the text has more than 1000 sentences

build.each 2  page  = FileMatcher("out/<book>/pages/<page>.txt")
              style = FileMatcher("books/<book>/style.txt")       joined on <book>
  └─ image:<book>/<page>       (no task when <page> is not three digits)
       inputs:  pages/<page>.txt, books/<book>/style.txt, images/<page - 1>.svg (not for page 000)
       outputs: images/<page>.svg
       run:     drawImage({ prompt: style + page, previous: bytes of images/<page - 1>.svg })

build.each 3  text  = FileMatcher("books/<book>/text.txt")
              style = FileMatcher("books/<book>/style.txt")       joined on <book>
  └─ assemble:<book>
       inputs:  FilesystemPrefix("out/<book>/pages/"), FilesystemPrefix("out/<book>/images/")
       outputs: out/<book>/book.html
       run:     lists the page files, such as 003.txt, and ignores other files in pages/
```

`assemble` does not read the style. The style is in its `build.each` so that a book that never had a style gets no `book.html`. Without a style there are no image tasks, and the book would show links to images that do not exist.

On the first build, the folder `out/<book>/pages/` is empty, so the page matcher finds nothing in its scan. Each `ctx.produced(page)` call in `chunk` sends a `produced` event. The page matcher then sends `found`, and `build.each 2` adds the image task of that page before `ctx.produced` returns. So all images are drawn in the same build.

On a later build, the scan of the page matcher finds the pages of the last run. Each image task then waits for `chunk`, because the output folder of `chunk` covers its page.

Each image task waits for the image task before it, because it reads the image before it. `assemble` waits for `chunk` and for every image task, because its two folder inputs cover their outputs.

## What an edit costs

The test `book.test.ts` measures these counts. The sample has 9 sentences in `hamlet` and 4 in `owl`.

| Edit | Images drawn | Why |
| --- | --- | --- |
| first build | 13 | one for each sentence |
| no edit | 0 | each task skips |
| add a sentence at the end of `hamlet` | 1 | `chunk` writes all 10 pages again, but 9 have the same bytes, so their stamps do not change |
| `touch` every file | 0 | the stamp is a hash of the bytes, and the bytes did not change |
| change `books/hamlet/style.txt` | 9 | every hamlet image reads the style; no owl image |
| change sentence 4 of `hamlet` | 6 | page 003 and each page after it, because each image reads the image before it |
| new line wraps in `hamlet`, with the same words | 0 | `splitIntoPages` makes each line break a space, so `chunk` writes the same pages |
| remove the last sentence of `hamlet` | 0 | `chunk` deletes `pages/008.txt`, so `image:hamlet/008` leaves the build |
| put that sentence back | 1 | `image:hamlet/008` is a new task. When it left the build, dapat deleted its store record |
| put `.DS_Store` or `notes.txt` into `pages/` | 0 | no image task reads the file, because it is not a page name. The folder stamp changes, so `chunk` and `assemble` run one time. `chunk` keeps the file |

The add, touch, wrap, and edit rows need the default `"hash"` stamp. With `{ stamp: "time" }`, the add row costs 10 images, because each page that `chunk` writes again gets a new modification time. The pipeline sets no stamp option.

## Two rules that the layout follows

- **One task writes each folder that a task reads as a folder.** Only `chunk` writes `out/<book>/pages/`. `assemble` writes `book.html` next to `pages/` and `images/`, not in them. If two tasks write into one folder that a task reads, those tasks run again with no edits ([DOCS Limits](../../DOCS.md#13-limits)).
- **A task that writes files with unknown names declares their folder.** `chunk` does not know the page count before it runs. So it declares `out/<book>/pages/` as its output and reports each page with `ctx.produced`.

## Limits of this example

- When a sentence is removed, its old image stays in `out/<book>/images/`. dapat does not delete outputs of tasks that left the build. `assemble` lists the pages, not the images, so the old image does not get into the book.
- When you delete a style later, the old `book.html` and images stay on disk. Their tasks leave the build, and dapat does not delete their outputs.
- The sentence split is simple. `Mr. Smith` gives two pages, `Mr.` and `Smith`.
- A text can have at most 1000 sentences, because page names have three digits.
- The store keys are absolute paths. When you move the folder, every task runs again on the next build.
- A long text builds slowly. One book of 400 sentences takes about 9 to 12 seconds on the first build, and 200 sentences take about 1.5 to 2.5 seconds. A second build with no edit also takes seconds. Most of the time is in the dapat scheduler, not in this example. A children's book of 10 to 30 pages builds in less than a second.
