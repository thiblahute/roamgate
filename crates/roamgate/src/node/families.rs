//! A node's core: the families of its own connection, and every shared
//! family left to the home. A shared family keeps its name, so its calls,
//! paths and sockets still find it, but none of its code runs: it answers
//! `served_by_home`, writes nothing and starts no background work.

use std::sync::Arc;

use roamgate_base::node::{SERVED_BY_HOME, served_by_home_message};
use roamgate_sidecar::family::{CoreFamily, Families, FamilyContext};
use roamgate_sidecar::owners::families as declared_families;
use roamgate_sidecar::peer::{
    BodyReceiver, BoxFuture, HttpRequest, HttpResponse, IncomingCall, Peer, WsOpen,
};
use roamgate_sidecar::protocol::{RpcError, family_of};
use serde_json::{Value, json};

use crate::families::{agent_sessions, front, host, workspace};

/// The families the home serves for every machine: their stores and jobs
/// have one writer (Work, reviews, MR reviews, settings, archive,
/// activity, history, notifications and Web Push, voice, the assistant,
/// the forge cache, conversation mode, agent profiles, the limit
/// resumer, Herdr setup and the update).
pub const HOME_FAMILIES: &[&str] = &[
    "limit_resume",
    "time_report",
    "herdr_setup",
    "update",
    "settings",
    "mr_cache",
    "notifications",
    "activity",
    "archive",
    "assistant",
    "work",
    "mr_reviews",
    "voice",
    "agent_profiles",
    "conversation",
    "review",
    "history",
];

/// Methods of the node's own families, and of what the front answers
/// itself, that are the home's all the same: every settings read and
/// write (the home's settings.json is the one, the workspace arrangement
/// and auto-sync included), the port forwards (the
/// home's registry), the connections' registry changes and the time
/// report.
const HOME_METHODS: &[&str] = &[
    "settings.",
    "bridge.ui_settings.",
    "bridge.workspace_tree.",
    "forward.",
    "connections.create",
    "connections.update",
    "connections.remove",
    "connections.set_default",
    "bridge.time_report",
];

/// A browser method a node refuses: its family is the home's, or it is
/// one of [`HOME_METHODS`].
pub fn home_method(method: &str) -> bool {
    HOME_METHODS.iter().any(|entry| {
        if entry.ends_with('.') {
            method.starts_with(entry)
        } else {
            method == *entry
        }
    }) || family_of(method, declared_families())
        .is_some_and(|family| HOME_FAMILIES.contains(&family.as_str()))
}

/// The refusal of a call a node leaves to its home.
pub fn served_by_home(what: &str) -> RpcError {
    RpcError::with_code(served_by_home_message(what), SERVED_BY_HOME)
}

/// A shared family in a node: its name only.
struct HomeOnly(&'static str);

impl CoreFamily for HomeOnly {
    fn name(&self) -> &'static str {
        self.0
    }

    fn call(&self, _cx: &FamilyContext, call: IncomingCall) -> BoxFuture<Result<Value, RpcError>> {
        let error = served_by_home(&call.method);
        Box::pin(async move { Err(error) })
    }

    fn http(
        &self,
        _cx: &FamilyContext,
        request: HttpRequest,
        _body: Option<BodyReceiver>,
    ) -> BoxFuture<Result<HttpResponse, RpcError>> {
        let body = json!({
            "error": served_by_home_message(request.url.split('?').next().unwrap_or("")),
            "code": SERVED_BY_HOME,
        });
        Box::pin(async move {
            let (tx, rx) = tokio::sync::mpsc::channel(1);
            let _ = tx.try_send(serde_json::to_vec(&body).unwrap_or_default());
            Ok(HttpResponse {
                status: 404,
                headers: vec![(
                    "content-type".to_owned(),
                    "application/json;charset=utf-8".to_owned(),
                )],
                body: Some(rx),
            })
        })
    }

    fn ws_open(
        &self,
        _cx: &FamilyContext,
        _link: &Peer,
        _open: WsOpen,
    ) -> BoxFuture<Result<Value, RpcError>> {
        Box::pin(async {
            Ok(json!({
                "accepted": false,
                "status": 404,
                "headers": [["content-type", "text/plain;charset=utf-8"]],
                "body": "served by the home",
            }))
        })
    }

    // `owned` does nothing: no writer, no background work.
}

/// The families of a node's standalone core: the front family, the host
/// (its one connection), the workspace (files, git, worktrees) and agent
/// sessions (transcripts); every shared family as [`HomeOnly`].
pub fn node_families() -> Families {
    let (host, handle) = host::family_with_handle();
    let mut all: Families = vec![front::family(handle), host];
    all.extend(workspace::family());
    all.extend(agent_sessions::family());
    all.extend(
        HOME_FAMILIES
            .iter()
            .map(|name| Arc::new(HomeOnly(name)) as Arc<dyn CoreFamily>),
    );
    all
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every family the owners table declares is the node's or the
    /// home's: a new family must choose.
    #[test]
    fn every_declared_family_is_the_node_s_or_the_home_s() {
        let node = ["front", "host", "workspace", "agent_sessions", "test.echo"];
        for name in declared_families().keys() {
            assert!(
                node.contains(&name.as_str()) || HOME_FAMILIES.contains(&name.as_str()),
                "{name}"
            );
        }
        for name in HOME_FAMILIES {
            assert!(!node.contains(name), "{name}");
        }
    }

    #[test]
    fn the_shared_methods_are_the_home_s() {
        for method in [
            "bridge.work.list",
            "review.threads",
            "bridge.mr_reviews.list",
            "settings.get",
            "settings.profiles.get",
            "bridge.ui_settings.update",
            "settings.workspace_auto_sync.set",
            "bridge.notifications.list",
            "agent_chat.send",
            "agent_profile.list",
            "bridge.assistant.ask",
            "limit_resume.list",
            "forward.open",
            "connections.create",
            "bridge.workspace_tree.get",
        ] {
            assert!(home_method(method), "{method}");
        }
        for method in [
            "pane.list",
            "terminal.attach",
            "file.read",
            "git.status",
            "agent_history.list",
            "agent_session.read",
            "connections.list",
            "connections.connect",
            "bridge.ping",
            "workspace.list",
            "agent.list",
        ] {
            assert!(!home_method(method), "{method}");
        }
    }
}
