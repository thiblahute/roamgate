//! The smoke test of a packaged target on its own platform: the archive
//! extracted as a user does (on Windows with the system's
//! `C:\Windows\System32\tar.exe`), its VERSION and `--version`, the Pi
//! sidecar `roamgate-pi` answering `initialize`, `roamgate update`
//! refusing a target it does not serve, then the server started in
//! a sandbox with a login password: `/healthz`, the login page for a
//! stranger, a refused and an accepted login, the web app, the `/ws` hello,
//! and the review client's calls on the agent socket
//! (`~/.cache/roamgate/review.sock`, AF_UNIX on every platform).
//!
//! `--exec-prefix` runs the sandbox's commands through a prefix (an Alpine
//! container for the musl target); the checks run from here.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};

use crate::sandbox::{
    Response, Sandbox, TempDir, free_port, parse_response, request, wait_healthy,
};
use crate::targets::Target;

pub struct Smoke<'a> {
    pub archive: &'a Path,
    pub target: &'a Target,
    pub version: &'a str,
    pub exec_prefix: Vec<String>,
    pub keep: Option<PathBuf>,
}

const PASSWORD: &str = "smoke-test-password-0123456789";

pub fn run(smoke: &Smoke) -> Result<()> {
    let target = smoke.target;
    let (_temp, root) = TempDir::or_keep("smoke", smoke.keep.as_deref())?;
    let sandbox = Sandbox::new(
        &root,
        smoke.exec_prefix.clone(),
        &[("ROAMGATE_PASSWORD", PASSWORD.to_owned())],
    )?;
    let install = root.join("install");
    std::fs::create_dir_all(&install)?;
    extract(smoke.archive, &install)?;
    let dir = install.join(target.package_dir());
    let version_file = std::fs::read_to_string(dir.join("VERSION"))
        .with_context(|| format!("VERSION in {}", dir.display()))?;
    ensure!(
        version_file.trim() == format!("roamgate {} {}", smoke.version, target.platform),
        "VERSION is {version_file:?}"
    );
    let bin = dir.join(&target.binary);
    let pi = dir.join(target.pi_binary());
    ensure!(
        sandbox.version(&bin)? == smoke.version,
        "{} --version is not {}",
        target.binary,
        smoke.version
    );

    if !target.update {
        update_refused(&sandbox, &bin, target)?;
    }
    pi_initialize(&sandbox, &pi)?;

    let port = free_port()?;
    let mut server = sandbox.serve(&bin, port, &[])?;
    let address: SocketAddr = ([127, 0, 0, 1], port).into();
    wait_healthy(&mut server, address)?;
    eprintln!("xtask: smoke: /healthz answers Ok");

    let html = [("Accept", "text/html")];
    let stranger = request(address, "GET", "/", &html, &[])?;
    ensure!(
        (300..400).contains(&stranger.status) && stranger.header("location") == Some("/login"),
        "/ without a login answered {} {:?}",
        stranger.status,
        stranger.header("location")
    );
    let page = request(address, "GET", "/login", &html, &[])?;
    ensure!(
        page.status == 200 && page.text().contains("Roamgate login"),
        "/login answered {}",
        page.status
    );
    let json_type = [("Content-Type", "application/json")];
    let wrong = request(
        address,
        "POST",
        "/api/login",
        &json_type,
        json!({"password": "not-the-password"})
            .to_string()
            .as_bytes(),
    )?;
    ensure!(
        wrong.status == 401,
        "a wrong password answered {}",
        wrong.status
    );
    let login = request(
        address,
        "POST",
        "/api/login",
        &json_type,
        json!({"password": PASSWORD}).to_string().as_bytes(),
    )?;
    ensure!(login.status == 200, "the login answered {}", login.status);
    let cookie = login
        .header("set-cookie")
        .and_then(|value| value.split(';').next())
        .context("the login set no cookie")?
        .to_owned();
    eprintln!("xtask: smoke: the login page, a refused and an accepted login");

    let app = request(
        address,
        "GET",
        "/",
        &[("Accept", "text/html"), ("Cookie", &cookie)],
        &[],
    )?;
    ensure!(
        app.status == 200 && app.text().contains("<title>Roamgate</title>"),
        "/ after the login answered {}",
        app.status
    );

    let hello = ws_hello(address, &cookie)?;
    eprintln!("xtask: smoke: /ws said hello: {hello}");

    let listed = agent_call(&sandbox.home, &mut || server.running())?;
    eprintln!("xtask: smoke: the agent socket gave the skill, and for list: {listed}");

    drop(server);
    eprintln!(
        "xtask: smoke of {}: extracted {}, ran roamgate {} and roamgate-pi, served with a login, said hello on /ws and answered on the agent socket",
        target.platform,
        smoke.archive.display(),
        smoke.version
    );
    Ok(())
}

