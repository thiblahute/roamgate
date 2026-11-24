//! Reviews in the history (history/reviews.ts):
//! `reviews/<yyyy>/<review>/review.json` (the session, and the images its
//! comments show), one Markdown file per thread, `<thread>.md` (the
//! thread's header, a title line, then each comment's header and text),
//! and the screenshots, content-addressed, in
//! `reviews/images/<sha256>.<ext>` (one stored once however often used;
//! one over 5 MB stays out and review.json says so). A review is placed by
//! the year it was made.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

use regex::Regex;
use roamgate_agents::js;
use roamgate_base::secrets::without_secrets;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use crate::area::{AreaRender, HistoryArea, ReviewSource, count};
use crate::format::{DocBlock, file_name_of, parse_doc, render_doc, stable_json};

/// A screenshot larger than this stays out of git (the backup target
/// keeps it).
pub const HISTORY_IMAGE_MAX_BYTES: u64 = 5 * 1024 * 1024;

static IMAGE_REF: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"images[\\/]([0-9a-f]{16})[\\/]([0-9a-f]{16}\.(?:png|jpg|gif|webp))").unwrap()
});

/// `reviews/<year>/<id>/`, the year the review was made (`undated`).
pub fn review_dir(session: &Value) -> String {
    let created = js::sv(session.get("createdAt"));
    let year = created
        .get(..4)
        .filter(|head| head.bytes().all(|byte| byte.is_ascii_digit()))
        .unwrap_or("undated");
    format!(
        "reviews/{year}/{}/",
        file_name_of(js::sv(session.get("id")))
    )
}

/// `title.replace(/\s*\n\s*/g, " ").trim()`: a run of white space holding
/// a line break becomes one space.
fn one_line(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut run = String::new();
    let flush = |out: &mut String, run: &mut String| {
        if run.contains('\n') {
            out.push(' ');
        } else {
            out.push_str(run);
        }
        run.clear();
    };
    for c in title.chars() {
        if js::is_js_space(c) || c == '\u{FEFF}' {
            run.push(c);
        } else {
            flush(&mut out, &mut run);
            out.push(c);
        }
    }
    flush(&mut out, &mut run);
    js::trim(&out).to_owned()
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        _ => Map::new(),
    }
}

/// A thread's file: its header and title, then each comment.
pub fn render_thread(thread: &Value, title: &str) -> Result<String, String> {
    let mut rest = thread.as_object().cloned().unwrap_or_default();
    let comments = rest.shift_remove("comments");
    let heading = one_line(title);
    let mut blocks = vec![DocBlock::new(
        "thread",
        object(without_secrets(&Value::Object(rest))),
        format!(
            "# {}",
            if heading.is_empty() {
                "Review"
            } else {
                &heading
            }
        ),
    )];
    for comment in comments
        .as_ref()
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let mut meta = comment.as_object().cloned().unwrap_or_default();
        let body = match meta.shift_remove("body") {
            Some(Value::String(body)) => body,
            _ => return Err("a comment without a text".into()),
        };
        blocks.push(DocBlock::new(
            "comment",
            object(without_secrets(&Value::Object(meta))),
            body,
        ));
    }
    render_doc(&blocks)
}

/// A thread's file read back (its title line is not part of the thread).
pub fn parse_thread(text: &str) -> Result<Value, String> {
    let mut blocks = parse_doc(text)?.into_iter();
    let head = blocks
        .next()
        .filter(|head| head.tag == "thread")
        .ok_or("not a thread file")?;
    let mut comments = Vec::new();
    for block in blocks {
        if block.tag != "comment" {
            return Err("a thread file holds comments only".into());
        }
        let mut comment = block.meta;
        comment.insert("body".into(), Value::String(block.body));
        comments.push(Value::Object(comment));
    }
    let mut thread = head.meta;
    thread.insert("comments".into(), Value::Array(comments));
    Ok(Value::Object(thread))
}

/// The session as kept: without what only says what an agent is doing now.
fn kept_session(session: &Value) -> Value {
    let working = session.get("agent").and_then(|agent| agent.get("working"));
    let truthy = match working {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0),
        Some(_) => true,
    };
    if !truthy {
        return session.clone();
    }
    let mut session = session.clone();
    if let Some(agent) = session.get_mut("agent").and_then(Value::as_object_mut) {
        agent.shift_remove("working");
    }
    session
}

