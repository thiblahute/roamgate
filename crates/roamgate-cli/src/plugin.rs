//! `roamgate plugin` (config/plugin-command.ts): the actions and the panel
//! the Herdr plugin runs. The service actions run this executable's own
//! `service` command, the panel reads keys in raw mode on a terminal and
//! prints its status once otherwise.

use std::io::{IsTerminal, Write};
use std::path::Path;
use std::process::{Command, Stdio};

use crate::args::Failure;
use crate::commands::CliRuntime;
use crate::context::CliContext;
use crate::index::Outcome;
use crate::service_context::{
    access_urls, locate_service_config, read_service_access, read_service_setup,
};

const USAGE: &str = "Usage: roamgate plugin <start|restart|status|url|version|uninstall|panel>";

/// The service's local login URL, computed exactly as `roamgate url` does.
pub fn service_login_url(runtime: &CliRuntime) -> Result<String, String> {
    let setup = read_service_setup(runtime)?;
    let access = read_service_access(runtime, &setup)?;
    Ok(access_urls(&access, Vec::new).local)
}

/// A spawn failure as Node's `spawnSync` words it.
fn spawn_error(binary: &Path, error: &std::io::Error) -> String {
    let code = match error.kind() {
        std::io::ErrorKind::NotFound => "ENOENT",
        std::io::ErrorKind::PermissionDenied => "EACCES",
        _ => return error.to_string(),
    };
    format!("spawnSync {} {code}", binary.display())
}

struct Captured {
    code: i32,
    out: String,
    err: String,
}

fn capture(binary: &Path, args: &[&str]) -> Captured {
    match Command::new(binary)
        .args(args)
        .stdin(Stdio::null())
        .output()
    {
        Ok(output) => Captured {
            code: output.status.code().unwrap_or(1),
            out: String::from_utf8_lossy(&output.stdout).into_owned(),
            err: String::from_utf8_lossy(&output.stderr).into_owned(),
        },
        Err(error) => Captured {
            code: 1,
            out: String::new(),
            err: spawn_error(binary, &error),
        },
    }
}

fn url_text(runtime: &CliRuntime) -> String {
    service_login_url(runtime).unwrap_or_else(|error| format!("unavailable ({error})"))
}

fn print_url(context: &CliContext) -> i32 {
    let result = locate_service_config(&context.runtime).and_then(|file| {
        if !file.config_exists {
            context.error(&format!(
                "roamgate plugin: no service environment at {}, showing defaults",
                file.config_path.display()
            ));
        }
        service_login_url(&context.runtime)
    });
    match result {
        Ok(url) => {
            context.log(&url);
            0
        }
        Err(error) => {
            context.error(&format!("roamgate plugin: {error}"));
            1
        }
    }
}

fn status_text(binary: &Path) -> String {
    let result = capture(binary, &["service", "status"]);
    if result.code != 0 {
        return "not installed".into();
    }
    let first = result.out.trim().split('\n').next().unwrap_or("").trim();
    if first.is_empty() {
        "installed".into()
    } else {
        first.to_owned()
    }
}

fn service_args(verb: &str) -> Option<&'static [&'static str]> {
    match verb {
        "start" => Some(&["install", "--force"]),
        "restart" => Some(&["install"]),
        "status" => Some(&["status"]),
        "uninstall" => Some(&["uninstall"]),
        _ => None,
    }
}

/// `roamgate plugin <args>` (runPluginCommand without its leading word).
pub async fn run(args: &[String], context: &CliContext) -> Result<Outcome, Failure> {
    Ok(Outcome::Code(run_plugin(args, context).await))
}

async fn run_plugin(args: &[String], context: &CliContext) -> i32 {
    let binary = context.runtime.exec_path.clone();
    if let [verb] = args {
        match verb.as_str() {
            "version" => {
                context.log(&format!("roamgate {}", context.runtime.version));
                return 0;
            }
            "url" => return print_url(context),
            "panel" => return panel(context, &binary).await,
            other => {
                if let Some(rest) = service_args(other) {
                    let mut argv = vec!["service"];
                    argv.extend_from_slice(rest);
                    return match Command::new(&binary).args(&argv).status() {
                        Ok(status) => status.code().unwrap_or(1),
                        Err(error) => {
                            context.error(&format!(
                                "roamgate plugin: {}",
                                spawn_error(&binary, &error)
                            ));
                            1
                        }
                    };
                }
            }
        }
    }
    context.error(USAGE);
    if args.is_empty() || (args.len() == 1 && args[0] == "--help") {
        0
    } else {
        1
    }
}

fn write_out(text: &str) {
    let mut out = std::io::stdout().lock();
    let _ = out.write_all(text.as_bytes());
    let _ = out.flush();
}

fn render(runtime: &CliRuntime, binary: &Path, message: &str) {
    let mut lines = vec![
        "Roamgate".to_owned(),
        String::new(),
        format!("Status:  {}", status_text(binary)),
        format!("URL:     {}", url_text(runtime)),
        format!("Version: roamgate {}", runtime.version),
        String::new(),
        "[s] start  [r] restart  [u] uninstall  [q] close".to_owned(),
    ];
    if !message.is_empty() {
        lines.push(String::new());
        lines.push(message.to_owned());
    }
    write_out(&format!("\x1b[?25l\x1b[2J\x1b[H{}\r\n", lines.join("\r\n")));
}

