//! The update proof: a roamgate of an earlier build (a Bun-built one, or a
//! published release), installed in a sandbox (its own HOME, XDG
//! directories and TMPDIR, no service, no user bus), updates itself with
//! `roamgate update` from a loopback mirror of a packaged target; the
//! package's Pi sidecar `roamgate-pi` lands beside it (the new binary's
//! `roamgate update` adds it when the old updater left it out), the
//! installed binary serves its embedded web app, and `roamgate rollback`
//! swaps both back.
//!
//! `--exec-prefix` runs every sandbox command through a prefix, such as an
//! arm64 container sharing the network and the sandbox's path: the proof of
//! a target this machine runs only under emulation.

use std::io::{BufRead, BufReader, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use anyhow::{Context, Result, ensure};

use crate::sandbox::{Sandbox, TempDir, free_port, get, wait_healthy};
use crate::targets::Target;

pub struct Proof<'a> {
    /// The earlier roamgate the sandbox starts from.
    pub from: &'a Path,
    /// The directory holding the target's package.
    pub dist: &'a Path,
    pub target: &'a Target,
    pub version: &'a str,
    /// The web app the package embeds.
    pub web: &'a Path,
    pub exec_prefix: Vec<String>,
    /// Keep the sandbox in this directory.
    pub keep: Option<PathBuf>,
}

/// A loopback HTTP server for the files of one directory; it records the
/// paths asked for.
pub fn mirror(dir: PathBuf) -> Result<(SocketAddr, Arc<Mutex<Vec<String>>>)> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let address = listener.local_addr()?;
    let asked = Arc::new(Mutex::new(Vec::new()));
    let log = asked.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let _ = answer(stream, &dir, &log);
        }
    });
    Ok((address, asked))
}

fn answer(mut stream: TcpStream, dir: &Path, log: &Mutex<Vec<String>>) -> Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut line = String::new();
    reader.read_line(&mut line)?;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header == "\r\n" {
            break;
        }
    }
    let mut parts = line.split_whitespace();
    let (method, path) = (
        parts.next().unwrap_or_default(),
        parts.next().unwrap_or_default(),
    );
    log.lock()
        .expect("mirror log")
        .push(format!("{method} {path}"));
    let name = path.trim_start_matches('/');
    let file =
        (method == "GET" && !name.is_empty() && !name.contains('/') && !name.starts_with('.'))
            .then(|| std::fs::read(dir.join(name)).ok())
            .flatten();
    match file {
        Some(body) => {
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nContent-Type: application/octet-stream\r\nConnection: close\r\n\r\n",
                body.len()
            )?;
            stream.write_all(&body)?;
        }
        None => stream.write_all(
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
        )?,
    }
    Ok(())
}

