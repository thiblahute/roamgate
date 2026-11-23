//! The user's order of the reviews inbox as the server keeps it
//! (`mr-reviews/order.ts`): one document (settings.json `mr_reviews.order`)
//! with a version that every change bumps (the pins and removals too). A
//! change is an operation on the latest order, so the user's drag and the
//! agent's reorder never overwrite each other; a whole list saved by a page
//! that has since fallen behind is rebased onto it. Every saved change is
//! pushed to every page.
//!
//! The pure order lives in [`crate::shared::order`]; this keeps its
//! history (to rebase and to undo) and runs the changes one at a time
//! ([`MrOrder::edit`], `editSettings`).

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, Mutex};

use roamgate_agents::js::{self, Obj};
use serde_json::{Value, json};

use crate::connection::BoxFuture;
use crate::inbox::{MrInbox, SettingsFn, key_of, list};
use crate::shared::order::{
    MAX_ORDER, OrderOp, SECTIONS, Sections, apply_order_op, flatten_sections, order_entries,
    rebase_order, stored_order,
};
use crate::shared::types::{forge_ref_key, workspace_ref_key};

/// Who changed it, and what to say about it (the agent's changes only).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ChangeMeta {
    /// "user" or "agent".
    pub by: String,
    pub summary: Option<String>,
    /// Offer to take this change back (Undo).
    pub undoable: bool,
}

impl ChangeMeta {
    pub fn user() -> ChangeMeta {
        ChangeMeta {
            by: "user".into(),
            summary: None,
            undoable: false,
        }
    }

    pub fn agent() -> ChangeMeta {
        ChangeMeta {
            by: "agent".into(),
            ..ChangeMeta::user()
        }
    }

    /// `{by, summary?, undoable?}`.
    pub fn to_json(&self) -> Value {
        let mut out = Obj::new();
        out.insert("by".into(), json!(self.by));
        if let Some(summary) = &self.summary {
            out.insert("summary".into(), json!(summary));
        }
        if self.undoable {
            out.insert("undoable".into(), json!(true));
        }
        Value::Object(out)
    }
}

/// Saves the settings (bumping the version when the order, pins, removals
/// and the other pushed fields moved), gives them back as saved.
pub type SaveFn =
    Arc<dyn Fn(Obj, ChangeMeta) -> BoxFuture<'static, Result<Obj, String>> + Send + Sync>;

/// The inbox as the user sees it: sections in their order.
#[derive(Clone, Debug, PartialEq)]
pub struct MrOrderView {
    pub version: i64,
    /// Indexed as [`SECTIONS`].
    pub sections: [Vec<Obj>; 4],
    pub hidden: Vec<Obj>,
}

impl MrOrderView {
    pub fn section(&self, name: &str) -> &[Obj] {
        SECTIONS
            .iter()
            .position(|s| *s == name)
            .map_or(&[], |at| &self.sections[at])
    }

    /// `{version, sections: {pinned, mine, authored, suggested}, hidden}`.
    pub fn to_json(&self) -> Value {
        let mut sections = Obj::new();
        for (name, entries) in SECTIONS.iter().zip(&self.sections) {
            sections.insert(
                (*name).into(),
                Value::Array(entries.iter().cloned().map(Value::Object).collect()),
            );
        }
        json!({
            "version": self.version,
            "sections": sections,
            "hidden": self.hidden.iter().cloned().map(Value::Object).collect::<Vec<_>>(),
        })
    }
}

/// What an operation did.
#[derive(Clone, Debug, PartialEq)]
pub struct MrOrderResult {
    pub changed: bool,
    pub version: i64,
    pub moved: Vec<String>,
    pub unknown: Vec<String>,
    pub elsewhere: Vec<String>,
    pub view: MrOrderView,
}

/// The settings' `orderVersion`, 0 when unset.
pub fn order_version(settings: &Obj) -> i64 {
    settings
        .get("orderVersion")
        .and_then(Value::as_f64)
        .unwrap_or(0.0) as i64
}

