//! The Work board in the history (history/work.ts): `work/items/<id>.md`
//! (the item as a one-line JSON header, then its description, from the
//! item's review), `work/projects/<id>.json`, and the store's
//! `work/history.jsonl` (kept until restoring from git is proven). Each
//! change of an item is its own commit ([`work_commit`]), authored by
//! whoever made it at the time it was made: `git log -p --
//! work/items/<id>.md` is the item's history.

use std::path::PathBuf;
use std::sync::Arc;

use roamgate_agents::js;
use roamgate_base::secrets::without_secrets;
use roamgate_work::ReviewThread;
use roamgate_work::shared::work_description_thread;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::area::{AreaRender, HistoryArea, ReviewSource, count};
use crate::format::{
    DocBlock, file_name_of, jsonl, parse_doc, parse_jsonl, render_doc, stable_json,
};
use crate::repo::{GitAuthor, WorkCommit};

pub fn work_item_path(id: &str) -> String {
    format!("work/items/{}.md", file_name_of(id))
}

/// An item's file: its header, then its description (Markdown).
pub fn render_work_item(item: &Value, description: Option<&str>) -> String {
    let meta = match without_secrets(item) {
        Value::Object(meta) => meta,
        _ => Map::new(),
    };
    render_doc(&[DocBlock::new("item", meta, description.unwrap_or(""))])
        .expect("item is a valid tag")
}

/// An item's file read back: the item and its description.
pub fn parse_work_item(text: &str) -> Result<(Value, String), String> {
    let mut blocks = parse_doc(text)?;
    if blocks.first().is_none_or(|block| block.tag != "item") {
        return Err("not a Work item file".into());
    }
    let block = blocks.swap_remove(0);
    Ok((Value::Object(block.meta), block.body))
}

/// The item's description: the first comment of its description thread.
pub fn work_description_of(source: Option<&dyn ReviewSource>, item: &Value) -> Option<String> {
    let source = source?;
    let review = item.get("review").and_then(Value::as_str)?;
    if review.is_empty() {
        return None;
    }
    let threads: Vec<ReviewThread> = source
        .load_threads(review)
        .ok()?
        .into_iter()
        .filter_map(|thread| serde_json::from_value(thread).ok())
        .collect();
    let created = js::sv(item.get("createdAt"));
    work_description_thread(&threads, created)?
        .comments
        .first()
        .map(|comment| comment.body.clone())
}

/// work.json's projects and items.
type Board = (Vec<Value>, Vec<Value>);

fn read_work(dir: &std::path::Path) -> Result<Option<Board>, String> {
    let path = dir.join("work.json");
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    let raw: Value = serde_json::from_str(&String::from_utf8_lossy(&bytes))
        .map(js::js_value)
        .map_err(|error| error.to_string())?;
    let list = |key: &str| {
        raw.get(key)
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default()
    };
    Ok(Some((list("projects"), list("items"))))
}

/// The work area: the board's store, and the review store for the items'
/// descriptions.
pub struct WorkArea {
    pub work: PathBuf,
    pub reviews: Arc<dyn Fn() -> Option<Arc<dyn ReviewSource>> + Send + Sync>,
}

impl HistoryArea for WorkArea {
    fn name(&self) -> &str {
        "work"
    }

    // Not watched: the store says each change, and the server writes
    // work.json whole from memory, so a hand edit would not last.

