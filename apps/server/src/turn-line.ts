/**
 * The turns waiting for a place on the server, first come first served. Kept in memory: a
 * turn in line when the server stops is cut short, as a running one is.
 */
export class TurnLine {
  private waiting: { threadId: string; go: () => void }[] = [];

  get size(): number {
    return this.waiting.length;
  }

  has(threadId: string): boolean {
    return this.waiting.some((w) => w.threadId === threadId);
  }

  /** Joins the end of the line; resolves once the thread is let through or leaves. */
  wait(threadId: string): Promise<void> {
    return new Promise((go) => this.waiting.push({ threadId, go }));
  }

  /** Lets the first in line through, or the first that `may` go; false when none does. */
  next(may: (threadId: string) => boolean = () => true): boolean {
    const found = this.waiting.find((w) => may(w.threadId));
    if (!found) return false;
    this.waiting = this.waiting.filter((w) => w !== found);
    found.go();
    return true;
  }

  /** Takes the thread out of the line, wherever it stands; false when it was not in it. */
  leave(threadId: string): boolean {
    const found = this.waiting.find((w) => w.threadId === threadId);
    if (!found) return false;
    this.waiting = this.waiting.filter((w) => w !== found);
    found.go();
    return true;
  }

  /** The threads in line, first to last. */
  threads(): string[] {
    return this.waiting.map((w) => w.threadId);
  }
}
