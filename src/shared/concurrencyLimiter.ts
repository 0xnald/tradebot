// Minimal concurrency limiter — caps how many async tasks run at once, so
// wallet-intelligence code that fans out RPC/API calls across many
// pools/wallets doesn't hammer a provider. Deliberately simple (no queue
// priority, no retry/backoff) — see Phase 3's "do not attempt to evade
// provider rate limits" instruction: this only throttles our own request
// rate, nothing more.

export class ConcurrencyLimiter {
  #maxConcurrent: number;
  #active = 0;
  #queue: (() => void)[] = [];

  constructor(maxConcurrent: number) {
    if (maxConcurrent < 1) throw new Error("maxConcurrent must be >= 1");
    this.#maxConcurrent = maxConcurrent;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.#acquire();
    try {
      return await task();
    } finally {
      this.#release();
    }
  }

  /** Runs `task` for every item in `items`, respecting the concurrency cap, preserving result order. */
  async map<T, R>(items: T[], task: (item: T, index: number) => Promise<R>): Promise<R[]> {
    return Promise.all(items.map((item, index) => this.run(() => task(item, index))));
  }

  #acquire(): Promise<void> {
    if (this.#active < this.#maxConcurrent) {
      this.#active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#queue.push(() => {
        this.#active += 1;
        resolve();
      });
    });
  }

  #release(): void {
    this.#active -= 1;
    const next = this.#queue.shift();
    if (next) next();
  }
}
