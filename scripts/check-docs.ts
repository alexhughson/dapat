// Runs each ```ts block in the docs as a complete program, then type-checks all of them.
//   bun scripts/check-docs.ts [file.md ...]
// A block that follows a line `<!-- no-run -->` is skipped (signatures and shapes).
// A ```text block that follows a line `<!-- output -->` must equal the stdout of the ts block before it.
// Each program runs in a fresh folder under .doccheck/<pid>/, so it can write files with relative paths,
// `import ... from "dapat"` resolves to this checkout, and two checks can run at the same time.
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"

type Block = {
  file: string
  line: number
  lang: string
  code: string
  directive: string | undefined
}

type Sample = {
  block: Block
  expectedOutput: string | undefined
  dir: string
}

const root = path.resolve(import.meta.dir, "..")
const checkRoot = path.join(root, ".doccheck", String(process.pid))

function docFiles(): string[] {
  const args = process.argv.slice(2)
  if (args.length > 0) {
    return args.map((arg) => path.resolve(arg))
  }
  const files: string[] = []
  const globs = ["README.md", "DOCS.md", "docs/**/*.md", "examples/**/README.md"]
  for (const pattern of globs) {
    for (const match of new Bun.Glob(pattern).scanSync({ cwd: root })) {
      files.push(path.join(root, match))
    }
  }
  return files.sort()
}

function readBlocks(file: string, text: string): Block[] {
  const lines = text.split("\n")
  const blocks: Block[] = []
  let directive: string | undefined = undefined
  let index = 0
  while (index < lines.length) {
    const line = lines[index]!
    const comment = line.match(/^<!--\s*(no-run|output)\s*-->$/)
    if (comment) {
      directive = comment[1]
      index++
      continue
    }
    const fence = line.match(/^```(\w*)/)
    if (!fence) {
      if (line.trim() !== "") {
        directive = undefined
      }
      index++
      continue
    }
    const start = index + 1
    let end = start
    while (end < lines.length && !lines[end]!.startsWith("```")) {
      end++
    }
    if (end === lines.length) {
      throw new Error(`${file}:${index + 1}: code fence is not closed`)
    }
    blocks.push({
      file,
      line: index + 1,
      lang: fence[1]!,
      code: lines.slice(start, end).join("\n") + "\n",
      directive,
    })
    directive = undefined
    index = end + 1
  }
  return blocks
}

function samplesOf(blocks: Block[]): { samples: Sample[]; skipped: number } {
  const samples: Sample[] = []
  let skipped = 0
  for (const block of blocks) {
    if (block.directive === "output") {
      const previous = samples.at(-1)
      if (block.lang !== "text" || previous === undefined) {
        throw new Error(`${block.file}:${block.line}: <!-- output --> must mark a text block after a ts block`)
      }
      if (previous.expectedOutput !== undefined) {
        throw new Error(`${block.file}:${block.line}: two output blocks for one ts block`)
      }
      previous.expectedOutput = block.code
      continue
    }
    if (block.lang !== "ts") {
      continue
    }
    if (block.directive === "no-run") {
      skipped++
      continue
    }
    const name = `${path.relative(root, block.file).replaceAll(/[^\w]+/g, "-")}-${block.line}`
    samples.push({ block, expectedOutput: undefined, dir: path.join(checkRoot, name) })
  }
  return { samples, skipped }
}

async function runSample(sample: Sample): Promise<string | undefined> {
  mkdirSync(sample.dir, { recursive: true })
  writeFileSync(path.join(sample.dir, "main.ts"), sample.block.code)
  const proc = Bun.spawn(["bun", "main.ts"], { cwd: sample.dir, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => proc.kill(), 30_000)
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  clearTimeout(timer)
  if (code !== 0) {
    return `exit code ${code}\n${stderr}${stdout}`
  }
  if (sample.expectedOutput !== undefined && stdout.trimEnd() !== sample.expectedOutput.trimEnd()) {
    return `stdout differs from the output block\n--- expected\n${sample.expectedOutput}--- actual\n${stdout}`
  }
  return undefined
}

async function typeCheck(samples: Sample[]): Promise<string | undefined> {
  const config = {
    extends: path.join(root, "tsconfig.json"),
    include: samples.map((sample) => path.join(sample.dir, "main.ts")),
  }
  const configPath = path.join(checkRoot, "tsconfig.json")
  writeFileSync(configPath, JSON.stringify(config, null, 2))
  const proc = Bun.spawn(["tsc", "-p", configPath], { cwd: root, stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    return stdout
  }
  return undefined
}

rmSync(checkRoot, { recursive: true, force: true })
const samples: Sample[] = []
let skipped = 0
for (const file of docFiles()) {
  const found = samplesOf(readBlocks(file, await Bun.file(file).text()))
  samples.push(...found.samples)
  skipped += found.skipped
}

let failures = 0
for (const sample of samples) {
  const where = `${path.relative(root, sample.block.file)}:${sample.block.line}`
  const failure = await runSample(sample)
  if (failure === undefined) {
    console.log(`ok   ${where}`)
  } else {
    failures++
    console.log(`FAIL ${where}\n${failure}`)
  }
}

const typeErrors = await typeCheck(samples)
if (typeErrors !== undefined) {
  failures++
  console.log(`FAIL type check\n${typeErrors}`)
}

console.log(`${samples.length} samples run, ${skipped} skipped (no-run), ${failures} failures`)
if (failures === 0) {
  rmSync(checkRoot, { recursive: true, force: true })
}
process.exit(failures === 0 ? 0 : 1)
