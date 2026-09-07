// Phase 7 §15 — every external provider call in the live pipeline must
// have a timeout so a slow provider can never freeze the whole signal
// (or the whole listener). `fetchJson` already has its own built-in
// timeout for HTTP calls; this is the general-purpose wrapper for
// anything else (RPC calls, wallet-intelligence computations, etc.).

export class TimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = "TimeoutError";
  }
}

export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