/// The packages a container image needs for the Pi sidecar: Bun's musl
/// build links libstdc++ and libgcc dynamically.
const ALPINE_PACKAGES: &[&str] = &["libstdc++", "libgcc"];

/// [`run`] with the sandbox's commands in a container of `image` (sharing
/// the network and the sandbox's path); the checks run from here.
pub fn run_in_container(smoke: &Smoke, image: &str) -> Result<()> {
    let engine = ["docker", "podman"]
        .into_iter()
        .find(|engine| {
            Command::new(engine)
                .arg("--version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .is_ok_and(|status| status.success())
        })
        .context("no docker or podman to run a container")?;
    let base = TempDir::new("smoke-container")?;
    let shared = crate::sandbox::dunce(base.0.clone());
    let name = format!("roamgate-smoke-{}", std::process::id());
    let volume = format!("{0}:{0}", shared.display());
    let status = Command::new(engine)
        .args(["run", "-d", "--rm", "--name", &name, "--network", "host"])
        .args(["-v", &volume, image, "sleep", "3600"])
        .status()
        .with_context(|| format!("running {engine}"))?;
    ensure!(status.success(), "starting a {image} container failed");
    struct Remove<'a>(&'a str, &'a str);
    impl Drop for Remove<'_> {
        fn drop(&mut self) {
            let _ = Command::new(self.0)
                .args(["rm", "-f", self.1])
                .stdout(Stdio::null())
                .status();
        }
    }
    let _remove = Remove(engine, &name);
    if image.starts_with("alpine") {
        let status = Command::new(engine)
            .args(["exec", &name, "apk", "add", "--no-cache"])
            .args(ALPINE_PACKAGES)
            .status()?;
        ensure!(status.success(), "apk add {ALPINE_PACKAGES:?} failed");
    }
    eprintln!("xtask: smoke: in a {image} container ({engine})");
    run(&Smoke {
        archive: smoke.archive,
        target: smoke.target,
        version: smoke.version,
        exec_prefix: vec![engine.to_owned(), "exec".into(), "-i".into(), name.clone()],
        keep: Some(shared.join("run")),
    })
}

