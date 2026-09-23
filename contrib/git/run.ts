export async function git(
  args: readonly string[],
  opts: { cwd: string },
): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const detail = stderr.trim().length > 0 ? stderr.trim() : `exit ${exitCode}`
    throw new Error(`git ${args.join(" ")} failed: ${detail}`)
  }
  return stdout
}
