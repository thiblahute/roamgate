//! cli/setup.test.ts.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use roamgate_voice_server::testing::{
    ModelServer, SetupHome, cpu_laptop, nvidia_desktop, serve_models, setup_home,
};
use serde_json::{Value, json};

use super::*;
use crate::archive::Captured;

struct Test {
    _server: ModelServer,
    home: SetupHome,
    _cli_home: tempfile::TempDir,
    runtime: CliRuntime,
}

async fn test() -> Test {
    let server = serve_models().await;
    let home = setup_home(&server, cpu_laptop());
    let cli_home = tempfile::tempdir().unwrap();
    let runtime = CliRuntime {
        platform: "linux".into(),
        arch: "x64".into(),
        home: cli_home.path().into(),
        app_data: None,
        exec_path: cli_home.path().join("bin").join("roamgate"),
        version: "1.2.3".into(),
        standalone: true,
        uid: Some(1000),
        env: Arc::new(HashMap::<String, String>::new()),
    };
    Test {
        _server: server,
        home,
        _cli_home: cli_home,
        runtime,
    }
}

impl Test {
    /// The command on a CPU laptop, with no terminal.
    fn deps(&self) -> SetupCommandDeps {
        SetupCommandDeps {
            hardware: Some(Arc::new(cpu_laptop)),
            ask: None,
            setup: Some(self.home.deps.clone()),
            interrupt: false,
        }
    }

    async fn run(&self, deps: &SetupCommandDeps, args: &[&str]) -> (i32, Captured) {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        let mut out = Captured::default();
        let code = setup(&self.runtime, deps, &args, &mut out).await;
        (code, out)
    }

    fn config(&self) -> Value {
        serde_json::from_str(&std::fs::read_to_string(&self.home.deps.config_path).unwrap())
            .unwrap()
    }
}

/// An ask answering `answers` in turn ("" once they run out), keeping the
/// questions.
fn answering(answers: &[&str], asked: Arc<Mutex<Vec<String>>>) -> Ask {
    let answers = Arc::new(Mutex::new(
        answers
            .iter()
            .map(|answer| (*answer).to_owned())
            .collect::<Vec<_>>(),
    ));
    Arc::new(move |question: String| {
        asked.lock().unwrap().push(question);
        let mut answers = answers.lock().unwrap();
        let answer = if answers.is_empty() {
            String::new()
        } else {
            answers.remove(0)
        };
        Box::pin(async move { answer })
    })
}

#[tokio::test]
async fn is_listed_among_the_commands() {
    // The Bun CLI lists it while it runs the command; here: the command and
    // its help.
    let test = test().await;
    let (code, out) = test.run(&test.deps(), &["--help"]).await;
    assert_eq!(code, 0);
    assert!(out.output.join("\n").contains("roamgate setup voice"));
}

#[tokio::test]
async fn list_shows_the_hardware_each_part_s_models_and_the_tier() {
    let test = test().await;
    let (code, out) = test.run(&test.deps(), &["voice", "list"]).await;
    assert_eq!(code, 0);
    let out = out.output.join("\n");
    for expected in [
        "CPU: Intel Core i5, 8 threads",
        "GPU: none found",
        "Proposed tier: light",
        "Speech recognition (--speech)",
        "kokoro-onnx",
        "not found: build it",
    ] {
        assert!(out.contains(expected), "{expected} in {out}");
    }
}

#[tokio::test]
async fn list_json_is_the_assistant_s_state() {
    let test = test().await;
    let (_, out) = test.run(&test.deps(), &["voice", "list", "--json"]).await;
    let state: Value = serde_json::from_str(&out.output.join("\n")).unwrap();
    assert_eq!(state["tier"], "light");
    assert_eq!(state["recommended"]["heavy"]["tts"], "qwen3-tts-0.6b");
}

