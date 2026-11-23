//! The cases of bridge/ssh-forward.test.ts.

use super::*;
use crate::ssh::sessions::tests::flush;
use crate::ssh::supervised::{ChildControl, KillSignal};
use roamgate_base::clock::TokioClock;

/// A forward process that never exits by itself and records its kills.
struct Deferred {
    child: SupervisedSsh,
    control: ChildControl,
    killed: Arc<Mutex<Vec<KillSignal>>>,
}

fn deferred() -> Deferred {
    let killed: Arc<Mutex<Vec<KillSignal>>> = Arc::default();
    let seen = killed.clone();
    let (child, control) = SupervisedSsh::manual(move |signal, _| {
        seen.lock().unwrap().push(signal);
        Ok(())
    });
    control.set_stderr("bind: Address already in use");
    Deferred {
        child,
        control,
        killed,
    }
}

fn clock() -> SharedClock {
    Arc::new(TokioClock::starting_at(0))
}

/// Forwards spawning `children` in order.
fn forwards(
    children: Vec<SupervisedSsh>,
    is_free: impl Fn(u16) -> bool + Send + Sync + 'static,
) -> SshForwards {
    let children = Arc::new(Mutex::new(children));
    SshForwards::new(
        clock(),
        ForwardDeps {
            spawn: Arc::new(move |_| Ok(children.lock().unwrap().remove(0))),
            is_port_free: Arc::new(is_free),
            ..ForwardDeps::default()
        },
    )
}

fn request(connection: &str, destination: &str, port: u16) -> ForwardRequest {
    ForwardRequest {
        connection_id: connection.into(),
        destination: destination.into(),
        port,
        direction: SshForwardDirection::Local,
        label: None,
    }
}

// Forward argv.

#[test]
fn binds_loopback_locally_and_resolves_localhost_on_the_far_host() {
    let argv = ssh_forward_argv("user@host", 5173, 3000, SshForwardDirection::Local).unwrap();
    assert!(argv.contains(&"-N".to_owned()));
    assert!(argv.contains(&"-L".to_owned()));
    assert!(argv.contains(&format!("{FORWARD_BIND_HOST}:5173:localhost:3000")));
    // A refused bind must exit rather than run on without the forward.
    assert!(argv.contains(&"ExitOnForwardFailure=yes".to_owned()));
    assert_eq!(argv.last().unwrap(), "user@host");
}

#[test]
fn refuses_a_destination_that_is_not_a_plain_ssh_target() {
    assert!(ssh_forward_argv("-oProxyCommand=evil", 1, 2, SshForwardDirection::Local).is_err());
}

// Port handling.

#[test]
fn rejects_anything_outside_a_usable_port() {
    assert_eq!(validate_forward_port(&Value::from(3000)), Ok(3000));
    assert_eq!(validate_forward_port(&Value::from("3000")), Ok(3000));
    for bad in [
        Value::from(0),
        Value::from(-1),
        Value::from(65536),
        Value::from(1.5),
        Value::from("http"),
        Value::Null,
        Value::Array(Vec::new()),
    ] {
        assert!(validate_forward_port(&bad).is_err(), "{bad}");
    }
}

#[test]
fn prefers_the_remotes_own_number_then_walks_upwards() {
    assert_eq!(choose_local_port(3000, |_| true, 64), Ok(3000));
    assert_eq!(choose_local_port(3000, |port| port >= 3002, 64), Ok(3002));
}

#[test]
fn gives_up_rather_than_binding_something_wildly_unrelated() {
    let error = choose_local_port(3000, |_| false, 4).unwrap_err();
    assert!(error.contains("No free local port"));
}

// Forward supervisor.

#[tokio::test(start_paused = true)]
async fn reports_a_forward_only_once_it_has_survived_startup() {
    let process = deferred();
    let forwards = forwards(vec![process.child.clone()], |_| true);
    let record = forwards
        .open(request("desktop", "user@desktop", 5173))
        .unwrap();
    assert_eq!(
        record.id,
        forward_id("desktop", 5173, SshForwardDirection::Local)
    );
    assert_eq!(record.local_port, 5173);
    assert_eq!(record.state, SshForwardState::Starting);
    forwards.mark_open(&record.id);
    assert_eq!(forwards.list()[0].state, SshForwardState::Open);
}

