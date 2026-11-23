//! Claude Code's /rewind over its control protocol
//! (`drivers/claude-rewind.ts`, with `claude-rewind-scan.ts`, whose
//! `scanRewind` is roamgate-agents' `rewind::scan_rewind`): the
//! conversation (Claude Code records the cut in the transcript, so a later
//! resume, here or in the terminal, goes on from before it), the code
//! (from the checkpoints Claude Code keeps), or both. `last_seen` is the
//! latest message of the user's the chat shows: Claude Code refuses to cut
//! a later turn the user has not seen.

use std::sync::Arc;

use roamgate_agents::js::Obj;
use roamgate_agents::obj;
use roamgate_agents::rewind::{self as scan, RewindScan, scan_rewind};
use roamgate_conversation::driver::{
    BoxFuture, HeadlessProcess, RewindContext, RewindDriver, RewindInput, Transcript,
};
use serde_json::{Value, json};

/// Why Claude Code would not rewind the conversation, said for the user.
fn rewind_refusal(reason: &str) -> Option<&'static str> {
    Some(match reason {
        "turn_running" => "a turn is running",
        "commands_queued" => "messages wait to be sent",
        "prompt_pending" => "a question or permission waits for an answer",
        "target_not_found" => "the message is not in the conversation any more",
        "stale_target" => {
            "the conversation has moved on since the chat showed it; reload and try again"
        }
        "unseen_later_turn" => {
            "the conversation has a later turn the chat has not shown yet; try again"
        }
        "target_splits_tool_call" => "the message is inside a tool call",
        "persist_failed" => "Claude Code could not save the rewind",
        "state_changed" => "the conversation changed meanwhile; try again",
        "usage_limited" => "the usage limit is reached",
        "expired" => "it took too long",
        _ => return None,
    })
}

const NO_CHECKPOINTS: &str = "File rewinding is not enabled.";
const NO_CHECKPOINT_FOR_MESSAGE: &str = "No file checkpoint found for this message.";

/// `scanRewind` on a transcript as the session reads it.
pub fn scan_transcript_of(transcript: &Transcript, uuid: &str) -> RewindScan {
    match transcript {
        Transcript::Text(text) => scan_rewind(scan::Transcript::Text(text), uuid),
        Transcript::Records(records) => {
            scan_rewind(scan::Transcript::Records(records.clone()), uuid)
        }
    }
}

/// What the code of a rewind to before a message comes to
/// (`AgentChatRewindCheck`).
pub fn rewind_check_of(scan: Option<&RewindScan>) -> Value {
    let Some(scan) = scan.filter(|scan| scan.found) else {
        return json!({"code": "unknown"});
    };
    if scan.edited.is_empty() {
        return json!({"code": "none"});
    }
    json!({
        "code": if scan.checkpoint { "restorable" } else { "no_checkpoint" },
        "files": scan.edited,
    })
}

/// A rewind step that did not go through, and why.
type Step = Result<Option<Vec<String>>, String>;

/// Restores the code to before `uuid`: a dry run first, unless `real`.
async fn rewind_files(
    context: &dyn RewindContext,
    child: &Arc<dyn HeadlessProcess>,
    uuid: &str,
    dry_run: bool,
) -> Step {
    let mut params = obj! {"user_message_id" => uuid};
    if dry_run {
        params.insert("dry_run".into(), Value::Bool(true));
    }
    let Some(answer) = context.control(child, "rewind_files", params).await else {
        return Err("Claude did not answer".to_owned());
    };
    let empty = Obj::new();
    let response = answer.response.as_ref().unwrap_or(&empty);
    let error = answer.error.clone().or_else(|| {
        if response.get("canRewind") == Some(&Value::Bool(true)) {
            None
        } else {
            Some(
                response
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("Claude Code cannot restore the code")
                    .to_owned(),
            )
        }
    });
    // JavaScript's `if (error)`: an empty one is none.
    if let Some(error) = error.filter(|error| !error.is_empty()) {
        return Err(error);
    }
    let files = response
        .get("filesChanged")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        });
    Ok(files)
}

/// What the transcript says of the code after `uuid`; None: unknown.
async fn scan_transcript(context: &dyn RewindContext, uuid: &str) -> Option<RewindScan> {
    let read = context.read_transcript()?;
    match read.await {
        Ok(Some(transcript)) => {
            Some(scan_transcript_of(&transcript, uuid)).filter(|scan| scan.found)
        }
        Ok(None) => None,
        Err(error) => {
            context.log(
                "could not read the transcript for a rewind",
                Some(obj! {"session" => context.session_id(), "error" => error}),
            );
            None
        }
    }
}

fn refuse(reason: String) -> Value {
    json!({"ok": false, "reason": reason})
}

pub struct ClaudeRewind;

