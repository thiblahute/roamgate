//! What the inbox, order and RPC tests share: a store on disk, settings,
//! fetchers made of closures, and the inbox over them.

use std::sync::{Arc, Mutex};

use roamgate_agents::js::{self, Obj};
use roamgate_base::paths::{DataContext, Platform};
use serde_json::{Value, json};

use super::{MrInbox, MrInboxDeps, SettingsFn};
use crate::connection::BoxFuture;
use crate::fetchers::{FetchCall, FetchError, FetchResult, InboxFetchers};
use crate::settings::default_settings;
use crate::store::{MrStore, state_path};

pub type SharedStore = Arc<Mutex<MrStore>>;

/// A store on disk, in a directory gone with the TempDir.
pub fn store() -> (tempfile::TempDir, SharedStore) {
    let dir = tempfile::tempdir().unwrap();
    let context = DataContext::new(dir.path(), Platform::current(), None);
    let path = state_path(&context.data_root());
    (dir, Arc::new(Mutex::new(MrStore::open(context, path))))
}

/// `DEFAULT_MR_REVIEWS_SETTINGS` with these fields.
pub fn settings(fields: Value) -> Obj {
    let mut out = default_settings();
    for (key, value) in fields.as_object().cloned().unwrap_or_default() {
        out.insert(key, value);
    }
    out
}

/// Settings that never change.
pub fn fixed(settings: &Obj) -> SettingsFn {
    let settings = settings.clone();
    Arc::new(move || {
        let settings = settings.clone();
        Box::pin(async move { settings })
    })
}

/// Settings a test changes as it goes.
pub fn shared(settings: &Arc<Mutex<Obj>>) -> SettingsFn {
    let settings = settings.clone();
    Arc::new(move || {
        let value = settings.lock().unwrap().clone();
        Box::pin(async move { value })
    })
}

/// A clock a test moves.
pub fn clock(at: &str) -> Arc<Mutex<f64>> {
    Arc::new(Mutex::new(js::date_parse(at)))
}

type Answer = Box<dyn Fn(&str, &str) -> FetchResult<Value> + Send + Sync>;
type Drafts = Box<dyn Fn(&Obj) -> FetchResult<usize> + Send + Sync>;

/// Fetchers made of closures (host, query), as the TS tests' objects.
pub struct FnFetchers {
    pub gitlab: Answer,
    pub github: Answer,
    pub drafts: Drafts,
}

impl Default for FnFetchers {
    fn default() -> Self {
        FnFetchers {
            gitlab: Box::new(|_, _| Ok(json!({"data": {}}))),
            github: Box::new(|_, _| Ok(json!({"data": {"viewer": {"login": "me"}}}))),
            drafts: Box::new(|_| Ok(0)),
        }
    }
}

impl InboxFetchers for FnFetchers {
    fn gitlab<'a>(
        &'a self,
        host: &'a str,
        query: &'a str,
        _call: &'a FetchCall,
    ) -> BoxFuture<'a, FetchResult<Value>> {
        let answer = (self.gitlab)(host, query);
        Box::pin(async move { answer })
    }

    fn github<'a>(
        &'a self,
        host: &'a str,
        query: &'a str,
        _call: &'a FetchCall,
    ) -> BoxFuture<'a, FetchResult<Value>> {
        let answer = (self.github)(host, query);
        Box::pin(async move { answer })
    }

    fn gitlab_drafts<'a>(&'a self, item: &'a Obj) -> BoxFuture<'a, FetchResult<usize>> {
        let answer = (self.drafts)(item);
        Box::pin(async move { answer })
    }
}

pub fn failed(message: &str) -> FetchError {
    FetchError::Failed(message.into())
}

/// The inbox over these fetchers, settings and store; `now` when given.
pub fn inbox_of(
    fetchers: Arc<dyn InboxFetchers>,
    settings: SettingsFn,
    store: &SharedStore,
    now: Option<Arc<Mutex<f64>>>,
) -> MrInbox {
    let mut deps = MrInboxDeps::new(fetchers, settings, store.clone());
    if let Some(now) = now {
        deps.now = Arc::new(move || *now.lock().unwrap());
    }
    MrInbox::new(deps)
}

/// The snapshot's rows.
pub fn entries(inbox: &MrInbox, settings: &Obj) -> Vec<Obj> {
    inbox.entries(settings).0
}

/// The rows of a section.
pub fn section(inbox: &MrInbox, settings: &Obj, name: &str) -> Vec<Obj> {
    entries(inbox, settings)
        .into_iter()
        .filter(|e| js::sv(e.get("section")) == name)
        .collect()
}

pub fn number(entry: &Obj) -> u64 {
    entry.get("number").and_then(Value::as_u64).unwrap_or(0)
}

pub fn by_number(entries: &[Obj], number: u64) -> Obj {
    entries
        .iter()
        .find(|e| e.get("number").and_then(Value::as_u64) == Some(number))
        .cloned()
        .unwrap_or_else(|| panic!("no row {number}"))
}

/// A GitLab GraphQL merge request node, as the TS tests' `mr`.
pub fn gitlab_mr(iid: u64, extra: Value) -> Value {
    let mut node = json!({
        "iid": iid.to_string(),
        "title": format!("MR {iid}"),
        "webUrl": format!("https://gitlab.example.org/group/app/-/merge_requests/{iid}"),
        "state": "opened",
        "updatedAt": "2026-11-03T10:00:00Z",
        "userNotesCount": 1,
        "diffHeadSha": "aaaaaaa1",
        "project": {"fullPath": "group/app"},
        "author": {"username": "alice"},
    });
    for (key, value) in extra.as_object().cloned().unwrap_or_default() {
        node[key] = value;
    }
    node
}