pub fn run(proof: &Proof) -> Result<()> {
    let target = proof.target;
    ensure!(
        target.update,
        "roamgate update does not install {}",
        target.platform
    );
    let (_temp, root) = TempDir::or_keep("update-proof", proof.keep.as_deref())?;
    let mirror_dir = root.join("mirror");
    std::fs::create_dir_all(&mirror_dir)?;
    for name in [target.manifest_name(), target.latest_archive()] {
        std::fs::copy(proof.dist.join(&name), mirror_dir.join(&name))
            .with_context(|| format!("{name} in {}", proof.dist.display()))?;
    }
    let (mirror_address, asked) = mirror(mirror_dir)?;
    let sandbox = Sandbox::new(
        &root,
        proof.exec_prefix.clone(),
        &[(
            "ROAMGATE_UPDATE_BASE_URL",
            format!("http://{mirror_address}"),
        )],
    )?;
    let bin_dir = sandbox.home.join(".local").join("bin");
    std::fs::create_dir_all(&bin_dir)?;
    // roamgate.exe and roamgate-pi.exe on Windows, each with its
    // `<name>.previous` beside it.
    let bin = bin_dir.join(&target.binary);
    std::fs::copy(proof.from, &bin).with_context(|| proof.from.display().to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755))?;
    }

    let old = sandbox.version(&bin)?;
    ensure!(old != proof.version, "the sandbox already runs {old}");

    let check = sandbox.run(&bin, &["update", "--check", "--json"])?;
    ensure!(check.status.success(), "roamgate update --check failed");
    let report: serde_json::Value =
        serde_json::from_slice(&check.stdout).context("update --check --json")?;
    ensure!(
        report["update_available"] == true
            && report["latest_version"] == proof.version
            && report["current_version"] == old.as_str()
            && report["platform"] == target.platform.as_str(),
        "update --check reported {report}"
    );

    let update = sandbox.run(&bin, &["update"])?;
    ensure!(update.status.success(), "roamgate update failed");
    let said = String::from_utf8_lossy(&update.stdout);
    ensure!(
        said.contains(&format!(
            "Installed roamgate {} at {}",
            proof.version,
            bin.display()
        )),
        "roamgate update said {said:?}"
    );
    let asked = asked.lock().expect("mirror log").clone();
    for name in [target.manifest_name(), target.latest_archive()] {
        ensure!(
            asked.contains(&format!("GET /{name}")),
            "the updater never fetched {name}: {asked:?}"
        );
    }

    ensure!(
        sandbox.version(&bin)? == proof.version,
        "the update did not install {}",
        proof.version
    );
    let previous = bin.with_file_name(format!("{}.previous", target.binary));
    ensure!(
        sandbox.version(&previous)? == old,
        "roamgate.previous is not {old}"
    );

    // The package's roamgate-pi beside the binary. An updater before the
    // Rust build extracts roamgate only: the new binary's `roamgate update`
    // then adds roamgate-pi and keeps roamgate.previous.
    let archive = std::fs::read(proof.dist.join(target.latest_archive()))?;
    let pi_member = format!("{}/{}", target.package_dir(), target.pi_binary());
    let pi_bytes = crate::package::read_archive(&archive)?
        .into_iter()
        .find(|entry| entry.path == pi_member)
        .map(|entry| entry.data)
        .with_context(|| format!("the package has no {pi_member}"))?;
    let pi = bin.with_file_name(target.pi_binary());
    let pi_previous = bin.with_file_name(format!("{}.previous", target.pi_binary()));
    if !pi.exists() {
        eprintln!("xtask: the {old} updater left roamgate-pi out; updating again adds it");
        let again = sandbox.run(&bin, &["update"])?;
        let said = String::from_utf8_lossy(&again.stdout);
        ensure!(
            again.status.success()
                && said.contains(&format!(
                    "Installed roamgate-pi {} at {}",
                    proof.version,
                    pi.display()
                )),
            "the second roamgate update said {said:?}"
        );
        ensure!(
            sandbox.version(&previous)? == old,
            "adding roamgate-pi replaced roamgate.previous"
        );
    }
    ensure!(
        std::fs::read(&pi).ok() == Some(pi_bytes.clone()),
        "roamgate-pi beside the binary is not the package's"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&pi)?.permissions().mode() & 0o777;
        ensure!(mode == 0o755, "roamgate-pi has mode {mode:o}");
    }
    ensure!(
        !pi_previous.exists(),
        "roamgate-pi.previous exists though {old} had no roamgate-pi"
    );
    let port = free_port()?;
    // No login on the loopback in development: the web app answers `/`
    // instead of the login page. No Herdr either: the server serves all the
    // same.
    let mut server = sandbox.serve(&bin, port, &[("NODE_ENV", "development")])?;
    let address: SocketAddr = ([127, 0, 0, 1], port).into();
    wait_healthy(&mut server, address)?;
    // The entry document is served named after the instance: the build's
    // own, known by its module script.
    let index = std::fs::read_to_string(proof.web.join("index.html"))?;
    let script = entry_script(&index).context("the web app's index.html has no module script")?;
    let (status, body) = get(address, "/")?;
    ensure!(
        status == 200 && String::from_utf8_lossy(&body).contains(script),
        "/ is not the embedded web app (status {status})"
    );
    let (status, body) = get(address, "/settings")?;
    ensure!(
        status == 200 && String::from_utf8_lossy(&body).contains(script),
        "an app route is not the web app (status {status})"
    );
    let (status, body) = get(address, script)?;
    ensure!(
        status == 200 && !body.is_empty(),
        "{script} is not served (status {status})"
    );
    drop(server);

    // Rollback swaps the pair: {old} again, with no roamgate-pi, and the
    // package's roamgate-pi kept as roamgate-pi.previous.
    let rollback = sandbox.run(&bin, &["rollback"])?;
    ensure!(rollback.status.success(), "roamgate rollback failed");
    ensure!(
        sandbox.version(&bin)? == old,
        "roamgate rollback did not restore {old}"
    );
    ensure!(
        sandbox.version(&previous)? == proof.version,
        "roamgate rollback did not keep {} as roamgate.previous",
        proof.version
    );
    ensure!(
        !pi.exists() && std::fs::read(&pi_previous).ok() == Some(pi_bytes),
        "roamgate rollback did not move roamgate-pi to roamgate-pi.previous"
    );

    eprintln!(
        "xtask: update proof for {}: roamgate {old} updated itself to {} from {}, kept {old} as roamgate.previous, installed roamgate-pi beside it, served the web app, and rolled both back",
        target.platform, proof.version, mirror_address
    );
    Ok(())
}

/// The path of the entry document's first `/assets/` script.
fn entry_script(index: &str) -> Option<&str> {
    let start = index.find("src=\"/assets/")? + "src=\"".len();
    let length = index[start..].find('"')?;
    Some(&index[start..start + length])
}

/// Writes the roamgate binary of `archive` (a package of `target`, of any
/// version) into `dir`; returns it.
pub fn binary_of(archive: &Path, target: &Target, dir: &Path) -> Result<PathBuf> {
    let bytes = std::fs::read(archive).with_context(|| archive.display().to_string())?;
    let member = format!("{}/{}", target.package_dir(), target.binary);
    let data = crate::package::read_archive(&bytes)?
        .into_iter()
        .find(|entry| entry.path == member)
        .map(|entry| entry.data)
        .with_context(|| format!("{} has no {member}", archive.display()))?;
    let path = dir.join(&target.binary);
    std::fs::write(&path, data)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755))?;
    }
    Ok(path)
}
