# Children's book example

[book.ts](book.ts) makes a picture book from a text: one page for each sentence, one image for each page, and one HTML file. Each image also reads the image before it, so the look stays the same from page to page.

The image step is a fake for a paid model call. So the number to watch is how many images a build draws after an edit.

```sh
mkdir /tmp/book && cd /tmp/book
bun run <path to dapat>/examples/book/book.ts
```

The first run copies the sample books (`hamlet`, 9 sentences, and `owl`, 4 sentences) into `books/`.

## The tasks

```
chunk:<book>         books/<book>/text.txt  ->  FilesystemPrefix("out/<book>/pages/")
                     writes 000.txt, 001.txt, ... and calls ctx.produced for each page
image:<book>/<page>  pages/<page>.txt + books/<book>/style.txt + images/<page - 1>.svg  ->  images/<page>.svg
assemble:<book>      FilesystemPrefix(pages/) + FilesystemPrefix(images/)  ->  out/<book>/book.html
```

On the first run, `pages/` is empty. Each `ctx.produced(page)` makes the page matcher send `found`, and `build.each` adds the image task of that page. So all images are drawn in the same run.

## What an edit costs

| Edit | Images drawn |
| --- | --- |
| first run | 13 |
| no edit | 0 |
| add a sentence at the end of `hamlet` | 1 |
| `touch` every file | 0 |
| change `books/owl/style.txt` | 4, every `owl` image |
| change sentence 4 of `hamlet` | 6: that image and each image after it |

`chunk` writes every page again on each run. The default stamp is a hash of the bytes, so only the pages with new bytes make their images run again.
