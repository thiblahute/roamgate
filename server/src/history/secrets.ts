/**
 * What looks like a secret, for everything Roamgate writes out of its
 * stores: the Reviews export, the history repo. A secret never reaches the
 * history repo: every JSON written there goes through withoutSecrets, and
 * a last scan of what is staged (scanDiff) blocks a commit that still
 * holds one, such as a token pasted in a comment.
 */

/** A key whose value is a secret: dropped with its value. */
export const SECRET_KEY =
  /token|secret|passw(or)?d|api[-_]?key|credential|private[-_]?key|cookie|authorization|bearer/i;

/** A value that is a secret, wherever it appears in a text. */
export const SECRET_VALUE =
  /\b(glpat-[\w-]{10,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|xox[abprs]-[\w-]{10,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

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
