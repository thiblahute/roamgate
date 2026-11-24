//! The default server path over a real socket: `roamgate [server flags]`
//! runs the front with its standalone core and serves the web build the
//! binary carries; `--help` and `--version` are the server's flags.
#![cfg(unix)]
// Waits on real time for a child process.
#![allow(clippy::disallowed_methods)]

use std::process::Stdio;
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

async fn get(address: &str, path: &str) -> (u16, String, String) {
    let mut stream = tokio::net::TcpStream::connect(address).await.unwrap();
    // A page navigation asks for HTML; a file does not.
    let accept = if path.contains('.') {
        "*/*"
    } else {
        "text/html"
    };
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: localhost\r\nAccept: {accept}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await.unwrap();
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await.unwrap();
    let response = String::from_utf8_lossy(&response).into_owned();
    let (head, body) = response.split_once("\r\n\r\n").unwrap();
    let status = head.split(' ').nth(1).unwrap().parse().unwrap();
    (status, head.to_ascii_lowercase(), body.to_owned())
}

/// The binary with an environment of its own under `home`.
fn roamgate(home: &std::path::Path) -> tokio::process::Command {
    let mut command = tokio::process::Command::new(env!("CARGO_BIN_EXE_roamgate"));
    command
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("XDG_CONFIG_HOME", home.join(".config"))
        .env("XDG_DATA_HOME", home.join(".local/share"))
        .env("XDG_CACHE_HOME", home.join(".cache"))
        .env("XDG_RUNTIME_DIR", home.join("runtime"))
        .env("TMPDIR", home)
        .env("HERDR_SOCKET_PATH", home.join("no-herdr.sock"))
        .env(
            "HERDR_CLIENT_SOCKET_PATH",
            home.join("no-herdr-client.sock"),
        )
        .env("ROAMGATE_DISABLE_UPDATE_CHECK", "1")
        .current_dir(home)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    command
}

#[tokio::test]
async fn help_and_version_are_the_server_s_flags() {
    let home = tempfile::tempdir().unwrap();
    let output = roamgate(home.path()).arg("--help").output().await.unwrap();
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        include_str!("../../../contract/cli/help/roamgate.txt")
    );
    let output = roamgate(home.path()).arg("-V").output().await.unwrap();
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!("roamgate {}\n", roamgate::VERSION)
    );
    let output = roamgate(home.path()).arg("--nope").output().await.unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        "[bridge] Unknown option '--nope'\nRun `roamgate --help` for usage.\n"
    );
}

#[tokio::test]
async fn serves_healthz_and_the_web_app_it_carries() {
    let home = tempfile::tempdir().unwrap();
    // No login on the loopback in development: `/` is the web app.
    let mut server = roamgate(home.path())
        .args(["--host", "127.0.0.1", "--port", "0"])
        .env("NODE_ENV", "development")
        .env("ROAMGATE_LOG_LEVEL", "info")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut lines = BufReader::new(server.stdout.take().unwrap()).lines();
    let address = tokio::time::timeout(Duration::from_secs(60), async {
        while let Some(line) = lines.next_line().await.unwrap() {
            if let Some(url) = line.split("url=http://").nth(1) {
                let port = url.split_whitespace().next().unwrap().rsplit(':').next();
                return format!("127.0.0.1:{}", port.unwrap());
            }
        }
        panic!("the server ended before it listened");
    })
    .await
    .expect("the server listens");
    tokio::spawn(async move { while let Ok(Some(_)) = lines.next_line().await {} });

    let (status, head, body) = get(&address, "/healthz").await;
    assert_eq!(status, 200);
    assert!(head.contains("content-type: text/plain; charset=utf-8"));
    assert_eq!(body, "Ok");
    assert_eq!(get(&address, "/missing.js").await.0, 404);

    let (status, head, body) = get(&address, "/").await;
    if (roamgate::embedded_web().0)("index.html").is_some() {
        assert_eq!(status, 200);
        assert!(head.contains("content-type: text/html"));
        assert!(body.contains("<title>Roamgate</title>"), "{body}");
        // An app route gets the app.
        assert_eq!(get(&address, "/settings/profiles").await.2, body);
    } else {
        // No web build yet (a fresh checkout): nothing but the manifest.
        assert_eq!(status, 404);
        assert_eq!(get(&address, "/manifest.json").await.0, 200);
    }
    server.start_kill().unwrap();
    let _ = server.wait().await;
}
