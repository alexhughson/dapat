// A matcher that adds vars to the matches of another matcher. Each added var is a function of the
// vars of the match, like a computed column in a database view. For example, `next` = `n` + 1.
import { Matcher, type ArtifactEvent, type MatchedData, type Ref, type Vars } from "dapat"

export type VarFunctions = Record<string, (vars: Vars) => string>

export class ComputedVarsMatcher<D extends MatchedData> extends Matcher<D> {
  readonly varNames: readonly string[]

  constructor(
    private readonly inner: Matcher<D>,
    private readonly varFunctions: VarFunctions,
  ) {
    super()
    for (const name of Object.keys(varFunctions)) {
      if (inner.varNames.includes(name)) {
        throw new Error(`ComputedVarsMatcher: the var '${name}' is already a var of the inner matcher`)
      }
    }
    this.varNames = [...inner.varNames, ...Object.keys(varFunctions)]
    inner.subscribe((event) => {
      if (event.kind === "found") {
        const vars = this.withComputedVars(event.matched.vars)
        this.send({ kind: "found", matched: { vars, data: event.matched.data } })
      } else {
        this.send({ kind: "gone", vars: this.withComputedVars(event.vars) })
      }
    })
  }

  scan(signal: AbortSignal): Promise<void> {
    return this.inner.scan(signal)
  }

  override receiveArtifactEvent(event: ArtifactEvent): void {
    this.inner.receiveArtifactEvent(event)
  }

  // Matcher has region() only on the gate-task prototype branch, so this reads it from the inner
  // matcher when it is there.
  region(): Ref | null {
    const inner = this.inner as { region?: () => Ref | null }
    if (inner.region === undefined) {
      return null
    }
    return inner.region()
  }

  private withComputedVars(vars: Vars): Vars {
    const allVars: Record<string, string> = { ...vars }
    for (const [name, compute] of Object.entries(this.varFunctions)) {
      allVars[name] = compute(vars)
    }
    return allVars
  }
}