fn strings(value: Option<&Value>) -> Vec<String> {
    list(value)
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

/// Versions kept, to rebase a stale list and to undo.
const HISTORY: i64 = 40;

/// Lists Undo restores element by element (by their key).
pub const UNDO_LISTS: [&str; 8] = [
    "pinned",
    "hidden",
    "views",
    "unsent",
    "upstreamGroups",
    "upstreamSkip",
    "upstreamWorkspaces",
    "efforts",
];

/// The key of an element of one of [`UNDO_LISTS`].
pub fn undo_list_key(field: &str, value: &Value) -> String {
    let obj = || value.as_object().cloned().unwrap_or_default();
    match field {
        "pinned" => forge_ref_key(&obj()),
        "hidden" | "unsent" => js::sv(value.get("key")).to_owned(),
        "views" => js::sv(value.get("name")).to_lowercase(),
        "upstreamGroups" => js::sv(Some(value)).to_owned(),
        "upstreamSkip" | "upstreamWorkspaces" => workspace_ref_key(&obj()),
        _ => js::sv(value.get("id")).to_owned(),
    }
}

/// Records Undo restores key by key.
pub const UNDO_RECORDS: [&str; 1] = ["overrides"];

/// `JSON.stringify(a ?? null) === JSON.stringify(b ?? null)`.
fn same_json(a: Option<&Value>, b: Option<&Value>) -> bool {
    let text = |v: Option<&Value>| js::stringify(v.unwrap_or(&Value::Null));
    text(a) == text(b)
}

/// A record after undoing the change from `before` to `after`: each key it
/// changed goes back, unless it changed again since.
pub fn undo_record(before: &Obj, after: &Obj, current: &Obj) -> Obj {
    let mut out = current.clone();
    let mut keys: Vec<&String> = before.keys().collect();
    for key in after.keys() {
        if !keys.contains(&key) {
            keys.push(key);
        }
    }
    for key in keys {
        if same_json(before.get(key), after.get(key)) {
            continue;
        }
        if !same_json(current.get(key), after.get(key)) {
            continue;
        }
        match before.get(key) {
            None => {
                out.shift_remove(key);
            }
            Some(value) => {
                out.insert(key.clone(), value.clone());
            }
        }
    }
    out
}

/// A keyed list after undoing a change, as [`undo_record`]; restored
/// ones first.
pub fn undo_list(
    before: &[Value],
    after: &[Value],
    current: &[Value],
    key_of: &dyn Fn(&Value) -> String,
) -> Vec<Value> {
    let index = |list: &[Value]| {
        let mut out: Vec<(String, Value)> = Vec::new();
        for each in list {
            let key = key_of(each);
            match out.iter_mut().find(|(k, _)| *k == key) {
                Some(slot) => slot.1 = each.clone(),
                None => out.push((key, each.clone())),
            }
        }
        out
    };
    let was = index(before);
    let now = index(after);
    let get = |list: &[(String, Value)], key: &str| {
        list.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
    };
    let mut out: Vec<Value> = current.to_vec();
    let mut restored: Vec<Value> = Vec::new();
    for (key, value) in &now {
        if get(&was, key).is_none()
            && let Some(at) = out.iter().position(|each| key_of(each) == *key)
            && same_json(Some(&out[at]), Some(value))
        {
            out.remove(at);
        }
    }
    for (key, value) in &was {
        let at = out.iter().position(|each| key_of(each) == *key);
        match get(&now, key) {
            None => {
                if at.is_none() {
                    restored.push(value.clone());
                }
            }
            Some(then) => {
                // Changed in place by that change, and not since.
                if let Some(at) = at
                    && !same_json(Some(value), Some(&then))
                    && same_json(Some(&out[at]), Some(&then))
                {
                    out[at] = value.clone();
                }
            }
        }
    }
    restored.extend(out);
    restored
}

/// The settings fields a save pushes to every page, and what the push
/// says changed (`PUSHED_FIELDS` of module.ts).
pub const PUSHED_FIELDS: [(&str, &str); 10] = [
    ("order", "order"),
    ("pinned", "pinned"),
    ("hidden", "hidden"),
    ("overrides", "overrides"),
    ("views", "views"),
    ("unsent", "unsent"),
    ("upstreamGroups", "upstream"),
    ("upstreamSkip", "upstream"),
    ("upstreamWorkspaces", "upstream"),
    ("efforts", "efforts"),
];

/// What a save from `before` to `next` changed among [`PUSHED_FIELDS`]
/// (each kind once): a change takes the next version and is pushed.
pub fn pushed_changes(before: &Obj, next: &Obj) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for (field, kind) in PUSHED_FIELDS {
        let same = js::stringify(before.get(field).unwrap_or(&Value::Null))
            == js::stringify(next.get(field).unwrap_or(&Value::Null));
        if !same && !out.contains(&kind) {
            out.push(kind);
        }
    }
    out
}

