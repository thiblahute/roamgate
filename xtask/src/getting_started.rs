//! The getting-started proof of a packaged target, on its own platform:
//! the documented install line of site/install.json, run as it is shown
//! (`curl ... | sh`, or `irm ... | iex` in Windows PowerShell) with its
//! base a loopback mirror of this run's package and the installers
//! (`ROAMGATE_RELEASE_BASE_URL` pointing there too), in a sandbox; then
//! the documented start (`roamgate`, on its default port) and login (the
//! link `roamgate url` prints, opened as a browser does).

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde::Deserialize;

use crate::sandbox::{Container, Sandbox, TempDir, request, wait_healthy};
use crate::targets::Target;

/// site/install.json: the lines README.md, docs/DEPLOYMENT.md and the site
/// show (scripts/install-lines.test.ts holds them equal).
#[derive(Debug, Deserialize)]
pub struct Lines {
    pub variable: String,
    pub unix: String,
    pub windows: String,
    pub start: String,
    pub url: String,
}

impl Lines {
    pub fn load(root: &Path) -> Result<Self> {
        let path = root.join("site/install.json");
        let text = std::fs::read_to_string(&path).with_context(|| path.display().to_string())?;
        Ok(serde_json::from_str(&text)?)
    }

    /// The install line of `target`'s system, from `base`.
    pub fn install(&self, target: &Target, base: &str) -> String {
        let line = if target.os == "win32" {
            &self.windows
        } else {
            &self.unix
        };
        line.replace("{base}", base)
    }
}

/// The port `roamgate` serves on without options, which the printed login
/// link names.
const DEFAULT_PORT: u16 = 8787;

pub struct GettingStarted<'a> {
    /// The directory holding the target's package (target/dist).
    pub dist: &'a Path,
    pub target: &'a Target,
    pub version: &'a str,
    pub exec_prefix: Vec<String>,
    pub keep: Option<PathBuf>,
}

/// Where the installer puts `roamgate` under the sandbox's home.
fn installed(sandbox: &Sandbox, target: &Target) -> PathBuf {
    if target.os == "win32" {
        sandbox
            .home
            .join("AppData/Local/Programs/roamgate")
            .join(&target.binary)
    } else {
        sandbox.home.join(".local/bin").join(&target.binary)
    }
}

pub fn run(proof: &GettingStarted) -> Result<()> {
    let target = proof.target;
    let root = crate::repo_root();
    let lines = Lines::load(&root)?;
    let (_temp, dir) = TempDir::or_keep("getting-started", proof.keep.as_deref())?;

    // The mirror: the latest archive and its checksum, as a release holds
    // them, and the installers.
    let mirror = dir.join("mirror");
    std::fs::create_dir_all(&mirror)?;
    let archive = target.latest_archive();
    for name in [archive.clone(), format!("{archive}.sha256")] {
        std::fs::copy(proof.dist.join(&name), mirror.join(&name))
            .with_context(|| format!("{} in {}", name, proof.dist.display()))?;
    }
    for name in ["install-roamgate.sh", "install-roamgate.ps1"] {
        std::fs::copy(root.join("scripts").join(name), mirror.join(name))?;
    }
    let (address, asked) = crate::proof::mirror(mirror)?;
    let base = format!("http://{address}");

    let sandbox = Sandbox::new(
        &dir,
        proof.exec_prefix.clone(),
        &[(lines.variable.as_str(), base.clone())],
    )?;
    let line = lines.install(target, &base);
    eprintln!("xtask: getting started: $ {line}");
    let (program, args): (PathBuf, Vec<&str>) = if target.os == "win32" {
        let system_root = std::env::var("SystemRoot").unwrap_or_else(|_| r"C:\Windows".into());
        (
            PathBuf::from(system_root).join(r"System32\WindowsPowerShell\v1.0\powershell.exe"),
            vec![
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                &line,
            ],
        )
    } else {
        (PathBuf::from("sh"), vec!["-c", &line])
    };
    let output = sandbox.run(&program, &args)?;
    ensure!(
        output.status.success(),
        "the install line failed ({}); the mirror was asked {:?}",
        output.status,
        asked.lock().expect("mirror log")
    );
    let bin = installed(&sandbox, target);
    ensure!(
        sandbox.version(&bin)? == proof.version,
        "{} is not roamgate {}",
        bin.display(),
        proof.version
    );
    eprintln!("xtask: getting started: installed {}", bin.display());

    // `roamgate`, as documented: no options, the default port, which must
    // be free (another Roamgate there would answer for this one).
    ensure!(
        std::net::TcpListener::bind(("127.0.0.1", DEFAULT_PORT)).is_ok(),
        "port {DEFAULT_PORT} is taken: the documented `roamgate` serves there"
    );
    let mut server = sandbox.start(&bin, &[], &[])?;
    let served: SocketAddr = ([127, 0, 0, 1], DEFAULT_PORT).into();
    wait_healthy(&mut server, served)?;
    eprintln!("xtask: getting started: `{}` serves", lines.start);

    // `roamgate url`: its local link, opened as a browser does.
    let mut url_args: Vec<&str> = lines.url.split_whitespace().skip(1).collect();
    url_args.push("--json");
    let printed = sandbox.run(&bin, &url_args)?;
    ensure!(printed.status.success(), "`{}` failed", lines.url);
    let json: serde_json::Value = serde_json::from_slice(&printed.stdout)?;
    let link = json["local"]
        .as_str()
        .context("`roamgate url` printed no local link")?
        .to_owned();
    let path = link
        .strip_prefix(&format!("http://localhost:{DEFAULT_PORT}"))
        .with_context(|| format!("the login link {link} is not this server's"))?;
    ensure!(
        path.starts_with("/?token="),
        "the login link {link} has no token"
    );
    let opened = request(served, "GET", path, &[("Accept", "text/html")], &[])?;
    ensure!(
        opened.status == 303 && opened.header("location") == Some("/"),
        "opening the login link answered {} {:?}",
        opened.status,
        opened.header("location")
    );
    let cookie = opened
        .header("set-cookie")
        .and_then(|cookie| cookie.split(';').next())
        .context("opening the login link logged nobody in")?
        .to_owned();
    let app = request(
        served,
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
    drop(server);
    eprintln!(
        "xtask: getting started on {}: the documented line installed roamgate {}, `{}` served, and its `{}` link logged in",
        target.platform, proof.version, lines.start, lines.url
    );
    Ok(())
}

/// [`run`] in a container of `image`: the line runs there.
pub fn run_in_container(proof: &GettingStarted, image: &str) -> Result<()> {
    let container = Container::start(image)?;
    run(&GettingStarted {
        dist: proof.dist,
        target: proof.target,
        version: proof.version,
        exec_prefix: container.prefix(),
        keep: Some(container.shared.join("run")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_lines_render_for_each_system() {
        let root = crate::repo_root();
        let lines = Lines::load(&root).unwrap();
        let targets = crate::targets::load(&root).unwrap();
        for target in &targets {
            let line = lines.install(target, "http://127.0.0.1:9");
            if target.os == "win32" {
                assert_eq!(line, "irm http://127.0.0.1:9/install-roamgate.ps1 | iex");
            } else {
                assert_eq!(
                    line,
                    "curl -fsSL http://127.0.0.1:9/install-roamgate.sh | sh"
                );
            }
        }
        assert_eq!(lines.variable, "ROAMGATE_RELEASE_BASE_URL");
    }
}
