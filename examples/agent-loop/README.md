# Agent loop

This example runs an agent loop as a dapat build. A question goes in a file. The model replies with tool calls or with an answer. The build runs the tool calls, gives the results back to the model, and repeats until the model answers.

Each step writes a file. So when you run the build again, a step runs only when its input files changed. A rerun with no edits calls the model zero times.

The model here is a fake: `fakeModel` in [model.ts](model.ts). It gives the same reply for the same prompt, so the test can say which tasks run. To use a real model, give `addAgentLoop` a different async function of the type `Model`.

The model function is not a task input. If you change the model or its settings, no task runs again, and the old replies stay. To run the loop again with a new model, put the model name in the prompt, or force the tasks to run (DOCS section 12.1).

## Run it

Copy the sample to a folder that does not exist yet, then run the build two times:

```sh
cp -r examples/agent-loop/sample /tmp/agent-demo
bun run examples/agent-loop/run.ts /tmp/agent-demo    # runs every task
bun run examples/agent-loop/run.ts /tmp/agent-demo    # runs nothing
cat /tmp/agent-demo/answers/intro.txt
```

The sample has two questions. `inbox/intro.txt` asks about three terms. The fake model asks for at most two terms in one turn, so this session takes three turns. `inbox/matcher.txt` asks about one term and takes two turns.

To see a partial rerun, add a file `inbox/<name>.txt` and run again. Only the tasks of the new session run.

## The files of one session

`<sid>` is the name of the inbox file. `<n>` is the turn number, from 0.

| File | Written by | Content |
| --- | --- | --- |
| `inbox/<sid>.txt` | you | the question |
| `prompts/<sid>/<n>/prompt.txt` | `seed:<sid>` for turn 0, `advance:<sid>/<n-1>` for the other turns | the question and every tool result so far |
| `turns/<sid>/<n>/step.json` | `think:<sid>/<n>` | the model reply: `{ "kind": "tools", "calls": [...] }` or `{ "kind": "answer", "text": "..." }` |
| `turns/<sid>/<n>/results/<id>.txt` | `act:<sid>/<n>` | one file for each tool call |
| `answers/<sid>.txt` | `answer:<sid>` | the final answer |

## The tasks

[pipeline.ts](pipeline.ts) has three `build.each` calls. Each one makes tasks from the files that one `FileMatcher` finds.

```text
build.each 1: inbox = FileMatcher("inbox/<sid>.txt")
├─ seed:<sid>        inbox/<sid>.txt → prompts/<sid>/0/prompt.txt
└─ answer:<sid>      folders prompts/<sid>/ and turns/<sid>/ → answers/<sid>.txt

build.each 2: prompt = FileMatcher("prompts/<sid>/<n>/prompt.txt")
└─ think:<sid>/<n>   prompt.txt → turns/<sid>/<n>/step.json            (the model call)

build.each 3: prompt = FileMatcher("prompts/<sid>/<n>/prompt.txt")
              step   = FileMatcher("turns/<sid>/<n>/step.json")       (joined on sid and n)
├─ act:<sid>/<n>     step.json → folder turns/<sid>/<n>/results/        (the tool calls)
└─ advance:<sid>/<n> prompt.txt, step.json, folder results/
                     → folder prompts/<sid>/<n+1>/                      (the next prompt, or nothing)
```

The number of turns is not known before the build. The loop grows during the run in this order:

```text
build.run()
├─ scan: the inbox matcher finds inbox/intro.txt → seed:intro, answer:intro
├─ seed:intro writes prompts/intro/0/prompt.txt
│  └─ produced event → the prompt matcher finds turn 0 → think:intro/0
├─ think:intro/0 writes turns/intro/0/step.json (tools: dapat, stamp)
│  └─ produced event → build.each 3 has prompt and step of turn 0 → act:intro/0, advance:intro/0
├─ act:intro/0 writes results/1.txt and results/2.txt, each with ctx.produced
├─ advance:intro/0 writes prompts/intro/1/prompt.txt with ctx.produced
│  └─ produced event → the prompt matcher finds turn 1 → think:intro/1
├─ ... turn 1 asks for task, turn 2 answers
├─ advance:intro/2 writes nothing, so no turn 3 starts
└─ answer:intro reads the turns from 0 to the first answer → answers/intro.txt
```

