//! The `roamgate` executable. For now the skeleton the release targets are
//! built, packaged and updated with (migration plan, phase 1): it answers
//! `--version` as the Bun build does, which `roamgate update` checks, and
//! serves the embedded web app with `/healthz`.

use std::net::SocketAddr;
use std::process::ExitCode;

use roamgate::{Options, USAGE, parse_args, version_line};

#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let options = match parse_args(&args, |name| std::env::var(name).ok()) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("roamgate: {message}\n\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    match options {
        Options::Version => {
            println!("{}", version_line());
            ExitCode::SUCCESS
        }
        Options::Core => ExitCode::from(
            roamgate_sidecar::core::run_core(
                &roamgate_base::env::ProcessEnv,
                roamgate::VERSION,
                roamgate::core_families(),
            )
            .await,
        ),
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
            _ => roamgate::families::update::cli(&command, &args).await,
        }),
        Options::Help => {
            print!("{USAGE}");
            ExitCode::SUCCESS
        }
        Options::Serve { host, port } => {
            let listener = match tokio::net::TcpListener::bind((host.as_str(), port)).await {
                Ok(listener) => listener,
                Err(error) => {
                    eprintln!("roamgate: cannot listen on {host}:{port}: {error}");
                    return ExitCode::FAILURE;
                }
            };
            let address: SocketAddr = listener.local_addr().expect("listener address");
            println!("{} listening on http://{address}", version_line());
            let shutdown = async {
                #[cfg(unix)]
                {
                    use tokio::signal::unix::{SignalKind, signal};
                    let mut term = signal(SignalKind::terminate()).expect("SIGTERM handler");
                    tokio::select! {
                        _ = tokio::signal::ctrl_c() => {}
                        _ = term.recv() => {}
                    }
                }
                #[cfg(not(unix))]
                let _ = tokio::signal::ctrl_c().await;
            };
            match roamgate::serve(listener, shutdown).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("roamgate: {error}");
                    ExitCode::FAILURE
                }
            }
        }
    }
}
