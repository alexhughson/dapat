// Runs each ```ts block in the docs as a complete program, then type-checks all of them.
//   bun scripts/check-docs.ts [file.md ...]
// A block that follows a line `<!-- no-run -->` is skipped (signatures and shapes).
// A ```text block that follows a line `<!-- output -->` must equal the stdout of the ts block before it.
// A ts block that follows a line `<!-- file: name.ts -->` does not run. It is saved as name.ts next to
// each later program on the same page, so those programs can import it.
// A bold term is a definition, so each one may appear in bold only once in all the docs.
// Each relative link must name a file that exists, and each #anchor a heading in that file.
// Each program runs in a fresh folder under .doccheck/<pid>/, so it can write files with relative paths,
// `import ... from "dapat"` resolves to this checkout, and two checks can run at the same time.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
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
  modules: Module[]
}

type Module = {
  name: string
  code: string
}

const root = path.resolve(import.meta.dir, "..")
const checkRoot = path.join(root, ".doccheck", String(process.pid))

function docFiles(): string[] {
  const args = process.argv.slice(2)
  if (args.length > 0) {
    return args.map((arg) => path.resolve(arg))
  }
  const files: string[] = []
  const globs = ["README.md", "docs/**/*.md", "examples/**/README.md"]
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
    const comment = line.match(/^<!--\s*(no-run|output|file:\s*[\w.-]+\.ts)\s*-->$/)
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
  const modules: Module[] = []
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
    if (block.directive !== undefined && block.directive.startsWith("file:")) {
      const moduleName = block.directive.slice("file:".length).trim()
      modules.push({ name: moduleName, code: block.code })
      continue
    }
    const name = `${path.relative(root, block.file).replaceAll(/[^\w]+/g, "-")}-${block.line}`
    const earlierModules = [...modules]
    samples.push({ block, expectedOutput: undefined, dir: path.join(checkRoot, name), modules: earlierModules })
  }
  return { samples, skipped }
}

async function runSample(sample: Sample): Promise<string | undefined> {
  mkdirSync(sample.dir, { recursive: true })
  writeFileSync(path.join(sample.dir, "main.ts"), sample.block.code)
  for (const module of sample.modules) {
    writeFileSync(path.join(sample.dir, module.name), module.code)
  }
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
    include: samples.map((sample) => path.join(sample.dir, "*.ts")),
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

function proseLines(text: string): string[] {
  const lines: string[] = []
  let inFence = false
  for (const line of text.split("\n")) {
    if (line.startsWith("```")) {
      inFence = !inFence
      continue
    }
    if (!inFence) {
      lines.push(line)
    }
  }
  return lines
}

// The anchors GitHub makes for headings: lowercase, punctuation dropped, spaces as "-", "-1" on repeats.
function anchorsOf(text: string): Set<string> {
  const anchors = new Set<string>()
  for (const line of proseLines(text)) {
    const heading = line.match(/^#+\s+(.*)$/)
    if (!heading) {
      continue
    }
    const base = heading[1]!.toLowerCase().replaceAll(/[^\p{L}\p{N} _-]/gu, "").replaceAll(" ", "-")
    let anchor = base
    let repeat = 0
    while (anchors.has(anchor)) {
      repeat++
      anchor = `${base}-${repeat}`
    }
    anchors.add(anchor)
  }
  return anchors
}

async function linkErrors(file: string, text: string): Promise<string[]> {
  const errors: string[] = []
  const lines = proseLines(text)
  for (const line of lines) {
    const withoutCode = line.replaceAll(/`[^`]*`/g, "")
    for (const link of withoutCode.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = link[1]!
      if (/^(https?|mailto):/.test(target)) {
        continue
      }
      const [targetPath, anchor] = target.split("#")
      const targetFile = targetPath === "" ? file : path.resolve(path.dirname(file), targetPath!)
      const where = `${path.relative(root, file)}: link ${target}`
      if (!existsSync(targetFile)) {
        errors.push(`${where}: no file ${path.relative(root, targetFile)}`)
        continue
      }
      if (anchor === undefined || !targetFile.endsWith(".md")) {
        continue
      }
      const anchors = anchorsOf(await Bun.file(targetFile).text())
      if (!anchors.has(anchor)) {
        errors.push(`${where}: no heading for #${anchor}`)
      }
    }
  }
  return errors
}

function boldTerms(file: string, text: string): Map<string, string[]> {
  const terms = new Map<string, string[]>()
  const lines = text.split("\n")
  let inFence = false
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("```")) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      continue
    }
    for (const match of line.matchAll(/\*\*([^*]+)\*\*/g)) {
      const term = match[1]!.trim().toLowerCase().replaceAll("`", "")
      const places = terms.get(term) ?? []
      places.push(`${path.relative(root, file)}:${index + 1}`)
      terms.set(term, places)
    }
  }
  return terms
}

rmSync(checkRoot, { recursive: true, force: true })
let failures = 0
const boldPlaces = new Map<string, string[]>()
const samples: Sample[] = []
let skipped = 0
for (const file of docFiles()) {
  const text = await Bun.file(file).text()
  const found = samplesOf(readBlocks(file, text))
  samples.push(...found.samples)
  skipped += found.skipped
  for (const error of await linkErrors(file, text)) {
    failures++
    console.log(`FAIL ${error}`)
  }
  for (const [term, places] of boldTerms(file, text)) {
    const all = boldPlaces.get(term) ?? []
    all.push(...places)
    boldPlaces.set(term, all)
  }
}
for (const [term, places] of boldPlaces) {
  if (places.length > 1) {
    failures++
    console.log(`FAIL bold term "${term}" is defined more than once: ${places.join(", ")}`)
  }
}

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