/// Extracts `archive` (a `.tar.xz`, or a Windows `.zip`) into `dir` with
/// the system's tar: on Windows the one Windows ships, which users and
/// install-plugin.ps1 run (bsdtar: it reads zip archives too).
fn extract(archive: &Path, dir: &Path) -> Result<()> {
    let zip = archive.extension().is_some_and(|ext| ext == "zip");
    let (program, flags) = if cfg!(windows) {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        let tar = PathBuf::from(system_root).join(r"System32\tar.exe");
        (tar, if zip { "-xf" } else { "-xJf" })
    } else if zip {
        (PathBuf::from("unzip"), "-q")
    } else {
        (PathBuf::from("tar"), "-xJf")
    };
    let mut command = Command::new(&program);
    if zip && !cfg!(windows) {
        command.arg(flags).arg(archive).arg("-d").arg(dir);
    } else {
        command.arg(flags).arg(archive).arg("-C").arg(dir);
    }
    let output = command
        .output()
        .with_context(|| format!("running {}", program.display()))?;
    ensure!(
        output.status.success(),
        "{} {flags} {} failed: {}{}",
        program.display(),
        archive.display(),
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    eprintln!("xtask: smoke: {} extracted the archive", program.display());
    Ok(())
}

/// A target `roamgate update` does not serve: `roamgate update --check`
/// says so and fails, without a panic or a download.
fn update_refused(sandbox: &Sandbox, bin: &Path, target: &Target) -> Result<()> {
    let output = sandbox.run(bin, &["update", "--check"])?;
    let said = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    ensure!(
        !output.status.success()
            && said.contains("no update package for")
            && !said.contains("panicked"),
        "roamgate update --check on {} did not refuse cleanly: {said:?}",
        target.platform
    );
    eprintln!("xtask: smoke: roamgate update refuses {}", target.platform);
    Ok(())
}

/// Starts the Pi sidecar, asks `initialize` (contract/wire/pi-sidecar.md)
/// and checks it exits when its stdin closes.
fn pi_initialize(sandbox: &Sandbox, pi: &Path) -> Result<()> {
    let mut child = sandbox
        .command(pi, &[])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .with_context(|| format!("starting {}", pi.display()))?;
    let mut stdin = child.stdin.take().context("no stdin")?;
    let stdout = child.stdout.take().context("no stdout")?;
    let (lines, received) = mpsc::channel();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            if lines.send(line).is_err() {
                break;
            }
        }
    });
    writeln!(
        stdin,
        "{}",
        json!({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {"protocol": 1}})
    )?;
    stdin.flush()?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let reply = loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let line = match received.recv_timeout(left) {
            Ok(line) => line,
            Err(_) => {
                let _ = child.kill();
                bail!("roamgate-pi never answered initialize");
            }
        };
        // Stdout carries the wire only, but a line that is not a message is
        // skipped by the server too.
        if let Ok(value) = serde_json::from_str::<Value>(&line)
            && value["id"] == 1
        {
            break value;
        }
    };
    ensure!(
        reply["result"]["protocol"] == 1,
        "roamgate-pi answered initialize with {reply}"
    );
    drop(stdin);
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Some(status) = child.try_wait()? {
            eprintln!("xtask: smoke: roamgate-pi answered {reply} and exited ({status})");
            return Ok(());
        }
        if Instant::now() > deadline {
            let _ = child.kill();
            bail!("roamgate-pi did not exit when its stdin closed");
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Opens `/ws` with the login's cookie; the first JSON text message with
/// `hello: true`.
fn ws_hello(address: SocketAddr, cookie: &str) -> Result<Value> {
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(30)))?;
    write!(
        stream,
        "GET /ws HTTP/1.1\r\nHost: {address}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://{address}\r\nCookie: {cookie}\r\n\r\n"
    )?;
    // The handshake's head, byte by byte: frames follow it at once.
    let mut head = Vec::new();
    let mut byte = [0u8; 1];
    while !head.ends_with(b"\r\n\r\n") {
        stream
            .read_exact(&mut byte)
            .context("reading the /ws handshake")?;
        head.push(byte[0]);
        ensure!(head.len() < 64 * 1024, "the /ws handshake never ended");
    }
    let Response { status, head, .. } = parse_response(&head)?;
    ensure!(status == 101, "/ws answered {status}: {head}");
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut message = Vec::new();
    while Instant::now() < deadline {
        let mut header = [0u8; 2];
        stream.read_exact(&mut header)?;
        let fin = header[0] & 0x80 != 0;
        let opcode = header[0] & 0x0f;
        ensure!(header[1] & 0x80 == 0, "the server masked a frame");
        let length = match header[1] & 0x7f {
            126 => {
                let mut bytes = [0u8; 2];
                stream.read_exact(&mut bytes)?;
                u64::from(u16::from_be_bytes(bytes))
            }
            127 => {
                let mut bytes = [0u8; 8];
                stream.read_exact(&mut bytes)?;
                u64::from_be_bytes(bytes)
            }
            short => u64::from(short),
        };
        ensure!(length < 64 * 1024 * 1024, "a frame of {length} bytes");
        let mut payload = vec![0u8; usize::try_from(length)?];
        stream.read_exact(&mut payload)?;
        match opcode {
            // A text frame or its continuation.
            0x1 | 0x0 => {
                message.extend_from_slice(&payload);
                if !fin {
                    continue;
                }
                let text = String::from_utf8_lossy(&message).into_owned();
                message.clear();
                if let Ok(value) = serde_json::from_str::<Value>(&text)
                    && value["hello"] == true
                {
                    return Ok(value);
                }
            }
            0x8 => bail!("/ws closed before its hello: {payload:?}"),
            _ => {}
        }
    }
    bail!("no hello on /ws")
}

