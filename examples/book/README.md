# Children's book example

[book.ts](book.ts) makes a picture book from a text: one page for each group of lines, one image for each page, and one HTML file. Each image also gets every image before it as a reference, so the look stays the same from page to page.

The images come from the [OpenRouter image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation), with the model `google/gemini-2.5-flash-image`. **Each image costs money.** So the number to watch is how many images a run draws after an edit, and the script prints it.

```sh
export OPENROUTER_API_KEY=...
bun examples/book/book.ts ~/my-book       # 2 lines on each page
bun examples/book/book.ts ~/my-book 3     # 3 lines on each page
bun examples/book/book.ts                 # prints the usage
```

The first argument is the work folder. It can be anywhere, and the script makes it if it is missing. The script reads `books/` and writes `out/` and `.dapat/` in that folder. The first run copies the sample books (`hamlet`, 9 lines, and `owl`, 4 lines) into `books/`. With 2 lines on each page, that is 5 + 2 pages, so it draws 7 images.

The number of references that a model accepts varies by provider. A long book sends many references with its last pages.

## The tasks

```
chunk:<book>/lines=<n>  books/<book>/text.txt  ->  FilesystemPrefix("out/<book>/pages/")
                        writes 000.txt, 001.txt, ... with n lines each, and calls ctx.produced for each page
image:<book>/<page>     pages/<page>.txt + books/<book>/style.txt + images/000.png ... images/<page - 1>.png
                        ->  images/<page>.png
assemble:<book>         FilesystemPrefix(pages/) + FilesystemPrefix(images/)  ->  out/<book>/book.html
```

The number of lines on each page is in the id of `chunk`. A new number makes a new task id. The new task has no record in the store, so it runs.

On the first run, `pages/` is empty. Each `ctx.produced(page)` makes the page matcher send `found`, and `build.each` adds the image task of that page. So all images are drawn in the same run.

## What an edit costs

These counts start from the sample books, with 2 lines on each page.

| Edit | Images drawn |
| --- | --- |
| first run | 7 |
| no edit | 0 |
| add a line at the end of `hamlet` | 1: the last page gets its second line |
| `touch` every file | 0 |
| change `books/owl/style.txt` | 2, every `owl` image |
| change line 4 of `hamlet` | 4: page 001 and each page after it, because each image reads every image before it |
| run with `3` as the second argument | 5: every page changes |

`chunk` writes every page again on each run. The default stamp is a hash of the bytes, so only the pages with new bytes make their images run again. With `{ stamp: "time" }`, adding one line would draw all 5 `hamlet` images again.
