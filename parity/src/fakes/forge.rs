//! fake-glab and fake-gh `api` answers: a GraphQL answer cut down to the
//! fields the query asks, and the HTTP head `--include` asks for (status,
//! ETag, Retry-After and the rate-limit headers).
//!
//! A rule's answer may hold, besides the usual output (script.rs):
//! - `graphql`: the `data` to answer with, keyed by the query's response
//!   names (aliases); only what the query selects is printed, so a query
//!   asking for fewer fields gets fewer back, as from a real forge;
//! - `graphql_errors`: GraphQL `errors` printed next to the data;
//! - `body`: a JSON value printed as it is (REST);
//! - `http_status` (default 200) and `http_headers`: printed before the
//!   body as glab and gh print them, only when the call has `--include`.

use std::io::Write;
use std::path::Path;

#[cfg(test)]
use serde_json::json;
use serde_json::{Map, Value};

use super::respond;
use super::script::Answer;

#[derive(Debug, Clone, PartialEq)]
enum Selection {
    Field {
        key: String,
        children: Vec<Selection>,
    },
    Fragment(Vec<Selection>),
}

fn tokens(text: &str) -> Vec<String> {
    let chars: Vec<char> = text.chars().collect();
    let mut out = Vec::new();
    let mut at = 0;
    while at < chars.len() {
        let c = chars[at];
        if c.is_whitespace() || c == ',' {
            at += 1;
        } else if c == '#' {
            while at < chars.len() && chars[at] != '\n' {
                at += 1;
            }
        } else if c == '"' {
            let start = at;
            at += 1;
            while at < chars.len() && chars[at] != '"' {
                if chars[at] == '\\' {
                    at += 1;
                }
                at += 1;
            }
            at += 1;
            out.push(chars[start..at.min(chars.len())].iter().collect());
        } else if c == '.' && chars.get(at + 1) == Some(&'.') && chars.get(at + 2) == Some(&'.') {
            out.push("...".into());
            at += 3;
        } else if c.is_alphanumeric() || c == '_' || c == '$' {
            let start = at;
            while at < chars.len()
                && (chars[at].is_alphanumeric() || chars[at] == '_' || chars[at] == '$')
            {
                at += 1;
            }
            out.push(chars[start..at].iter().collect());
        } else {
            out.push(c.to_string());
            at += 1;
        }
    }
    out
}

struct Parser {
    tokens: Vec<String>,
    at: usize,
}

impl Parser {
    fn peek(&self) -> Option<&str> {
        self.tokens.get(self.at).map(String::as_str)
    }

    fn next(&mut self) -> Option<String> {
        let token = self.tokens.get(self.at).cloned();
        self.at += 1;
        token
    }

    /// Skips a balanced `( ... )`.
    fn skip_parens(&mut self) {
        if self.peek() != Some("(") {
            return;
        }
        let mut depth = 0;
        while let Some(token) = self.next() {
            match token.as_str() {
                "(" => depth += 1,
                ")" => {
                    depth -= 1;
                    if depth == 0 {
                        return;
                    }
                }
                _ => {}
            }
        }
    }

    fn skip_directives(&mut self) {
        while self.peek() == Some("@") {
            self.next();
            self.next();
            self.skip_parens();
        }
    }

    fn set(&mut self) -> Vec<Selection> {
        let mut out = Vec::new();
        if self.peek() != Some("{") {
            return out;
        }
        self.next();
        while let Some(token) = self.peek() {
            if token == "}" {
                self.next();
                break;
            }
            if token == "..." {
                self.next();
                if self.peek() == Some("on") {
                    self.next();
                    self.next();
                }
                self.skip_directives();
                out.push(Selection::Fragment(self.set()));
                continue;
            }
            let name = self.next().unwrap_or_default();
            let key = if self.peek() == Some(":") {
                self.next();
                self.next();
                name
            } else {
                name
            };
            self.skip_parens();
            self.skip_directives();
            let children = self.set();
            out.push(Selection::Field { key, children });
        }
        out
    }
}

fn parse(query: &str) -> Vec<Selection> {
    let mut parser = Parser {
        tokens: tokens(query),
        at: 0,
    };
    // `query Name($a: T) { ... }` or `{ ... }`.
    while let Some(token) = parser.peek() {
        if token == "{" {
            break;
        }
        if token == "(" {
            parser.skip_parens();
        } else {
            parser.next();
        }
    }
    parser.set()
}

