//! fake-ssh: OpenSSH's command line, with the remote side run locally.
//!
//! - `-O check|exit|stop|forward|cancel` talk to the master of the control
//!   path (`-S` or `-o ControlPath=`): a master is a file there holding its
//!   pid while a `-M` process runs.
//! - `-G <host>` prints a resolved configuration.
//! - `-M` and `-N` stay up until killed (the master, tunnels, forwards).
//! - Otherwise the remote command runs with `sh -c` in the fake remote home
//!   (`PARITY_REMOTE_HOME`, HOME set to it), with stdin and the exit code
//!   passed through.
//!
//! A scripted rule answers first: refusals (`exit: 255` and OpenSSH's
//! message), delays, canned output; with `passthrough` the command still
//! runs after the rule's output.

use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use super::respond;
use super::script::Answer;

/// Options taking a value, from ssh(1).
const WITH_VALUE: &str = "BbcDEeFIiJLlmOopQRSWw";

#[derive(Debug, Default, PartialEq)]
pub struct Parsed {
    pub flags: Vec<char>,
    pub options: Vec<(char, String)>,
    pub destination: Option<String>,
    pub command: Vec<String>,
}

impl Parsed {
    pub fn value(&self, flag: char) -> Option<&str> {
        self.options
            .iter()
            .rev()
            .find(|(name, _)| *name == flag)
            .map(|(_, value)| value.as_str())
    }

    pub fn has(&self, flag: char) -> bool {
        self.flags.contains(&flag)
    }

    /// `-o Key=value` or `-o "Key value"`, case-insensitive key.
    pub fn config(&self, key: &str) -> Option<String> {
        self.options
            .iter()
            .rev()
            .filter(|(name, _)| *name == 'o')
            .find_map(|(_, value)| {
                let (name, rest) = value.split_once('=').or_else(|| value.split_once(' '))?;
                name.trim()
                    .eq_ignore_ascii_case(key)
                    .then(|| rest.trim().to_owned())
            })
    }

    pub fn control_path(&self) -> Option<PathBuf> {
        self.value('S')
            .map(str::to_owned)
            .or_else(|| self.config("ControlPath"))
            .filter(|path| path != "none")
            .map(PathBuf::from)
    }
}

pub fn parse(args: &[String]) -> Parsed {
    let mut parsed = Parsed::default();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if parsed.destination.is_some() {
            parsed.command.extend(args[index..].iter().cloned());
            break;
        }
        if arg == "--" {
            index += 1;
            if index < args.len() {
                parsed.destination = Some(args[index].clone());
                parsed.command.extend(args[index + 1..].iter().cloned());
            }
            break;
        }
        if let Some(cluster) = arg.strip_prefix('-').filter(|rest| !rest.is_empty()) {
            let chars: Vec<char> = cluster.chars().collect();
            let mut at = 0;
            while at < chars.len() {
                let flag = chars[at];
                if WITH_VALUE.contains(flag) {
                    let rest: String = chars[at + 1..].iter().collect();
                    let value = if rest.is_empty() {
                        index += 1;
                        args.get(index).cloned().unwrap_or_default()
                    } else {
                        rest
                    };
                    parsed.options.push((flag, value));
                    break;
                }
                parsed.flags.push(flag);
                at += 1;
            }
        } else {
            parsed.destination = Some(arg.clone());
        }
        index += 1;
    }
    parsed
}

fn remote_home(fakes: &Path) -> PathBuf {
    std::env::var_os("PARITY_REMOTE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| fakes.join("remote-home"))
}

fn master_pid(path: &Path) -> Option<u32> {
    std::fs::read_to_string(path).ok()?.trim().parse().ok()
}

/// Stays up until the harness or the server kills the process.
fn park() -> ! {
    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}

/// Copies bytes both ways until either side closes.
fn splice<A, B>(a: A, b: B)
where
    A: std::io::Read + std::io::Write + Send + 'static + TryClone,
    B: std::io::Read + std::io::Write + Send + 'static + TryClone,
{
    let (Ok(mut a_read), Ok(mut b_read)) = (a.try_clone_stream(), b.try_clone_stream()) else {
        return;
    };
    let (mut a_write, mut b_write) = (a, b);
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut a_read, &mut b_write);
        b_write.shutdown_write();
    });
    std::thread::spawn(move || {
        let _ = std::io::copy(&mut b_read, &mut a_write);
        a_write.shutdown_write();
    });
}

/// The streams `splice` joins.
pub trait TryClone: Sized {
    fn try_clone_stream(&self) -> std::io::Result<Self>;
    fn shutdown_write(&self);
}

impl TryClone for std::net::TcpStream {
    fn try_clone_stream(&self) -> std::io::Result<Self> {
        self.try_clone()
    }
    fn shutdown_write(&self) {
        let _ = self.shutdown(std::net::Shutdown::Write);
    }
}

#[cfg(unix)]
impl TryClone for std::os::unix::net::UnixStream {
    fn try_clone_stream(&self) -> std::io::Result<Self> {
        self.try_clone()
    }
    fn shutdown_write(&self) {
        let _ = self.shutdown(std::net::Shutdown::Write);
    }
}

