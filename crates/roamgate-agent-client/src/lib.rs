//! The agent-side clients, run by the `roamgate` binary: `roamgate-review`
//! (agents' and Claude Code hooks' client of the agent socket) and
//! `roamgate-hold` (conversation mode's pane holder). The server installs
//! them in `~/.cache/roamgate/bin` as links to itself, so a local host
//! needs no Python; the binary tells them by the name it runs under, or
//! by `roamgate review ...` and `roamgate hold ...`. SSH hosts, where no
//! roamgate binary may be, run the Python versions in
//! contract/assets/python, which speak the same protocol and print the
//! same output (parity/scenarios prove both).

pub mod argparse;
pub mod hold;
pub mod hook_install;
pub mod http;
mod process;
pub mod py;
pub mod review;

/// A client the binary can run as.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Client {
    Review,
    Hold,
}

impl Client {
    /// The name it is installed and run under.
    pub fn name(self) -> &'static str {
        match self {
            Client::Review => "roamgate-review",
            Client::Hold => "roamgate-hold",
        }
    }

    /// The `roamgate` subcommand that runs it.
    pub fn subcommand(self) -> &'static str {
        match self {
            Client::Review => "review",
            Client::Hold => "hold",
        }
    }
}

/// The client a program name runs (`roamgate-review`,
/// `/x/roamgate-hold`, `roamgate-review.exe`), if any.
pub fn client_named(argv0: &str) -> Option<Client> {
    let base = argv0.rsplit(['/', '\\']).next().unwrap_or(argv0);
    let base = base
        .strip_suffix(".exe")
        .or_else(|| base.strip_suffix(".EXE"))
        .unwrap_or(base);
    match base {
        "roamgate-review" => Some(Client::Review),
        "roamgate-hold" => Some(Client::Hold),
        _ => None,
    }
}

/// Runs the client the process was started as: by its name, or as
/// `roamgate review|hold ...`. None when it is neither.
pub fn run_from_args(argv: &[String]) -> Option<i32> {
    let argv0 = argv.first().map(String::as_str).unwrap_or("");
    let (client, prefix) = match client_named(argv0) {
        Some(client) => (client, 0),
        None => match argv.get(1).map(String::as_str) {
            Some("review") => (Client::Review, 1),
            Some("hold") => (Client::Hold, 1),
            _ => return None,
        },
    };
    let args = &argv[1 + prefix..];
    Some(match client {
        Client::Review => review::main(args),
        Client::Hold => hold::main(argv0, &argv[1..1 + prefix], args),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tells_the_client_by_its_name() {
        assert_eq!(client_named("roamgate-review"), Some(Client::Review));
        assert_eq!(
            client_named("/home/me/.cache/roamgate/bin/roamgate-hold"),
            Some(Client::Hold)
        );
        assert_eq!(
            client_named(r"C:\Users\me\.cache\roamgate\bin\roamgate-review.exe"),
            Some(Client::Review)
        );
        assert_eq!(client_named("roamgate"), None);
        assert_eq!(client_named("roamgate-hold-x"), None);
    }
}