fn prune_with(value: &Value, selections: &[Selection]) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .map(|item| prune_with(item, selections))
                .collect(),
        ),
        Value::Object(map) => {
            let mut out = Map::new();
            collect(map, selections, &mut out);
            Value::Object(out)
        }
        other => other.clone(),
    }
}

fn collect(map: &Map<String, Value>, selections: &[Selection], out: &mut Map<String, Value>) {
    for selection in selections {
        match selection {
            Selection::Fragment(children) => collect(map, children, out),
            Selection::Field { key, children } => {
                let Some(value) = map.get(key) else { continue };
                let pruned = if children.is_empty() {
                    value.clone()
                } else {
                    prune_with(value, children)
                };
                out.insert(key.clone(), pruned);
            }
        }
    }
}

/// `data` with only what `query` selects.
pub fn prune(data: &Value, query: &str) -> Value {
    prune_with(data, &parse(query))
}

/// The GraphQL query of a glab or gh `api` call (`-f query=...`).
pub fn query_of(args: &[String]) -> Option<String> {
    args.windows(2).find_map(|pair| {
        (matches!(pair[0].as_str(), "-f" | "-F" | "--raw-field" | "--field"))
            .then(|| pair[1].strip_prefix("query="))
            .flatten()
            .map(str::to_owned)
    })
}

/// Whether the answer is one of this module's.
pub fn handles(answer: &Answer) -> bool {
    [
        "graphql",
        "graphql_errors",
        "body",
        "http_status",
        "http_headers",
    ]
    .iter()
    .any(|key| answer.extra.contains_key(*key))
}

pub fn run(args: &[String], answer: &Answer, base: &Path) -> i32 {
    if !handles(answer) {
        return respond(answer, base);
    }
    let mut out = String::new();
    if args.iter().any(|arg| arg == "--include" || arg == "-i") {
        let status = answer
            .extra
            .get("http_status")
            .and_then(Value::as_u64)
            .unwrap_or(200);
        out.push_str(&format!("HTTP/2.0 {status} {}\r\n", reason(status)));
        if let Some(Value::Object(headers)) = answer.extra.get("http_headers") {
            for (name, value) in headers {
                let value = value
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| value.to_string());
                out.push_str(&format!("{name}: {value}\r\n"));
            }
        }
        out.push_str("\r\n");
    }
    if let Some(body) = answer.extra.get("body") {
        out.push_str(&body.to_string());
        out.push('\n');
    } else if answer.extra.contains_key("graphql") || answer.extra.contains_key("graphql_errors") {
        let mut body = Map::new();
        if let Some(data) = answer.extra.get("graphql") {
            let query = query_of(args).unwrap_or_default();
            body.insert("data".into(), prune(data, &query));
        }
        if let Some(errors) = answer.extra.get("graphql_errors") {
            body.insert("errors".into(), errors.clone());
        }
        out.push_str(&Value::Object(body).to_string());
        out.push('\n');
    }
    let plain = Answer {
        stdout: Some(format!("{out}{}", answer.stdout_text())),
        stdout_json: None,
        stdout_lines: None,
        ..answer.clone()
    };
    let _ = std::io::stdout().flush();
    respond(&plain, base)
}

fn reason(status: u64) -> &'static str {
    match status {
        200 => "OK",
        304 => "Not Modified",
        403 => "Forbidden",
        404 => "Not Found",
        429 => "Too Many Requests",
        503 => "Service Unavailable",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_selected_fields_by_alias_through_fragments() {
        let data = json!({
            "viewer": {"login": "me", "name": "Me"},
            "rr": {"nodes": [{"number": 1, "title": "t", "extra": true, "repository": {"nameWithOwner": "a/b", "id": 3}}]},
            "unasked": 1
        });
        let query = r#"query { viewer { login } rr: search(type: ISSUE, query: "is:pr { x }", first: 50) { nodes { ... on PullRequest { number title repository { nameWithOwner } } } } }"#;
        assert_eq!(
            prune(&data, query),
            json!({"viewer": {"login": "me"}, "rr": {"nodes": [{"number": 1, "title": "t", "repository": {"nameWithOwner": "a/b"}}]}})
        );
    }

    #[test]
    fn finds_the_query_argument() {
        let args: Vec<String> = ["api", "graphql", "-f", "query={ a }"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(query_of(&args).as_deref(), Some("{ a }"));
    }
}
