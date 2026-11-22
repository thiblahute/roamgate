/**
 * What looks like a secret, for everything Roamgate writes out of its
 * stores: the Reviews export and the history repo drop or block it
 * (withoutSecrets, scanDiff: a commit that still holds one, such as a token
 * pasted in a comment, is blocked), and the archive's conversation text repo
 * replaces it in free text (redactSecrets). One list of patterns for all.
 */

/** A key whose value is a secret: dropped with its value. */
export const SECRET_KEY =
  /token|secret|passw(or)?d|api[-_]?key|credential|private[-_]?key|cookie|authorization|bearer/i;

/** Secret values by their shape: provider token prefixes, private keys. */
const VALUE_PATTERNS = [
  String.raw`\b(?:glpat|gldt|glrt|glptt|glsoat)-[\w-]{10,}`,
  String.raw`\bgh[pousr]_[A-Za-z0-9]{20,}`,
  String.raw`\bgithub_pat_\w{20,}`,
  String.raw`\bxox[abprs]-[\w-]{10,}`,
  String.raw`\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}`,
  String.raw`\bAKIA[0-9A-Z]{16}\b`,
  String.raw`\bAIza[0-9A-Za-z_-]{35}\b`,
  String.raw`\bnpm_[A-Za-z0-9]{36}\b`,
  String.raw`\bhf_[A-Za-z0-9]{30,}\b`,
  String.raw`\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}`,
  // A private key block, or its first line when the block is cut.
  String.raw`-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?`,
];

/** A value that is a secret, wherever it appears in a text. */
export const SECRET_VALUE = new RegExp(VALUE_PATTERNS.join("|"));

/** A copy without anything that looks like a secret (by key or by value). */
export function withoutSecrets(value: unknown): unknown {
  if (typeof value === "string")
    return SECRET_VALUE.test(value)
      ? value.replace(new RegExp(SECRET_VALUE.source, "g"), "[removed]")
      : value;
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => !SECRET_KEY.test(key))
        .map(([key, each]) => [key, withoutSecrets(each)]),
    );
  return value;
}

export type SecretHit = {
  /** The file's path in the repo. */
  file: string;
  /** Its line in the new version of the file. */
  line: number;
  /** What was found, shortened so the status never shows the secret. */
  kind: string;
};

function kindOf(match: string): string {
  if (match.startsWith("-----BEGIN")) return "private key";
  return `${/^[a-z]+[-_]/i.exec(match)?.[0] ?? match.slice(0, 4)}... token`;
}

/**
 * The secrets in the lines a diff adds (`git diff -U0` output): each with
 * its file and line in the new version.
 */
export function scanDiff(diff: string): SecretHit[] {
  const hits: SecretHit[] = [];
  let file = "";
  let line = 0;
  for (const text of diff.split("\n")) {
    if (text.startsWith("+++ ")) {
      const path = text.slice(4);
      file = path === "/dev/null" ? "" : path.replace(/^b\//, "");
      continue;
    }
    if (text.startsWith("@@")) {
      const hunk = /\+(\d+)/.exec(text);
      line = hunk ? Number(hunk[1]) : 0;
      continue;
    }
    if (text.startsWith("+")) {
      const match = SECRET_VALUE.exec(text.slice(1));
      if (match && file) hits.push({ file, line, kind: kindOf(match[0]) });
      line++;
    } else if (text.startsWith(" ")) line++;
  }
  return hits;
}

// ------------------------------------------------- free text (redaction)

/** What a secret in free text becomes. */
export const SECRET_MARK = "[secret]";

/** Credentials inside a URL: scheme://user:password@host. */
const URL_CREDENTIALS = /\b([a-z][a-z\d+.-]*:\/\/[^\s:/@]+:)[^\s@/]+@/gi;
/** Authorization: Bearer|Basic|token <value>. */
const AUTH_HEADER =
  /\b((?:proxy-)?authorization\s*:\s*(?:bearer|basic|token)\s+)[^\s"',;]+/gi;
/** key=value or key: value with a secret-sounding key and a literal value. */
const SECRET_PAIR =
  /(["']?\b(?:password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?token)["']?\s*[:=]\s*)(?:"[^"\s]{6,}"|'[^'\s]{6,}'|[A-Za-z0-9+/=_~!@#$%^*-]{8,}(?![\w(.[]))/gi;

export type Redacted = { text: string; count: number };

/**
 * `text` with every secret-looking value replaced by [secret], and how
 * many: the secret values above, credentials in URLs, Authorization
 * headers and the value of a `password=` / `token: ` pair.
 */
export function redactSecrets(text: string): Redacted {
  let count = 0;
  const mark = (prefix: string) => {
    count += 1;
    return `${prefix}${SECRET_MARK}`;
  };
  let out = text.replace(new RegExp(SECRET_VALUE.source, "g"), () => mark(""));
  out = out.replace(
    URL_CREDENTIALS,
    (_match, prefix: string) => `${mark(prefix)}@`,
  );
  out = out.replace(AUTH_HEADER, (_match, prefix: string) => mark(prefix));
  out = out.replace(SECRET_PAIR, (match, prefix: string) =>
    match.slice(prefix.length).includes(SECRET_MARK) ? match : mark(prefix),
  );
  return { text: out, count };
}
