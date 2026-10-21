/**
 * Times the scheduler of Build on synthetic pipelines of in-memory artifacts, with a MemoryStore.
 *
 *   bun bench/scheduler.ts                          every scenario at every size, each in its own process
 *   bun bench/scheduler.ts flat 4000                one scenario at one size, prints one JSON line
 *   BENCH_TIMEOUT=60 bun bench/scheduler.ts         per-case limit in seconds (default 120)
 *
 * Scenarios:
 *   flat           n tasks, no dependencies: mem:in/i -> mem:out/i
 *   chain          n tasks, each reads the output of the one before it
 *   fanin          n producers into mem:out/, and one task that reads the prefix mem:out/
 *   shared-prefix  n tasks that each read their own input and the prefix mem:cfg/; one task writes mem:cfg/a
 *   add-during-run one task adds n flat tasks with ctx.add while it runs
 *   replace        n flat tasks run; then build.add replaces each one again (each add is one step) and a 2nd run
 *   custom-prefix  as shared-prefix, but the prefix class overrides covers(), so each look scans every output
 *   one-at-a-time  one task reads the prefix mem:out/; task i writes mem:out/i and adds task i+1 with ctx.add
 *
 * custom-prefix and one-at-a-time are the two known cases whose cost grows with n².
 *
 * The time is from the first build.add to the end of build.run(), so it includes the task changes.
 */
import { Build, IdPrefix, MemoryStore, Prefix, Task, type Artifact, type Context } from "../src/index"
import { Mem } from "../test/mem"

/** A prefix with the default rule, but its own covers(). The build cannot use its index for it. */
class CustomPrefix extends Prefix {
  constructor(readonly id: string) {
    super()
  }
  override covers(artifact: Artifact): boolean {
    return artifact.id.startsWith(this.id)
  }
}

type Scenario = (n: number) => Promise<{ ms: number; executed: number }>

const write = (out: Mem) => async () => {
  out.write("v")
}

async function timed(build: Build, expected: number, add: () => void): Promise<{ ms: number; executed: number }> {
  const start = performance.now()
  add()
  const result = await build.run()
  const ms = performance.now() - start
  if (!result.success || result.executed.length !== expected) {
    throw new Error(`expected ${expected} executed, got ${result.executed.length}, failed ${result.failed.size}`)
  }
  return { ms, executed: result.executed.length }
}