#[tokio::test]
async fn yes_downloads_the_tier_s_models_and_writes_voice_json() {
    let test = test().await;
    let (code, out) = test
        .run(&test.deps(), &["voice", "--yes", "--text-turn", "none"])
        .await;
    assert_eq!(code, 0, "{:?}", out.errors);
    let models = &test.home.deps.models_dir;
    let path = |parts: &[&str]| {
        parts
            .iter()
            .fold(models.clone(), |path, part| path.join(part))
            .display()
            .to_string()
    };
    let config = test.config();
    assert_eq!(config["parakeet_model"], path(&["parakeet-tdt-0.6b-v3"]));
    assert_eq!(
        config["tts_models"],
        json!([
            {"model": "pocket-tts", "path": path(&["pocket-tts-fr", "languages", "french"]), "languages": "fr", "voice": "estelle"},
            {"model": "pocket-tts", "path": path(&["pocket-tts-en", "languages", "english"]), "languages": "en", "voice": "alba"},
        ])
    );
    assert!(config.get("kokoro_model").is_none());
    assert!(config.get("text_turn_model").is_none());
    assert!(out.output.join("\n").contains("Wrote"));
}

#[tokio::test]
async fn questions_enter_keeps_a_choice_a_number_picks_another() {
    let test = test().await;
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let deps = SetupCommandDeps {
        hardware: Some(Arc::new(nvidia_desktop)),
        ask: Some(answering(&["", "", "3", "", "", "", "y"], asked.clone())),
        ..test.deps()
    };
    let (code, out) = test.run(&deps, &["voice", "--tier", "light"]).await;
    assert_eq!(code, 0, "{:?}", out.errors);
    assert!(
        asked
            .lock()
            .unwrap()
            .last()
            .unwrap()
            .contains("Download and write voice.json?")
    );
    // Speech, second reading, then the third reading voice: Kokoro-82M.
    assert_eq!(
        test.config()["tts_models"],
        json!([{"model": "kokoro", "path": test.home.deps.models_dir.join("Kokoro-82M").display().to_string()}])
    );
}

#[tokio::test]
async fn answering_no_changes_nothing() {
    let test = test().await;
    let asked: Arc<Mutex<Vec<String>>> = Arc::default();
    let kept = asked.clone();
    let deps = SetupCommandDeps {
        ask: Some(Arc::new(move |question: String| {
            let answer = if question.starts_with("Download") {
                "n"
            } else {
                ""
            };
            kept.lock().unwrap().push(question);
            Box::pin(async move { answer.to_owned() })
        })),
        ..test.deps()
    };
    test.run(&deps, &["voice", "--tier", "light"]).await;
    assert!(asked.lock().unwrap().last().unwrap().contains("Download"));
    assert!(!test.home.deps.config_path.exists());
}

#[tokio::test]
async fn bad_arguments_are_usage_errors() {
    let test = test().await;
    let usage = |code: i32, out: &Captured, message: &str| {
        assert_eq!(code, 2, "{:?}", out.errors);
        assert!(out.errors.join("\n").contains(message), "{:?}", out.errors);
    };
    let (code, out) = test.run(&test.deps(), &["voice", "--tier", "huge"]).await;
    usage(code, &out, "--tier is heavy or light");
    let (code, out) = test
        .run(&test.deps(), &["voice", "--tts", "nope", "--yes"])
        .await;
    usage(code, &out, "no reading voice model named nope");
    let (code, out) = test.run(&test.deps(), &["voice"]).await;
    usage(code, &out, "--yes is needed without a terminal");
    let (code, out) = test.run(&test.deps(), &["herdr"]).await;
    usage(code, &out, "unknown setup");
}

#[tokio::test]
async fn remove_unused_frees_what_voice_json_no_longer_uses() {
    let test = test().await;
    test.run(&test.deps(), &["voice", "--yes"]).await;
    test.run(&test.deps(), &["voice", "--yes", "--turn", "none"])
        .await;
    let (code, out) = test
        .run(&test.deps(), &["voice", "remove-unused", "--yes"])
        .await;
    assert_eq!(code, 0);
    assert!(out.output.join("\n").contains("Smart Turn"));
    assert!(
        !test
            .home
            .deps
            .models_dir
            .join("smart-turn-v3.2-cpu.onnx")
            .exists()
    );
}
