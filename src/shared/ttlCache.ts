// Simple in-memory, per-process, TTL-based cache. Deliberately not a
// distributed cache — see Phase 2's "CACHING / RATE LIMITING" scope
// (simple in-memory caching is enough for now).

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache<T> {
  #store = new Map<string, CacheEntry<T>>();
  #defaultTtlMs: number;

  constructor(defaultTtlMs: number) {
    this.#defaultTtlMs = defaultTtlMs;
  }

  get(key: string): T | undefined {
    const entry = this.#store.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.#store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number = this.#defaultTtlMs): void {
    this.#store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /** Returns the cached value if present and fresh, otherwise computes, caches, and returns it. */
  async getOrCompute(key: string, compute: () => Promise<T>, ttlMs?: number): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const value = await compute();
    this.set(key, value, ttlMs);
    return value;
  }

  delete(key: string): void {
    this.#store.delete(key);
  }

  clear(): void {
    this.#store.clear();
  }

  get size(): number {
    return this.#store.size;
  }
}
