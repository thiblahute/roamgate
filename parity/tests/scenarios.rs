//! Every scenario under parity/scenarios, one test each, against the server
//! `ROAMGATE_SERVER_CMD` names (the Bun server by default).
//!
//! `cargo test -p roamgate-parity --test scenarios [-- <filter>]`; at most
//! `PARITY_JOBS` (default 4) servers run at once.

use std::path::Path;

use libtest_mimic::{Arguments, Failed, Trial};
use roamgate_parity::paths::{repo_root, scenarios_dir};
use roamgate_parity::scenario;

fn platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(windows) {
        "windows"
    } else {
        "linux"
    }
}

fn main() {
    let mut arguments = Arguments::from_args();
    if arguments.test_threads.is_none() {
        arguments.test_threads = Some(
            std::env::var("PARITY_JOBS")
                .ok()
                .and_then(|jobs| jobs.parse().ok())
                .unwrap_or(4),
        );
    }
    let fake = Path::new(env!("CARGO_BIN_EXE_parity-fake")).to_path_buf();
    let root = repo_root();
    let trials = scenario::all(&scenarios_dir())
        .into_iter()
        .map(|path| {
            let name = path
                .strip_prefix(&root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let ignored = match scenario::load(&path) {
                Ok(loaded) => {
                    !loaded.platforms.is_empty()
                        && !loaded.platforms.iter().any(|name| name == platform())
                }
                Err(_) => false,
            };
            let fake = fake.clone();
            Trial::test(name, move || {
                let runtime = tokio::runtime::Builder::new_multi_thread()
                    .worker_threads(2)
                    .enable_all()
                    .build()
                    .map_err(|error| Failed::from(error.to_string()))?;
                runtime
                    .block_on(scenario::run(&fake, &path))
                    .map_err(|error| Failed::from(format!("{error:#}")))
            })
            .with_ignored_flag(ignored)
        })
        .collect();
    libtest_mimic::run(&arguments, trials).exit();
}