    fn render(&self, ids: Option<&[String]>) -> Result<AreaRender, String> {
        let mut render = AreaRender::default();
        let Some((projects, items)) = read_work(&self.work)? else {
            render.owns = vec!["work/".into()];
            return Ok(render);
        };
        let source = (self.reviews)();
        for item in &items {
            let Some(id) = item.get("id").and_then(Value::as_str) else {
                continue;
            };
            if ids.is_some_and(|ids| !ids.iter().any(|each| each == id)) {
                continue;
            }
            let description = work_description_of(source.as_deref(), item);
            render.set(
                work_item_path(id),
                render_work_item(item, description.as_deref()),
            );
        }
        if let Some(ids) = ids {
            render.owns = ids.iter().map(|id| work_item_path(id)).collect();
            return Ok(render);
        }
        for project in &projects {
            let id = js::sv(project.get("id"));
            render.set(
                format!("work/projects/{}.json", file_name_of(id)),
                stable_json(&without_secrets(project)),
            );
        }
        if let Ok(bytes) = std::fs::read(self.work.join("history.jsonl")) {
            let lines = parse_jsonl(&String::from_utf8_lossy(&bytes));
            if !lines.is_empty() {
                let clean: Vec<Value> = lines.iter().map(without_secrets).collect();
                render.set("work/history.jsonl", jsonl(&clean));
            }
        }
        render.owns = vec!["work/".into()];
        Ok(render)
    }

    fn describe(&self, paths: &[String]) -> Option<String> {
        let items = paths
            .iter()
            .filter(|path| path.starts_with("work/items/"))
            .count();
        let projects = paths
            .iter()
            .filter(|path| path.starts_with("work/projects/"))
            .count();
        let parts = [
            if items > 0 {
                count(items, "item")
            } else {
                String::new()
            },
            if projects > 0 {
                count(projects, "project")
            } else {
                String::new()
            },
            if paths.iter().any(|path| path == "work/history.jsonl") {
                "its history".into()
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

/// Who made a Work change: the user, or an agent (its session's address).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkActor {
    pub by: String,
    /// The agent session's address (CONNECTION/PANE), when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    /// The agent's name ("Claude in roamgate").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub caller: Option<String>,
}

/// A Work change as the store tells it (history/hooks.ts `WorkChange`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct WorkChange {
    /// The item after the change; None when it was removed.
    #[serde(default)]
    pub item: Option<Value>,
    pub id: String,
    /// The fields that changed, as the store's history.jsonl has them.
    #[serde(default)]
    pub change: Map<String, Value>,
    #[serde(default)]
    pub actor: WorkActor,
    /// When (ISO 8601).
    #[serde(default)]
    pub at: String,
}

/// The user's login as Bun's `os.userInfo().username` gives it: `$USER`
/// (`USERNAME` on Windows), "unknown" when unset; "you" when empty (the
/// TS code's `|| "you"`).
pub fn local_user() -> String {
    let name = if cfg!(windows) { "USERNAME" } else { "USER" };
    user_of(std::env::var(name).ok())
}

fn user_of(value: Option<String>) -> String {
    match value {
        Some(user) if user.is_empty() => "you".into(),
        Some(user) => user,
        None => "unknown".into(),
    }
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) | Some(Value::Bool(false)) => false,
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(_) => true,
    }
}

/// What a change did, in a few words: "state doing, tags".
fn change_words(change: &Map<String, Value>) -> String {
    if truthy(change.get("removed")) {
        return "removed".into();
    }
    let ordered = roamgate_base::json_store::js_key_order(Value::Object(change.clone()));
    let words: Vec<String> = ordered
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(key, _)| *key != "previous_description")
        .map(|(key, value)| match value {
            Value::String(text) if (key == "state" || key == "project") && js::len16(text) < 40 => {
                format!("{key} {text}")
            }
            _ => key.clone(),
        })
        .collect();
    if words.is_empty() {
        "updated".into()
    } else {
        words.join(", ")
    }
}