fn extension_of(name: &str) -> &str {
    name.rsplit_once('.')
        .map_or(name, |(_, extension)| extension)
}

/// The reviews area.
pub struct ReviewsArea {
    /// The review directory (its `images/`).
    pub reviews: PathBuf,
    pub source: Arc<dyn Fn() -> Option<Arc<dyn ReviewSource>> + Send + Sync>,
}

impl HistoryArea for ReviewsArea {
    fn name(&self) -> &str {
        "reviews"
    }

    fn render(&self, ids: Option<&[String]>) -> Result<AreaRender, String> {
        let mut render = AreaRender::default();
        let store = (self.source)().ok_or("the review store is not open")?;
        let all = store.load_sessions()?;
        render.owns = match ids {
            Some(ids) => ids
                .iter()
                .map(|id| format!("reviews/*/{}/", file_name_of(id)))
                .collect(),
            None => vec!["reviews/".into()],
        };
        let mut images: BTreeMap<String, Vec<u8>> = BTreeMap::new();
        for session in &all {
            let id = js::sv(session.get("id"));
            if ids.is_some_and(|ids| !ids.iter().any(|each| each == id)) {
                continue;
            }
            let dir = review_dir(session);
            let threads = store.load_threads(id)?;
            let mut used = Map::new();
            let mut texts: Vec<&str> = vec![js::sv(session.get("summary"))];
            for thread in &threads {
                for comment in thread
                    .get("comments")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                {
                    texts.push(js::sv(comment.get("body")));
                }
            }
            for text in texts {
                for found in IMAGE_REF.captures_iter(text) {
                    let key = format!("{}/{}", &found[1], &found[2]);
                    if used.contains_key(&key) {
                        continue;
                    }
                    let full = self.reviews.join("images").join(&found[1]).join(&found[2]);
                    // Gone: the comment links to nothing either way.
                    let Ok(info) = std::fs::metadata(&full) else {
                        continue;
                    };
                    if info.len() > HISTORY_IMAGE_MAX_BYTES {
                        used.insert(
                            key,
                            json!({"omitted": "larger than 5 MB", "bytes": info.len()}),
                        );
                        continue;
                    }
                    let Ok(data) = std::fs::read(&full) else {
                        continue;
                    };
                    let name = format!("{:x}.{}", Sha256::digest(&data), extension_of(&found[2]));
                    used.insert(key, Value::String(name.clone()));
                    images.insert(format!("reviews/images/{name}"), data);
                }
            }
            let mut kept = Map::new();
            kept.insert("session".into(), without_secrets(&kept_session(session)));
            if !used.is_empty() {
                kept.insert("images".into(), Value::Object(used));
            }
            render.set(
                format!("{dir}review.json"),
                stable_json(&Value::Object(kept)),
            );
            let title = js::sv(session.get("title"));
            for thread in &threads {
                render.set(
                    format!("{dir}{}.md", file_name_of(js::sv(thread.get("id")))),
                    render_thread(thread, title)?,
                );
            }
        }
        render.files.extend(images);
        Ok(render)
    }

    fn describe(&self, paths: &[String]) -> Option<String> {
        static IN_REVIEW: LazyLock<Regex> =
            LazyLock::new(|| Regex::new(r"^reviews/[^/]+/([^/]+)/(.+)$").unwrap());
        let mut reviews = std::collections::HashSet::new();
        let mut threads = 0;
        let mut images = 0;
        for path in paths {
            if path.starts_with("reviews/images/") {
                images += 1;
            } else if let Some(found) = IN_REVIEW.captures(path) {
                reviews.insert(found[1].to_owned());
                if found[2].ends_with(".md") {
                    threads += 1;
                }
            }
        }
        let parts = [
            if threads > 0 {
                format!(
                    "{} in {}",
                    count(threads, "thread"),
                    count(reviews.len(), "review")
                )
            } else if !reviews.is_empty() {
                count(reviews.len(), "review")
            } else {
                String::new()
            },
            if images > 0 {
                count(images, "image")
            } else {
                String::new()
            },
        ];
        Some(
            parts
                .into_iter()
                .filter(|part| !part.is_empty())
                .collect::<Vec<_>>()
                .join(", "),
        )
    }
}

