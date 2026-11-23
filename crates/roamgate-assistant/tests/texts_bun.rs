//! Ranger's texts as Bun gives them (the plan's section 6.1, same text):
//! the system prompt of both modes, and the tools of a turn with every
//! handler, compared byte for byte with server/src/assistant/ranger-tools.ts.
//! Skipped, saying why, when bun is not on PATH.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use roamgate_assistant::tools::{
    Handler, RangerHandlers, Replay, ToolResult, ranger_system_prompt, ranger_tools,
};
use serde_json::{Value, json};

fn repo() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .canonicalize()
        .unwrap()
}

fn bun() -> Option<PathBuf> {
    let found = std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths)
            .map(|dir| dir.join(if cfg!(windows) { "bun.exe" } else { "bun" }))
            .find(|path| path.is_file())
    });
    if found.is_none() {
        eprintln!("skipped: bun is not on PATH, Ranger's TS texts cannot be read");
    }
    found
}

const BUN_TEXTS: &str = r#"
const { rangerSystemPrompt, rangerTools } = await import(process.argv[1]);
const handler = async () => ({ text: "" });
const handlers = { read: handler, propose: handler, task: handler, notify: handler,
  show: handler, arrange: handler, threads: handler, archive: handler };
const tools = (automatic) => rangerTools(handlers, automatic).map((tool) => ({
  name: tool.name, label: tool.label ?? "", description: tool.description,
  parameters: JSON.parse(JSON.stringify(tool.parameters)), replay: tool.replay,
  sequential: tool.sequential }));
console.log(JSON.stringify({ prompts: [rangerSystemPrompt(false), rangerSystemPrompt(true)],
  tools: [tools(false), tools(true)] }));
"#;

#[test]
fn the_system_prompt_and_turn_tools_are_buns_byte_for_byte() {
    let Some(bun) = bun() else { return };
    let output = Command::new(bun)
        .current_dir(repo().join("server"))
        .arg("-e")
        .arg(BUN_TEXTS)
        .arg(repo().join("server/src/assistant/ranger-tools.ts"))
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "bun failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let bun: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(bun["prompts"][0], ranger_system_prompt(false));
    assert_eq!(bun["prompts"][1], ranger_system_prompt(true));
    let handler: Handler = Arc::new(|_, _, _| Box::pin(async { Ok(ToolResult::default()) }));
    let handlers = RangerHandlers {
        read: handler.clone(),
        propose: Some(handler.clone()),
        task: Some(handler.clone()),
        notify: Some(handler.clone()),
        show: Some(handler.clone()),
        arrange: Some(handler.clone()),
        threads: Some(handler.clone()),
        archive: Some(handler),
    };
    for (index, automatic) in [false, true].into_iter().enumerate() {
        let ours: Vec<Value> = ranger_tools(&handlers, automatic)
            .into_iter()
            .map(|tool| {
                json!({
                    "name": tool.name, "label": tool.label, "description": tool.description,
                    "parameters": tool.parameters,
                    "replay": if tool.replay == Replay::Safe { "safe" } else { "unsafe" },
                    "sequential": tool.sequential,
                })
            })
            .collect();
        assert_eq!(
            Value::Array(ours),
            bun["tools"][index],
            "automatic: {automatic}"
        );
    }
}