/// The commit of one Work change: the item's file as the change left it,
/// authored by the user (their login on this machine) or the agent (its
/// name and session address), dated when it was made.
pub fn work_commit(
    change: &WorkChange,
    description: Option<&str>,
    host: &str,
    user: &str,
) -> WorkCommit {
    let short = js::head16(&change.id, 8);
    let title = match change.item.as_ref().and_then(|item| item.get("title")) {
        Some(Value::String(title)) if !title.is_empty() => {
            if js::len16(title) > 60 {
                format!(" \"{}...\"", js::head16(title, 57))
            } else {
                format!(" \"{title}\"")
            }
        }
        _ => String::new(),
    };
    let actor = &change.actor;
    let address = actor
        .address
        .as_deref()
        .filter(|address| !address.is_empty());
    let author = if actor.by == "agent" {
        let name = [
            actor
                .caller
                .as_deref()
                .map(|caller| caller.split(" in ").next().unwrap_or("").to_owned())
                .unwrap_or_default(),
            address
                .map(|address| format!("({address})"))
                .unwrap_or_default(),
        ]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
        GitAuthor {
            name: if name.is_empty() {
                "agent".into()
            } else {
                name
            },
            email: format!("agent@{host}"),
        }
    } else {
        GitAuthor {
            name: user.to_owned(),
            email: format!("{user}@{host}"),
        }
    };
    let body = if actor.by == "agent" {
        format!(
            "By {}{}.",
            actor.caller.as_deref().unwrap_or("an agent"),
            address
                .map(|address| format!(" at {address}"))
                .unwrap_or_default()
        )
    } else {
        "By the user.".into()
    };
    WorkCommit {
        path: work_item_path(&change.id),
        content: change
            .item
            .as_ref()
            .map(|item| render_work_item(item, description)),
        author,
        date: change.at.clone(),
        subject: format!("work {short}: {}{title}", change_words(&change.change)),
        body: Some(body),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    struct Threads(Value);

    impl ReviewSource for Threads {
        fn load_sessions(&self) -> Result<Vec<Value>, String> {
            Ok(Vec::new())
        }
        fn load_threads(&self, session_id: &str) -> Result<Vec<Value>, String> {
            Ok(self.0[session_id].as_array().cloned().unwrap_or_default())
        }
    }

    fn item() -> Value {
        json!({
            "id": "8a057f17bc9203bc",
            "project": "roamgate",
            "title": "History and backup",
            "state": "doing",
            "tags": ["history"],
            "owner": {"session": "desktop/w35:p1"},
            "links": [{"kind": "file", "path": "plans/data-history.md"}],
            "createdAt": "2026-11-22T11:12:26.494Z",
            "updatedAt": "2026-11-22T12:00:00.000Z",
            "by": "agent",
            "review": "696679c25b617a96",
        })
    }

    const DESCRIPTION: &str = "# History\n\nKeep what you do.\n";

    fn description_thread() -> Value {
        let item = item();
        json!({
            "id": "t1",
            "sessionId": "696679c25b617a96",
            "kind": "discussion",
            "anchor": {"work": {"item": item["id"], "description": true}},
            "comments": [{
                "id": "c1",
                "author": "Claude",
                "body": DESCRIPTION,
                "createdAt": item["createdAt"],
                "updatedAt": item["createdAt"],
            }],
            "resolved": false,
            "createdAt": item["createdAt"],
            "updatedAt": item["createdAt"],
        })
    }

    #[test]
    fn an_item_s_file_is_its_header_then_its_description_and_reads_back() {
        let item = item();
        let text = render_work_item(&item, Some(DESCRIPTION));
        assert!(
            text.split('\n')
                .next()
                .unwrap()
                .starts_with("<!-- roamgate:item {\"by\":\"agent\"")
        );
        assert!(text.ends_with(&format!("{DESCRIPTION}\n")));
        assert_eq!(
            parse_work_item(&text).unwrap(),
            (item.clone(), DESCRIPTION.to_owned())
        );
        assert_eq!(
            parse_work_item(&render_work_item(&item, None)).unwrap(),
            (item, String::new())
        );
    }

    #[test]
    fn the_work_area_writes_items_with_their_description_projects_and_history() {
        let dir = tempfile::tempdir().unwrap();
        let item = item();
        let mut other = item.clone();
        other["id"] = json!("0000000000000001");
        other.as_object_mut().unwrap().remove("review");
        std::fs::write(
            dir.path().join("work.json"),
            json!({
                "version": 1,
                "projects": [{"id": "roamgate", "name": "Roamgate", "roots": [], "done": {"kind": "deployed"}}],
                "items": [item, other],
            })
            .to_string(),
        )
        .unwrap();
        std::fs::write(
            dir.path().join("history.jsonl"),
            format!(
                "{}\n",
                json!({"at": "x", "item": item["id"], "by": "user", "change": {"state": "doing"}})
            ),
        )
        .unwrap();
        let threads: Arc<dyn ReviewSource> =
            Arc::new(Threads(json!({"696679c25b617a96": [description_thread()]})));
        let area = WorkArea {
            work: dir.path().to_path_buf(),
            reviews: Arc::new(move || Some(threads.clone())),
        };
        let full = area.render(None).unwrap();
        assert_eq!(
            full.files.keys().collect::<Vec<_>>(),
            [
                "work/history.jsonl",
                "work/items/0000000000000001.md",
                "work/items/8a057f17bc9203bc.md",
                "work/projects/roamgate.json",
            ]
        );
        assert_eq!(full.owns, ["work/"]);
        assert_eq!(
            parse_work_item(full.text(&work_item_path("8a057f17bc9203bc")).unwrap())
                .unwrap()
                .1,
            DESCRIPTION
        );
        let some = area
            .render(Some(&[
                "8a057f17bc9203bc".into(),
                "ffffffffffffffff".into(),
            ]))
            .unwrap();
        assert_eq!(
            some.files.keys().collect::<Vec<_>>(),
            [&work_item_path("8a057f17bc9203bc")]
        );
        // A removed item's file goes.
        assert!(
            some.owns
                .contains(&"work/items/ffffffffffffffff.md".to_owned())
        );
        assert_eq!(
            area.describe(&[
                "work/items/a.md".into(),
                "work/items/b.md".into(),
                "work/history.jsonl".into()
            ])
            .unwrap(),
            "2 items, its history"
        );
    }

    #[test]
    fn a_change_is_committed_as_its_author_at_its_time() {
        let item = item();
        let by_agent = work_commit(
            &WorkChange {
                item: Some(item.clone()),
                id: "8a057f17bc9203bc".into(),
                change: json!({"state": "doing", "previous_description": "old", "tags": ["x"]})
                    .as_object()
                    .unwrap()
                    .clone(),
                actor: WorkActor {
                    by: "agent".into(),
                    address: Some("desktop/w35:p1".into()),
                    caller: Some("Claude in roamgate".into()),
                },
                at: "2026-11-22T12:00:00.000Z".into(),
            },
            Some(DESCRIPTION),
            "desk",
            "me",
        );
        assert_eq!(by_agent.path, "work/items/8a057f17bc9203bc.md");
        assert_eq!(
            by_agent.author,
            GitAuthor {
                name: "Claude (desktop/w35:p1)".into(),
                email: "agent@desk".into()
            }
        );
        assert_eq!(by_agent.date, "2026-11-22T12:00:00.000Z");
        assert_eq!(
            by_agent.subject,
            "work 8a057f17: state doing, tags \"History and backup\""
        );
        assert_eq!(
            by_agent.body.as_deref(),
            Some("By Claude in roamgate at desktop/w35:p1.")
        );
        assert_eq!(
            by_agent.content,
            Some(render_work_item(&item, Some(DESCRIPTION)))
        );
        let user = local_user();
        let removed = work_commit(
            &WorkChange {
                item: None,
                id: "8a057f17bc9203bc".into(),
                change: json!({"removed": true}).as_object().unwrap().clone(),
                actor: WorkActor {
                    by: "user".into(),
                    ..WorkActor::default()
                },
                at: "2026-11-22T13:00:00.000Z".into(),
            },
            None,
            "desk",
            &user,
        );
        assert_eq!(removed.content, None);
        assert_eq!(
            removed.author,
            GitAuthor {
                name: user.clone(),
                email: format!("{user}@desk")
            }
        );
        assert_eq!(removed.subject, "work 8a057f17: removed");
    }
}
