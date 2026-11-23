//! Threads and reviews in the shape the skill documents
//! (review/agent-server.ts's threadOutput and sessionOutput).

use serde_json::{Map, Value, json};

use crate::model::{ReviewAnchor, ReviewSession, ReviewThread, comment_edited};
use crate::parse::describe_target;

fn to_value<T: serde::Serialize>(value: &T) -> Value {
    serde_json::to_value(value).unwrap_or(Value::Null)
}

fn location_of(anchor: &ReviewAnchor) -> String {
    let Some(path) = anchor.path.as_deref().filter(|p| !p.is_empty()) else {
        if let Some(effort) = &anchor.effort {
            let item = effort
                .item
                .as_ref()
                .map(|item| format!(" {} {}", item.kind, item.key))
                .unwrap_or_default();
            return format!("effort {}{item}", effort.tab);
        }
        return "review".into();
    };
    let Some(line) = anchor.line.filter(|l| *l != 0) else {
        return path.to_owned();
    };
    let lines = match anchor.end_line.filter(|l| *l != 0) {
        Some(end) => format!("{line}-{end}"),
        None => line.to_string(),
    };
    let old = if anchor.side.as_deref() == Some("old") {
        " [old]"
    } else {
        ""
    };
    format!("{path}:{lines}{old}")
}

/// The user's held feedback is not the agent's until sent.
pub fn not_held(thread: &ReviewThread) -> bool {
    thread.held.is_none()
}

fn opt<T: serde::Serialize>(value: &Option<T>) -> Value {
    value.as_ref().map_or(Value::Null, to_value)
}

/// A thread in the shape the skill documents.
pub fn thread_output(thread: &ReviewThread) -> Value {
    let anchor = &thread.anchor;
    let mut out = Map::new();
    out.insert("id".into(), json!(thread.id));
    out.insert("session".into(), json!(thread.session_id));
    out.insert("kind".into(), json!(thread.kind));
    out.insert("location".into(), json!(location_of(anchor)));
    out.insert("path".into(), opt(&anchor.path));
    out.insert("line".into(), opt(&anchor.line));
    out.insert("end_line".into(), opt(&anchor.end_line.or(anchor.line)));
    out.insert("side".into(), opt(&anchor.side));
    out.insert("code".into(), opt(&anchor.text));
    // On a part of a chat message: which one, and the words quoted.
    if let Some(chat) = &anchor.chat {
        let mut part = Map::new();
        part.insert("entry".into(), json!(chat.entry));
        part.insert("at".into(), opt(&chat.at));
        part.insert("excerpt".into(), opt(&chat.excerpt));
        part.insert("quote".into(), json!(chat.quote));
        // On a file a tool call changed: that call.
        if let Some(call) = chat.call.as_deref().filter(|c| !c.is_empty()) {
            part.insert("tool_call".into(), json!(call));
        }
        out.insert("on_chat_message".into(), Value::Object(part));
    }
    // On what an effort's view shows: the tab, the item, the words.
    if let Some(effort) = &anchor.effort {
        out.insert(
            "on_effort".into(),
            json!({
                "tab": effort.tab,
                "item": opt(&effort.item),
                "plan": opt(&effort.plan),
                "quote": opt(&effort.quote),
            }),
        );
    }
    if let Some(terminal) = &anchor.terminal {
        out.insert("on_terminal".into(), to_value(terminal));
    }
    // On what a rendered review shows: the words, region, element, page.
    if let Some(render) = &anchor.render {
        out.insert("on_rendered".into(), to_value(render));
    }
    // On a part of an earlier message: which one, and the words quoted.
    if let Some(message) = &anchor.message {
        out.insert(
            "on_message".into(),
            json!({
                "thread": message.thread,
                "comment": message.comment,
                "quote": opt(&message.quote),
            }),
        );
    }
    out.insert("resolved".into(), json!(thread.resolved));
    // A review comment answering this GitLab discussion, once sent there.
    if let Some(reply_to) = thread.gitlab_reply_to.as_deref().filter(|r| !r.is_empty()) {
        out.insert("reply_to".into(), json!(format!("gl:{reply_to}")));
    }
    let comments: Vec<Value> = thread
        .comments
        .iter()
        .map(|comment| {
            let mut each = Map::new();
            each.insert("id".into(), json!(comment.id));
            each.insert("author".into(), json!(comment.author));
            each.insert("text".into(), json!(comment.body));
            each.insert("created_at".into(), json!(comment.created_at));
            if comment_edited(comment) {
                each.insert("edited_at".into(), json!(comment.updated_at));
            }
            if comment.gitlab_draft_id.is_some() {
                each.insert("gitlab_draft".into(), json!(true));
            }
            Value::Object(each)
        })
        .collect();
    out.insert("comments".into(), Value::Array(comments));
    Value::Object(out)
}

/// A review in the shape the skill documents.
pub fn session_output(session: &ReviewSession) -> Value {
    json!({
        "id": session.id,
        "title": session.title,
        "target": describe_target(&session.target),
        "root": session.root,
        "gitlab": session.gitlab,
        "summary": session.summary,
        "handoff_at": opt(&session.handoff_at),
        "agent": to_value(&session.agent),
        "updated_at": session.updated_at,
    })
}
