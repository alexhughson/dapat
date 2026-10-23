# dapat documentation

Run the [README example](../README.md#example) first, then read part 1 of the guide. The table lists each page by goal, and the [examples](../examples/README.md) are complete programs.

| Goal | Page | Read it when |
| --- | --- | --- |
| Write a first program | [Guide](guide.md), part 1 | you start: it defines the terms that the other pages use |
| Write a pipeline | [Guide](guide.md#buildeach), part 2 | you use `build.subscribe` or `build.each` |
| | [build.each](build-each.md) | you write a pattern or an output template, join matchers, or write a loop, such as an agent loop |
| | [Built-in artifacts and stores](builtins.md) | you choose a stamp mode or a store, or use folders or S3 |
| Do a common job | [Recipes](recipes.md) | you force a rerun, rerun after a code change, delete old outputs, limit parallel work, run in CI, or call a paid model |
| Fix a problem | [Troubleshooting](troubleshooting.md) | a task runs, skips, waits or is missing when you do not expect it, and there is no error message |
| Check the limits | [Limits](limits.md) | you plan thousands of tasks, or you look for a known issue |
| Extend dapat | [Write an artifact type](write-an-artifact.md) | a task reads or writes a value that is not a file or an S3 object |
| | [Write a matcher](write-a-matcher.md) | `build.each` must find artifacts that are not files |
| | [Write a store](builtins.md#write-a-store) | you keep the records in a database of your own |
| Look up a rule or an export | [How a build works](semantics.md) | you need the exact rules for order, skips, events and fatal errors, or you subclass `Build` |
| | [API reference](api.md) | you look up an export or the exact text of an error |
| Look up a term | [Terms](glossary.md) | a page uses a term that you do not know |
