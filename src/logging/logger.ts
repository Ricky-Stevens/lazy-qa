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

export function deepRedact(obj: unknown): unknown {
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

const DEFAULT_LLM_RESULT_BYTES = 8 * 1024;

/**
 * Redact secret-shaped fields and truncate to a byte cap before handing to
 * the LLM. Use for any tool result that returns app-controlled content
 * (evaluate, read_recent, page snapshots that include user-rendered text).
 *
 * Strings pass through (subject to byte cap). Objects/arrays are
 * deep-redacted then JSON-stringified. Truncation uses character slicing,
 * which may overshoot the byte cap by a few bytes at the truncation
 * boundary if the byte at maxBytes happens to be in the middle of a UTF-8
 * multi-byte sequence — acceptable for an LLM input cap (off by ≤3 bytes).
 */
export function redactForLlm(value: unknown, maxBytes: number = DEFAULT_LLM_RESULT_BYTES): string {
  const redacted =
    typeof value === 'string' ? value : (JSON.stringify(deepRedact(value)) ?? 'undefined');
  if (Buffer.byteLength(redacted, 'utf8') <= maxBytes) return redacted;
  const truncated = redacted.slice(0, maxBytes);
  return `${truncated}\n[truncated at ${maxBytes} bytes]`;
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
  /** 'json' (default — one JSON object per line) | 'pretty' (compact human
   *  text, color when stdout is a TTY). Override via LOG_FORMAT env var. */
  format?: 'json' | 'pretty';
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
} as const;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: ANSI.gray,
  info: ANSI.cyan,
  warn: ANSI.yellow,
  error: ANSI.red,
};

function shortTime(iso: string): string {
  // "2026-04-28T13:46:36.178Z" → "13:46:36"
  return iso.slice(11, 19);
}

function formatFields(fields: Record<string, unknown>, useColor: boolean): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    let s: string;
    if (typeof v === 'string') s = v;
    else if (v === null) s = 'null';
    else if (typeof v === 'object') s = JSON.stringify(v);
    else s = String(v);
    if (s.length > 120) s = `${s.slice(0, 117)}…`;
    parts.push(useColor ? `${ANSI.dim}${k}=${ANSI.reset}${s}` : `${k}=${s}`);
  }
  return parts.join(' ');
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const envLevel = process.env.LOG_LEVEL as LogLevel | undefined;
  const level = opts.level ?? envLevel ?? 'info';
  const threshold = LEVEL_ORDER[level] ?? LEVEL_ORDER.info;
  const envFormat = process.env.LOG_FORMAT as 'json' | 'pretty' | undefined;
  // Default to pretty when stdout is a TTY (interactive shell) so users see
  // a readable audit log without flag-flipping. Pipes / CI / file redirects
  // get JSON, which downstream tooling can grep.
  const interactiveDefault: 'json' | 'pretty' = process.stdout.isTTY ? 'pretty' : 'json';
  const format = opts.format ?? envFormat ?? interactiveDefault;
  const useColor = format === 'pretty' && process.stdout.isTTY === true;
  const baseBindings: Record<string, unknown> = {
    ...(opts.runId ? { runId: opts.runId } : {}),
    ...(opts.bindings ?? {}),
  };

  function emit(lvl: LogLevel, msg: string, fields?: Record<string, unknown>) {
    if (LEVEL_ORDER[lvl] < threshold) return;
    const ts = new Date().toISOString();
    const redactedFields = fields ? (deepRedact(fields) as Record<string, unknown>) : undefined;
    if (format === 'pretty') {
      const colorOpen = useColor ? LEVEL_COLOR[lvl] : '';
      const colorClose = useColor ? ANSI.reset : '';
      const lvlTag = `${colorOpen}${lvl.toUpperCase().padEnd(5)}${colorClose}`;
      const dimTs = useColor ? `${ANSI.dim}${shortTime(ts)}${ANSI.reset}` : shortTime(ts);
      // Surface agentId / phase / tool prominently when present.
      const agentId = baseBindings.agentId ?? redactedFields?.agentId;
      const phase = baseBindings.phase ?? redactedFields?.phase;
      const tagBits: string[] = [];
      if (phase) tagBits.push(String(phase));
      if (agentId && agentId !== phase) tagBits.push(String(agentId));
      const tag = tagBits.length > 0 ? `[${tagBits.join('/')}] ` : '';
      const fieldsStr = redactedFields
        ? formatFields(
            // strip agentId/phase from the fields tail since we surfaced them in the tag
            Object.fromEntries(
              Object.entries(redactedFields).filter(([k]) => k !== 'agentId' && k !== 'phase'),
            ),
            useColor,
          )
        : '';
      const line = `${dimTs} ${lvlTag} ${tag}${msg}${fieldsStr ? ` ${fieldsStr}` : ''}\n`;
      process.stdout.write(line);
    } else {
      const payload = {
        ts,
        level: lvl,
        ...baseBindings,
        msg,
        ...(redactedFields ?? {}),
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    }
  }

  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child(bindings) {
      return createLogger({ level, format, bindings: { ...baseBindings, ...bindings } });
    },
  };
}
