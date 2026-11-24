//! Herdr's `ServerMessage::SemanticNotification` (tag 14 of the frozen
//! endpoint generation 1 enum; bridge/semantic-notification.ts): Herdr
//! reports the semantic event after applying its own notification policy;
//! each client-rendered shell chooses how to show it.

use serde_json::{Value, json};

use crate::thin::BinReader;

/// Variant order of Herdr's `SemanticNotificationKind`.
const KINDS: [&str; 4] = ["needs_attention", "finished", "update_installed", "custom"];
/// Variant order of Herdr's `SemanticNotificationSound`.
const SOUNDS: [&str; 2] = ["done", "request"];
/// `ToastHerdrPosition`: TopLeft, TopRight, BottomLeft, BottomRight.
const POSITION_VARIANTS: u64 = 4;
const MAX_TITLE_CHARS: usize = 200;
const MAX_TEXT_CHARS: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticNotification {
    pub kind: &'static str,
    pub title: String,
    pub body: Option<String>,
    pub sound: Option<&'static str>,
    pub agent: Option<String>,
    pub workspace_id: Option<String>,
    pub tab_id: Option<String>,
    pub pane_id: Option<String>,
}

impl SemanticNotification {
    /// The TS object's fields (`workspaceId`, `tabId`, `paneId`), as
    /// roamgate-notify's task event mapping reads them.
    pub fn to_value(&self) -> Value {
        json!({
            "kind": self.kind,
            "title": self.title,
            "body": self.body,
            "sound": self.sound,
            "agent": self.agent,
            "workspaceId": self.workspace_id,
            "tabId": self.tab_id,
            "paneId": self.pane_id,
        })
    }
}

/// `value.slice(0, max - 1) + "…"` past `max` UTF-16 units.
fn clip(value: String, max: usize) -> String {
    if value.encode_utf16().count() <= max {
        return value;
    }
    let kept: Vec<u16> = value.encode_utf16().take(max - 1).collect();
    format!("{}\u{2026}", String::from_utf16_lossy(&kept))
}

fn optional_text(reader: &mut BinReader<'_>, max: usize) -> Result<Option<String>, String> {
    let value = reader.option(BinReader::string)?;
    Ok(value
        .filter(|value| !value.is_empty())
        .map(|value| clip(value, max)))
}

/// The payload after the ServerMessage variant tag.
pub fn read_semantic_notification(
    reader: &mut BinReader<'_>,
) -> Result<SemanticNotification, String> {
    let kind = *KINDS
        .get(reader.variant()? as usize)
        .ok_or("unknown semantic notification kind")?;
    let title = clip(reader.string()?, MAX_TITLE_CHARS);
    let body = optional_text(reader, MAX_TEXT_CHARS)?;
    let sound = reader.option(|reader| {
        SOUNDS
            .get(reader.variant()? as usize)
            .copied()
            .ok_or_else(|| "unknown semantic notification sound".to_owned())
    })?;
    let agent = optional_text(reader, MAX_TITLE_CHARS)?;
    let workspace_id = optional_text(reader, MAX_TITLE_CHARS)?;
    let tab_id = optional_text(reader, MAX_TITLE_CHARS)?;
    let pane_id = optional_text(reader, MAX_TITLE_CHARS)?;
    // Toast placement only applies to Herdr's own TUI renderer.
    reader.option(|reader| {
        if reader.variant()? >= POSITION_VARIANTS {
            return Err("unknown semantic notification position".to_owned());
        }
        Ok(())
    })?;
    Ok(SemanticNotification {
        kind,
        title,
        body,
        sound,
        agent,
        workspace_id,
        tab_id,
        pane_id,
    })
}
