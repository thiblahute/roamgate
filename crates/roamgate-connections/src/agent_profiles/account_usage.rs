//! Which sessions spent an account: each session's runs on an account
//! (roamgate_accounts::sessions) and the tokens its transcript records
//! during them (roamgate_agents::token_usage).

use std::path::{Path, PathBuf};

use roamgate_accounts::sessions::{SessionRun, SessionRuns};
use roamgate_accounts::{AccountAgent, session_roots};
use roamgate_agents::files::{AgentEnv, LocalSessionFiles, SessionFiles};
use roamgate_agents::token_usage::{TokenUsage, summarize_token_usage};
use roamgate_base::log::parse_iso_millis;
use serde_json::{Map, Value, json};

use super::shared::{profile_account_id, profile_agent, profile_name};
use super::store::data_root_for;

/// Notes the account (if any) a session runs on with `profile` now.
pub fn record_session(home: &Path, session_id: &str, profile: &Value, now_ms: i64) {
    let runs = SessionRuns::new(&data_root_for(home));
    let on =
        profile_account_id(profile).map(|id| (profile_agent(profile), id, profile_name(profile)));
    let _ = runs.record(session_id, on, now_ms);
}

/// A Claude session's transcript: `<projects>/*/<id>.jsonl` under the
/// user's projects or an account's own.
fn claude_transcript(home: &Path, data_root: &Path, id: &str) -> Option<PathBuf> {
    let name = format!("{id}.jsonl");
    let config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    std::iter::once(config.join("projects"))
        .chain(session_roots(data_root, AccountAgent::Claude))
        .filter_map(|root| std::fs::read_dir(root).ok())
        .flat_map(|entries| entries.filter_map(Result::ok))
        .map(|entry| entry.path().join(&name))
        .find(|path| path.is_file())
}

async fn transcript(home: &Path, data_root: &Path, run: &SessionRun) -> Option<PathBuf> {
    match run.agent.as_str() {
        "claude" => claude_transcript(home, data_root, &run.session_id),
        "codex" => {
            let files = LocalSessionFiles {
                env: AgentEnv {
                    home: home.to_path_buf(),
                    vars: std::env::vars().collect(),
                },
            };
            files
                .find_codex_session_by_id(&run.session_id)
                .await
                .ok()
                .flatten()
                .map(|file| PathBuf::from(file.path))
        }
        _ => None,
    }
}

fn timestamp(record: &Map<String, Value>) -> Option<i64> {
    record
        .get("timestamp")
        .and_then(Value::as_str)
        .and_then(parse_iso_millis)
}

fn minus(after: Option<f64>, before: Option<f64>) -> Option<f64> {
    after.map(|after| (after - before.unwrap_or(0.0)).max(0.0))
}

/// The tokens a transcript records within `[from, to]`: its total up to
/// `to` less its total before `from` (a per-message sum, or a running
/// total, both read the same way).
pub fn tokens_between(text: &str, from: i64, to: i64) -> Option<Value> {
    let mut before = Vec::new();
    let mut upto = Vec::new();
    for line in text.lines() {
        let Ok(Value::Object(record)) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let at = timestamp(&record);
        if at.is_some_and(|at| at > to) {
            continue;
        }
        if at.is_some_and(|at| at < from) {
            before.push(record.clone());
        }
        upto.push(record);
    }
    let total = summarize_token_usage(&upto)?;
    let earlier = summarize_token_usage(&before).unwrap_or_default();
    let spent = TokenUsage {
        input_tokens: minus(total.input_tokens, earlier.input_tokens),
        cached_input_tokens: minus(total.cached_input_tokens, earlier.cached_input_tokens),
        output_tokens: minus(total.output_tokens, earlier.output_tokens),
        reasoning_output_tokens: minus(
            total.reasoning_output_tokens,
            earlier.reasoning_output_tokens,
        ),
        prompt_tokens: None,
        total_tokens: None,
    };
    Some(spent.to_value())
}

/// The sessions that ran on an account within `[from, to]`, each with the
/// tokens its transcript records during its runs there.
pub async fn sessions_report(home: &Path, profile: &Value, from: i64, to: i64) -> Value {
    let data_root = data_root_for(home);
    let (Some(id), agent) = (profile_account_id(profile), profile_agent(profile)) else {
        return json!({"sessions": []});
    };
    let runs = SessionRuns::new(&data_root).on_account(agent, id, from, to);
    let mut sessions = Vec::new();
    for run in runs {
        let start = run.started_at.max(from);
        let end = run.ended_at.unwrap_or(to).min(to);
        let tokens = match transcript(home, &data_root, &run).await {
            Some(path) => std::fs::read_to_string(path)
                .ok()
                .and_then(|text| tokens_between(&text, start, end)),
            None => None,
        };
        sessions.push(json!({
            "session_id": run.session_id,
            "profile": run.profile,
            "started_at": run.started_at,
            "ended_at": run.ended_at,
            "tokens": tokens,
        }));
    }
    json!({"sessions": sessions})
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(at: &str, input: u64, output: u64) -> String {
        json!({
            "type": "assistant",
            "timestamp": at,
            "message": {"model": "claude-x", "usage": {"input_tokens": input, "output_tokens": output}},
        })
        .to_string()
    }

    #[test]
    fn tokens_are_counted_within_the_window() {
        let text = [
            line("2026-11-26T10:00:00.000Z", 100, 10),
            line("2026-11-26T11:00:00.000Z", 200, 20),
            line("2026-11-26T12:00:00.000Z", 400, 40),
        ]
        .join("\n");
        let at = |text: &str| parse_iso_millis(text).unwrap();
        let tokens = tokens_between(
            &text,
            at("2026-11-26T10:30:00.000Z"),
            at("2026-11-26T11:30:00.000Z"),
        )
        .unwrap();
        assert_eq!(tokens["input_tokens"], 200);
        assert_eq!(tokens["output_tokens"], 20);
        assert_eq!(tokens_between("", 0, 1), None);
    }

    #[tokio::test]
    async fn an_account_s_sessions_are_listed_with_their_tokens() {
        if std::env::var_os("ROAMGATE_DATA_ROOT").is_some()
            || std::env::var_os("CLAUDE_CONFIG_DIR").is_some()
        {
            return;
        }
        let temp = tempfile::tempdir().unwrap();
        let home = temp.path();
        let id = "11111111-1111-4111-8111-111111111111";
        let project = home.join(".claude/projects/-repo");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::write(
            project.join(format!("{id}.jsonl")),
            line("2026-11-26T10:00:00.000Z", 7, 3),
        )
        .unwrap();
        let profile = json!({"name": "Work", "agent": "claude", "account": {"id": "work"}});
        let at = |text: &str| parse_iso_millis(text).unwrap();
        record_session(home, id, &profile, at("2026-11-26T09:00:00.000Z"));
        let report = sessions_report(
            home,
            &profile,
            at("2026-11-26T00:00:00.000Z"),
            at("2026-11-27T00:00:00.000Z"),
        )
        .await;
        let session = &report["sessions"][0];
        assert_eq!(session["session_id"], id);
        assert_eq!(session["profile"], "Work");
        assert_eq!(session["tokens"]["input_tokens"], 7);
        assert_eq!(session["ended_at"], Value::Null);
    }
}