/// The push of a saved change (`MrReviewsPush`).
pub fn push_of(saved: &Obj, changed: &[&str], meta: &ChangeMeta) -> Value {
    let version = order_version(saved);
    let mut out = Obj::new();
    out.insert("version".into(), json!(version));
    out.insert(
        "order".into(),
        saved.get("order").cloned().unwrap_or(json!([])),
    );
    out.insert("changed".into(), json!(changed));
    out.insert("by".into(), json!(meta.by));
    if let Some(summary) = &meta.summary {
        out.insert("summary".into(), json!(summary));
    }
    if meta.undoable {
        out.insert("undo".into(), json!(version));
    }
    Value::Object(out)
}

/// Says in a few words what an operation moved.
pub type Describe<'a> = &'a (dyn Fn(&[String]) -> String + Sync);

#[derive(Default)]
struct History {
    /// Per version: the whole settings as saved (Undo takes back any field
    /// a change touched).
    stored: HashMap<i64, Obj>,
    /// Per version: the list as it was shown.
    shown: HashMap<i64, Vec<String>>,
}

/// The order service (`createMrOrder`).
pub struct MrOrder {
    inbox: MrInbox,
    settings: SettingsFn,
    save: SaveFn,
    history: Mutex<History>,
    /// Pins, removals and order changes read the settings, change them,
    /// save: one at a time.
    editing: tokio::sync::Mutex<()>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

impl MrOrder {
    pub fn new(inbox: MrInbox, settings: SettingsFn, save: SaveFn) -> MrOrder {
        MrOrder {
            inbox,
            settings,
            save,
            history: Mutex::new(History::default()),
            editing: tokio::sync::Mutex::new(()),
        }
    }

    /// Runs a settings change after those asked before it (`editSettings`).
    pub async fn edit<T>(&self, change: impl Future<Output = T>) -> T {
        let _turn = self.editing.lock().await;
        change.await
    }

    /// The inbox as the user sees it, for these settings.
    pub fn view_of(&self, settings: &Obj) -> MrOrderView {
        let (entries, hidden) = self.inbox.entries(settings);
        let order = strings(settings.get("order"));
        let sections: [Vec<Obj>; 4] = SECTIONS.map(|name| {
            let entries: Vec<Obj> = entries
                .iter()
                .filter(|e| js::sv(e.get("section")) == name)
                .cloned()
                .collect();
            order_entries(&entries, &order, |e: &Obj| key_of(e))
        });
        MrOrderView {
            version: order_version(settings),
            sections,
            hidden,
        }
    }

    fn keys_of(view: &MrOrderView) -> Sections {
        view.sections
            .clone()
            .map(|entries| entries.iter().map(|e| key_of(e).to_owned()).collect())
    }

    fn shown_list(&self, settings: &Obj) -> Vec<String> {
        flatten_sections(&Self::keys_of(&self.view_of(settings)))
    }

    /// Remembers what a save produced (the version it got).
    pub fn remember(&self, settings: &Obj) {
        let version = order_version(settings);
        let shown = self.shown_list(settings);
        let mut history = lock(&self.history);
        history.stored.insert(version, settings.clone());
        history.shown.insert(version, shown);
        history.stored.retain(|old, _| *old > version - HISTORY);
        history.shown.retain(|old, _| *old > version - HISTORY);
    }

    /// Remembers the settings a save starts from, unless known.
    pub fn seed(&self, settings: &Obj) {
        let known = lock(&self.history)
            .stored
            .contains_key(&order_version(settings));
        if !known {
            self.remember(settings);
        }
    }

    /// The inbox as the user sees it: sections in their order.
    pub async fn view(&self) -> MrOrderView {
        self.view_of(&(self.settings)().await)
    }