/// The review client's calls (contract/assets/python/roamgate-review.py)
/// over the agent socket its link names: `skill`, which needs no Herdr, and
/// `list`, which answers that no connection is ready (the sandbox has no
/// Herdr) as JSON.
fn agent_call(home: &Path, running: &mut dyn FnMut() -> bool) -> Result<Value> {
    let link = home.join(".cache/roamgate/review.sock");
    let deadline = Instant::now() + Duration::from_secs(60);
    while !link.exists() {
        ensure!(running(), "the server exited");
        ensure!(
            Instant::now() < deadline,
            "{} never appeared",
            link.display()
        );
        std::thread::sleep(Duration::from_millis(250));
    }
    let body = json!({
        "pane": "",
        "workspace": "",
        "herdr_socket": "",
        "cwd": home.to_string_lossy(),
        "agent": "smoke",
    });
    let skill = agent_request(&link, "skill", &body)?;
    ensure!(
        skill.status == 200,
        "skill on the agent socket answered {}: {}",
        skill.status,
        skill.text()
    );
    let skill: Value = serde_json::from_slice(&skill.body).context("the skill's answer")?;
    ensure!(
        skill["skill"]
            .as_str()
            .is_some_and(|text| text.contains("roamgate-review")),
        "skill answered {skill}"
    );
    let mut all = body.clone();
    all["all"] = json!("1");
    let list = agent_request(&link, "list", &all)?;
    let answer: Value = serde_json::from_slice(&list.body).context("the list's answer")?;
    ensure!(
        list.status == 503 && answer["error"] == "no local connection is ready",
        "list on the agent socket answered {}: {answer}",
        list.status
    );
    Ok(answer)
}

/// `POST /v1/<command>` with `body` over the agent socket at `link`.
fn agent_request(link: &Path, command: &str, body: &Value) -> Result<Response> {
    let body = body.to_string();
    let request = format!(
        "POST /v1/{command} HTTP/1.1\r\nHost: roamgate\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    parse_response(&unix_exchange(link, request.as_bytes())?)
}

/// Writes `request` on the AF_UNIX socket at `path` (Windows has them since
/// 10 1803), reads to the end.
fn unix_exchange(path: &Path, request: &[u8]) -> Result<Vec<u8>> {
    use socket2::{Domain, SockAddr, Socket, Type};
    let socket = Socket::new(Domain::UNIX, Type::STREAM, None)?;
    socket.set_read_timeout(Some(Duration::from_secs(30)))?;
    socket
        .connect(&SockAddr::unix(path)?)
        .with_context(|| format!("connecting to {}", path.display()))?;
    let mut socket = socket;
    socket.write_all(request)?;
    let mut response = Vec::new();
    socket.read_to_end(&mut response)?;
    Ok(response)
}