const scenarios: Record<string, Scenario> = {
  async flat(n) {
    const build = new Build({ store: new MemoryStore() })
    return timed(build, n, () => {
      for (let i = 0; i < n; i++) {
        const out = new Mem(`mem:out/${i}`)
        build.add(new Task({ id: `t${i}`, inputs: [new Mem(`mem:in/${i}`, "x")], outputs: [out], run: write(out) }))
      }
    })
  },

  async chain(n) {
    const build = new Build({ store: new MemoryStore() })
    return timed(build, n, () => {
      let previous = new Mem("mem:seed", "x")
      for (let i = 0; i < n; i++) {
        const out = new Mem(`mem:c/${i}`)
        build.add(new Task({ id: `t${i}`, inputs: [previous], outputs: [out], run: write(out) }))
        previous = out
      }
    })
  },

  async fanin(n) {
    const build = new Build({ store: new MemoryStore() })
    return timed(build, n + 1, () => {
      for (let i = 0; i < n; i++) {
        const out = new Mem(`mem:out/${i}`)
        build.add(new Task({ id: `t${i}`, inputs: [new Mem(`mem:in/${i}`, "x")], outputs: [out], run: write(out) }))
      }
      const total = new Mem("mem:total")
      build.add(new Task({ id: "total", inputs: [new IdPrefix("mem:out/")], outputs: [total], run: write(total) }))
    })
  },

  async "shared-prefix"(n) {
    const build = new Build({ store: new MemoryStore() })
    return timed(build, n + 1, () => {
      const cfg = new Mem("mem:cfg/a")
      build.add(new Task({ id: "cfg", inputs: [new Mem("mem:cfg-source", "x")], outputs: [cfg], run: write(cfg) }))
      for (let i = 0; i < n; i++) {
        const out = new Mem(`mem:out/${i}`)
        const inputs = [new Mem(`mem:in/${i}`, "x"), new IdPrefix("mem:cfg/")]
        build.add(new Task({ id: `t${i}`, inputs, outputs: [out], run: write(out) }))
      }
    })
  },

  async "add-during-run"(n) {
    const build = new Build({ store: new MemoryStore() })
    return timed(build, n + 1, () => {
      build.add(
        new Task({
          id: "spawner",
          inputs: [new Mem("mem:spawn", "x")],
          run: async (ctx: Context) => {
            for (let i = 0; i < n; i++) {
              const out = new Mem(`mem:out/${i}`)
              ctx.add(new Task({ id: `t${i}`, inputs: [new Mem(`mem:in/${i}`, "x")], outputs: [out], run: write(out) }))
            }
          },
        }),
      )
    })
  },

  async "custom-prefix"(n) {
    const build = new Build({ store: new MemoryStore() })
    return timed(build, n + 1, () => {
      const cfg = new Mem("mem:cfg/a")
      build.add(new Task({ id: "cfg", inputs: [new Mem("mem:cfg-source", "x")], outputs: [cfg], run: write(cfg) }))
      for (let i = 0; i < n; i++) {
        const out = new Mem(`mem:out/${i}`)
        const inputs = [new Mem(`mem:in/${i}`, "x"), new CustomPrefix("mem:cfg/")]
        build.add(new Task({ id: `t${i}`, inputs, outputs: [out], run: write(out) }))
      }
    })
  },

  async "one-at-a-time"(n) {
    const build = new Build({ store: new MemoryStore() })
    const makeTask = (i: number): Task => {
      const out = new Mem(`mem:out/${i}`)
      return new Task({
        id: `t${i}`,
        inputs: [new Mem(`mem:in/${i}`, "x")],
        outputs: [out],
        run: async (ctx: Context) => {
          out.write("v")
          if (i + 1 < n) {
            ctx.add(makeTask(i + 1))
          }
        },
      })
    }
    return timed(build, n + 1, () => {
      const total = new Mem("mem:total")
      build.add(new Task({ id: "total", inputs: [new IdPrefix("mem:out/")], outputs: [total], run: write(total) }))
      build.add(makeTask(0))
    })
  },

  async replace(n) {
    const build = new Build({ store: new MemoryStore() })
    const makeTask = (i: number, value: string) => {
      const out = new Mem(`mem:out/${i}`)
      return new Task({ id: `t${i}`, inputs: [new Mem(`mem:in/${i}`, value)], outputs: [out], run: write(out) })
    }
    for (let i = 0; i < n; i++) build.add(makeTask(i, "x"))
    await build.run()
    return timed(build, 2 * n, () => {
      for (let i = 0; i < n; i++) build.add(makeTask(i, "y"))
    })
  },
}

const SIZES: Record<string, number[]> = {
  flat: [1000, 2000, 4000, 8000, 16000, 32000],
  chain: [250, 500, 1000, 2000, 4000, 8000],
  fanin: [1000, 2000, 4000, 8000, 16000, 32000],
  "shared-prefix": [1000, 2000, 4000, 8000, 16000, 32000],
  "add-during-run": [1000, 2000, 4000, 8000, 16000, 32000],
  replace: [1000, 2000, 4000, 8000, 16000, 32000],
  "custom-prefix": [1000, 2000, 4000, 8000, 16000, 32000],
  "one-at-a-time": [1000, 2000, 4000, 8000, 16000, 32000],
}

const [name, sizeText] = process.argv.slice(2)
if (name !== undefined) {
  const scenario = scenarios[name]
  if (!scenario) throw new Error(`unknown scenario '${name}'`)
  const n = Number(sizeText)
  // One small warm-up run, so the JIT does not count.
  await scenario(Math.min(n, 200))
  const { ms } = await scenario(n)
  console.log(JSON.stringify({ scenario: name, n, ms: Math.round(ms) }))
} else {
  const limit = Number(process.env.BENCH_TIMEOUT ?? 120)
  for (const scenarioName of Object.keys(scenarios)) {
    for (const n of SIZES[scenarioName]!) {
      const proc = Bun.spawn(["bun", import.meta.path, scenarioName, String(n)], { stdout: "pipe", stderr: "inherit" })
      const timer = setTimeout(() => proc.kill(), limit * 1000)
      const text = await new Response(proc.stdout).text()
      clearTimeout(timer)
      await proc.exited
      if (proc.signalCode !== null) {
        console.log(JSON.stringify({ scenario: scenarioName, n, ms: `>${limit * 1000}` }))
        // A bigger size takes longer still.
        break
      }
      process.stdout.write(text)
    }
  }
}
