//! The history repo's file formats (history/format.ts; docs/ARCHITECTURE.md,
//! "History"):
//!
//! - structured data: JSON with every object's keys sorted, two-space
//!   indent, one trailing newline, no export timestamps ([`stable_json`],
//!   the Reviews export's own code);
//! - prose (Work item descriptions, review threads): Markdown, each part
//!   introduced by a one-line JSON header in an HTML comment, invisible
//!   when rendered ([`render_doc`], [`parse_doc`]);
//! - logs: JSONL, one value per line ([`jsonl`]).

use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub use roamgate_mr_reviews::history::{sorted_keys, stable_json};

/// Values as JSONL: one compact JSON value per line, a trailing newline.
pub fn jsonl(values: &[Value]) -> String {
    if values.is_empty() {
        return String::new();
    }
    let mut out = values
        .iter()
        .map(js::stringify)
        .collect::<Vec<_>>()
        .join("\n");
    out.push('\n');
    out
}

/// JSONL read back: lines that do not parse are skipped.
pub fn parse_jsonl(text: &str) -> Vec<Value> {
    text.split('\n')
        .filter(|line| !js::trim(line).is_empty())
        // A torn last line, or a line written by hand.
        .filter_map(js::parse)
        .collect()
}

/// One part of a prose file: its tag (`item`, `thread`, `comment`), what is
/// not the text as JSON, and the text.
#[derive(Debug, Clone, PartialEq)]
pub struct DocBlock {
    pub tag: String,
    pub meta: Map<String, Value>,
    pub body: String,
}

impl DocBlock {
    pub fn new(tag: &str, meta: Map<String, Value>, body: impl Into<String>) -> Self {
        Self {
            tag: tag.to_owned(),
            meta,
            body: body.into(),
        }
    }
}

/// `^<!-- roamgate:([a-z][a-z0-9-]*) (\{.*\}) -->$`, `.` as JavaScript's
/// (no line terminator).
static MARKER: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new("^<!-- roamgate:([a-z][a-z0-9-]*) (\\{[^\n\r\u{2028}\u{2029}]*\\}) -->$").unwrap()
});
static TAG: LazyLock<Regex> = LazyLock::new(|| Regex::new("^[a-z][a-z0-9-]*$").unwrap());

/// Whether a line would read as a part's header.
fn looks_like_marker(line: &str) -> bool {
    line.starts_with("<!-- roamgate:")
}

/// A prose file: each block as its header line, then its text, blocks
/// separated by a blank line. A text holding a line that reads as a header
/// goes in its header's `body` instead, so every file parses back to the
/// same blocks ([`parse_doc`]).
pub fn render_doc(blocks: &[DocBlock]) -> Result<String, String> {
    let mut parts = Vec::with_capacity(blocks.len());
    for DocBlock { tag, meta, body } in blocks {
        if !TAG.is_match(tag) {
            return Err(format!("bad tag {tag}"));
        }
        let in_header = body.split('\n').any(looks_like_marker);
        let mut header = meta.clone();
        if in_header {
            header.insert("body".into(), Value::String(body.clone()));
        }
        // Never an end of comment inside the header: escaped, read back the same.
        let json = js::stringify(&sorted_keys(&Value::Object(header))).replace("-->", "--\\u003e");
        parts.push(format!(
            "<!-- roamgate:{tag} {json} -->\n{}\n",
            if in_header { "" } else { body }
        ));
    }
    Ok(parts.join("\n"))
}

/// A prose file read back into its blocks; an error on a file it did not
/// write.
pub fn parse_doc(text: &str) -> Result<Vec<DocBlock>, String> {
    let Some(text) = text.strip_suffix('\n') else {
        return Err("a history file ends with a newline".into());
    };
    let mut blocks: Vec<(String, Map<String, Value>, Vec<&str>)> = Vec::new();
    for line in text.split('\n') {
        if let Some(marker) = MARKER.captures(line) {
            let bad = || format!("bad header: {}", js::head16(line, 80));
            let meta = match js::parse(&marker[2]) {
                Some(Value::Object(meta)) => meta,
                _ => return Err(bad()),
            };
            blocks.push((marker[1].to_owned(), meta, Vec::new()));
            continue;
        }
        let Some(current) = blocks.last_mut() else {
            return Err("text before the first header".into());
        };
        current.2.push(line);
    }
    let count = blocks.len();
    let mut out = Vec::with_capacity(count);
    for (index, (tag, mut meta, mut lines)) in blocks.into_iter().enumerate() {
        // Every block but the last is followed by the blank separator line.
        if index + 1 < count {
            if lines.last() != Some(&"") {
                return Err("blocks are separated by a blank line".into());
            }
            lines.pop();
        }
        let in_header = meta.shift_remove("body");
        let body = match in_header {
            Some(Value::String(body)) => body,
            _ => lines.join("\n"),
        };
        out.push(DocBlock { tag, meta, body });
    }
    Ok(out)
}

