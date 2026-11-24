//! The history's mr-reviews area (history/mr-reviews.ts `mrReviewsArea`):
//! the Reviews export (roamgate-mr-reviews' `export_reviews`, the same code
//! as `roamgate reviews export`), split so each effort's ledger and history
//! are their own files (a ledger change does not rewrite the others):
//! `mr-reviews/export.json` holds the authored `mr_reviews` keys (no
//! `exported_at`: the same state, the same file),
//! `mr-reviews/efforts/<id>/ledger.json` and `history.jsonl` each effort's.

use std::collections::{BTreeMap, HashSet};
use std::path::PathBuf;

use roamgate_agents::js;
use roamgate_mr_reviews::history::{ReviewsExport, export_reviews, parse_reviews_export};
use serde_json::{Map, Value, json};

use crate::area::{AreaRender, HistoryArea, count};
use crate::files::read_json;
use crate::format::{file_name_of, jsonl, parse_jsonl, stable_json};

/// `/^[\w-]+$/` (JavaScript's ASCII `\w`).
fn is_effort_id(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
}

fn effort_dirs(root: &std::path::Path) -> Vec<PathBuf> {
    let Ok(read) = std::fs::read_dir(root) else {
        return Vec::new();
    };
    read.flatten()
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.') && is_effort_id(name))
        .map(|name| root.join(name))
        .collect()
}

/// The mr-reviews area: settings.json's `mr_reviews` and the efforts'
/// files under `<data>/mr-reviews/efforts`.
pub struct MrReviewsArea {
    pub settings: PathBuf,
    pub data: PathBuf,
}

impl MrReviewsArea {
    fn efforts_root(&self) -> PathBuf {
        self.data.join("mr-reviews").join("efforts")
    }
}

impl HistoryArea for MrReviewsArea {
    fn name(&self) -> &str {
        "mr-reviews"
    }

    fn watch(&self) -> Option<Vec<PathBuf>> {
        let mut out = vec![self.settings.clone()];
        for dir in effort_dirs(&self.efforts_root()) {
            out.push(dir.join("ledger.json"));
            out.push(dir.join("history.jsonl"));
        }
        Some(out)
    }

    fn render(&self, _ids: Option<&[String]>) -> Result<AreaRender, String> {
        // `readJson` of the module: null when missing or unreadable.
        let settings = read_json(&self.settings).ok().flatten();
        let exported = export_reviews(
            settings
                .as_ref()
                .and_then(|settings| settings.get("mr_reviews")),
            &self.efforts_root(),
            0.0,
        );
        let mut render = AreaRender {
            owns: vec!["mr-reviews/".into()],
            ..AreaRender::default()
        };
        let mut head = exported.to_value();
        if let Some(head) = head.as_object_mut() {
            head.insert("efforts".into(), json!({}));
            head.shift_remove("exported_at");
        }
        render.set("mr-reviews/export.json", stable_json(&head));
        for (id, effort) in &exported.efforts {
            let base = format!("mr-reviews/efforts/{}", file_name_of(id));
            render.set(
                format!("{base}/ledger.json"),
                stable_json(effort.get("ledger").unwrap_or(&Value::Null)),
            );
            let history = exported.history(id);
            if !history.is_empty() {
                render.set(format!("{base}/history.jsonl"), jsonl(history));
            }
        }
        Ok(render)
    }

