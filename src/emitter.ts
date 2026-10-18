/**
 * Sends events to subscribers with plain synchronous calls.
 *
 * `send` calls each listener in the order it subscribed. A listener that
 * throws stops the send, and the error goes back to the caller of `send`.
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
      listener(event)
    }
  }
}
