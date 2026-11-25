//! `cargo xtask`: builds, packages and checks Roamgate's release targets
//! (targets.toml).

mod binary;
mod compile;
mod notices;
mod package;
mod proof;
mod sandbox;
mod smoke;
mod targets;
mod verify;

use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use anyhow::{Context, Result, bail};

use crate::targets::Builder;

const USAGE: &str = "Usage: cargo xtask <command> [options]

Commands:
  targets [--json]                    list the release targets of targets.toml
                                      (--json: CI's build matrix)
  web                                 build the web app (bun run build:web)
  build <platform...|all>             build roamgate for targets
  package <platform...|all>           build, package and verify targets
                                      (needs cargo-about, notices.rs)
  verify <platform...|all>            check packaged targets
  update-proof <platform> --from <roamgate> | --archive <package>
               [--container]
                                      install a packaged target through an
                                      earlier roamgate's `roamgate update`
                                      in a sandbox (roamgate-pi beside it),
                                      serve with it, then roll back
  smoke <platform> [--archive <tar.xz>] [--container]
                                      run a packaged target on this machine
                                      in a sandbox: its roamgate-pi, then
                                      the server with a login, /healthz,
                                      the /ws hello and an agent-socket call
                                      (--container: in the target's
                                      container image of targets.toml)
  version [--next]                    print the workspace version (--next:
                                      the next patch, as a prerelease above
                                      the current one, for update proofs)

Options:
  --version <X.Y.Z[-pre]>  the version built and packaged (default: the
                           workspace's, Cargo.toml)
  --web <dir>              the web app embedded (default: server/public)
  --out <dir>              where packages go (default: target/dist)
  --builder <cargo|zigbuild|xwin>
                           override targets.toml's builder
  --archive <package>      smoke: the package (default: the versioned
                           archive in --out); update-proof: the package of
                           the earlier roamgate
  --container              smoke, update-proof: in the target's container
                           image (targets.toml)
  --exec-prefix <command>  update-proof, smoke: run the sandbox's commands
                           through this prefix (a container)
  --keep <dir>             update-proof, smoke: keep the sandbox in <dir>
";

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("xtask is in the repository")
        .to_path_buf()
}

/// `[workspace.package] version` of the root Cargo.toml.
pub fn workspace_version(root: &Path) -> Result<String> {
    let text = std::fs::read_to_string(root.join("Cargo.toml"))?;
    let manifest: toml::Value = toml::from_str(&text)?;
    manifest
        .get("workspace")
        .and_then(|w| w.get("package"))
        .and_then(|p| p.get("version"))
        .and_then(|v| v.as_str())
        .map(str::to_owned)
        .context("Cargo.toml has no [workspace.package] version")
}

/// A version above `version` and below its next release:
/// `X.Y.(Z+1)-update-proof`.
fn next_patch(version: &str) -> Result<String> {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let parts: Vec<u64> = core
        .split('.')
        .map(str::parse)
        .collect::<Result<_, _>>()
        .with_context(|| format!("bad version {version}"))?;
    let [major, minor, patch] = parts[..] else {
        bail!("bad version {version}");
    };
    Ok(format!("{major}.{minor}.{}-update-proof", patch + 1))
}

#[derive(Default)]
struct Args {
    command: String,
    names: Vec<String>,
    json: bool,
    next: bool,
    version: Option<String>,
    web: Option<PathBuf>,
    out: Option<PathBuf>,
    builder: Option<Builder>,
    from: Option<PathBuf>,
    archive: Option<PathBuf>,
    container: bool,
    exec_prefix: Vec<String>,
    keep: Option<PathBuf>,
}

fn parse(mut raw: impl Iterator<Item = String>) -> Result<Args> {
    let mut args = Args {
        command: raw.next().unwrap_or_default(),
        ..Args::default()
    };
    while let Some(arg) = raw.next() {
        let mut value = |name: &str| raw.next().with_context(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--json" => args.json = true,
            "--next" => args.next = true,
            "--version" => args.version = Some(value("--version")?),
            "--web" => args.web = Some(value("--web")?.into()),
            "--out" => args.out = Some(value("--out")?.into()),
            "--from" => args.from = Some(value("--from")?.into()),
            "--archive" => args.archive = Some(value("--archive")?.into()),
            "--container" => args.container = true,
            "--keep" => args.keep = Some(value("--keep")?.into()),
            "--exec-prefix" => {
                args.exec_prefix = value("--exec-prefix")?
                    .split_whitespace()
                    .map(str::to_owned)
                    .collect()
            }
            "--builder" => {
                args.builder = Some(match value("--builder")?.as_str() {
                    "cargo" => Builder::Cargo,
                    "zigbuild" => Builder::Zigbuild,
                    "xwin" => Builder::Xwin,
                    other => bail!("unknown builder {other}"),
                })
            }
            "-h" | "--help" => args.command = "help".into(),
            other if other.starts_with('-') => bail!("unknown option {other}"),
            _ => args.names.push(arg),
        }
    }
    Ok(args)
}

fn absolute(path: PathBuf) -> Result<PathBuf> {
    Ok(if path.is_absolute() {
        path
    } else {
        std::env::current_dir()?.join(path)
    })
}

fn run() -> Result<()> {
    let args = parse(std::env::args().skip(1))?;
    let root = repo_root();
    let all = targets::load(&root)?;
    let version = match &args.version {
        Some(version) => version.clone(),
        None => workspace_version(&root)?,
    };
    let web = absolute(
        args.web
            .clone()
            .unwrap_or_else(|| root.join("server/public")),
    )?;
    let out = absolute(
        args.out
            .clone()
            .unwrap_or_else(|| compile::target_dir(&root).join("dist")),
    )?;
    let build = compile::Build {
        root: &root,
        version: &version,
        web: &web,
        builder: args.builder,
    };
    match args.command.as_str() {
        "targets" => {
            if args.json {
                println!("{}", serde_json::to_string(&all)?);
            } else {
                for target in &all {
                    println!(
                        "{:16} {:28} {:?} on {}",
                        target.platform, target.triple, target.builder, target.runner
                    );
                }
            }
        }
        "version" if args.next => println!("{}", next_patch(&version)?),
        "version" => println!("{version}"),
        "web" => {
            let status = Command::new("bun")
                .args(["run", "build:web"])
                .current_dir(&root)
                .status()?;
            if !status.success() {
                bail!("bun run build:web failed: {status}");
            }
        }
        "build" => {
            for target in targets::select(&all, &args.names)? {
                let binary = compile::build(&build, &target)?;
                println!("{}", binary.display());
            }
        }
        "package" => {
            let selected = targets::select(&all, &args.names)?;
            for target in &selected {
                let binary = compile::build(&build, target)?;
                let pi = compile::build_pi(&root, target)?;
                let notices = notices::generate(
                    &root,
                    target,
                    &version,
                    &compile::pi_metafile(&pi),
                    &compile::target_dir(&root).join("xtask"),
                )?;
                package::write_package(&out, target, &binary, &pi, &notices, &version)?;
                verify::verify(&out, target, &version)?;
            }
            for target in &selected {
                for path in package::package_paths(&out, target, &version) {
                    println!("{}", path.display());
                }
            }
        }
        "verify" => {
            for target in targets::select(&all, &args.names)? {
                verify::verify(&out, &target, &version)?;
            }
        }
        "update-proof" => {
            let [name] = args.names.as_slice() else {
                bail!("update-proof takes one platform");
            };
            let target = targets::select(&all, std::slice::from_ref(name))?.remove(0);
            // The earlier roamgate: a binary, or the one in a package.
            let from_dir = sandbox::TempDir::new("update-proof-from")?;
            let from = match (&args.from, &args.archive) {
                (Some(from), None) => absolute(from.clone())?,
                (None, Some(archive)) => {
                    proof::binary_of(&absolute(archive.clone())?, &target, &from_dir.0)?
                }
                _ => bail!("update-proof needs --from <roamgate> or --archive <package>"),
            };
            verify::verify(&out, &target, &version)?;
            let container = match (&target.container, args.container) {
                (Some(image), true) => Some(sandbox::Container::start(image)?),
                (None, true) => bail!("{} has no container", target.platform),
                (_, false) => None,
            };
            let (exec_prefix, keep) = match &container {
                Some(container) => (container.prefix(), Some(container.shared.join("run"))),
                None => (
                    args.exec_prefix.clone(),
                    args.keep.clone().map(absolute).transpose()?,
                ),
            };
            proof::run(&proof::Proof {
                from: &from,
                dist: &out,
                target: &target,
                version: &version,
                web: &compile::check_web(&web)?,
                exec_prefix,
                keep,
            })?;
        }
        "smoke" => {
            let [name] = args.names.as_slice() else {
                bail!("smoke takes one platform");
            };
            let target = targets::select(&all, std::slice::from_ref(name))?.remove(0);
            let archive = absolute(
                args.archive
                    .clone()
                    .unwrap_or_else(|| out.join(target.versioned_archive(&version))),
            )?;
            let smoke = smoke::Smoke {
                archive: &archive,
                target: &target,
                version: &version,
                exec_prefix: args.exec_prefix.clone(),
                keep: args.keep.clone().map(absolute).transpose()?,
            };
            match (&target.container, args.container) {
                (Some(image), true) => smoke::run_in_container(&smoke, image)?,
                (None, true) => bail!("{} has no container", target.platform),
                (_, false) => smoke::run(&smoke)?,
            }
        }
        "help" | "" => print!("{USAGE}"),
        other => bail!("unknown command {other}\n\n{USAGE}"),
    }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("xtask: {error:#}");
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_version_is_package_json_s() {
        let root = repo_root();
        let package: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("package.json")).unwrap())
                .unwrap();
        assert_eq!(
            workspace_version(&root).unwrap(),
            package["version"].as_str().unwrap()
        );
    }

    #[test]
    fn next_patch_is_above() {
        assert_eq!(next_patch("0.8.15").unwrap(), "0.8.16-update-proof");
        assert_eq!(next_patch("1.0.0-rc.1").unwrap(), "1.0.1-update-proof");
        assert!(next_patch("1.0").is_err());
    }

    #[test]
    fn parses_options() {
        let args = parse(
            [
                "package",
                "linux-x64",
                "--version",
                "1.2.3-x",
                "--exec-prefix",
                "podman run --rm",
                "darwin-x64",
            ]
            .into_iter()
            .map(str::to_owned),
        )
        .unwrap();
        assert_eq!(args.command, "package");
        assert_eq!(args.names, ["linux-x64", "darwin-x64"]);
        assert_eq!(args.version.as_deref(), Some("1.2.3-x"));
        assert_eq!(args.exec_prefix, ["podman", "run", "--rm"]);
        assert!(parse(["build", "--nope"].into_iter().map(str::to_owned)).is_err());
        assert!(
            parse(
                ["build", "--builder", "make"]
                    .into_iter()
                    .map(str::to_owned)
            )
            .is_err()
        );
    }
}
