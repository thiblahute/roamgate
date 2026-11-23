//! What looks like a secret (utils/secrets.ts), for everything Roamgate
//! writes out of its stores: the Reviews export and the history repo drop or
//! block it ([`without_secrets`], [`scan_diff`]), and the archive's
//! conversation text replaces it in free text ([`redact_secrets`]). One list
//! of patterns for all.

use std::cell::Cell;
use std::sync::LazyLock;

use fancy_regex::Regex as FancyRegex;
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

/// A key whose value is a secret: dropped with its value.
pub static SECRET_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)token|secret|passw(or)?d|api[-_]?key|credential|private[-_]?key|cookie|authorization|bearer",
    )
    .unwrap()
});

/// Secret values by their shape: provider token prefixes, private keys.
const VALUE_PATTERNS: &[&str] = &[
    r"\b(?:glpat|gldt|glrt|glptt|glsoat)-[A-Za-z0-9_-]{10,}",
    r"\bgh[pousr]_[A-Za-z0-9]{20,}",
    r"\bgithub_pat_[A-Za-z0-9_]{20,}",
    r"\bxox[abprs]-[A-Za-z0-9_-]{10,}",
    r"\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}",
    r"\bAKIA[0-9A-Z]{16}\b",
    r"\bAIza[0-9A-Za-z_-]{35}\b",
    r"\bnpm_[A-Za-z0-9]{36}\b",
    r"\bhf_[A-Za-z0-9]{30,}\b",
    r"\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}",
    // A private key block, or its first line when the block is cut.
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----(?:[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----)?",
];

/// A value that is a secret, wherever it appears in a text.
pub static SECRET_VALUE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&VALUE_PATTERNS.join("|")).unwrap());

/// A copy without anything that looks like a secret (by key or by value).
pub fn without_secrets(value: &Value) -> Value {
    match value {
        Value::String(text) => {
            Value::String(SECRET_VALUE.replace_all(text, "[removed]").into_owned())
        }
        Value::Array(items) => Value::Array(items.iter().map(without_secrets).collect()),
        Value::Object(object) => Value::Object(
            object
                .iter()
                .filter(|(key, _)| !SECRET_KEY.is_match(key))
                .map(|(key, each)| (key.clone(), without_secrets(each)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// A secret found in a diff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SecretHit {
    /// The file's path in the repo.
    pub file: String,
    /// Its line in the new version of the file.
    pub line: u64,
    /// What was found, shortened so the status never shows the secret.
    pub kind: String,
}

static KIND_PREFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^[a-z]+[-_]").unwrap());
static HUNK_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\+(\d+)").unwrap());

fn kind_of(found: &str) -> String {
    if found.starts_with("-----BEGIN") {
        return "private key".into();
    }
    let prefix = match KIND_PREFIX.find(found) {
        Some(prefix) => prefix.as_str().to_owned(),
        None => found.chars().take(4).collect(),
    };
    format!("{prefix}... token")
}

/// The secrets in the lines a diff adds (`git diff -U0` output): each with
/// its file and line in the new version.
pub fn scan_diff(diff: &str) -> Vec<SecretHit> {
    let mut hits = Vec::new();
    let mut file = String::new();
    let mut line = 0u64;
    for text in diff.split('\n') {
        if let Some(path) = text.strip_prefix("+++ ") {
            file = if path == "/dev/null" {
                String::new()
            } else {
                path.strip_prefix("b/").unwrap_or(path).to_owned()
            };
            continue;
        }
        if text.starts_with("@@") {
            line = HUNK_START
                .captures(text)
                .and_then(|found| found[1].parse().ok())
                .unwrap_or(0);
            continue;
        }
        if let Some(added) = text.strip_prefix('+') {
            if let Some(found) = SECRET_VALUE.find(added)
                && !file.is_empty()
            {
                hits.push(SecretHit {
                    file: file.clone(),
                    line,
                    kind: kind_of(found.as_str()),
                });
            }
            line += 1;
        } else if text.starts_with(' ') {
            line += 1;
        }
    }
    hits
}

/// What a secret in free text becomes.
pub const SECRET_MARK: &str = "[secret]";

/// Credentials inside a URL: scheme://user:password@host.
static URL_CREDENTIALS: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\b([a-z][a-z\d+.\-]*://[^\s:/@]+:)[^\s@/]+@").unwrap());
/// Authorization: Bearer|Basic|token <value>.
static AUTH_HEADER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#"(?i)\b((?:proxy-)?authorization\s*:\s*(?:bearer|basic|token)\s+)[^\s"',;]+"#)
        .unwrap()
});
/// key=value or key: value with a secret-sounding key and a literal value.
static SECRET_PAIR: LazyLock<FancyRegex> = LazyLock::new(|| {
    FancyRegex::new(
        r#"(?i)(["']?\b(?:password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?token)["']?\s*[:=]\s*)(?:"[^"\s]{6,}"|'[^'\s]{6,}'|[A-Za-z0-9+/=_~!@#$%^*-]{8,}(?![A-Za-z0-9_(.\[]))"#,
    )
    .unwrap()
});

/// A key of [`SECRET_PAIR`]: no pair without one.
static SECRET_PAIR_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)password|passwd|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?token",
    )
    .unwrap()
});

/// A text with its secrets replaced, and how many.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Redacted {
    pub text: String,
    pub count: usize,
}