impl ClaudeRewind {
    async fn rewind(
        &self,
        context: &dyn RewindContext,
        input: RewindInput,
    ) -> Result<Value, String> {
        let mut child = context.ensure_process().await?;
        // Whether the code is restored: only when asked, and when there is
        // something to restore.
        let mut code = false;
        let mut files: Option<Vec<String>> = None;
        if input.mode != "conversation" {
            // Checked first: a conversation rewound without its code (or the
            // other way round) is not what was asked. What the transcript
            // says (None: it does not) decides along with Claude Code's dry
            // run.
            let scan = scan_transcript(context, &input.uuid).await;
            let edited = scan.as_ref().map(|scan| scan.edited.clone());
            let no_checkpoint = || {
                let mut result = obj! {
                    "ok" => false,
                    "no_checkpoint" => true,
                    "reason" => "Claude Code has no code checkpoint for these changes (made before checkpoints were on)",
                };
                if let Some(edited) = edited.as_ref().filter(|edited| !edited.is_empty()) {
                    result.insert("files".into(), json!(edited));
                }
                Value::Object(result)
            };
            // Nothing edited after the message: nothing to restore, so no
            // checkpoint is needed, nor a process that keeps them.
            let nothing_edited = edited.as_ref().is_some_and(Vec::is_empty);
            let mut check = rewind_files(context, &child, &input.uuid, true).await;
            if !nothing_edited && matches!(&check, Err(reason) if reason == NO_CHECKPOINTS) {
                // A process started before checkpoints were turned on for
                // it: a new one has them, and reads those already in the
                // session; unless Claude Code took none for this message
                // (the edits were made before), which no restart brings
                // back.
                if scan.as_ref().is_some_and(|scan| !scan.checkpoint) {
                    return Ok(no_checkpoint());
                }
                context.log(
                    "conversation process without checkpoints; starting another",
                    Some(obj! {"session" => context.session_id()}),
                );
                if !context.stop_process().await {
                    return Ok(refuse("Claude did not stop to restore the code".to_owned()));
                }
                child = context.ensure_process().await?;
                check = rewind_files(context, &child, &input.uuid, true).await;
            }
            match check {
                Err(reason) if !nothing_edited => {
                    return Ok(
                        if reason == NO_CHECKPOINT_FOR_MESSAGE || reason == NO_CHECKPOINTS {
                            no_checkpoint()
                        } else {
                            refuse(reason)
                        },
                    );
                }
                Ok(Some(changed)) if !changed.is_empty() => {
                    code = true;
                    files = Some(changed);
                }
                _ => {}
            }
        }
        let mut prefill: Option<String> = None;
        if input.mode != "code" {
            let mut params = obj! {"target_message_uuid" => input.uuid.as_str()};
            if let Some(seen) = input.last_seen.as_ref().filter(|seen| !seen.is_empty()) {
                params.insert(
                    "last_seen_user_message_uuid".into(),
                    Value::String(seen.clone()),
                );
            }
            let Some(answer) = context.control(&child, "rewind_conversation", params).await else {
                return Ok(refuse("Claude did not answer".to_owned()));
            };
            let empty = Obj::new();
            let response = answer.response.as_ref().unwrap_or(&empty);
            let error = answer.error.clone().filter(|error| !error.is_empty());
            if error.is_some() || response.get("rewound") != Some(&Value::Bool(true)) {
                let why = match (answer.error, response.get("reason").and_then(Value::as_str)) {
                    (Some(error), _) => error,
                    (None, Some(reason)) => rewind_refusal(reason)
                        .map(str::to_owned)
                        .or_else(|| {
                            response
                                .get("error")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                        })
                        .unwrap_or_else(|| reason.to_owned()),
                    (None, None) => "it refused".to_owned(),
                };
                return Ok(refuse(format!("Claude Code did not rewind: {why}")));
            }
            prefill = response
                .get("prefillText")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if code && let Err(reason) = rewind_files(context, &child, &input.uuid, false).await {
            return Ok(refuse(if input.mode == "both" {
                format!("The conversation was rewound, but not the code: {reason}")
            } else {
                reason
            }));
        }
        context.log(
            "conversation rewound",
            Some(obj! {
                "session" => context.session_id(),
                "mode" => input.mode.as_str(),
                "code" => code,
            }),
        );
        let mut result = obj! {"ok" => true, "prefill" => prefill};
        if let Some(files) = files {
            result.insert("files".into(), json!(files));
        }
        if input.mode != "conversation" {
            result.insert(
                "code".into(),
                Value::String(if code { "restored" } else { "none" }.to_owned()),
            );
        }
        Ok(Value::Object(result))
    }
}

impl RewindDriver for ClaudeRewind {
    fn check_transcript(&self, transcript: Option<&Transcript>, uuid: &str) -> Value {
        rewind_check_of(transcript.map(|t| scan_transcript_of(t, uuid)).as_ref())
    }

    fn check<'a>(&'a self, context: &'a dyn RewindContext, uuid: &'a str) -> BoxFuture<'a, Value> {
        Box::pin(async move { rewind_check_of(scan_transcript(context, uuid).await.as_ref()) })
    }

    fn run<'a>(
        &'a self,
        context: &'a dyn RewindContext,
        input: RewindInput,
    ) -> BoxFuture<'a, Result<Value, String>> {
        Box::pin(self.rewind(context, input))
    }
}

#[cfg(test)]
mod tests;
