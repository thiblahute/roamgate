//! The Bun front and the Rust core over the internal channel
//! (contract/wire/core-channel.md): `server/src/core-channel/hybrid.test.ts`
//! run against this checkout's `roamgate core`, so a change on either side
//! that breaks the other fails here. Its calls, pushes, reverse calls,
//! streamed HTTP and shadow reads go through the channel's test family.

use std::path::Path;
use std::process::Command;

use roamgate_parity::paths::repo_root;

#[test]
fn the_bun_front_and_the_rust_core_talk_over_the_channel() {
    let core = roamgate_parity::build::core().expect("the Rust core");
    let mut command = if cfg!(unix) && Path::new("/usr/bin/nice").exists() {
        let mut command = Command::new("nice");
        command.args(["-n", "19", "bun"]);
        command
    } else {
        Command::new("bun")
    };
    let output = command
        .args(["test", "server/src/core-channel/hybrid.test.ts"])
        .env("ROAMGATE_CORE_BIN", &core)
        .current_dir(repo_root())
        .output()
        .expect("bun test");
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(output.status.success(), "{text}");
    // Never skipped: with ROAMGATE_CORE_BIN the case runs.
    assert!(
        text.contains(" 1 pass") && !text.contains(" 1 skip"),
        "{text}"
    );
}
