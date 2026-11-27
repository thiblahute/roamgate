//! The command fakes of the parity suite, one multi-call binary: the run's
//! `bin/` directory links it under each program's name (ssh, glab, gh,
//! claude, agy, systemctl, ...), and it acts as the program its name says. It
//! can also be run as `parity-fake <program> [args...]`.
//!
//! Every call is logged and answered from the run's scripts
//! (roamgate_parity::fakes::script); the fakes with their own protocol (ssh,
//! claude, the voice helper) fall back to it when no rule answers.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use roamgate_parity::fakes::script::{self, Call, Script};
use roamgate_parity::fakes::{agy, claude, forge, respond, ssh, voice};

fn program_name() -> (String, Vec<String>) {
    let mut args = std::env::args();
    let zero = args.next().unwrap_or_default();
    let name = Path::new(&zero)
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    // Windows' PATHEXT spells it `.EXE`: a program found on PATH.
    let name = match name.len().checked_sub(4) {
        Some(at) if name.is_char_boundary(at) && name[at..].eq_ignore_ascii_case(".exe") => {
            name[..at].to_owned()
        }
        _ => name,
    };
    let rest: Vec<String> = args.collect();
    if name == "parity-fake" {
        let mut rest = rest.into_iter();
        let program = rest.next().unwrap_or_default();
        return (program, rest.collect());
    }
    let name = name.strip_prefix("fake-").unwrap_or(&name).to_owned();
    (name, rest)
}

fn read_stdin() -> String {
    let mut text = String::new();
    let _ = std::io::stdin().read_to_string(&mut text);
    text
}

/// What a program does when no rule answers.
fn fallback(program: &str, args: &[String]) -> i32 {
    match program {
        "gamemoded" => {
            println!("gamemode is inactive");
            0
        }
        "herdr" if args.first().map(String::as_str) == Some("--version") => {
            println!("herdr {}", herdr_api::HERDR_VERSION);
            0
        }
        // host-spawn runs its command on the host: here, the host is local
        // (its own options, --no-pty, are left out).
        "host-spawn" if args.iter().any(|arg| !arg.starts_with("--")) => {
            let command: Vec<&String> = args
                .iter()
                .skip_while(|arg| arg.starts_with("--"))
                .collect();
            Command::new(command[0])
                .args(&command[1..])
                .status()
                .map(|status| status.code().unwrap_or(1))
                .unwrap_or(127)
        }
        "systemctl" | "journalctl" | "launchctl" | "schtasks" | "powershell" | "pwsh"
        | "xdg-open" | "open" | "explorer" | "lsof" | "ss" | "ps" | "nvidia-smi" | "rocm-smi"
        | "system_profiler" => 0,
        _ => {
            eprintln!(
                "parity fake {program}: no scripted answer for: {}",
                args.join(" ")
            );
            1
        }
    }
}

fn main() -> ExitCode {
    let (program, args) = program_name();
    let Some(fakes) = script::fakes_dir() else {
        eprintln!("parity fake {program}: PARITY_FAKES_DIR is not set");
        return ExitCode::from(127);
    };
    let script: Script = script::load(&fakes, &program);
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let env = script::recorded_env_keys(&program)
        .into_iter()
        .filter_map(|key| std::env::var(&key).ok().map(|value| (key, value)))
        .collect();

    // Protocol fakes read their stdin as a stream; the others read it
    // only when a rule looks at it.
    let streaming = matches!(
        program.as_str(),
        "claude" | "agy" | "roamgate-voice" | "ssh"
    );
    let stdin = if !streaming && script.rules.iter().any(|rule| rule.needs_stdin()) {
        Some(read_stdin())
    } else {
        None
    };
    let picked = script::pick(&fakes, &program, &script, &args, stdin.as_deref());
    script::log_call(
        &fakes,
        &Call {
            program: program.clone(),
            argv: args.clone(),
            cwd: cwd.to_string_lossy().into_owned(),
            stdin,
            env,
            rule: picked.as_ref().map(|(index, _)| *index),
            pid: std::process::id(),
        },
    );
    if let Some((index, _)) = &picked {
        script::count_hit(&fakes, &program, *index);
    }
    let picked = picked.map(|(_, answer)| answer);

    let code = match program.as_str() {
        "ssh" => ssh::run(&args, picked, &fakes),
        "claude" => claude::run(&args, &script, picked),
        "agy" => agy::run(&args, &script, picked),
        "roamgate-voice" => voice::run(&script),
        "glab" | "gh" => match picked.or_else(|| script.default.clone()) {
            Some(found) => forge::run(&args, &found, &cwd),
            None => fallback(&program, &args),
        },
        _ => match picked.or_else(|| script.default.clone()) {
            Some(found) => respond(&found, &cwd),
            None => fallback(&program, &args),
        },
    };
    ExitCode::from(u8::try_from(code.clamp(0, 255)).unwrap_or(1))
}
