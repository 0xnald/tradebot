// Minimal structured logger. Emits one JSON line per call so log output is
// easy to grep/pipe into a file during development.
//
// Any field object passed in is recursively scanned for secret-shaped keys
// (api hash/id, session, token, password, private key, seed phrase) and
// those values are redacted before the line is written — a defense against
// accidentally logging a config object that contains credentials.

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

// Deliberately more specific than a bare "token": this codebase has a
// legitimate, frequently-logged field called `tokenSymbol` (a crypto
// ticker, e.g. "THROBBIN") which a bare /token/i match would redact.
const SECRET_KEY_PATTERN =
  /(api[_-]?hash|api[_-]?id|session|secret|private[_-]?key|seed[_-]?phrase|password|(access|auth|bot|api)[_-]?token|^token$)/i;

function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((entry) => redact(entry, seen));
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[circular]";
    seen.add(value as object);
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? "[redacted]" : redact(entry, seen);
    }
    return out;
  }
  return value;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

function envLogLevel(): LogLevel {
  const raw = (process.env.LOG_LEVEL ?? "info").toLowerCase();
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info";
}

export function createLogger(scope: string, minLevel: LogLevel = envLogLevel()): Logger {
  function write(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      scope,
      msg,
      ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
    };
    const line = JSON.stringify(record);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }

  return {
    debug: (msg, fields) => write("debug", msg, fields),
    info: (msg, fields) => write("info", msg, fields),
    warn: (msg, fields) => write("warn", msg, fields),
    error: (msg, fields) => write("error", msg, fields),
  };
}
