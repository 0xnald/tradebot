// Small fetch-JSON helper shared by external HTTP-based data providers
// (DexScreener, Blockscout). Centralizes timeout handling and turns any
// failure (network error, timeout, non-2xx, non-JSON body) into a typed
// result rather than a thrown exception with an inconsistent shape —
// providers turn this into their own ProviderResult envelope.

export type FetchJsonResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export async function fetchJson<T>(url: string, timeoutMs = 8000): Promise<FetchJsonResult<T>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal, headers: { Accept: "application/json" } });
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status} ${response.statusText}` };
    }
    const data = (await response.json()) as T;
    return { ok: true, data };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { ok: false, error: `request timed out after ${timeoutMs}ms` };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}