/// The review store's file, read only (the review service has it open):
/// each record as stored, in the store's order.
pub struct SqliteReviews {
    path: PathBuf,
    db: Mutex<Option<rusqlite::Connection>>,
}

impl SqliteReviews {
    /// `<dir>/reviews.sqlite`, opened at the first read.
    pub fn new(dir: &Path) -> Self {
        Self {
            path: dir.join("reviews.sqlite"),
            db: Mutex::new(None),
        }
    }

    fn rows(&self, sql: &str, param: Option<&str>) -> Result<Vec<Value>, String> {
        let mut db = self.db.lock().unwrap_or_else(|e| e.into_inner());
        if db.is_none() {
            if !self.path.exists() {
                return Ok(Vec::new());
            }
            let opened = rusqlite::Connection::open_with_flags(
                &self.path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|error| error.to_string())?;
            opened
                .busy_timeout(std::time::Duration::from_millis(5000))
                .map_err(|error| error.to_string())?;
            *db = Some(opened);
        }
        let connection = db.as_ref().expect("opened above");
        let result = (|| -> rusqlite::Result<Vec<String>> {
            let mut statement = connection.prepare_cached(sql)?;
            let rows = match param {
                Some(param) => statement
                    .query_map([param], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
                None => statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .collect::<rusqlite::Result<Vec<_>>>()?,
            };
            Ok(rows)
        })();
        match result {
            // A row this version cannot read is skipped rather than failing
            // every other review.
            Ok(rows) => Ok(rows.iter().filter_map(|data| js::parse(data)).collect()),
            Err(error) => {
                // Opened again next time (the file may have been replaced).
                *db = None;
                Err(error.to_string())
            }
        }
    }
}

impl ReviewSource for SqliteReviews {
    fn load_sessions(&self) -> Result<Vec<Value>, String> {
        self.rows("SELECT data FROM sessions ORDER BY updated_at", None)
    }

    fn load_threads(&self, session_id: &str) -> Result<Vec<Value>, String> {
        Ok(self
            .rows(
                "SELECT data FROM threads WHERE session_id = ? ORDER BY created_at, id",
                Some(session_id),
            )?
            .into_iter()
            .filter(|thread| thread.get("sessionId").and_then(Value::as_str) == Some(session_id))
            .collect())
    }
}

/// The review store telling the history what it wrote (`withHistoryHooks`):
/// each review changed, and the Work item a thread is on (whose file shows
/// its description). The store calls these after its own writes.
#[derive(Default)]
pub struct ReviewHooks {
    session_of: HashMap<String, String>,
    work_of: HashMap<String, String>,
}

impl ReviewHooks {
    fn seen(&mut self, thread: &Value) {
        let id = js::sv(thread.get("id")).to_owned();
        self.session_of
            .insert(id.clone(), js::sv(thread.get("sessionId")).to_owned());
        let item = thread
            .get("anchor")
            .and_then(|anchor| anchor.get("work"))
            .and_then(|work| work.get("item"))
            .and_then(Value::as_str)
            .filter(|item| !item.is_empty());
        if let Some(item) = item {
            self.work_of.insert(id, item.to_owned());
        }
    }

    /// Threads the store read.
    pub fn loaded(&mut self, threads: &[Value]) {
        for thread in threads {
            self.seen(thread);
        }
    }

    pub fn saved_session(&mut self, id: &str, changed: &mut dyn FnMut(&str, Option<&str>)) {
        changed("reviews", Some(id));
    }

    pub fn saved_thread(&mut self, thread: &Value, changed: &mut dyn FnMut(&str, Option<&str>)) {
        self.seen(thread);
        changed("reviews", Some(js::sv(thread.get("sessionId"))));
        if let Some(item) = self.work_of.get(js::sv(thread.get("id"))) {
            changed("work", Some(item));
        }
    }

