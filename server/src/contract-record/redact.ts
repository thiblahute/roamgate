import { createHash, randomBytes } from "node:crypto";

/**
 * Redaction for contract recordings (recorder.ts). A recording keeps the
 * shape of every message (keys, types, array lengths) and drops what must
 * never reach a file: credentials, tokens, keystrokes and terminal bytes.
 *
 * - A value under a sensitive key (password, pin, cookie, authorization, any
 *   key ending in token or secret, ...) becomes `[redacted:<tag>]`: the tag
 *   is a salted hash, so the same secret reads the same within one process
 *   (a scenario seed can still tell that a call reused a token) and the salt
 *   never leaves memory.
 * - Strings that look like credentials anywhere (bearer headers, JWTs, forge
 *   and API keys, private keys, URL passwords, token query parameters, push
 *   service endpoints) are replaced in place, and so is every exact secret
 *   the server registers (its auth token, password, PIN, session secret).
 * - Terminal bytes (terminal frames, `terminal.input`) and long base64
 *   strings keep only their length; other long strings are cut.
 *
 * Numbers under a sensitive key become 0 and booleans stay, so a schema check
 * of a redacted message still sees the right types.
 */

export type RedactOptions = {
  /** Strings longer than this are cut (with a `...[+N]` tail). */
  maxString: number;
};

export const DEFAULT_MAX_STRING = 4096;

const SENSITIVE_EXACT = new Set([
  "pin",
  "auth",
  "otp",
  "cookie",
  "set-cookie",
  "authorization",
  "proxy-authorization",
  "p256dh",
  "credentials",
  "credential",
  "private_key",
  "privatekey",
  "api_key",
  "apikey",
  "secret_key",
  "x-api-key",
  "passphrase",
]);

const SENSITIVE_SUFFIXES = [
  "token",
  "secret",
  "password",
  "passwd",
  "cookie",
  "authorization",
];

/** True for a key whose value is a credential. */
export function sensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_EXACT.has(lower)) return true;
  return SENSITIVE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/** Keys whose string values are terminal bytes or keystrokes. */
const TERMINAL_KEYS = new Set(["bytes"]);

const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64_MIN = 64;

type Pattern = {
  re: RegExp;
  replace: (tag: (s: string) => string, ...groups: string[]) => string;
};