    fn describe(&self, paths: &[String]) -> Option<String> {
        let efforts: HashSet<&str> = paths
            .iter()
            .filter_map(|path| {
                let rest = path.strip_prefix("mr-reviews/efforts/")?;
                let (id, _) = rest.split_once('/')?;
                (!id.is_empty()).then_some(id)
            })
            .collect();
        let parts = [
            if paths.iter().any(|path| path == "mr-reviews/export.json") {
                "the Reviews' settings".to_owned()
            } else {
                String::new()
            },
            if efforts.is_empty() {
                String::new()
            } else {
                count(efforts.len(), "effort")
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

/// The history's files read back as an export (format 3), for an import.
pub fn mr_reviews_from_history(files: &BTreeMap<String, String>) -> Result<ReviewsExport, String> {
    let head = files
        .get("mr-reviews/export.json")
        .and_then(|text| js::parse(text))
        .unwrap_or_else(|| json!({}));
    let mut efforts = Map::new();
    for (path, text) in files {
        let Some(id) = path
            .strip_prefix("mr-reviews/efforts/")
            .and_then(|rest| rest.strip_suffix("/ledger.json"))
            .filter(|id| !id.is_empty() && !id.contains('/'))
        else {
            continue;
        };
        let ledger = js::parse(text).ok_or("a ledger is not JSON")?;
        let history = parse_jsonl(
            files
                .get(&format!("mr-reviews/efforts/{id}/history.jsonl"))
                .map_or("", String::as_str),
        );
        efforts.insert(id.to_owned(), json!({"ledger": ledger, "history": history}));
    }
    let mut whole = head.as_object().cloned().unwrap_or_default();
    whole.insert("exported_at".into(), json!(""));
    whole.insert("efforts".into(), Value::Object(efforts));
    parse_reviews_export(&js::stringify(&Value::Object(whole)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mr_reviews_area_splits_the_export_by_effort_and_reads_back_to_it() {
        let temp = tempfile::tempdir().unwrap();
        let data = temp.path();
        let settings = data.join("settings.json");
        std::fs::write(
            &settings,
            json!({"mr_reviews": {
                "order": ["a", "b"],
                "efforts": [{"id": "e1", "name": "Big"}],
                "hints": "token glpat-abcdefghijklmnopqrst",
                "clones": {"x": 1},
            }})
            .to_string(),
        )
        .unwrap();
        let effort = data.join("mr-reviews").join("efforts").join("e1");
        std::fs::create_dir_all(&effort).unwrap();
        std::fs::write(
            effort.join("ledger.json"),
            json!({"version": 3, "entries": [{"id": "x"}], "journal": [{"undo": 1}]}).to_string(),
        )
        .unwrap();
        std::fs::write(
            effort.join("history.jsonl"),
            "{\"at\":\"1\",\"what\":\"a\"}\n{\"at\":\"2\",\"what\":\"b\"}\n",
        )
        .unwrap();
        std::fs::write(effort.join("derived.json"), "{}").unwrap();
        let area = MrReviewsArea {
            settings: settings.clone(),
            data: data.to_path_buf(),
        };
        let render = area.render(None).unwrap();
        assert_eq!(
            render.files.keys().collect::<Vec<_>>(),
            [
                "mr-reviews/efforts/e1/history.jsonl",
                "mr-reviews/efforts/e1/ledger.json",
                "mr-reviews/export.json"
            ]
        );
        let head = render.text("mr-reviews/export.json").unwrap();
        assert!(!head.contains("exported_at"));
        assert!(!head.contains("glpat-"));
        assert!(!head.contains("clones"));
        assert!(
            !render
                .text("mr-reviews/efforts/e1/ledger.json")
                .unwrap()
                .contains("journal")
        );
        assert!(area.watch().unwrap().contains(&effort.join("ledger.json")));
        let texts: BTreeMap<String, String> = render
            .files
            .iter()
            .map(|(path, bytes)| (path.clone(), String::from_utf8(bytes.clone()).unwrap()))
            .collect();
        let back = mr_reviews_from_history(&texts).unwrap();
        let stored: Value =
            serde_json::from_str(&std::fs::read_to_string(&settings).unwrap()).unwrap();
        let direct = export_reviews(
            stored.get("mr_reviews"),
            &data.join("mr-reviews/efforts"),
            0.0,
        );
        let mut back = back.to_value();
        let mut direct = direct.to_value();
        back["exported_at"] = json!("");
        direct["exported_at"] = json!("");
        assert_eq!(stable_json(&back), stable_json(&direct));
        assert_eq!(
            area.describe(&[
                "mr-reviews/export.json".into(),
                "mr-reviews/efforts/e1/ledger.json".into()
            ])
            .unwrap(),
            "the Reviews' settings, 1 effort"
        );
    }
}
