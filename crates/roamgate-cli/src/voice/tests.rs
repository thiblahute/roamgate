//! cli/voice.test.ts.

use std::collections::HashMap;
use std::sync::Arc;

use roamgate_voice_server::low_gpu::{LowGpuFile, read_low_gpu};
use serde_json::{Value, json};

use super::*;

struct Cli {
    home: tempfile::TempDir,
    runtime: CliRuntime,
}

fn cli() -> Cli {
    let home = tempfile::tempdir().unwrap();
    let runtime = CliRuntime {
        platform: "linux".into(),
        arch: "x64".into(),
        home: home.path().into(),
        app_data: None,
        exec_path: home.path().join("bin").join("roamgate"),
        version: "1.2.3".into(),
        standalone: true,
        uid: Some(1000),
        env: Arc::new(HashMap::<String, String>::new()),
    };
    Cli { home, runtime }
}

impl Cli {
    fn run(&self, args: &[&str]) -> Printed {
        let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
        voice(&self.runtime, &args)
    }

    fn state(&self) -> LowGpuFile {
        read_low_gpu(
            &self
                .home
                .path()
                .join(".local/share/roamgate/voice/low-gpu.json"),
        )
    }

    fn holders(&self) -> Vec<String> {
        self.state().holders.keys().cloned().collect()
    }
}

fn lines(printed: &Printed) -> Vec<&str> {
    printed.stdout.lines().collect()
}

#[test]
fn profile_low_gpu_on_and_off_by_holder() {
    let cli = cli();
    assert_eq!(
        cli.run(&["profile", "low-gpu", "on", "--by", "render"])
            .code,
        0
    );
    let on = cli.run(&["profile", "low-gpu", "on"]);
    assert_eq!(on.code, 0);
    let mut holders = cli.holders();
    holders.sort();
    assert_eq!(holders, ["manual", "render"]);
    assert_eq!(
        lines(&on),
        [
            "Low-GPU voice: on, for render, manual",
            "A call going on switches when it ends.",
        ]
    );
    cli.run(&["profile", "low-gpu", "off", "--by", "render"]);
    assert_eq!(cli.holders(), ["manual"]);
    let off = cli.run(&["profile", "low-gpu", "off"]);
    assert!(cli.state().holders.is_empty());
    assert_eq!(
        lines(&off)[0],
        "Low-GPU voice: off (unless GameMode runs as a call starts)"
    );
}

#[test]
fn gaming_is_the_profile_held_by_gaming_now_asking_a_call_to_switch() {
    let cli = cli();
    let on = cli.run(&["gaming", "on", "--now"]);
    assert_eq!(cli.holders(), ["gaming"]);
    assert!(cli.state().now.is_some());
    assert_eq!(
        lines(&on).last().copied(),
        Some("A call going on switches now, after a short notice.")
    );
    cli.run(&["gaming", "off"]);
    assert!(cli.state().holders.is_empty());
}

#[test]
fn status_says_who_holds_it_even_without_voice_json() {
    let cli = cli();
    cli.run(&["gaming", "on"]);
    let status = cli.run(&["profile", "low-gpu", "status"]);
    assert!(lines(&status).contains(&"Low-GPU voice: on, for gaming"));
    assert!(
        status
            .stdout
            .contains("Its models cannot be chosen: No voice configuration"),
        "{}",
        status.stdout
    );
    let json = cli.run(&["gaming", "status", "--json"]);
    let status: Value = serde_json::from_str(&json.stdout).unwrap();
    assert_eq!(status["active"], true);
    assert_eq!(status["holders"], json!(["gaming"]));
}

#[test]
fn models_sets_parts_by_hand_reset_goes_back() {
    let cli = cli();
    cli.run(&[
        "profile",
        "low-gpu",
        "models",
        "tts=kokoro-82m",
        "text-turn=none",
    ]);
    assert_eq!(
        cli.state().models.map(Value::Object),
        Some(json!({"tts": "kokoro-82m", "text_turn": "none"}))
    );
    cli.run(&["profile", "low-gpu", "models", "--reset"]);
    assert_eq!(cli.state().models, None);
    let unknown = cli.run(&["profile", "low-gpu", "models", "tts=nope"]);
    assert_eq!(unknown.code, 2);
    assert!(
        unknown.stderr.contains("no reading voice model named nope"),
        "{}",
        unknown.stderr
    );
    let part = cli.run(&["profile", "low-gpu", "models", "voice=x"]);
    assert_eq!(part.code, 2);
}

#[test]
fn refuses_what_it_does_not_know() {
    let cli = cli();
    let refused = |args: &[&str], message: &str| {
        let printed = cli.run(args);
        assert_eq!(printed.code, 2, "{args:?}");
        assert!(printed.stderr.contains(message), "{}", printed.stderr);
    };
    refused(&["profile", "quiet", "on"], "unknown voice profile: quiet");
    refused(&["profile", "low-gpu", "on", "--by", "a b"], "--by a b");
    refused(&["profile", "low-gpu", "maybe"], "unknown action: maybe");
    refused(&["other"], "unknown voice command");
}