/// `text` with every secret-looking value replaced by `[secret]`, and how
/// many: the secret values above, credentials in URLs, Authorization
/// headers and the value of a `password=` / `token: ` pair.
pub fn redact_secrets(text: &str) -> Redacted {
    let count = Cell::new(0usize);
    let mark = |prefix: &str| {
        count.set(count.get() + 1);
        format!("{prefix}{SECRET_MARK}")
    };
    let out = SECRET_VALUE.replace_all(text, |_: &regex::Captures<'_>| mark(""));
    let out = URL_CREDENTIALS.replace_all(&out, |found: &regex::Captures<'_>| {
        format!("{}@", mark(&found[1]))
    });
    let out = AUTH_HEADER.replace_all(&out, |found: &regex::Captures<'_>| mark(&found[1]));
    // The pair's lookahead needs the backtracking engine, slow on every
    // line of a transcript: only run it where one of its keys appears.
    if !SECRET_PAIR_KEY.is_match(&out) {
        return Redacted {
            text: out.into_owned(),
            count: count.get(),
        };
    }
    let out = SECRET_PAIR.replace_all(&out, |found: &fancy_regex::Captures<'_>| {
        let whole = found.get(0).map(|m| m.as_str()).unwrap_or("");
        let prefix = found.get(1).map(|m| m.as_str()).unwrap_or("");
        if whole[prefix.len()..].contains(SECRET_MARK) {
            whole.to_owned()
        } else {
            mark(prefix)
        }
    });
    Redacted {
        text: out.into_owned(),
        count: count.get(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn without_secrets_drops_secret_keys_and_replaces_secret_values() {
        assert_eq!(
            without_secrets(&json!({
                "name": "x",
                "ANTHROPIC_AUTH_TOKEN": "abc",
                "env": { "password": "p", "HOME": "/h" },
                "note": "my token glpat-abcdefghijklmnop here",
                "list": ["ghp_abcdefghijklmnopqrstuvwx1234", 1],
            })),
            json!({
                "name": "x",
                "env": { "HOME": "/h" },
                "note": "my token [removed] here",
                "list": ["[removed]", 1],
            })
        );
    }

    #[test]
    fn scan_diff_names_the_file_and_line_of_each_secret_a_diff_adds() {
        let diff = [
            "diff --git a/work/items/a.md b/work/items/a.md",
            "--- a/work/items/a.md",
            "+++ b/work/items/a.md",
            "@@ -3,0 +4,2 @@",
            "+fine",
            "+token glpat-abcdefghijklmnop",
            "diff --git a/reviews/x.md b/reviews/x.md",
            "new file mode 100644",
            "--- /dev/null",
            "+++ b/reviews/x.md",
            "@@ -0,0 +1,3 @@",
            "+-----BEGIN OPENSSH PRIVATE KEY-----",
            "+ok",
            "+sk-abcdefghijklmnopqrstuvwxyz",
            "diff --git a/gone.md b/gone.md",
            "--- a/gone.md",
            "+++ /dev/null",
            "@@ -1 +0,0 @@",
            "-glpat-abcdefghijklmnop",
        ]
        .join("\n");
        let hit = |file: &str, line, kind: &str| SecretHit {
            file: file.into(),
            line,
            kind: kind.into(),
        };
        assert_eq!(
            scan_diff(&diff),
            vec![
                hit("work/items/a.md", 5, "glpat-... token"),
                hit("reviews/x.md", 1, "private key"),
                hit("reviews/x.md", 3, "sk-... token"),
            ]
        );
    }

    #[test]
    fn a_removed_secret_or_a_clean_diff_is_no_hit() {
        assert!(
            scan_diff("+++ b/a\n@@ -1 +1 @@\n-ghp_abcdefghijklmnopqrstuvwx1234\n+clean").is_empty()
        );
    }

    #[test]
    fn redact_secrets_replaces_tokens_keys_credentials_and_pairs() {
        let cases = [
            ("token glpat-abcdefghij1234567890 here".to_owned(), "token [secret] here".to_owned()),
            (format!("gh ghp_{}", "a".repeat(36)), "gh [secret]".into()),
            (format!("key sk-ant-{}", "x".repeat(40)), "key [secret]".into()),
            ("aws AKIAABCDEFGHIJKLMNOP".into(), "aws [secret]".into()),
            (
                "https://user:hunter2pass@example.com/repo".into(),
                "https://user:[secret]@example.com/repo".into(),
            ),
            (
                "Authorization: Bearer abc.def.ghi123".into(),
                "Authorization: Bearer [secret]".into(),
            ),
            ("password=\"correct-horse\"".into(), "password=[secret]".into()),
            ("export API_KEY=Zx81kdP2qq9".into(), "export API_KEY=[secret]".into()),
            (
                "-----BEGIN OPENSSH PRIVATE KEY----- \u{23ce} b3BlbnNzaC1rZXk \u{23ce} -----END OPENSSH PRIVATE KEY-----".into(),
                "[secret]".into(),
            ),
        ];
        for (input, expected) in cases {
            let out = redact_secrets(&input);
            assert_eq!(out.text, expected, "{input}");
            assert!(out.count > 0, "{input}");
        }
    }

    #[test]
    fn redact_secrets_leaves_ordinary_text_and_code_alone() {
        for text in [
            "the secret is to keep going",
            "const password = getPassword();",
            "token = os.environ['TOKEN']",
            "sk-learn is a library",
            "https://example.com/path?x=1",
        ] {
            let out = redact_secrets(text);
            assert_eq!(out.text, text);
            assert_eq!(out.count, 0);
        }
    }
}
