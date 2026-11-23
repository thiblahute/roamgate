//! `roamgate core`, the process the Bun server spawns: it connects to the
//! channel it is given, says hello, and exits when the channel closes.
#![cfg(unix)]
// Waits on real time for a child process.
#![allow(clippy::disallowed_methods)]

use std::collections::BTreeMap;
use std::process::Stdio;
use std::time::Duration;

use roamgate_sidecar::peer::{HandshakeError, accept_hello};
use roamgate_sidecar::protocol::{Message, PROTOCOL, ShadowSettings, Side};
use roamgate_sidecar::transport::Listener;

const TOKEN: &str = "abababababababababababababababababababababababababababababababab";

fn core(path: Option<&std::path::Path>, token: &str) -> tokio::process::Child {
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_roamgate"));
    command
        .arg("core")
        .env_clear()
        .env("ROAMGATE_LOG_LEVEL", "error")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(path) = path {
        command
            .env("ROAMGATE_CORE_CHANNEL", path)
            .env("ROAMGATE_CORE_TOKEN", token);
    }
    command.spawn().unwrap()
}

async fn exit_code(child: tokio::process::Child) -> i32 {
    let output = tokio::time::timeout(Duration::from_secs(20), child.wait_with_output())
        .await
        .expect("the core exits")
        .unwrap();
    output.status.code().unwrap()
}

#[tokio::test]
async fn says_hello_and_exits_when_the_channel_closes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sock");
    let mut listener = Listener::bind(path.to_str().unwrap()).unwrap();
    let child = core(Some(&path), TOKEN);
    let mut stream = listener.accept().await.unwrap();
    let hello = accept_hello(&mut stream, TOKEN, |_| Message::Welcome {
        protocol: PROTOCOL,
        side: Side::Bun,
        owners: BTreeMap::new(),
        shadow: ShadowSettings::default(),
    })
    .await
    .unwrap();
    let Message::Hello {
        protocol,
        side,
        version,
        pid,
        families,
        test,
        ..
    } = hello
    else {
        panic!("{hello:?}");
    };
    assert_eq!((protocol, side), (PROTOCOL, Side::Rust));
    assert_eq!(version, roamgate::VERSION);
    assert_eq!(Some(pid), child.id());
    // No family moves in S11, and the test family needs its variable.
    assert!(families.is_empty());
    assert!(!test);
    drop(stream);
    assert_eq!(exit_code(child).await, 0);
}

#[tokio::test]
async fn a_refused_core_exits_3_and_one_without_a_channel_2() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("core.sock");
    let mut listener = Listener::bind(path.to_str().unwrap()).unwrap();
    let child = core(Some(&path), "wrong");
    let mut stream = listener.accept().await.unwrap();
    let refused = accept_hello(&mut stream, TOKEN, |_| unreachable!()).await;
    assert!(matches!(refused, Err(HandshakeError::Refused(_))));
    assert_eq!(exit_code(child).await, 3);

    assert_eq!(exit_code(core(None, "")).await, 2);
    let gone = dir.path().join("nobody.sock");
    assert_eq!(exit_code(core(Some(&gone), TOKEN)).await, 1);
}
