//! What the holder asks of the system: signals, the terminal's job
//! control and line settings, and processes by id. Off Unix there is no
//! job control and no terminal signal to turn off (as Python's holder,
//! which has no `termios` there).

/// A signal's disposition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Disposition {
    Ignore,
    Default,
}

#[cfg(unix)]
mod unix {
    use super::Disposition;
    use rustix::process::{Pid, Signal};
    use rustix::termios::{LocalModes, OptionalActions, Termios};

    pub const SIGINT: i32 = libc::SIGINT;
    pub const SIGTSTP: i32 = libc::SIGTSTP;
    pub const SIGQUIT: i32 = libc::SIGQUIT;
    pub const SIGHUP: i32 = libc::SIGHUP;
    pub const SIGTERM: i32 = libc::SIGTERM;

    /// `signal.signal(sig, SIG_IGN or SIG_DFL)`.
    #[allow(unsafe_code)]
    pub fn set_signal(signal: i32, disposition: Disposition) {
        let handler = match disposition {
            Disposition::Ignore => libc::SIG_IGN,
            Disposition::Default => libc::SIG_DFL,
        };
        // SAFETY: installs one of the two built-in dispositions, no
        // handler code of ours runs in signal context.
        unsafe {
            libc::signal(signal, handler);
        }
    }

    fn pid(raw: u32) -> Option<Pid> {
        Pid::from_raw(raw as i32)
    }

    /// `os.kill(pid, SIGKILL)`.
    pub fn kill(raw: u32) {
        if let Some(pid) = pid(raw) {
            let _ = rustix::process::kill_process(pid, Signal::KILL);
        }
    }

    /// `os.kill(pid, 0)`: false only when no such process exists.
    pub fn alive(raw: u32) -> bool {
        match pid(raw) {
            Some(pid) => !matches!(
                rustix::process::test_kill_process(pid),
                Err(rustix::io::Errno::SRCH)
            ),
            None => false,
        }
    }

    /// Stops this process as a job (`os.kill(os.getpid(), SIGTSTP)`).
    pub fn stop_self() {
        let _ = rustix::process::kill_process(rustix::process::getpid(), Signal::TSTP);
    }

    /// Whether it can stop as a job of the pane's shell: an interactive
    /// shell with job control runs it as its own process group, in the
    /// terminal's foreground.
    pub fn job_control() -> bool {
        let stdin = std::io::stdin();
        if !rustix::termios::isatty(&stdin) {
            return false;
        }
        let group = rustix::process::getpgrp();
        let Ok(foreground) = rustix::termios::tcgetpgrp(&stdin) else {
            return false;
        };
        let Some(parent) = rustix::process::getppid() else {
            return false;
        };
        let Ok(parent_group) = rustix::process::getpgid(Some(parent)) else {
            return false;
        };
        group == rustix::process::getpid() && foreground == group && parent_group != group
    }

    /// Whether this process group is the terminal's foreground one again
    /// (an error counts as yes).
    pub fn in_foreground() -> bool {
        match rustix::termios::tcgetpgrp(std::io::stdin()) {
            Ok(foreground) => foreground == rustix::process::getpgrp(),
            Err(_) => true,
        }
    }

    /// The terminal's settings before the holder turned its signals off.
    pub struct SavedTty(Termios);

    /// Turns the terminal's signal keys off (`ISIG`): nothing typed may
    /// signal the holder or its claude. None when stdin is no terminal.
    pub fn quiet_tty() -> Option<SavedTty> {
        let stdin = std::io::stdin();
        if !rustix::termios::isatty(&stdin) {
            return None;
        }
        let saved = rustix::termios::tcgetattr(&stdin).ok()?;
        let mut quiet = saved.clone();
        quiet.local_modes.remove(LocalModes::ISIG);
        rustix::termios::tcsetattr(&stdin, OptionalActions::Now, &quiet).ok()?;
        Some(SavedTty(saved))
    }

    pub fn restore_tty(saved: &SavedTty) {
        let _ = rustix::termios::tcsetattr(std::io::stdin(), OptionalActions::Now, &saved.0);
    }
}

#[cfg(unix)]
pub use unix::*;

#[cfg(not(unix))]
mod other {
    use super::Disposition;

    pub const SIGINT: i32 = 2;
    pub const SIGTSTP: i32 = 20;
    pub const SIGQUIT: i32 = 3;
    pub const SIGHUP: i32 = 1;
    pub const SIGTERM: i32 = 15;

    pub fn set_signal(_signal: i32, _disposition: Disposition) {}

    pub fn kill(pid: u32) {
        let _ = std::process::Command::new("taskkill")
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }

    pub fn alive(pid: u32) -> bool {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .map(|out| String::from_utf8_lossy(&out.stdout).contains(&pid.to_string()))
            .unwrap_or(true)
    }

    pub fn stop_self() {}

    pub fn job_control() -> bool {
        false
    }

    pub fn in_foreground() -> bool {
        true
    }

    pub struct SavedTty;

    pub fn quiet_tty() -> Option<SavedTty> {
        None
    }

    pub fn restore_tty(_saved: &SavedTty) {}
}

#[cfg(not(unix))]
pub use other::*;
