export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY_RE =
  /password|pwd|pass(?![a-z])|secret|token|api[_-]?key|bearer|credential|authorization|auth(?![a-z])|private[_-]?key|client[_-]?secret/i;

// Value-level scan: any string value matching one of these prefixes is treated as sensitive
// regardless of the field name, so that e.g. a free-text `description` containing
// "token=sk-ant-…" is still redacted.
const SECRET_VALUE_PREFIXES = [
  'sk-ant-',
  'sk-live-',
  'sk-test-',
  'ghp_',
  'gho_',
  'ghu_',
  'ghs_',
  'ghr_',
  'glpat-',
  'xoxb-',
  'xoxp-',
  'AKIA',
  '-----BEGIN ',
];

function fingerprint(value: string): string {
  if (value.length < 8) return '[redacted]';
  return `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function containsSecretPrefix(value: string): boolean {
  for (const p of SECRET_VALUE_PREFIXES) {
    if (value.includes(p)) return true;
  }
  return false;
}

function redact(value: unknown): unknown {
  if (value == null) return value;
  if (typeof value !== 'string') return value;
  return fingerprint(value);
}

function scrubString(s: string): string {
  if (containsSecretPrefix(s)) return fingerprint(s);
  return s;
}

function deepRedact(obj: unknown): unknown {
  if (obj == null) return obj;
  if (typeof obj === 'string') return scrubString(obj);
  if (typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map((v) => deepRedact(v));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    out[k] = SECRET_KEY_RE.test(k) ? redact(v) : deepRedact(v);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export interface LoggerOptions {
  level?: LogLevel;
  runId?: string;
  bindings?: Record<string, unknown>;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
  const level = opts.level ?? envLevel ?? 'info';
  const threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  const baseBindings: Record<string, unknown> = {
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.bindings ?? {}),
  };

  function emit(lvl: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const payload = {
      ts: new Date().toISOString(),
      level: lvl,
      ...baseBindings,
      msg,
      ...(fields ? (deepRedact(fields) as Record<string, unknown>) : {}),
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child(bindings) {
      return createLogger({ level, bindings: { ...baseBindings, ...bindings } });
    },
  };
}
