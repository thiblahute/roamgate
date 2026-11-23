//! Ranger's chats on disk (state.json and sessions/<id>.json) written by
//! one side and rewritten by the other, byte for byte. Each side writes a
//! directory: a configured chat with a turn, archived by a new chat with a
//! turn of its own. Each side then rewrites both directories without
//! changing what they hold: an approval save rewrites state.json, and
//! selecting the archived chat and back rewrites both chats. Every file
//! either side writes is the one the writer wrote, and Bun's rewrite and
//! Rust's are the same bytes. Skipped, saying why, when bun is not on PATH.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use roamgate_assistant::context::{AssistantContext, CapturedScope, Scope};
use roamgate_assistant::driver::{AssistantDriver, LoginInteraction, RunEvent, RunInput};
use roamgate_assistant::errors::AssistantResult;
use roamgate_assistant::service::{AssistantService, ServiceOptions};
use roamgate_assistant::tools::{BoxFuture, ToolResult};
use roamgate_base::clock::SystemClock;
use roamgate_base::paths::{DataContext, Platform};
use serde_json::{Value, json};
use tokio_util::sync::CancellationToken;

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
        eprintln!("skipped: bun is not on PATH, the Bun side of Ranger's chats cannot run");
    }
    found
}

/// The Bun side: the same fakes as the Rust side, then `write` or
/// `rewrite <first> <second>`.
const BUN: &str = r#"
const { createAssistantService } = await import(process.argv[1]);
const { copyFileSync } = await import("node:fs");
const [directory, mode, first, second] = process.argv.slice(2);
const workspace = { connection_id: "local", workspace_id: "ws", connection_label: "Local", label: "Workspace", runtime_generation: 7 };
const catalog = {
  providers: [{ id: "test", label: "Test", methods: ["api_key"], configured: true }],
  models: [{ provider: "test", id: "model", label: "Model" }],
};
const service = createAssistantService({
  directory,
  context: {
    catalog: async () => ({ workspaces: [workspace], errors: [] }),
    captureScope: async () => [structuredClone(workspace)],
    read: async () => ({ text: "", sources: [] }),
  },
  driver: {
    catalog: async () => structuredClone(catalog),
    login: async () => {},
    run: async (input) => {
      input.delta("Hé ");
      input.message("Hé \u{1f600} \"quoted\"\n<tag> &  ");
      return [{ persisted: true, text: "été", n: 1.5 }];
    },
    stop: async () => {},
    dispose: async () => {},
  },
  publish: () => {},
});
const idle = async () => { while (service.peek().running) await Bun.sleep(5); };
if (mode === "write") {
  await service.handle("configure", { config: {
    provider: "test", model: "model", credential_source: "assistant",
    allowed_workspaces: [{ connection_id: "local", workspace_id: "ws" }],
  } });
  await service.handle("configure_approval", { approval_mode: "manual" });
  await service.handle("send", { request_id: "first", text: "First chat é\nsecond line" });
  await idle();
  const first = service.peek().session_id;
  await service.handle("new_session", {});
  await service.handle("send", { request_id: "second", text: "Second \u{1f600}" });
  await idle();
  console.log(JSON.stringify({ first, second: service.peek().session_id }));
} else {
  await service.handle("configure_approval", { approval_mode: "manual" });
  copyFileSync(`${directory}/state.json`, `${directory}/approval.json`);
  await service.handle("select_session", { session_id: first });
  await service.handle("select_session", { session_id: second });
}
await service.dispose();
"#;

fn bun_side(bun: &Path, directory: &Path, args: &[&str]) -> String {
    let output = Command::new(bun)
        .current_dir(repo().join("server"))
        .env_remove("ROAMGATE_ASSISTANT_DIR")
        .arg("-e")
        .arg(BUN)
        .arg(repo().join("server/src/assistant/service.ts"))
        .arg(directory)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .unwrap();
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(output.status.success(), "bun failed: {stderr}");
    String::from_utf8_lossy(&output.stdout).trim().to_owned()
}

fn workspace() -> Value {
    json!({"connection_id": "local", "workspace_id": "ws", "connection_label": "Local", "label": "Workspace", "runtime_generation": 7})
}