`answer:<sid>` has the folder inputs `prompts/<sid>/` and `turns/<sid>/`. A task waits for each task that writes into its input folders, also for tasks that the loop adds during the run. Each new turn comes from an event of a task that `answer` still waits for. So `answer` starts only after the last turn.

## Two layout rules

### A task that may write nothing declares a folder

`advance` writes the next prompt only when the model asked for tools. So the output of `advance` is the folder `prompts/<sid>/<n+1>/`, and it reports the file with `ctx.produced` when it writes one.

Do not declare the file `prompts/<sid>/<n+1>/prompt.txt` as the output. The build sends a `promised` event for each declared file output when it adds the task. The prompt matcher gets this event and finds turn n+1 before any task runs. So the build adds `think` for turn n+1. `think` declares `step.json`, so the build adds `advance` for turn n+1. That `advance` declares the prompt of turn n+2, and the chain does not stop. After 10,000 passes of the event queue, `build.run()` rejects with `send limit`. The last test in [agent-loop.test.ts](agent-loop.test.ts) shows this with a cut-down rule that has only `advance`.

### Each folder has one writer

Only `advance:<sid>/<n-1>` writes into `prompts/<sid>/<n>/`. Only `act:<sid>/<n>` writes into `turns/<sid>/<n>/results/`.

The first layout of this example kept each prompt in its turn folder, at `turns/<sid>/<n>/prompt.txt`. Then `advance:<sid>/<n-1>` declared the folder `turns/<sid>/<n>/` as its output. `think`, `act` and `advance` of turn n also wrote into that folder. So the folder changed after `advance` ended, and the record of `advance` was old on the next build.

- With the default `"hash"` stamp, the second build with no edits ran `advance:intro/0` and `advance:intro/1` again. They wrote the same bytes, so the build skipped everything from build 3.
- With `stamp: "time"`, every build with no edits ran 8 tasks again, with `think:intro/1` and `think:intro/2`. Each of these runs is a paid model call.

DOCS section 13 (Limits) describes this case.

`act` deletes the old files in its results folder before it writes the new ones. A turn with fewer tool calls than the run before must not leave old results, because `advance` reads the whole folder. No matcher watches this folder, so these deletes do not remove any task during the run.

`build.each 3` joins the prompt and the step of a turn. So `act` and `advance` exist only for a turn that has both files. Without the join, a `step.json` from an old run makes `act` at the scan, before the new prompt of that turn exists. Then `act` does not wait for `think`, skips with the old `step.json`, and `advance` reads old results. A test deletes `prompts/` and edits the question to show this case.

## When a question gets shorter

dapat does not delete the old outputs of a task that is gone. Thus an edit can leave turns on disk from an older, longer loop.

For example, `inbox/intro.txt` took three turns. You change it to `What is a task?`. Now the model answers on turn 1. `advance:intro/1` writes nothing, but `prompts/intro/2/prompt.txt` from the old run is still there. The prompt matcher still finds turn 2. Its tasks have the same inputs as before, so they skip and call no model.

`answer:intro` follows the turns from turn 0 to the first answer, so it ignores turn 2. It does not take the highest turn number.

`advance` does not clear its output folder before it writes, as `act` does. A test of that version cleared `prompts/<sid>/<n+1>/` at the start of each `advance` run and then wrote the prompt again. The delete sent a `deleted` event, so the prompt matcher removed `think` for that turn during the run. `act:intro/1` was waiting for that `think`, so it went on to its skip check and skipped with the old `step.json`. It ran only on the next build.

## When a question is removed

When you delete `inbox/<sid>.txt`, the build removes `seed:<sid>` and `answer:<sid>`. The old prompts and steps stay on disk, so `think`, `act` and `advance` of the old turns stay. Their inputs do not change, so they skip and call no model. `answers/<sid>.txt` stays.

## The test

[agent-loop.test.ts](agent-loop.test.ts) runs the loop on real files in a temp folder, with a new `Build` and the JSON store for each build, as `run.ts` does. It checks which tasks run on each build:

| Test | Builds |
| --- | --- |
| first run and rerun | three turns, then nothing |
| a new question | only the tasks of the new session |
| an edited question | every task of the session, plus the new turns |
| a shorter question | the new turns run, the old turn 2 skips, the answer comes from the new chain, then nothing |
| a turn whose prompt is gone | `prompts/` deleted and the question edited: every turn runs in the right order, then nothing |
| an exact next-prompt output | `build.run()` rejects with `send limit` |

```sh
bun test examples/agent-loop
```