async fn panel(context: &CliContext, binary: &Path) -> i32 {
    let runtime = &context.runtime;
    if !std::io::stdin().is_terminal() {
        context.log(&format!("Status:  {}", status_text(binary)));
        context.log(&format!("URL:     {}", url_text(runtime)));
        context.log(&format!("Version: roamgate {}", runtime.version));
        return 0;
    }
    let raw = raw_mode::enter();
    let (sender, mut keys) = tokio::sync::mpsc::unbounded_channel::<Option<String>>();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut buffer = [0u8; 1024];
        let mut stdin = std::io::stdin();
        loop {
            match stdin.read(&mut buffer) {
                Ok(0) | Err(_) => {
                    let _ = sender.send(None);
                    return;
                }
                Ok(read) => {
                    let chunk = String::from_utf8_lossy(&buffer[..read]).into_owned();
                    if sender.send(Some(chunk)).is_err() {
                        return;
                    }
                }
            }
        }
    });
    render(runtime, binary, "");
    loop {
        // The terminal is restored when the host closes or signals it.
        let key = tokio::select! {
            key = keys.recv() => key.flatten(),
            () = terminated() => None,
        };
        let Some(key) = key else { break };
        if key == "q" || key == "\x03" {
            break;
        }
        let Some(rest) = (match key.as_str() {
            "s" => Some(&["install", "--force"][..]),
            "r" => Some(&["install"][..]),
            "u" => Some(&["uninstall"][..]),
            _ => None,
        }) else {
            continue;
        };
        render(runtime, binary, "working...");
        let mut argv = vec!["service"];
        argv.extend_from_slice(rest);
        let result = capture(binary, &argv);
        let source = if result.err.is_empty() {
            &result.out
        } else {
            &result.err
        };
        let detail = source.trim().split('\n').next_back().unwrap_or("");
        render(
            runtime,
            binary,
            &if result.code == 0 {
                "done".to_owned()
            } else {
                format!("failed (exit {}): {detail}", result.code)
            },
        );
    }
    write_out("\x1b[?25h\x1b[0m\n");
    drop(raw);
    0
}

/// SIGTERM or SIGINT (Ctrl-C on Windows).
async fn terminated() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        match (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) {
            (Ok(mut term), Ok(mut interrupt)) => {
                tokio::select! {
                    _ = term.recv() => {}
                    _ = interrupt.recv() => {}
                }
            }
            _ => std::future::pending().await,
        }
    }
    #[cfg(not(unix))]
    {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// `stdin.setRawMode(true)` as libuv sets it, undone on drop.
mod raw_mode {
    #[cfg(unix)]
    pub struct Raw(Option<rustix::termios::Termios>);

    #[cfg(unix)]
    pub fn enter() -> Raw {
        use rustix::termios::{
            ControlModes, InputModes, LocalModes, OptionalActions, OutputModes, SpecialCodeIndex,
            tcgetattr, tcsetattr,
        };
        let stdin = std::io::stdin();
        let Ok(saved) = tcgetattr(&stdin) else {
            return Raw(None);
        };
        let mut raw = saved.clone();
        raw.input_modes -= InputModes::BRKINT
            | InputModes::ICRNL
            | InputModes::INPCK
            | InputModes::ISTRIP
            | InputModes::IXON;
        raw.output_modes |= OutputModes::ONLCR;
        raw.control_modes |= ControlModes::CS8;
        raw.local_modes -=
            LocalModes::ECHO | LocalModes::ICANON | LocalModes::IEXTEN | LocalModes::ISIG;
        raw.special_codes[SpecialCodeIndex::VMIN] = 1;
        raw.special_codes[SpecialCodeIndex::VTIME] = 0;
        if tcsetattr(&stdin, OptionalActions::Drain, &raw).is_err() {
            return Raw(None);
        }
        Raw(Some(saved))
    }

    #[cfg(unix)]
    impl Drop for Raw {
        fn drop(&mut self) {
            if let Some(saved) = &self.0 {
                let _ = rustix::termios::tcsetattr(
                    std::io::stdin(),
                    rustix::termios::OptionalActions::Drain,
                    saved,
                );
            }
        }
    }

    #[cfg(windows)]
    pub struct Raw(Option<u32>);

    #[cfg(windows)]
    pub fn enter() -> Raw {
        use windows_sys::Win32::System::Console::{
            ENABLE_VIRTUAL_TERMINAL_INPUT, ENABLE_WINDOW_INPUT, GetConsoleMode, GetStdHandle,
            STD_INPUT_HANDLE, SetConsoleMode,
        };
        // SAFETY: console calls on this process's own standard input.
        unsafe {
            let handle = GetStdHandle(STD_INPUT_HANDLE);
            let mut saved = 0u32;
            if GetConsoleMode(handle, &mut saved) == 0 {
                return Raw(None);
            }
            if SetConsoleMode(handle, ENABLE_WINDOW_INPUT | ENABLE_VIRTUAL_TERMINAL_INPUT) == 0
                && SetConsoleMode(handle, ENABLE_WINDOW_INPUT) == 0
            {
                return Raw(None);
            }
            Raw(Some(saved))
        }
    }

    #[cfg(windows)]
    impl Drop for Raw {
        fn drop(&mut self) {
            use windows_sys::Win32::System::Console::{
                GetStdHandle, STD_INPUT_HANDLE, SetConsoleMode,
            };
            if let Some(saved) = self.0 {
                // SAFETY: restores the mode read in `enter`.
                unsafe {
                    SetConsoleMode(GetStdHandle(STD_INPUT_HANDLE), saved);
                }
            }
        }
    }
}

#[cfg(test)]
mod tests;