struct Context;

impl AssistantContext for Context {
    fn catalog(&self) -> BoxFuture<AssistantResult<Value>> {
        Box::pin(async { Ok(json!({"workspaces": [workspace()], "errors": []})) })
    }

    fn capture_scope(
        &self,
        _refs: Value,
        _cancel: Option<CancellationToken>,
        _recovery: Option<Value>,
    ) -> BoxFuture<AssistantResult<Scope>> {
        Box::pin(async { Ok(CapturedScope::plain(json!([workspace()]))) })
    }

    fn read(
        &self,
        _kind: &str,
        _captured: &Scope,
        _params: Value,
        _cancel: Option<CancellationToken>,
    ) -> BoxFuture<AssistantResult<ToolResult>> {
        Box::pin(async { Ok(ToolResult::text("")) })
    }
}

struct Driver;

impl AssistantDriver for Driver {
    fn catalog(&self, _source: &str) -> BoxFuture<AssistantResult<Value>> {
        Box::pin(async {
            Ok(json!({
                "providers": [{"id": "test", "label": "Test", "methods": ["api_key"], "configured": true}],
                "models": [{"provider": "test", "id": "model", "label": "Model"}],
            }))
        })
    }

    fn login(
        &self,
        _provider: &str,
        _method: &str,
        _source: &str,
        _interaction: Arc<dyn LoginInteraction>,
        _cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<()>> {
        Box::pin(async { Ok(()) })
    }

    fn run(
        &self,
        input: RunInput,
        _cancel: CancellationToken,
    ) -> BoxFuture<AssistantResult<Vec<Value>>> {
        Box::pin(async move {
            (input.events)(RunEvent::Delta("H\u{e9} ".into()));
            (input.events)(RunEvent::Message(
                "H\u{e9} \u{1f600} \"quoted\"\n<tag> & \u{2028}".into(),
            ));
            Ok(vec![
                json!({"persisted": true, "text": "\u{e9}t\u{e9}", "n": 1.5}),
            ])
        })
    }

    fn stop(&self) -> BoxFuture<AssistantResult<()>> {
        Box::pin(async { Ok(()) })
    }

    fn dispose(&self) -> BoxFuture<AssistantResult<()>> {
        Box::pin(async { Ok(()) })
    }
}

fn rust_service(home: &Path, directory: &Path) -> AssistantService {
    let mut options = ServiceOptions::new(
        Arc::new(Context),
        Arc::new(|_| {}),
        DataContext::new(home, Platform::Unix, None),
        Arc::new(SystemClock),
        Arc::new(|_, _| Arc::new(Driver) as Arc<dyn AssistantDriver>),
    );
    options.directory = Some(directory.to_path_buf());
    AssistantService::new(options)
}

async fn idle(service: &AssistantService) {
    while service.peek()["running"] == true {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

async fn rust_write(home: &Path, directory: &Path) -> (String, String) {
    let service = rust_service(home, directory);
    service
        .handle(
            "configure",
            json!({"config": {
                "provider": "test", "model": "model", "credential_source": "assistant",
                "allowed_workspaces": [{"connection_id": "local", "workspace_id": "ws"}],
            }}),
        )
        .await
        .unwrap();
    service
        .handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    service
        .handle(
            "send",
            json!({"request_id": "first", "text": "First chat \u{e9}\nsecond line"}),
        )
        .await
        .unwrap();
    idle(&service).await;
    let first = service.peek()["session_id"].as_str().unwrap().to_owned();
    service.handle("new_session", json!({})).await.unwrap();
    service
        .handle(
            "send",
            json!({"request_id": "second", "text": "Second \u{1f600}"}),
        )
        .await
        .unwrap();
    idle(&service).await;
    let second = service.peek()["session_id"].as_str().unwrap().to_owned();
    service.dispose().await;
    (first, second)
}

async fn rust_rewrite(home: &Path, directory: &Path, first: &str, second: &str) {
    let service = rust_service(home, directory);
    service
        .handle("configure_approval", json!({"approval_mode": "manual"}))
        .await
        .unwrap();
    std::fs::copy(
        directory.join("state.json"),
        directory.join("approval.json"),
    )
    .unwrap();
    for id in [first, second] {
        service
            .handle("select_session", json!({"session_id": id}))
            .await
            .unwrap();
    }
    service.dispose().await;
}

/// The chat files of a directory (the tasks' database left out).
fn chats(directory: &Path) -> BTreeMap<String, Vec<u8>> {
    let mut files = BTreeMap::new();
    for (name, path) in [("state.json", directory.join("state.json"))]
        .into_iter()
        .map(|(n, p)| (n.to_owned(), p))
        .chain(
            std::fs::read_dir(directory.join("sessions"))
                .unwrap()
                .map(|entry| {
                    let entry = entry.unwrap();
                    (
                        format!("sessions/{}", entry.file_name().to_string_lossy()),
                        entry.path(),
                    )
                }),
        )
        .chain(
            directory
                .join("approval.json")
                .exists()
                .then(|| ("approval.json".to_owned(), directory.join("approval.json"))),
        )
    {
        files.insert(name, std::fs::read(path).unwrap());
    }
    files
}

fn copy_dir(from: &Path, to: &Path) {
    std::fs::create_dir_all(to.join("sessions")).unwrap();
    std::fs::copy(from.join("state.json"), to.join("state.json")).unwrap();
    for entry in std::fs::read_dir(from.join("sessions")).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), to.join("sessions").join(entry.file_name())).unwrap();
    }
}