    /// An operation on the latest order, applied and saved. `describe` says
    /// in a few words what moved (the agent's changes).
    pub async fn apply(
        &self,
        operation: &OrderOp,
        meta: &ChangeMeta,
        describe: Option<Describe<'_>>,
    ) -> Result<MrOrderResult, String> {
        self.edit(async {
            let current = (self.settings)().await;
            self.seed(&current);
            let before = self.view_of(&current);
            let outcome = apply_order_op(&Self::keys_of(&before), operation);
            if outcome.moved.is_empty() {
                return Ok(MrOrderResult {
                    changed: false,
                    version: before.version,
                    moved: vec![],
                    unknown: outcome.unknown,
                    elsewhere: outcome.elsewhere,
                    view: before,
                });
            }
            let mut next = current.clone();
            next.insert(
                "order".into(),
                json!(stored_order(
                    &flatten_sections(&outcome.sections),
                    &strings(current.get("order"))
                )),
            );
            let saved = (self.save)(
                next,
                ChangeMeta {
                    by: meta.by.clone(),
                    summary: describe.map(|describe| describe(&outcome.moved)),
                    undoable: meta.undoable,
                },
            )
            .await?;
            Ok(MrOrderResult {
                changed: true,
                version: order_version(&saved),
                moved: outcome.moved,
                unknown: outcome.unknown,
                elsewhere: outcome.elsewhere,
                view: self.view_of(&saved),
            })
        })
        .await
    }

    /// A whole list from a page that last saw `base_version`, put on the
    /// settings in effect: what it moved is applied on their order. Without
    /// that version's order (an old one, or after a restart) the list is
    /// taken as it is, the keys it lacks kept after it.
    pub fn rebased(
        &self,
        current: &Obj,
        list: &[String],
        base_version: Option<i64>,
    ) -> Vec<String> {
        self.seed(current);
        let base = base_version
            .filter(|base| *base != order_version(current))
            .and_then(|base| lock(&self.history).shown.get(&base).cloned());
        match base {
            Some(base) => stored_order(
                &rebase_order(&base, list, &self.shown_list(current)),
                &strings(current.get("order")),
            ),
            None => list.iter().take(MAX_ORDER).cloned().collect(),
        }
    }

    /// Takes back the change that made `version`: each field it touched
    /// goes back to what it was, unless something changed it since (for
    /// the order: what that change moved, undone on the latest order; for
    /// keyed fields such as overrides, key by key).
    pub async fn undo(&self, version: i64) -> Result<Obj, String> {
        self.edit(async {
            let current = (self.settings)().await;
            self.seed(&current);
            let (after, before, settings_before, settings_after) = {
                let history = lock(&self.history);
                (
                    history.shown.get(&version).cloned(),
                    history.shown.get(&(version - 1)).cloned(),
                    history.stored.get(&(version - 1)).cloned(),
                    history.stored.get(&version).cloned(),
                )
            };
            let (Some(after), Some(before), Some(settings_before), Some(settings_after)) =
                (after, before, settings_before, settings_after)
            else {
                return Err("That change can no longer be undone.".to_owned());
            };
            let text = |v: Option<&Value>| v.map(js::stringify);
            let mut next = current.clone();
            if text(settings_before.get("order")) != text(settings_after.get("order")) {
                let order = if order_version(&current) == version {
                    settings_before.get("order").cloned().unwrap_or(json!([]))
                } else {
                    json!(stored_order(
                        &rebase_order(&after, &before, &self.shown_list(&current)),
                        &strings(current.get("order"))
                    ))
                };
                next.insert("order".into(), order);
            }
            for field in UNDO_LISTS {
                let key_of = |value: &Value| undo_list_key(field, value);
                next.insert(
                    field.into(),
                    Value::Array(undo_list(
                        list(settings_before.get(field)),
                        list(settings_after.get(field)),
                        list(current.get(field)),
                        &key_of,
                    )),
                );
            }
            let record = |settings: &Obj, field: &str| {
                settings
                    .get(field)
                    .and_then(Value::as_object)
                    .cloned()
                    .unwrap_or_default()
            };
            for field in UNDO_RECORDS {
                next.insert(
                    field.into(),
                    Value::Object(undo_record(
                        &record(&settings_before, field),
                        &record(&settings_after, field),
                        &record(&current, field),
                    )),
                );
            }
            (self.save)(next, ChangeMeta::user()).await
        })
        .await
    }
}

#[cfg(test)]
mod tests;
