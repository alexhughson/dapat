# Blog site example

This example builds a small blog in two languages. It shows two `build.each` calls, a join of two `FileMatcher`s on a shared var, and a task that reads a folder.

Run it from the repo folder:

```sh
bun run examples/blog/blog.ts
bun run examples/blog/blog.ts
```

The first run executes 6 tasks. The second run skips all 6. The build writes `site/` and `.dapat/state.json` into `examples/blog/`. Git ignores both.

Run the e2e test with `bun test examples/blog`.

## Input files

```
content/en/blog/hello.md
content/en/blog/second-post.md
content/en/docs/install.md
content/fr/blog/hello.md
templates/en.html            <html lang="en"><body>{{body}}</body></html>
templates/fr.html            <html lang="fr"><body>{{body}}</body></html>
```

## The tasks

[blog.ts](blog.ts) exports `blogBuild(root)`. It returns a `Build` with two `build.each` calls.

```
blogBuild(root)
├─ build.each  pages
│    matchersByName
│      page:     FileMatcher("content/<lang>/<section>/<slug>.md")
│      template: FileMatcher("templates/<lang>.html")
│    one task for each page, joined to the template of its lang on `lang`
│      page:<lang>/<section>/<slug>
│        inputs:  the page file, the template file
│        outputs: site/<lang>/<section>/<slug>.html
│        run:     puts the page text into the template at {{body}}
└─ build.each  sitemaps
     matchersByName
       template: FileMatcher("templates/<lang>.html")
     one task for each template, so one for each lang
       sitemap:<lang>
         inputs:  FilesystemPrefix("content/<lang>/")
         outputs: site/<lang>/sitemap.xml
         run:     content.list(), keeps each <section>/<slug>.md, writes one <url> for each
```

A page with no template gets no task, because the two matchers join on `lang` and both are required. A template with no pages gets a sitemap with no `<url>`.

## What each edit runs

The e2e test [blog.test.ts](blog.test.ts) copies the input files into a temp folder and makes these edits in order. Each row is a new `Build` on the same folder and store, as a new run of the program is.

| edit | tasks that run |
| --- | --- |
| first build | all 4 pages, `sitemap:en`, `sitemap:fr` |
| no change | none |
| write `content/en/blog/hello.md` with the same bytes | none |
| change `content/en/blog/hello.md` | `page:en/blog/hello`, `sitemap:en` |
| change `templates/en.html` | the 3 en pages |
| add `content/fr/docs/install.md` | `page:fr/docs/install`, `sitemap:fr` |
| delete `content/en/docs/install.md` | `sitemap:en` |
| add `content/es/blog/hola.md`, with no `templates/es.html` | none |
| add `content/en/blog/notes.txt` and `content/en/blog/sub/deep.md` | `sitemap:en`, and it lists neither file |
| add `content/fr/blog/q&a 1.md` | `page:fr/blog/q&a 1`, `sitemap:fr`, with the url `.../fr/blog/q%26a%201.html` |
| add `templates/de.html` | `sitemap:de` |

The file stamp is `"hash"`, the default. Thus a write of the same bytes runs no task.

## Why the sitemap reads `content/`, not `site/`

dapat does not delete files. When you delete `content/en/docs/install.md`, the task `page:en/docs/install` is gone, but `site/en/docs/install.html` stays on disk. A sitemap that listed `site/en/` would still list that page. So the sitemap lists `content/en/` and changes each `<section>/<slug>.md` into the url of its page.

The same rule applies to a deleted template. When you delete `templates/fr.html`, the tasks of all fr pages and `sitemap:fr` are gone. `site/fr/` and its old `sitemap.xml` stay on disk.

The cost: `pageUrl` in `blog.ts` repeats the part of the page pattern under the lang folder, `<section>/<slug>.md`. If you change the page pattern, change `pageUrl` too.

The sitemap also runs for each edit of a page text, and for each new or changed file under `content/en/` that is not a page, because the stamp of `content/en/` changes. It then writes the same bytes. The stamp of a `FilesystemPrefix` includes the hash of each file under it, not only the names.

## One writer for each file

Each html file and each sitemap has one task that writes it. No task reads `site/`. If a task read `site/en/` and also wrote into it, the task would run one more time on the next build with no edits. With `stamp: "time"`, it would run on every build. DOCS section 13 (Limits) shows that case.
