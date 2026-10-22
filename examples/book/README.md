# Children's book example

[book.ts](book.ts) makes a picture book from the folder of one book. It cuts the text into pages. An LLM writes a plain picture description (a scene) for each page from the plot plan. An image model draws each scene in the style of the book. Image models follow plain descriptions well and conditions badly, so the LLM does all the reasoning, and the image prompt is only the style and the scene. Each image also gets the first 5 images and the 5 images before it as references, so the characters look the same from page to page.

```sh
export OPENROUTER_API_KEY=...
bun examples/book/book.ts ~/hamlet       # 2 lines on each page
bun examples/book/book.ts ~/hamlet 3     # 3 lines on each page
bun examples/book/book.ts                # prints the usage
```

When the folder is missing, the script copies the sample book [samples/hamlet](samples/hamlet) into it. The sample has 9 lines, so with 2 lines on each page it has 5 pages.

## The book folder

| File | You write it | What it does |
| --- | --- | --- |
| `text.txt` | yes | the story; cut into pages of n lines |
| `plan.txt` | yes | the goals of the plot; the LLM reads it for each scene |
| `style.txt` | yes | the look of the images |
| `page<nnn>_notes.txt` | optional | strict notes for one picture, for example `page003_notes.txt` for `pages/003.txt`. The LLM puts them into the scene of that page |
| `scene_prompt.txt` | optional | replaces the default prompt of the scene step; it can use `{{plan}}`, `{{page}}`, `{{notes}}` and `{{previous_scene}}` |
| `image_prompt.txt` | optional | replaces the default prompt of the image step; it can use `{{style}}` and `{{scene}}` |
| `pages/`, `scenes/`, `images/`, `book.html`, `.dapat/` | no | the outputs and the store |

To tune a book, edit `plan.txt` and `style.txt` first. To force one picture, add a notes file for its page. To change how the models are asked, copy a default prompt into a prompt file and edit it. `bun examples/book/book.ts --prompts` prints the defaults.

## Prompts as artifacts

Each prompt is a `PromptArtifact`, a small subclass of `Artifact` in `book.ts`. Its text is the prompt file when the file exists, and the default string in the code when it does not. Its stamp is a hash of that text, and the scene or image tasks list it as an input. So a task runs again only when the text that it sends changes:

| Change | Tasks that run again |
| --- | --- |
| the default in the code, with no prompt file | every task of that step |
| the default in the code, with a prompt file | none |
| add a prompt file with new text, change it, or delete it | every task of that step |
| add a prompt file with the same text as the default | none |

A `{{name}}` that the step has no value for fails the task, with the list of the names.

## The models

Both calls go to OpenRouter. Each call costs money, so the script prints how many calls each run made.

- Scenes: the [chat completions API](https://openrouter.ai/docs/api/reference/overview) with `anthropic/claude-sonnet-5.5` (`TEXT_MODEL`).
- Images: the [image API](https://openrouter.ai/docs/guides/overview/multimodal/image-generation) with `google/gemini-nano-banana-2.1` (`IMAGE_MODEL`). It accepts up to 14 reference images. Each page sends at most 10.

## The tasks

```
chunk/lines=<n>  build.add; text.txt  ->  FilesystemPrefix("pages/")
                 writes 000.txt, 001.txt, ... with n lines each, and calls ctx.produced for each page
scene:<page>     build.each on pages/<page>.txt, with page<page>_notes.txt not required;
                 plan.txt + the page + the notes + scenes/<page - 1>.txt  ->  FileTemplate("scenes/<page>.txt")
image:<page>     build.each on pages/<page>.txt;
                 scenes/<page>.txt + style.txt + images 000-004 + the 5 images before <page>
                 ->  FileTemplate("images/<page>.png")
assemble         build.add; FilesystemPrefix("pages/") + FilesystemPrefix("images/")  ->  book.html
```

There is one LLM call for each page, not one call for the whole book. So a new page at the end makes one scene call. With one call for the whole book, every scene would change, and every image would be drawn again.

The number of lines on each page is in the id of `chunk`. A new number makes a new task id. The new task has no record in the store, so it runs.

## What an edit costs

These counts start from the sample book, with 2 lines on each page. Each scene reads the scene before it, and each image reads the image before it, so a change to page n also changes the pages after it.

| Edit | Scene calls | Image calls |
| --- | --- | --- |
| first run | 5 | 5 |
| no edit, or `touch` every file | 0 | 0 |
| add a line at the end | 1 | 1 |
| change line 4 (page 001) | 4 | 4 |
| change `style.txt` | 0 | 5 |
| change `plan.txt` | 5 | 5 |
| add, change or delete `page002_notes.txt` | 3 | 3: page 002 and the pages after it |

The default stamp is a hash of the bytes. So a file that a task writes again with the same bytes does not make the next task run.
