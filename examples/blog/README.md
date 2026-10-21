# Blog site example

[blog.ts](blog.ts) builds a blog in two languages from these files:

```
content/<lang>/<section>/<slug>.md   the pages
templates/<lang>.html                one template for each lang, with {{body}}
```

It makes two kinds of tasks:

- `page:<lang>/<section>/<slug>` joins each page to the template of its lang on the shared var `lang`, and writes `site/<lang>/<section>/<slug>.html`.
- `sitemap:<lang>` reads the folder `content/<lang>/` and writes `site/<lang>/sitemap.txt`.

Run it two times from any folder:

```sh
bun run examples/blog/blog.ts
bun run examples/blog/blog.ts
```

The first run executes 6 tasks. The second run skips all 6. Then try an edit:

| edit | tasks that run |
| --- | --- |
| change `content/en/blog/hello.md` | `page:en/blog/hello`, `sitemap:en` |
| change `templates/en.html` | the 3 en pages |
| add a page under `content/fr/` | that page, `sitemap:fr` |
| delete `content/en/docs/install.md` | `sitemap:en`, which drops the page |

The build writes `site/` and `.dapat/state.json` into `examples/blog/`. Git ignores both.
