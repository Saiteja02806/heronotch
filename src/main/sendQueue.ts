/** A message waiting for its session to finish the turn it is already running.
 *
 * Sending into a live agent interrupts work or gets swallowed by the provider,
 * so a message for a busy session is held here instead and delivered when that
 * session goes quiet. Order is strict FIFO per session: the second message
 * never overtakes the first.
 */
export interface QueuedSend {
  sessionId: string
  message: string
  queuedAt: number
}

export const MAX_QUEUED_PER_SESSION = 8

export class SendQueue {
  private readonly queues = new Map<string, QueuedSend[]>()

  /** Returns the 1-based place in line, or 0 when the queue is full. */
  push(sessionId: string, message: string, at = Date.now()): number {
    const list = this.queues.get(sessionId) ?? []
    if (list.length >= MAX_QUEUED_PER_SESSION) return 0
    list.push({ sessionId, message, queuedAt: at })
    this.queues.set(sessionId, list)
    return list.length
  }

  /** Removes and returns the message at the head of a session's queue. */
  take(sessionId: string): QueuedSend | undefined {
    const list = this.queues.get(sessionId)
    if (!list?.length) return undefined
    const next = list.shift()
    if (!list.length) this.queues.delete(sessionId)
    return next
  }

  peek(sessionId: string): QueuedSend | undefined {
    return this.queues.get(sessionId)?.[0]
  }

  size(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0
  }

  sessions(): string[] {
    return [...this.queues.keys()]
  }

  counts(): Map<string, number> {
    return new Map([...this.queues].map(([id, list]) => [id, list.length]))
  }

  /** Drops everything held for a session that no longer exists. */
  drop(sessionId: string): QueuedSend[] {
    const list = this.queues.get(sessionId) ?? []
    this.queues.delete(sessionId)
    return list
  }

  clear(): void {
    this.queues.clear()
  }
}