#[tokio::test(start_paused = true)]
async fn a_refused_bind_fails_that_forward_alone_with_sshs_reason() {
    let first = deferred();
    let second = deferred();
    let forwards = forwards(vec![first.child.clone(), second.child.clone()], |_| true);
    let changes = Arc::new(Mutex::new(Vec::new()));
    let seen = changes.clone();
    forwards.on_change(move |list| seen.lock().unwrap().push(list.len()));
    let a = forwards
        .open(request("desktop", "user@desktop", 5173))
        .unwrap();
    let b = forwards
        .open(request("desktop", "user@desktop", 3000))
        .unwrap();
    first.control.exit(255);
    flush().await;
    let list = forwards.list();
    let by_id = |id: &str| list.iter().find(|record| record.id == id).unwrap().clone();
    assert_eq!(by_id(&a.id).state, SshForwardState::Failed);
    assert!(by_id(&a.id).error.is_some_and(|error| !error.is_empty()));
    // The sibling keeps running: one process each is the point.
    assert_ne!(by_id(&b.id).state, SshForwardState::Failed);
    assert!(!changes.lock().unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn a_second_request_for_the_same_port_reuses_the_live_forward() {
    let process = deferred();
    let spawns = Arc::new(Mutex::new(0));
    let counted = spawns.clone();
    let child = process.child.clone();
    let forwards = SshForwards::new(
        clock(),
        ForwardDeps {
            spawn: Arc::new(move |_| {
                *counted.lock().unwrap() += 1;
                Ok(child.clone())
            }),
            is_port_free: Arc::new(|_| true),
            ..ForwardDeps::default()
        },
    );
    let first = forwards
        .open(request("desktop", "user@desktop", 5173))
        .unwrap();
    let again = forwards
        .open(request("desktop", "user@desktop", 5173))
        .unwrap();
    assert_eq!(*spawns.lock().unwrap(), 1);
    assert_eq!(again.id, first.id);
    assert_eq!(forwards.list().len(), 1);
}

#[tokio::test(start_paused = true)]
async fn two_forwards_never_land_on_the_same_local_port() {
    let forwards = forwards(vec![deferred().child, deferred().child], |_| true);
    forwards.open(request("a", "user@a", 5173)).unwrap();
    let second = forwards.open(request("b", "user@b", 5173)).unwrap();
    // Same remote number on two connections: the second has to move.
    assert_eq!(second.local_port, 5174);
}

#[tokio::test(start_paused = true)]
async fn losing_a_connection_kills_its_forwards_lists_them_lost_and_leaves_others_alone() {
    let desktop = deferred();
    let laptop = deferred();
    let again = deferred();
    let forwards = forwards(
        vec![
            desktop.child.clone(),
            laptop.child.clone(),
            again.child.clone(),
        ],
        |_| true,
    );
    forwards
        .open(request("desktop", "user@desktop", 5173))
        .unwrap();
    forwards
        .open(request("laptop", "user@laptop", 8080))
        .unwrap();
    forwards.lose_connection("desktop");
    assert_eq!(desktop.killed.lock().unwrap().len(), 1);
    assert!(laptop.killed.lock().unwrap().is_empty());
    let list = forwards.list();
    let by_connection = |id: &str| {
        list.iter()
            .find(|record| record.connection_id == id)
            .unwrap()
            .clone()
    };
    // Still listed, so a reconnect does not make it vanish unexplained.
    let lost = by_connection("desktop");
    assert_eq!(lost.state, SshForwardState::Failed);
    assert!(lost.error.unwrap().contains("Lost with its connection"));
    assert_eq!(by_connection("laptop").state, SshForwardState::Starting);
    // Forwarding the port again replaces the lost entry.
    assert_eq!(
        forwards
            .open(request("desktop", "user@desktop", 5173))
            .unwrap()
            .state,
        SshForwardState::Starting
    );
    assert_eq!(forwards.list().len(), 2);
}

// Listening port discovery.

fn port(port: u16, process: Option<&str>) -> ListeningPort {
    ListeningPort {
        port,
        process: process.map(str::to_owned),
    }
}

#[test]
fn reads_ss_output_keeping_loopback_and_wildcard_listeners() {
    let output = [
        r#"LISTEN 0 4096 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=42,fd=23))"#,
        r#"LISTEN 0 4096 127.0.0.1:5174 0.0.0.0:* users:(("node",pid=42,fd=25))"#,
        r#"LISTEN 0 511 0.0.0.0:8787 0.0.0.0:* users:(("roamgate",pid=7,fd=7))"#,
        "LISTEN 0 128 [::1]:9229 [::]:* ",
    ]
    .join("\n");
    assert_eq!(
        parse_listening_ports(&output),
        [
            port(5173, Some("node")),
            port(5174, Some("node")),
            port(8787, Some("roamgate")),
            port(9229, None)
        ]
    );
}

#[test]
fn reads_lsof_output_as_macos_has_neither_ss_nor_netstat_p() {
    let output = [
        "COMMAND     PID USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME",
        "node      41234 me     23u  IPv6 0x798e7cda42e3b5b1      0t0  TCP [::1]:5173 (LISTEN)",
        "node      41234 me     24u  IPv4 0x7671e0373c8cc6b2      0t0  TCP 127.0.0.1:5173 (LISTEN)",
        "ollama      566 me     12u  IPv4 0x96eeac0de9a49e53      0t0  TCP *:11434 (LISTEN)",
        "tailscale  1081 me     15u  IPv4 0x891a01d18e480c2e      0t0  TCP 100.64.0.2:54906 (LISTEN)",
    ]
    .join("\n");
    assert_eq!(
        parse_listening_ports(&output),
        [port(5173, Some("node")), port(11434, Some("ollama"))]
    );
}

#[cfg(unix)]
#[test]
fn the_scan_command_finds_a_listener_on_this_machine() {
    // Run for real: on macOS a chain without lsof ends in a netstat that
    // rejects -ltnp and finds nothing.
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let listening = server.local_addr().unwrap().port();
    let output = std::process::Command::new("sh")
        .args(["-c", LISTENING_PORTS_COMMAND])
        .stderr(std::process::Stdio::null())
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(0));
    let ports: Vec<u16> = parse_listening_ports(&String::from_utf8_lossy(&output.stdout))
        .into_iter()
        .map(|entry| entry.port)
        .collect();
    assert!(ports.contains(&listening), "{ports:?}");
}

#[test]
fn drops_listeners_that_are_already_reachable_without_a_tunnel() {
    let output = [
        "LISTEN 0 128 192.168.1.10:5432 0.0.0.0:*",
        "LISTEN 0 128 10.0.0.4:6379 0.0.0.0:*",
        "LISTEN 0 128 127.0.0.1:5432 0.0.0.0:*",
    ]
    .join("\n");
    assert_eq!(parse_listening_ports(&output), [port(5432, None)]);
}

#[test]
fn reads_netstat_output_and_its_header() {
    let output = [
        "Active Internet connections (only servers)",
        "Proto Recv-Q Send-Q Local Address           Foreign Address         State",
        "tcp        0      0 127.0.0.1:3000          0.0.0.0:*               LISTEN",
        "tcp6       0      0 ::1:3001                :::*                    LISTEN",
    ]
    .join("\n");
    assert_eq!(
        parse_listening_ports(&output),
        [port(3000, None), port(3001, None)]
    );
}

#[test]
fn reports_each_port_once_preferring_the_line_that_names_a_process() {
    let output = [
        "LISTEN 0 128 0.0.0.0:3000 0.0.0.0:*",
        r#"LISTEN 0 128 [::]:3000 [::]:* users:(("api",pid=9,fd=3))"#,
    ]
    .join("\n");
    assert_eq!(parse_listening_ports(&output), [port(3000, Some("api"))]);
}

#[test]
fn survives_empty_or_unexpected_output() {
    assert!(parse_listening_ports("").is_empty());
    assert!(parse_listening_ports("ss: command not found").is_empty());
}

// Narrowing a scan to what is worth offering.

fn scanned() -> Vec<ListeningPort> {
    // Taken from a real desktop: the daemons are unnamed because an
    // unprivileged user cannot see root's sockets.
    parse_listening_ports(
        &[
            "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*",
            "LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*",
            "LISTEN 0 128 127.0.0.1:631 0.0.0.0:*",
            "LISTEN 0 4096 0.0.0.0:5355 0.0.0.0:*",
            r#"LISTEN 0 511 0.0.0.0:5173 0.0.0.0:* users:(("node",pid=3537556,fd=31))"#,
            r#"LISTEN 0 512 0.0.0.0:3000 0.0.0.0:* users:(("gst-dots-viewer",pid=3684462,fd=13))"#,
            "LISTEN 0 128 127.0.0.1:9222 0.0.0.0:*",
        ]
        .join("\n"),
    )
}

#[test]
fn keeps_the_ports_the_user_started_and_drops_the_machines_own() {
    assert_eq!(
        owned_listening_ports(&scanned()),
        [
            port(3000, Some("gst-dots-viewer")),
            port(5173, Some("node"))
        ]
    );
}

#[test]
fn keeps_everything_when_nothing_is_named_at_all() {
    let unnamed = parse_listening_ports(
        "LISTEN 0 511 127.0.0.1:5173 0.0.0.0:*\nLISTEN 0 128 127.0.0.1:3000 0.0.0.0:*",
    );
    let ports: Vec<u16> = owned_listening_ports(&unnamed)
        .iter()
        .map(|entry| entry.port)
        .collect();
    assert_eq!(ports, [3000, 5173]);
}

// Reverse forwards.

#[test]
fn a_remote_forward_binds_the_far_hosts_loopback_not_its_interfaces() {
    let argv = ssh_forward_argv("user@host", 11434, 11434, SshForwardDirection::Remote).unwrap();
    assert!(argv.contains(&"-R".to_owned()));
    assert!(!argv.contains(&"-L".to_owned()));
    assert!(argv.contains(&"127.0.0.1:11434:localhost:11434".to_owned()));
}

#[test]
fn the_two_directions_are_separate_forwards_on_the_same_number() {
    assert_ne!(
        forward_id("desktop", 3000, SshForwardDirection::Local),
        forward_id("desktop", 3000, SshForwardDirection::Remote)
    );
}

#[tokio::test(start_paused = true)]
async fn a_remote_forward_keeps_the_port_asked_for_rather_than_moving_it() {
    // Taken here, which for a reverse tunnel is irrelevant: the port that
    // must be free belongs to the far host, and only ssh can say.
    let forwards = forwards(vec![deferred().child, deferred().child], |_| false);
    let reverse = forwards
        .open(ForwardRequest {
            direction: SshForwardDirection::Remote,
            ..request("desktop", "user@desktop", 11434)
        })
        .unwrap();
    assert_eq!(reverse.remote_port, 11434);
    assert_eq!(reverse.local_port, 11434);
    assert_eq!(reverse.direction, SshForwardDirection::Remote);
}

#[tokio::test(start_paused = true)]
async fn a_local_forward_still_moves_off_a_taken_port() {
    let forwards = forwards(vec![deferred().child], |port| port >= 3002);
    assert_eq!(
        forwards
            .open(request("desktop", "user@desktop", 3000))
            .unwrap()
            .local_port,
        3002
    );
}

#[tokio::test(start_paused = true)]
async fn a_remote_forward_opens_once_ssh_reports_the_far_bind() {
    let process = deferred();
    let forwards = forwards(vec![process.child.clone()], |_| true);
    let record = forwards
        .open(ForwardRequest {
            direction: SshForwardDirection::Remote,
            ..request("desktop", "user@desktop", 11434)
        })
        .unwrap();
    let waiting = tokio::spawn({
        let forwards = forwards.clone();
        let id = record.id.clone();
        async move { forwards.wait_until_open(&id).await }
    });
    flush().await;
    process
        .control
        .emit_stderr("debug1: remote forward success for: listen 127.0.0.1:1143");
    process.control.emit_stderr("4, connect localhost:11434\n");
    let opened = waiting.await.unwrap().unwrap();
    assert_eq!(opened.state, SshForwardState::Open);
    assert!(remote_forward_succeeded(
        "remote forward success for: listen 9000, connect x",
        9000
    ));
    assert!(!remote_forward_succeeded(
        "remote forward success for: listen 9001, connect x",
        9000
    ));
}

// Local port availability.

#[test]
fn a_port_taken_on_ipv6_loopback_alone_is_not_free() {
    let Ok(server) = std::net::TcpListener::bind("[::1]:0") else {
        return; // No IPv6 loopback on this machine: nothing to collide with.
    };
    let port = server.local_addr().unwrap().port();
    // http://localhost:PORT would reach this listener, not the forward.
    assert!(!default_port_is_free(port));
}

#[test]
fn a_port_taken_on_ipv4_loopback_is_not_free() {
    let server = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    assert!(!default_port_is_free(server.local_addr().unwrap().port()));
}

#[tokio::test(start_paused = true)]
async fn a_spawn_failure_is_failed_immediately_and_does_not_retain_a_live_slot() {
    let forwards = SshForwards::new(
        clock(),
        ForwardDeps {
            spawn: Arc::new(|_| Err("spawn ssh ENOENT".into())),
            is_port_free: Arc::new(|_| true),
            ..ForwardDeps::default()
        },
    );
    let record = forwards.open(request("ssh", "user@host", 3000)).unwrap();
    assert_eq!(record.state, SshForwardState::Failed);
    let settled = forwards.wait_until_open(&record.id).await.unwrap();
    assert!(settled.error.unwrap().contains("ENOENT"));
    let retry = forwards.open(request("ssh", "user@host", 3000)).unwrap();
    assert_eq!(retry.state, SshForwardState::Failed);
    forwards.close_all();
}

#[test]
fn records_go_on_the_wire_in_snake_case() {
    let record = SshForwardRecord {
        id: "c:local:3000".into(),
        connection_id: "c".into(),
        direction: SshForwardDirection::Local,
        remote_port: 3000,
        local_port: 3001,
        label: None,
        state: SshForwardState::Open,
        error: None,
        attempt: 4,
    };
    assert_eq!(
        serde_json::to_value(forward_to_wire(&record)).unwrap(),
        serde_json::json!({
            "id": "c:local:3000",
            "connection_id": "c",
            "direction": "local",
            "remote_port": 3000,
            "local_port": 3001,
            "state": "open"
        })
    );
}