/// `/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,119}$/`.
fn plain_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    let ok = |byte: &u8, dot: bool| {
        byte.is_ascii_alphanumeric() || *byte == b'_' || *byte == b'-' || (dot && *byte == b'.')
    };
    !bytes.is_empty()
        && bytes.len() <= 120
        && ok(&bytes[0], false)
        && bytes[1..].iter().all(|byte| ok(byte, true))
}

/// A store's id as a file name: kept when it is plain (letters, digits,
/// dot, dash, underscore, not starting with a dot), else a readable part
/// and a short hash, so two ids never share a name.
pub fn file_name_of(id: &str) -> String {
    if plain_id(id) {
        return id.to_owned();
    }
    // id.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "")
    let mut plain = String::new();
    let mut in_run = false;
    for c in id.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            plain.push(c);
            in_run = false;
        } else if !in_run {
            plain.push('-');
            in_run = true;
        }
    }
    let plain = plain.trim_start_matches(['.', '-']);
    let hash = format!("{:x}", Sha256::digest(id.as_bytes()));
    let head: String = plain.chars().take(60).collect();
    format!(
        "{}-{}",
        if head.is_empty() { "id" } else { &head },
        &hash[..12]
    )
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn meta(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    fn round_trip(blocks: &[DocBlock]) -> Vec<DocBlock> {
        parse_doc(&render_doc(blocks).unwrap()).unwrap()
    }

    #[test]
    fn jsonl_writes_one_value_per_line_and_reads_back_skipping_torn_lines() {
        let values = vec![json!({"a": 1}), json!({"b": "x\ny"})];
        assert_eq!(jsonl(&values), "{\"a\":1}\n{\"b\":\"x\\ny\"}\n");
        assert_eq!(parse_jsonl(&format!("{}{{\"torn", jsonl(&values))), values);
        assert_eq!(jsonl(&[]), "");
    }

    #[test]
    fn a_prose_file_reads_back_to_the_same_blocks() {
        let blocks = vec![
            DocBlock::new(
                "thread",
                meta(json!({"id": "t1", "resolved": false})),
                "# Title",
            ),
            DocBlock::new(
                "comment",
                meta(json!({"id": "c1", "author": "you"})),
                "Hello\n\nworld",
            ),
            DocBlock::new("comment", meta(json!({"id": "c2"})), ""),
            DocBlock::new(
                "comment",
                meta(json!({"id": "c3"})),
                "ends with a newline\n",
            ),
            DocBlock::new(
                "comment",
                meta(json!({"id": "c4"})),
                "\n\nleading blank lines",
            ),
        ];
        let back = round_trip(&blocks);
        assert_eq!(back.len(), blocks.len());
        for (back, block) in back.iter().zip(&blocks) {
            assert_eq!(back.tag, block.tag);
            assert_eq!(
                Value::Object(back.meta.clone()),
                Value::Object(block.meta.clone())
            );
            assert_eq!(back.body, block.body);
        }
    }

    #[test]
    fn the_headers_are_one_line_of_json_in_an_html_comment() {
        let text = render_doc(&[DocBlock::new(
            "item",
            meta(json!({"title": "a --> b", "z": 1, "a": 2})),
            "Body",
        )])
        .unwrap();
        assert_eq!(
            text,
            "<!-- roamgate:item {\"a\":2,\"title\":\"a --\\u003e b\",\"z\":1} -->\nBody\n"
        );
        assert_eq!(parse_doc(&text).unwrap()[0].meta["title"], "a --> b");
    }

    #[test]
    fn a_text_holding_a_header_like_line_is_kept_in_its_header() {
        let body = "before\n<!-- roamgate:comment {} -->\nafter";
        let text = render_doc(&[
            DocBlock::new("comment", meta(json!({"id": "c1"})), body),
            DocBlock::new("comment", meta(json!({"id": "c2"})), "next"),
        ])
        .unwrap();
        assert_eq!(
            text.split('\n')
                .filter(|line| line.starts_with("<!--"))
                .count(),
            2
        );
        let back = parse_doc(&text).unwrap();
        assert_eq!(back[0].body, body);
        assert_eq!(Value::Object(back[0].meta.clone()), json!({"id": "c1"}));
        assert_eq!(back[1].body, "next");
    }

    #[test]
    fn a_file_roamgate_did_not_write_is_refused() {
        assert!(parse_doc("no header\n").is_err());
        assert!(parse_doc("<!-- roamgate:item {} -->\nno newline").is_err());
        assert!(parse_doc("<!-- roamgate:item [1] -->\n").is_err());
    }

    #[test]
    fn ids_become_file_names_that_never_collide() {
        assert_eq!(file_name_of("8a057f17bc9203bc"), "8a057f17bc9203bc");
        assert_eq!(file_name_of("roamgate"), "roamgate");
        let odd = file_name_of("a/b");
        assert!(
            Regex::new("^a-b-[0-9a-f]{12}$").unwrap().is_match(&odd),
            "{odd}"
        );
        assert_ne!(odd, file_name_of("a:b"));
        assert!(
            Regex::new("^id-[0-9a-f]{12}$")
                .unwrap()
                .is_match(&file_name_of(".."))
        );
        assert!(file_name_of(".hidden").starts_with("hidden-"));
    }
}
