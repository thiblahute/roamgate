//! The cases of bridge/herdr-relay.test.ts.

use super::*;

#[test]
fn quotes_alike_in_sh_and_fish() {
    // fish reads \\ and \' as escapes inside single quotes.
    assert!(!HERDR_RELAY_SCRIPT.contains(['\'', '\\']));
}

#[test]
fn the_script_prints_the_ready_line_and_owns_the_socket_prefix() {
    assert!(HERDR_RELAY_SCRIPT.contains(&format!("\"{HERDR_RELAY_READY}\"")));
    assert!(HERDR_RELAY_SCRIPT.contains(&format!("\"{HERDR_RELAY_SOCKET_PREFIX}\"")));
}

#[test]
fn listens_in_the_hosts_roamgate_cache_under_its_token() {
    let relay = herdr_relay(
        "/home/o'brien/",
        "/home/o'brien/.config/herdr/herdr.sock",
        "abc123",
    )
    .unwrap()
    .unwrap();
    assert_eq!(
        relay.socket,
        "/home/o'brien/.cache/roamgate/herdr-relay-abc123.sock"
    );
    assert!(relay.command.starts_with("exec python3 -c '"));
    assert!(relay.command.ends_with(
        r" '/home/o'\''brien/.config/herdr/herdr.sock' '/home/o'\''brien/.cache/roamgate/herdr-relay-abc123.sock'"
    ));
}

#[test]
fn leaves_hosts_whose_socket_path_would_be_too_long_to_the_direct_forward() {
    let long = format!("/home/{}", "x".repeat(80));
    assert_eq!(herdr_relay(&long, "/run/herdr.sock", "abc"), Ok(None));
    assert_eq!(herdr_relay("relative", "/h.sock", "abc"), Ok(None));
    assert_eq!(
        herdr_relay("/home/a", "/h.sock", "../x"),
        Err(InvalidRelayToken)
    );
}

#[test]
fn tokens_differ_and_are_alphanumeric() {
    let (a, b) = (random_relay_token(), random_relay_token());
    assert_ne!(a, b);
    assert!(herdr_relay("/home/a", "/h.sock", &a).unwrap().is_some());
}

#[cfg(unix)]
mod script {
    use super::*;
    use std::io::{BufRead, BufReader, Read, Write};
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    fn python() -> bool {
        Command::new("python3")
            .arg("-c")
            .arg("pass")
            .status()
            .is_ok_and(|status| status.success())
    }

    /// A Herdr stand-in: for each connection, whether the client had
    /// written when it opened (`written`), and what it got.
    type Seen = Arc<Mutex<Vec<(bool, String)>>>;

    fn fake_herdr(path: &std::path::Path, written: Arc<AtomicBool>) -> Seen {
        let listener = UnixListener::bind(path).unwrap();
        let seen: Seen = Arc::default();
        let sink = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { return };
                let opened = written.load(Ordering::SeqCst);
                let mut line = String::new();
                BufReader::new(stream.try_clone().unwrap())
                    .read_line(&mut line)
                    .unwrap();
                sink.lock().unwrap().push((opened, line));
                stream
                    .write_all(b"{\"id\":\"p\",\"result\":{\"type\":\"pong\"}}\n")
                    .unwrap();
            }
        });
        seen
    }

    fn start(home: &std::path::Path, herdr: &std::path::Path) -> (HerdrRelay, std::process::Child) {
        let relay = herdr_relay(home.to_str().unwrap(), herdr.to_str().unwrap(), "test")
            .unwrap()
            .unwrap();
        let mut child = Command::new("/bin/sh")
            .arg("-c")
            .arg(&relay.command)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        assert_eq!(line, format!("{HERDR_RELAY_READY}\n"));
        (relay, child)
    }

    #[test]
    fn connects_to_herdr_only_once_the_request_is_there() {
        if !python() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let herdr = home.path().join("herdr.sock");
        let written = Arc::new(AtomicBool::new(false));
        let seen = fake_herdr(&herdr, written.clone());
        let (relay, mut child) = start(home.path(), &herdr);

        // Like sshd: connected first, the request a moment later.
        let mut client = UnixStream::connect(&relay.socket).unwrap();
        std::thread::sleep(Duration::from_millis(30));
        written.store(true, Ordering::SeqCst);
        client
            .write_all(b"{\"id\":\"p\",\"method\":\"ping\",\"params\":{}}\n")
            .unwrap();
        let mut reply = String::new();
        client.read_to_string(&mut reply).unwrap();
        assert_eq!(reply, "{\"id\":\"p\",\"result\":{\"type\":\"pong\"}}\n");
        let seen = seen.lock().unwrap().clone();
        assert_eq!(seen.len(), 1);
        assert!(seen[0].0, "Herdr's connection opened before the request");
        assert_eq!(
            seen[0].1,
            "{\"id\":\"p\",\"method\":\"ping\",\"params\":{}}\n"
        );

        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
    }

    #[test]
    fn removes_its_socket_when_the_session_ends_and_stale_ones() {
        if !python() {
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let herdr = home.path().join("herdr.sock");
        fake_herdr(&herdr, Arc::default());
        let directory = home.path().join(".cache/roamgate");
        std::fs::create_dir_all(&directory).unwrap();
        // A socket nobody listens on, left by a relay killed outright.
        let stale = directory.join("herdr-relay-gone.sock");
        drop(UnixListener::bind(&stale).unwrap());
        std::fs::write(directory.join("unrelated.sock"), "").unwrap();

        let (relay, mut child) = start(home.path(), &herdr);
        assert!(!stale.exists());
        assert!(directory.join("unrelated.sock").exists());
        assert!(std::path::Path::new(&relay.socket).exists());

        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        assert!(!std::path::Path::new(&relay.socket).exists());
    }
}
