//! The `roamgate` executable: the server (`roamgate [server flags]`, the
//! front with its standalone core), the management commands
//! (`roamgate <command> [arguments]`) and the hidden `core` and `owners`.

use std::collections::BTreeMap;
use std::process::ExitCode;

use roamgate::{Options, parse_args};

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse_args(&args) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("roamgate: {message}");
            return ExitCode::from(2);
        }
    };
    match options {
        Options::Server(args) => ExitCode::from(roamgate::front::run(&args, BTreeMap::new()).await),
        Options::Core => {
            let env = roamgate_base::env::ProcessEnv;
            let families = if roamgate_sidecar::core::standalone_on(&env) {
                roamgate::standalone_families()
            } else {
                roamgate::core_families()
            };
            let recorder = roamgate::start_core_recorder(&env);
            let profile = roamgate::start_core_profile(&env)
                .map(|(profile, duration)| (std::sync::Arc::new(profile), duration));
            // The capture ends on the server's clock, as Bun's timer did.
            let timed = profile.clone();
            let on_clock = Box::new(move |clock: roamgate_base::clock::SharedClock| {
                if let Some((profile, duration)) = timed {
                    tokio::spawn(async move {
                        clock.sleep(duration).await;
                        profile.stop().await;
                    });
                }
            });
            let code = roamgate_sidecar::core::run_core_with_clock(
                &env,
                roamgate::VERSION,
                families,
                on_clock,
            )
            .await;
            // The capture's files are written when the server stops early.
            if let Some((profile, _)) = profile {
                profile.stop().await;
            }
            if let Some(recorder) = recorder {
                recorder.close();
            }
            ExitCode::from(code)
        }
        Options::Node(args) => ExitCode::from(roamgate::node::run(&args).await),
        Options::Owners(args) => {
            let (code, out, err) =
                roamgate::owners_cmd::run(&roamgate_base::env::ProcessEnv, &args);
            print!("{out}");
            eprint!("{err}");
            ExitCode::from(code)
        }
        Options::Command(command, args) => ExitCode::from(match command.as_str() {
            "herdr" => roamgate::families::herdr::cli(&args).await,
            "push" => roamgate::families::notifications::cli(&args).await,
            "activity" => roamgate::families::activity::cli(&args),
            "archive" => roamgate::families::archive::cli(&args).await,
            "history" => roamgate::families::history::cli(&args),
            "reviews" => roamgate::reviews_cmd::cli(&args),
            "voice" => roamgate::families::voice::cli(&args),
            "setup" => roamgate::families::voice::setup_cli(&args).await,
            "update" | "rollback" => roamgate::families::update::cli(&command, &args).await,
            // `roamgate help herdr` is herdr's own help (DELEGATED_HELP),
            // which its family's code prints.
            "help" if args.first().map(String::as_str) == Some("herdr") => {
                roamgate::families::herdr::cli(&["--help".to_owned()]).await
            }
            _ => match roamgate::cli::run(&command, &args).await {
                roamgate::cli::Done::Exit(code) => code,
                roamgate::cli::Done::Serve(entries) => roamgate::front::run(&[], entries).await,
            },
        }),
    }
}
