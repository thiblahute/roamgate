//! Companion memory driver for Antigravity CLI (`agy`).

use roamgate_conversation::driver::{BackgroundMemoryLaunch, CompanionMemoryDriver};

pub struct AgyMemoryDriver;

impl CompanionMemoryDriver for AgyMemoryDriver {
    fn reader(&self, _dir: &str) -> Option<BackgroundMemoryLaunch> {
        // AGY receives the memory index inline in its prompt.
        None
    }

    fn writer(&self, dir: &str) -> BackgroundMemoryLaunch {
        BackgroundMemoryLaunch {
            args: vec![
                "--mode".into(),
                "auto".into(),
                "--add-dir".into(),
                dir.to_owned(),
            ],
            tools: "read_file,write_file,edit_file".into(),
            cwd: Some(dir.to_owned()),
        }
    }
}