/// One `-L` forward: `local_socket:remote_socket`, `port:host:hostport` or
/// `bind:port:host:hostport`, served by a thread while the process lives.
fn forward(spec: &str) -> std::io::Result<()> {
    let parts: Vec<&str> = spec.split(':').collect();
    #[cfg(unix)]
    if parts.len() == 2 && parts[0].contains('/') {
        use std::os::unix::net::{UnixListener, UnixStream};
        let (local, remote) = (parts[0].to_owned(), parts[1].to_owned());
        let _ = std::fs::remove_file(&local);
        let listener = UnixListener::bind(&local)?;
        std::thread::spawn(move || {
            for client in listener.incoming().flatten() {
                if let Ok(upstream) = UnixStream::connect(&remote) {
                    splice(client, upstream);
                }
            }
        });
        return Ok(());
    }
    let (bind, port, host, host_port) = match parts.as_slice() {
        [port, host, host_port] => ("127.0.0.1", *port, *host, *host_port),
        [bind, port, host, host_port] => (*bind, *port, *host, *host_port),
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "not a forward this fake knows",
            ));
        }
    };
    let bind = if bind.is_empty() || bind == "localhost" {
        "127.0.0.1"
    } else {
        bind
    };
    let listener = std::net::TcpListener::bind(format!("{bind}:{port}"))?;
    let target = format!("{host}:{host_port}");
    std::thread::spawn(move || {
        for client in listener.incoming().flatten() {
            if let Ok(upstream) = std::net::TcpStream::connect(&target) {
                splice(client, upstream);
            }
        }
    });
    Ok(())
}

pub fn run(args: &[String], picked: Option<Answer>, fakes: &Path) -> i32 {
    let parsed = parse(args);
    let home = remote_home(fakes);
    let _ = std::fs::create_dir_all(&home);
    if let Some(answer) = &picked {
        let code = respond(answer, &home);
        if !answer.passthrough {
            return code;
        }
    }
    if let Some(operation) = parsed.value('O') {
        let Some(path) = parsed.control_path() else {
            eprintln!("No ControlPath specified for \"-O\" command");
            return 255;
        };
        let running = master_pid(&path);
        return match (operation, running) {
            ("check", Some(pid)) => {
                eprintln!("Master running (pid={pid})");
                0
            }
            ("exit" | "stop", Some(_)) => {
                let _ = std::fs::remove_file(&path);
                eprintln!("Exit request sent.");
                0
            }
            ("forward" | "cancel", Some(_)) => 0,
            (_, None) => {
                eprintln!(
                    "Control socket connect({}): No such file or directory",
                    path.display()
                );
                255
            }
            (other, Some(_)) => {
                eprintln!("Invalid multiplex command {other}");
                255
            }
        };
    }
    if parsed.has('G') {
        let host = parsed.destination.clone().unwrap_or_default();
        let (user, host) = host
            .split_once('@')
            .map(|(user, host)| (user.to_owned(), host.to_owned()))
            .unwrap_or_else(|| ("parity".to_owned(), host.clone()));
        println!("user {}", parsed.value('l').unwrap_or(&user));
        println!("hostname {host}");
        println!("port {}", parsed.value('p').unwrap_or("22"));
        if let Some(path) = parsed.control_path() {
            println!("controlpath {}", path.display());
        }
        return 0;
    }
    // Local forwards (`-L`): the remote end is this machine.
    for (flag, spec) in &parsed.options {
        if *flag == 'L'
            && let Err(error) = forward(spec)
        {
            eprintln!("parity fake ssh: forward {spec}: {error}");
            return 255;
        }
    }
    if parsed.has('M') {
        if let Some(path) = parsed.control_path() {
            let _ = std::fs::write(&path, std::process::id().to_string());
        }
        park();
    }
    if parsed.has('N') {
        park();
    }
    let command = parsed.command.join(" ");
    let mut child = Command::new("sh");
    if command.is_empty() {
        child.arg("-s");
    } else {
        child.arg("-c").arg(&command);
    }
    child.current_dir(&home).env("HOME", &home);
    match child.status() {
        Ok(status) => status.code().unwrap_or(255),
        Err(error) => {
            eprintln!("parity fake ssh: {error}");
            255
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<String> {
        list.iter().map(|arg| arg.to_string()).collect()
    }

    #[test]
    fn parses_options_destination_and_command() {
        let parsed = parse(&args(&[
            "-T",
            "-oBatchMode=yes",
            "-S",
            "/tmp/c",
            "-p2222",
            "me@host",
            "printf",
            "%s",
            "x",
        ]));
        assert_eq!(parsed.flags, vec!['T']);
        assert_eq!(parsed.value('S'), Some("/tmp/c"));
        assert_eq!(parsed.value('p'), Some("2222"));
        assert_eq!(parsed.config("batchmode").as_deref(), Some("yes"));
        assert_eq!(parsed.destination.as_deref(), Some("me@host"));
        assert_eq!(parsed.command, args(&["printf", "%s", "x"]));
    }

    #[test]
    fn control_path_from_option() {
        let parsed = parse(&args(&["-o", "ControlPath=/run/x", "-O", "check", "h"]));
        assert_eq!(parsed.control_path(), Some(PathBuf::from("/run/x")));
        assert_eq!(parsed.value('O'), Some("check"));
    }
}
