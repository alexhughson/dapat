/**
 * Sends events to subscribers with plain synchronous calls.
 *
 * `send` calls each listener in the order it subscribed. A listener that
 * throws stops the send, and the error goes back to the caller of `send`.
 * A listener that returns a promise is an error, because `send` cannot wait for it.
 */
export class Emitter<E> {
  private readonly listeners: ((event: E) => void)[] = []

  subscribe(listener: (event: E) => void): void {
    this.listeners.push(listener)
  }

  protected send(event: E): void {
    // A listener that subscribes during a send gets the next event, not this one.
    const listeners = [...this.listeners]
    for (const listener of listeners) {
      const returned: unknown = listener(event)
      if (isThenable(returned)) {
        throw new Error("subscriber returned a promise; subscribers must be synchronous")
      }
    }
  }
}

function isThenable(value: unknown): boolean {
  if (typeof value !== "object" && typeof value !== "function") return false
  if (value === null) return false
  return typeof (value as { then?: unknown }).then === "function"
}