const PATTERNS: Pattern[] = [
  {
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: (tag, match) => tag(match),
  },
  {
    re: /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
    replace: (tag, match, scheme) => `${scheme} ${tag(match)}`,
  },
  {
    re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g,
    replace: (tag, match) => tag(match),
  },
  {
    // GitLab (glpat-, gldt-, glrt-, ...), GitHub, Anthropic/OpenAI style,
    // Slack and AWS access keys.
    re: /\b(?:(?:glpat|gldt|glrt|glcbt|glptt|glft|glimt|glagent|gloas|glsoat|glffct)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g,
    replace: (tag, match) => tag(match),
  },
  {
    // A URL's password: scheme://user:password@host
    re: /\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@"']+):([^\s/@"']+)@/gi,
    replace: (tag, _match, prefix, password) =>
      `${prefix}:${tag(password ?? "")}@`,
  },
  {
    // A credential in a query string or form text.
    re: /([?&;](?:[a-z0-9_-]*token|auth|key|password|secret|sig|signature|code|pin)=)([^&\s"'#]+)/gi,
    replace: (tag, _match, prefix, value) => `${prefix}${tag(value ?? "")}`,
  },
  {
    // A Web Push subscription endpoint is a capability URL.
    re: /(https:\/\/(?:fcm\.googleapis\.com|updates\.push\.services\.mozilla\.com|web\.push\.apple\.com|[a-z0-9.-]+\.notify\.windows\.com)\/)[^\s"']+/gi,
    replace: (tag, match, prefix) => `${prefix}${tag(match)}`,
  },
  {
    // A rendered page's token is its credential.
    re: /(\/rendered\/)([A-Za-z0-9_-]{16,})/g,
    replace: (tag, _match, prefix, token) => `${prefix}${tag(token ?? "")}`,
  },
];

/** Any of the patterns could match: one scan before the eight. */
const MAYBE_CREDENTIAL =
  /BEGIN|bearer|eyJ|gl[a-z]{2,6}-|gh[pousr]_|github_pat_|sk-|xox|AKIA|:\/\/|=|\/rendered\//i;

export class Redactor {
  private readonly salt = randomBytes(16);
  private readonly secrets = new Set<string>();
  private secretsRe: RegExp | null = null;
  readonly options: RedactOptions;

  constructor(options: Partial<RedactOptions> = {}) {
    this.options = { maxString: DEFAULT_MAX_STRING, ...options };
  }

  /** An exact value to redact wherever it appears (4 characters at least). */
  addSecret(value: string | null | undefined): void {
    if (!value || value.length < 4 || this.secrets.has(value)) return;
    this.secrets.add(value);
    const escaped = [...this.secrets]
      .sort((a, b) => b.length - a.length)
      .map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    this.secretsRe = new RegExp(escaped.join("|"), "g");
  }

  /** `[redacted:<8 hex>]`: equal secrets read equal within this process. */
  tag(value: string): string {
    const hash = createHash("sha256")
      .update(this.salt)
      .update(value)
      .digest("hex")
      .slice(0, 8);
    return `[redacted:${hash}]`;
  }

  /** Credentials inside free text replaced, then the text cut. */
  string(value: string): string {
    let out = value;
    if (this.secretsRe) out = out.replace(this.secretsRe, (m) => this.tag(m));
    const tag = (s: string) => this.tag(s);
    for (const { re, replace } of MAYBE_CREDENTIAL.test(out) ? PATTERNS : []) {
      re.lastIndex = 0;
      if (!re.test(out)) continue;
      re.lastIndex = 0;
      out = out.replace(re, (...args) =>
        replace(tag, ...(args.slice(0, -2) as string[])),
      );
    }
    if (out.length >= BASE64_MIN && BASE64_RE.test(out))
      return `[base64:${out.length}]`;
    if (out.length > this.options.maxString)
      return `${out.slice(0, this.options.maxString)}...[+${out.length - this.options.maxString}]`;
    return out;
  }

  /** Every leaf of a credential's value redacted, keeping its type. */
  private secret(value: unknown): unknown {
    if (typeof value === "string") return this.tag(value);
    if (typeof value === "number") return 0;
    if (Array.isArray(value)) return value.map((item) => this.secret(item));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value))
        out[key] = this.secret(item);
      return out;
    }
    return value;
  }

  /** A deep copy of a JSON value with its credentials redacted. */
  value(value: unknown, depth = 0): unknown {
    if (typeof value === "string") return this.string(value);
    if (value === null || typeof value !== "object") return value;
    if (depth > 64) return "[depth]";
    if (Array.isArray(value))
      return value.map((item) => this.value(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (sensitiveKey(key)) out[key] = this.secret(item);
      else if (TERMINAL_KEYS.has(key) && typeof item === "string")
        out[key] = `[terminal:${item.length}]`;
      else out[key] = this.value(item, depth + 1);
    }
    return out;
  }

  /**
   * A browser RPC request: keystrokes (`terminal.input`) keep only their
   * length, the rest goes through value().
   */
  message(message: unknown): unknown {
    if (
      message &&
      typeof message === "object" &&
      !Array.isArray(message) &&
      (message as { method?: unknown }).method === "terminal.input"
    ) {
      const { params, ...rest } = message as {
        params?: Record<string, unknown>;
      };
      const data = params?.data;
      return this.value({
        ...rest,
        params: {
          ...params,
          data: typeof data === "string" ? `[terminal:${data.length}]` : data,
        },
      });
    }
    return this.value(message);
  }

  /** Headers as an object, credentials redacted. */
  headers(headers: Headers): Record<string, string> {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = sensitiveKey(key) ? this.tag(value) : this.string(value);
    });
    return out;
  }

  /** A path plus query, with credential parameters redacted. */
  url(url: URL): { path: string; query?: Record<string, string> } {
    const path = this.string(url.pathname);
    if (!url.search) return { path };
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams)
      query[key] =
        sensitiveKey(key) || key === "key" || key === "code"
          ? this.tag(value)
          : this.string(value);
    return { path, query };
  }

  /** A form body (the agent socket's) as an object, values decoded. */
  form(body: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of new URLSearchParams(body)) {
      if (sensitiveKey(key)) {
        out[key] = this.tag(raw);
        continue;
      }
      // Agents pass JSON inside fields (a tool's input, questions): keep its
      // shape so it can be checked.
      let value: unknown = raw;
      if (/^\s*[[{]/.test(raw)) {
        try {
          value = JSON.parse(raw);
        } catch {}
      }
      const redacted = this.value(value);
      if (key in out) {
        const previous = out[key];
        out[key] = Array.isArray(previous)
          ? [...previous, redacted]
          : [previous, redacted];
      } else out[key] = redacted;
    }
    return out;
  }
}
