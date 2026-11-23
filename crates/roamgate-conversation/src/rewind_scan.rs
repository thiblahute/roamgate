//! What a Claude transcript says of a rewind (`rewind-scan.ts`): the scan
//! lives with the transcript readers, in `roamgate-agents`.

pub use roamgate_agents::rewind::{RewindScan, Transcript, scan_rewind};

#[cfg(test)]
mod tests {
    use roamgate_agents::js;
    use serde_json::{Value, json};

    use super::*;

    fn lines(records: &[Value]) -> String {
        records
            .iter()
            .map(js::stringify)
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn prompt(uuid: &str, parent: Option<&str>) -> Value {
        json!({"type": "user", "uuid": uuid, "parentUuid": parent, "message": {"role": "user", "content": format!("message {uuid}")}})
    }

    fn tool(uuid: &str, parent: &str, name: &str, input: Value) -> Value {
        json!({"type": "assistant", "uuid": uuid, "parentUuid": parent, "message": {"role": "assistant", "content": [
            {"type": "text", "text": "doing it"},
            {"type": "tool_use", "id": format!("t-{uuid}"), "name": name, "input": input},
        ]}})
    }

    fn scan(text: &str, uuid: &str) -> RewindScan {
        scan_rewind(Transcript::Text(text), uuid)
    }

    #[test]
    fn the_files_claude_s_file_tools_edited_after_the_message_once_each() {
        let transcript = lines(&[
            prompt("u1", None),
            tool("a1", "u1", "Bash", json!({"command": "touch x"})),
            prompt("u2", Some("a1")),
            tool("a2", "u2", "Edit", json!({"file_path": "/w/a.ts"})),
            tool(
                "a3",
                "a2",
                "NotebookEdit",
                json!({"notebook_path": "/w/n.ipynb"}),
            ),
            tool("a4", "a3", "Write", json!({"file_path": "/w/a.ts"})),
            tool("a5", "a4", "Read", json!({"file_path": "/w/r.ts"})),
        ]);
        assert_eq!(
            scan(&transcript, "u1"),
            RewindScan {
                found: true,
                edited: vec!["/w/a.ts".into(), "/w/n.ipynb".into()],
                checkpoint: false
            }
        );
        assert_eq!(
            scan(&format!("{transcript}\n{{\"half"), "u2").edited,
            ["/w/a.ts", "/w/n.ipynb"]
        );
    }

    #[test]
    fn commands_only_nothing_edited() {
        let transcript = lines(&[
            prompt("u1", None),
            tool("a1", "u1", "Bash", json!({"command": "sed -i s/a/b/ f"})),
        ]);
        assert_eq!(
            scan(&transcript, "u1"),
            RewindScan {
                found: true,
                edited: vec![],
                checkpoint: false
            }
        );
    }

    #[test]
    fn the_checkpoint_claude_code_took_for_the_message() {
        let transcript = lines(&[
            prompt("u1", None),
            json!({"type": "file-history-snapshot", "messageId": "u1", "snapshot": {"messageId": "u1", "trackedFileBackups": {}}}),
            tool("a1", "u1", "Edit", json!({"file_path": "/w/a.ts"})),
        ]);
        assert!(scan(&transcript, "u1").checkpoint);
    }

    #[test]
    fn turns_a_rewind_left_behind_do_not_count() {
        let transcript = lines(&[
            prompt("u1", None),
            tool("a1", "u1", "Bash", json!({"command": "ls"})),
            prompt("u2", Some("a1")),
            tool("a2", "u2", "Edit", json!({"file_path": "/w/gone.ts"})),
            // Rewound to before u2: the next message hangs from a1.
            prompt("u3", Some("a1")),
            tool("a3", "u3", "Bash", json!({"command": "ls"})),
        ]);
        assert!(scan(&transcript, "u1").edited.is_empty());
        assert!(!scan(&transcript, "u2").found);
    }
}