fn text(files: &BTreeMap<String, Vec<u8>>, name: &str) -> String {
    String::from_utf8(files[name].clone()).unwrap()
}

#[tokio::test(flavor = "multi_thread")]
async fn chats_written_by_either_side_are_rewritten_by_both_with_the_same_bytes() {
    let Some(bun) = bun() else { return };
    let home = tempfile::tempdir().unwrap();
    let home = home.path();
    let by_bun = home.join("bun");
    let ids: Value = serde_json::from_str(&bun_side(&bun, &by_bun, &["write"])).unwrap();
    let bun_ids = (
        ids["first"].as_str().unwrap().to_owned(),
        ids["second"].as_str().unwrap().to_owned(),
    );
    let by_rust = home.join("rust");
    let rust_ids = rust_write(home, &by_rust).await;
    for (writer, written, (first, second)) in
        [("bun", &by_bun, bun_ids), ("rust", &by_rust, rust_ids)]
    {
        let original = chats(written);
        // A chat written whole, then a new one: the first is archived.
        assert_eq!(original.len(), 2, "{writer}: {:?}", original.keys());
        let saved: Value = serde_json::from_str(&text(&original, "state.json")).unwrap();
        assert_eq!(saved["session_id"], json!(second));
        assert_eq!(
            saved["messages"][1]["text"],
            json!("H\u{e9} \u{1f600} \"quoted\"\n<tag> & \u{2028}")
        );
        let archive = format!("sessions/{first}.json");
        assert!(original.contains_key(&archive), "{writer}");
        let mut rewritten = Vec::new();
        for rewriter in ["bun", "rust"] {
            let directory = home.join(format!("{writer}-by-{rewriter}"));
            copy_dir(written, &directory);
            if rewriter == "bun" {
                bun_side(&bun, &directory, &["rewrite", &first, &second]);
            } else {
                rust_rewrite(home, &directory, &first, &second).await;
            }
            let files = chats(&directory);
            for name in ["state.json", archive.as_str()] {
                assert_eq!(
                    text(&files, name),
                    text(&original, name),
                    "{rewriter} rewrote {writer}'s {name}"
                );
            }
            assert_eq!(
                text(&files, "approval.json"),
                text(&original, "state.json"),
                "{rewriter} saved {writer}'s approval"
            );
            rewritten.push(files);
        }
        // Bun and Rust archived the second chat the same way too.
        assert_eq!(
            rewritten[0].keys().collect::<Vec<_>>(),
            rewritten[1].keys().collect::<Vec<_>>()
        );
        for (name, bytes) in &rewritten[0] {
            assert_eq!(
                String::from_utf8_lossy(bytes),
                String::from_utf8_lossy(&rewritten[1][name]),
                "{writer}'s {name} rewritten by Bun and by Rust"
            );
        }
    }
}