    pub fn deleted_thread(&mut self, id: &str, changed: &mut dyn FnMut(&str, Option<&str>)) {
        match self
            .session_of
            .get(id)
            .filter(|session| !session.is_empty())
        {
            Some(session) => changed("reviews", Some(session)),
            None => changed("reviews", None),
        }
        if let Some(item) = self.work_of.get(id) {
            changed("work", Some(item));
        }
        self.session_of.remove(id);
        self.work_of.remove(id);
    }

    pub fn deleted_session(&mut self, id: &str, changed: &mut dyn FnMut(&str, Option<&str>)) {
        changed("reviews", Some(id));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const S1: &str = "00087e46c486e70c";
    const S2: &str = "4e6b9c5f4b89b44b";

    fn session(id: &str, created_at: &str) -> Value {
        json!({
            "id": id,
            "connectionId": "local",
            "root": "/repo",
            "title": "Work 8a057f17: History\nand backup",
            "target": {"kind": "work", "item": "8a057f17bc9203bc"},
            "gitlab": false,
            "summary": "",
            "agent": {"name": "Claude", "working": {"at": "now"}},
            "createdAt": created_at,
            "updatedAt": created_at,
        })
    }

    fn thread(id: &str, session_id: &str, bodies: &[&str]) -> Value {
        json!({
            "id": id,
            "sessionId": session_id,
            "kind": "discussion",
            "anchor": {"work": {"item": "8a057f17bc9203bc"}},
            "comments": bodies.iter().enumerate().map(|(index, body)| json!({
                "id": format!("{id}c{index}"),
                "author": if index > 0 { "Claude" } else { "you" },
                "body": body,
                "createdAt": "2026-11-22T11:12:26Z",
                "updatedAt": "2026-11-22T11:12:26Z",
            })).collect::<Vec<_>>(),
            "resolved": false,
            "createdAt": "2026-11-22T11:12:26Z",
            "updatedAt": "2026-11-22T11:12:26Z",
        })
    }

    struct Store {
        sessions: Vec<Value>,
        threads: Value,
    }

    impl ReviewSource for Store {
        fn load_sessions(&self) -> Result<Vec<Value>, String> {
            Ok(self.sessions.clone())
        }
        fn load_threads(&self, id: &str) -> Result<Vec<Value>, String> {
            Ok(self.threads[id].as_array().cloned().unwrap_or_default())
        }
    }

    #[test]
    fn a_thread_file_is_markdown_with_headers_and_reads_back_the_same_thread() {
        let t = thread(
            "67dba4b0cdce0f05",
            S1,
            &[
                "We should keep history.",
                "Sorted as:\n\n- one\n- two\n",
                "<!-- roamgate:comment {} --> pasted",
            ],
        );
        let text = render_thread(&t, "Work 8a057f17: History\nand backup").unwrap();
        let lines: Vec<&str> = text.split('\n').collect();
        assert!(lines[0].starts_with("<!-- roamgate:thread {\"anchor\""));
        assert_eq!(lines[1], "# Work 8a057f17: History and backup");
        assert!(lines[3].starts_with("<!-- roamgate:comment {\"author\":\"you\""));
        assert_eq!(lines[4], "We should keep history.");
        let back = parse_thread(&text).unwrap();
        assert_eq!(
            roamgate_mr_reviews::history::sorted_keys(&back),
            roamgate_mr_reviews::history::sorted_keys(&t)
        );
    }

    #[test]
    fn the_reviews_area_writes_each_review_by_year_its_threads_and_its_images() {
        let temp = tempfile::tempdir().unwrap();
        let dir = temp.path();
        let png = |fill: u8, size: usize| {
            let mut data = vec![fill; size];
            data[..4].copy_from_slice(&[0x89, 0x50, 0x4e, 0x47]);
            data
        };
        let images = dir.join("images").join(S1);
        std::fs::create_dir_all(&images).unwrap();
        std::fs::write(images.join("aaaaaaaaaaaaaaaa.png"), png(1, 64)).unwrap();
        // The same picture pasted twice: stored once.
        std::fs::write(images.join("bbbbbbbbbbbbbbbb.png"), png(1, 64)).unwrap();
        let big = HISTORY_IMAGE_MAX_BYTES as usize + 1;
        std::fs::write(images.join("cccccccccccccccc.png"), png(2, big)).unwrap();
        let image = |name: &str| images.join(name).display().to_string();
        let store: Arc<dyn ReviewSource> = Arc::new(Store {
            sessions: vec![
                session(S1, "2026-11-22T10:00:00Z"),
                session(S2, "2025-01-01T00:00:00Z"),
            ],
            threads: json!({
                S1: [thread("t1", S1, &[
                    &format!("see ![shot]({})", image("aaaaaaaaaaaaaaaa.png")),
                    &format!(
                        "again ![shot]({}) and ![big]({})",
                        image("bbbbbbbbbbbbbbbb.png"),
                        image("cccccccccccccccc.png")
                    ),
                ])],
                S2: [thread("t2", S2, &["old"])],
            }),
        });
        let area = ReviewsArea {
            reviews: dir.to_path_buf(),
            source: Arc::new(move || Some(store.clone())),
        };
        let full = area.render(None).unwrap();
        let sha = format!("{:x}", Sha256::digest(png(1, 64)));
        assert_eq!(
            full.files.keys().cloned().collect::<Vec<_>>(),
            [
                format!("reviews/2025/{S2}/review.json"),
                format!("reviews/2025/{S2}/t2.md"),
                format!("reviews/2026/{S1}/review.json"),
                format!("reviews/2026/{S1}/t1.md"),
                format!("reviews/images/{sha}.png"),
            ]
        );
        assert_eq!(full.owns, ["reviews/"]);
        let review: Value = serde_json::from_str(
            full.text(&format!("reviews/2026/{S1}/review.json"))
                .unwrap(),
        )
        .unwrap();
        assert_eq!(review["session"]["agent"], json!({"name": "Claude"}));
        assert_eq!(
            review["images"],
            json!({
                format!("{S1}/aaaaaaaaaaaaaaaa.png"): format!("{sha}.png"),
                format!("{S1}/bbbbbbbbbbbbbbbb.png"): format!("{sha}.png"),
                format!("{S1}/cccccccccccccccc.png"): {"omitted": "larger than 5 MB", "bytes": big},
            })
        );
        let one = area
            .render(Some(&[S2.into(), "ffffffffffffffff".into()]))
            .unwrap();
        assert_eq!(
            one.files.keys().cloned().collect::<Vec<_>>(),
            [
                format!("reviews/2025/{S2}/review.json"),
                format!("reviews/2025/{S2}/t2.md")
            ]
        );
        assert_eq!(
            one.owns,
            [
                format!("reviews/*/{S2}/"),
                "reviews/*/ffffffffffffffff/".into()
            ]
        );
        assert_eq!(
            area.describe(&[
                format!("reviews/2026/{S1}/t1.md"),
                format!("reviews/2026/{S1}/t3.md"),
                format!("reviews/2025/{S2}/review.json"),
                format!("reviews/images/{sha}.png"),
            ])
            .unwrap(),
            "2 threads in 2 reviews, 1 image"
        );
    }

    #[test]
    fn the_review_store_tells_the_history_each_review_and_work_item_it_wrote() {
        let mut marks: Vec<String> = Vec::new();
        let mut changed = |area: &str, id: Option<&str>| {
            marks.push(format!("{area}:{}", id.unwrap_or("*")));
        };
        let mut hooks = ReviewHooks::default();
        hooks.loaded(&[thread("t1", S1, &["a"])]);
        hooks.saved_session(S2, &mut changed);
        hooks.saved_thread(&thread("t9", S2, &["x"]), &mut changed);
        hooks.deleted_thread("t1", &mut changed);
        hooks.deleted_thread("unknown", &mut changed);
        hooks.deleted_session(S2, &mut changed);
        assert_eq!(
            marks,
            [
                format!("reviews:{S2}"),
                format!("reviews:{S2}"),
                "work:8a057f17bc9203bc".into(),
                format!("reviews:{S1}"),
                "work:8a057f17bc9203bc".into(),
                "reviews:*".into(),
                format!("reviews:{S2}"),
            ]
        );
    }
}
