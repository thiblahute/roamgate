//! THIRD_PARTY_LICENSES.md, shipped in every package beside the binaries:
//! the licences of what `roamgate` and `roamgate-pi` contain for the
//! target.
//!
//! - Roamgate's own LICENSE, THIRD_PARTY_NOTICES.md and the texts it points
//!   to in LICENSES/ (fonts and icons of the web app).
//! - The crates linked into `roamgate` for the target triple, from
//!   cargo-about (`cargo about generate --format json`, pinned in
//!   [`CARGO_ABOUT_VERSION`]; about.toml holds the accepted licences).
//! - Bun, the runtime inside `roamgate-pi`: LICENSES/BUN.md (Bun's notice
//!   at the pinned version) and the LGPL-2.1 of its JavaScriptCore.
//! - The npm packages bundled into `roamgate-pi` (Bun's metafile of the
//!   sidecar's build) and into the web app the binary embeds (the
//!   production dependencies of web/package.json, from node_modules).
//!
//! Every licence must be in about.toml's `accepted` list, else packaging
//! fails.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;

use crate::targets::Target;

/// The cargo-about packaging uses (.github/actions/rust-builder installs it).
pub const CARGO_ABOUT_VERSION: &str = "0.9.3";

/// The file name in the package.
pub const FILE: &str = "THIRD_PARTY_LICENSES.md";

/// about.toml's `accepted` licences.
pub fn accepted(root: &Path) -> Result<Vec<String>> {
    #[derive(Deserialize)]
    struct About {
        accepted: Vec<String>,
    }
    let path = root.join("about.toml");
    let text = std::fs::read_to_string(&path).with_context(|| path.display().to_string())?;
    let about: About = toml::from_str(&text).with_context(|| path.display().to_string())?;
    Ok(about.accepted)
}

// ---------------------------------------------------------------------------
// SPDX expressions

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    Open,
    Close,
    And,
    Or,
    With,
    Id(String),
}

fn tokens(expression: &str) -> Vec<Token> {
    let spaced = expression.replace('(', " ( ").replace(')', " ) ");
    spaced
        .split_whitespace()
        .map(|word| match word {
            "(" => Token::Open,
            ")" => Token::Close,
            _ if word.eq_ignore_ascii_case("and") => Token::And,
            _ if word.eq_ignore_ascii_case("or") => Token::Or,
            _ if word.eq_ignore_ascii_case("with") => Token::With,
            // "GPL-2.0+": the "or later" of an old identifier.
            _ => Token::Id(word.trim_end_matches('+').to_owned()),
        })
        .collect()
}

struct Parser<'a> {
    tokens: &'a [Token],
    at: usize,
    accepted: &'a [String],
}

impl Parser<'_> {
    fn next(&mut self) -> Option<&Token> {
        let token = self.tokens.get(self.at);
        self.at += 1;
        token
    }

    fn peek(&self) -> Option<&Token> {
        self.tokens.get(self.at)
    }

    fn is_accepted(&self, id: &str) -> bool {
        self.accepted
            .iter()
            .any(|accepted| accepted.eq_ignore_ascii_case(id))
    }

    /// `or := and ("OR" and)*`: one alternative accepted suffices.
    fn or(&mut self) -> Result<bool> {
        let mut ok = self.and()?;
        while self.peek() == Some(&Token::Or) {
            self.next();
            ok |= self.and()?;
        }
        Ok(ok)
    }

    /// `and := atom ("AND" atom)*`: every term must be accepted.
    fn and(&mut self) -> Result<bool> {
        let mut ok = self.atom()?;
        while self.peek() == Some(&Token::And) {
            self.next();
            ok &= self.atom()?;
        }
        Ok(ok)
    }

    /// `atom := "(" or ")" | id ("WITH" id)?`: an exception only adds
    /// permissions, so the licence alone accepted suffices.
    fn atom(&mut self) -> Result<bool> {
        match self.next().cloned() {
            Some(Token::Open) => {
                let ok = self.or()?;
                ensure!(self.next() == Some(&Token::Close), "unbalanced parentheses");
                Ok(ok)
            }
            Some(Token::Id(id)) => {
                if self.peek() == Some(&Token::With) {
                    self.next();
                    let Some(Token::Id(exception)) = self.next().cloned() else {
                        bail!("WITH needs an exception");
                    };
                    return Ok(self.is_accepted(&id)
                        || self.is_accepted(&format!("{id} WITH {exception}")));
                }
                Ok(self.is_accepted(&id))
            }
            other => bail!("unexpected {other:?}"),
        }
    }
}

/// Whether the SPDX `expression` is satisfied by the `accepted` licences.
pub fn satisfied(expression: &str, accepted: &[String]) -> Result<bool> {
    let tokens = tokens(expression);
    let mut parser = Parser {
        tokens: &tokens,
        at: 0,
        accepted,
    };
    let ok = parser
        .or()
        .with_context(|| format!("bad licence expression {expression:?}"))?;
    ensure!(
        parser.at == tokens.len(),
        "bad licence expression {expression:?}"
    );
    Ok(ok)
}

// ---------------------------------------------------------------------------
// Rust crates: cargo-about

#[derive(Debug, Deserialize)]
pub struct About {
    pub licenses: Vec<AboutLicense>,
    pub crates: Vec<AboutCrate>,
}

#[derive(Debug, Deserialize)]
pub struct AboutLicense {
    pub name: String,
    pub id: String,
    pub text: String,
    pub used_by: Vec<AboutUse>,
}

#[derive(Debug, Deserialize)]
pub struct AboutUse {
    #[serde(rename = "crate")]
    pub krate: AboutPackage,
}

#[derive(Debug, Deserialize)]
pub struct AboutCrate {
    pub package: AboutPackage,
    pub license: String,
}

#[derive(Debug, Deserialize)]
pub struct AboutPackage {
    pub name: String,
    pub version: String,
    /// None for the workspace's own crates.
    pub source: Option<String>,
}

/// The cargo-about command line listing `target`'s crates.
pub fn cargo_about_command(root: &Path, target: &Target, out: &Path) -> Command {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let mut command = Command::new(cargo);
    command
        .args([
            "about", "generate", "--format", "json", "--fail", "--frozen",
        ])
        .args(["--target", &target.triple])
        .arg("--manifest-path")
        .arg(root.join("crates/roamgate/Cargo.toml"))
        .arg("--config")
        .arg(root.join("about.toml"))
        .arg("--output-file")
        .arg(out)
        // Its own target directory: `cargo xtask` (cargo run) holds the
        // workspace's for as long as it runs, and cargo-about's cargo
        // would wait for it.
        .env(
            "CARGO_TARGET_DIR",
            out.parent().unwrap_or(root).join("about-target"),
        )
        .current_dir(root);
    command
}

/// The crates linked into `roamgate` for `target`.
pub fn cargo_about(root: &Path, target: &Target, scratch: &Path) -> Result<About> {
    let cargo = std::env::var_os("CARGO").unwrap_or_else(|| "cargo".into());
    let version = Command::new(&cargo).args(["about", "--version"]).output();
    let found = version
        .as_ref()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_owned());
    if found.as_deref() != Some(&format!("cargo-about {CARGO_ABOUT_VERSION}")) {
        bail!(
            "packaging needs cargo-about {CARGO_ABOUT_VERSION} (found {}): cargo install --locked --features cli cargo-about@{CARGO_ABOUT_VERSION}",
            found.as_deref().unwrap_or("none")
        );
    }
    // --frozen reads the sources only: every package of the lockfile is
    // fetched first, for whichever target.
    let status = Command::new(&cargo)
        .args(["fetch", "--locked"])
        .current_dir(root)
        .status()
        .context("running cargo fetch")?;
    ensure!(status.success(), "cargo fetch failed: {status}");
    std::fs::create_dir_all(scratch)?;
    let out = scratch.join(format!("about-{}.json", target.platform));
    let mut command = cargo_about_command(root, target, &out);
    eprintln!(
        "xtask: listing the licences of {} ({command:?})",
        target.platform
    );
    let status = command.status().context("running cargo about")?;
    ensure!(
        status.success(),
        "cargo about failed for {} ({status}): a licence outside about.toml's accepted list, or a crate without one",
        target.platform
    );
    let text = std::fs::read_to_string(&out).with_context(|| out.display().to_string())?;
    let _ = std::fs::remove_file(&out);
    Ok(serde_json::from_str(&text)?)
}

// ---------------------------------------------------------------------------
// npm packages

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NpmPackage {
    pub name: String,
    pub version: String,
    pub license: String,
    /// The licence and notice files it ships: name and text.
    pub files: Vec<(String, String)>,
}

#[derive(Deserialize)]
struct NpmClarify {
    clarify: BTreeMap<String, String>,
}

/// xtask/npm-licenses.toml: the licence of packages that name none.
pub fn npm_clarifications(root: &Path) -> Result<BTreeMap<String, String>> {
    let path = root.join("xtask/npm-licenses.toml");
    let text = std::fs::read_to_string(&path).with_context(|| path.display().to_string())?;
    Ok(toml::from_str::<NpmClarify>(&text)
        .with_context(|| path.display().to_string())?
        .clarify)
}

fn manifest(dir: &Path) -> Result<serde_json::Value> {
    let path = dir.join("package.json");
    let text = std::fs::read_to_string(&path).with_context(|| path.display().to_string())?;
    serde_json::from_str(&text).with_context(|| path.display().to_string())
}

/// The licence a package.json declares: `license` (a string, or the old
/// `{type}`), else the old `licenses` list (alternatives).
fn declared_license(manifest: &serde_json::Value) -> Option<String> {
    let kind = |value: &serde_json::Value| -> Option<String> {
        value
            .as_str()
            .or_else(|| value.get("type").and_then(|kind| kind.as_str()))
            .map(str::to_owned)
    };
    if let Some(license) = manifest.get("license").and_then(kind) {
        return Some(license);
    }
    let list: Vec<String> = manifest
        .get("licenses")?
        .as_array()?
        .iter()
        .filter_map(kind)
        .collect();
    (!list.is_empty()).then(|| list.join(" OR "))
}

fn is_license_file(name: &str) -> bool {
    let upper = name.to_ascii_uppercase();
    ["LICENSE", "LICENCE", "COPYING", "NOTICE"]
        .iter()
        .any(|prefix| upper.starts_with(prefix))
}

/// The package in `dir`.
pub fn npm_package(dir: &Path, clarify: &BTreeMap<String, String>) -> Result<NpmPackage> {
    let manifest = manifest(dir)?;
    let field = |name: &str| {
        manifest
            .get(name)
            .and_then(|value| value.as_str())
            .map(str::to_owned)
            .with_context(|| format!("{}: no {name}", dir.display()))
    };
    let name = field("name")?;
    let version = field("version")?;
    let license = clarify
        .get(&name)
        .cloned()
        .or_else(|| declared_license(&manifest))
        .with_context(|| {
            format!(
                "{name} {version} names no licence: read its licence file and add it to xtask/npm-licenses.toml"
            )
        })?;
    let mut names: Vec<String> = std::fs::read_dir(dir)?
        .flatten()
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| is_license_file(name))
        .collect();
    names.sort();
    let mut files = Vec::new();
    for file in names {
        let bytes = std::fs::read(dir.join(&file))?;
        files.push((file, String::from_utf8_lossy(&bytes).into_owned()));
    }
    Ok(NpmPackage {
        name,
        version,
        license,
        files,
    })
}

/// The package directory a module path lies in: the part up to its last
/// `node_modules/<name>` (or `node_modules/@scope/<name>`).
fn package_dir_of(module: &str) -> Option<String> {
    let module = module.replace('\\', "/");
    let at = module.rfind("node_modules/")?;
    let rest = &module[at + "node_modules/".len()..];
    let mut parts = rest.split('/');
    let first = parts.next()?;
    let name = if first.starts_with('@') {
        format!("{first}/{}", parts.next()?)
    } else {
        first.to_owned()
    };
    Some(format!("{}node_modules/{name}", &module[..at]))
}

/// The package directories of a Bun metafile's inputs, relative to `base`
/// (the build's working directory).
pub fn metafile_packages(metafile: &str, base: &Path) -> Result<Vec<PathBuf>> {
    let value: serde_json::Value = serde_json::from_str(metafile)?;
    let inputs = value
        .get("inputs")
        .and_then(|inputs| inputs.as_object())
        .context("the metafile has no inputs")?;
    let dirs: BTreeSet<String> = inputs.keys().filter_map(|k| package_dir_of(k)).collect();
    Ok(dirs.into_iter().map(|dir| base.join(dir)).collect())
}

/// Node's resolution of `name` from `from`: `node_modules/<name>` there or
/// in a parent, up to `root`.
fn resolve(name: &str, from: &Path, root: &Path) -> Option<PathBuf> {
    let mut dir = from;
    loop {
        let candidate = dir.join("node_modules").join(name);
        if candidate.join("package.json").is_file() {
            return candidate.canonicalize().ok();
        }
        if dir == root {
            return None;
        }
        dir = dir.parent()?;
    }
}

/// The package directories of `workspace`'s production dependencies and
/// theirs, resolved from node_modules. Optional dependencies not installed
/// (another platform's) are left out.
pub fn dependency_closure(root: &Path, workspace: &Path) -> Result<Vec<PathBuf>> {
    let root = root.canonicalize()?;
    let workspace = workspace.canonicalize()?;
    let mut seen = BTreeSet::new();
    let mut stack = Vec::new();
    let push = |stack: &mut Vec<(PathBuf, String, bool)>, dir: &Path| -> Result<()> {
        let manifest = manifest(dir)?;
        for (field, optional) in [("dependencies", false), ("optionalDependencies", true)] {
            if let Some(deps) = manifest.get(field).and_then(|deps| deps.as_object()) {
                for name in deps.keys() {
                    stack.push((dir.to_path_buf(), name.clone(), optional));
                }
            }
        }
        Ok(())
    };
    push(&mut stack, &workspace)?;
    while let Some((from, name, optional)) = stack.pop() {
        let Some(dir) = resolve(&name, &from, &root) else {
            if optional {
                continue;
            }
            bail!(
                "{name} (a dependency of {}) is not installed: bun install --frozen-lockfile",
                from.display()
            );
        };
        if seen.insert(dir.clone()) {
            push(&mut stack, &dir)?;
        }
    }
    Ok(seen.into_iter().collect())
}

/// The packages in `dirs`, one per name and version, each with an
/// accepted licence and a text (its files, else the SPDX text the
/// repository keeps in LICENSES/spdx).
pub fn npm_packages(
    root: &Path,
    dirs: &[PathBuf],
    accepted: &[String],
    clarify: &BTreeMap<String, String>,
) -> Result<Vec<NpmPackage>> {
    let mut packages = BTreeMap::new();
    for dir in dirs {
        let package = npm_package(dir, clarify)?;
        ensure!(
            satisfied(&package.license, accepted)?,
            "{} {} is under {}, not in about.toml's accepted list",
            package.name,
            package.version,
            package.license
        );
        if package.files.is_empty() {
            ensure!(
                spdx_text(root, &package.license).is_some(),
                "{} {} ships no licence file and LICENSES/spdx has no text for {}",
                package.name,
                package.version,
                package.license
            );
        }
        packages.insert((package.name.clone(), package.version.clone()), package);
    }
    Ok(packages.into_values().collect())
}

/// The SPDX text of a single licence identifier, from LICENSES/spdx.
fn spdx_text(root: &Path, id: &str) -> Option<String> {
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '.')
    {
        return None;
    }
    let dir = root.join("LICENSES/spdx");
    std::fs::read_dir(&dir).ok()?.flatten().find_map(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        let stem = name.strip_suffix(".txt")?;
        stem.eq_ignore_ascii_case(id)
            .then(|| std::fs::read_to_string(entry.path()).ok())
            .flatten()
    })
}

// ---------------------------------------------------------------------------
// Rendering

/// A text's words, for comparing licence texts laid out differently.
fn words(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `text` in a fenced block no line of it can close.
fn fenced(text: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        if c == '`' {
            run += 1;
            longest = longest.max(run);
        } else {
            run = 0;
        }
    }
    let fence = "`".repeat(longest.max(2) + 1);
    format!("{fence}text\n{}\n{fence}\n", text.trim_end())
}

/// The npm packages grouped by licence text, each group once.
fn render_npm(out: &mut String, root: &Path, packages: &[NpmPackage]) {
    out.push_str("| Package | Version | Licence |\n|---|---|---|\n");
    for package in packages {
        out.push_str(&format!(
            "| {} | {} | {} |\n",
            package.name, package.version, package.license
        ));
    }
    out.push('\n');
    // Keyed by the text's words: the same licence laid out differently once.
    let mut groups: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    let mut add = |text: String, user: String| {
        groups
            .entry(words(&text))
            .or_insert_with(|| (text.trim().to_owned(), Vec::new()))
            .1
            .push(user);
    };
    for package in packages {
        let id = format!("{} {}", package.name, package.version);
        if package.files.is_empty() {
            let text = spdx_text(root, &package.license).unwrap_or_default();
            add(
                text,
                format!("{id} (ships no licence file: the {} text)", package.license),
            );
        }
        for (file, text) in &package.files {
            add(text.clone(), format!("{id} ({file})"));
        }
    }
    let mut groups: Vec<_> = groups.into_values().collect();
    groups.sort_by(|a, b| a.1.cmp(&b.1));
    for (text, users) in groups {
        out.push_str(&format!("Used by: {}\n\n", users.join(", ")));
        out.push_str(&fenced(&text));
        out.push('\n');
    }
}

pub struct Inputs<'a> {
    pub root: &'a Path,
    pub target: &'a Target,
    pub version: &'a str,
    pub about: &'a About,
    pub bun_version: &'a str,
    pub pi_packages: &'a [NpmPackage],
    pub web_packages: &'a [NpmPackage],
}

fn read(root: &Path, path: &str) -> Result<String> {
    std::fs::read_to_string(root.join(path)).with_context(|| path.to_owned())
}

/// The whole file.
pub fn render(inputs: &Inputs) -> Result<String> {
    let root = inputs.root;
    let target = inputs.target;
    let mut out = format!(
        "# Third-party licences of Roamgate {} for {}\n\n\
         This package holds `{}` (Roamgate, built from Rust crates for {}) and\n\
         `{}` (Roamgate's Pi sidecar, a Bun {} executable with bundled npm\n\
         packages). `{}` embeds the Roamgate web app, built from npm packages.\n\
         Below are Roamgate's licence and notices, then the licence of every\n\
         third-party component they contain.\n\n",
        inputs.version,
        target.platform,
        target.binary,
        target.triple,
        target.pi_binary(),
        inputs.bun_version,
        target.binary,
    );
    out.push_str("## Roamgate\n\n");
    out.push_str(&fenced(&read(root, "LICENSE")?));
    out.push('\n');
    let notices = read(root, "THIRD_PARTY_NOTICES.md")?;
    // One level down, under Roamgate's heading.
    for line in notices.lines() {
        if line.starts_with('#') {
            out.push('#');
        }
        out.push_str(line);
        out.push('\n');
    }
    out.push('\n');
    for name in ["NERD-FONTS.txt", "LOBE-ICONS.txt", "PI.txt"] {
        out.push_str(&format!("### LICENSES/{name}\n\n"));
        out.push_str(&fenced(&read(root, &format!("LICENSES/{name}"))?));
        out.push('\n');
    }

    // Rust crates.
    out.push_str(&format!(
        "## Rust crates in {} ({})\n\n",
        target.binary, target.triple
    ));
    let mut crates: Vec<_> = inputs
        .about
        .crates
        .iter()
        .filter(|krate| krate.package.source.is_some())
        .collect();
    crates.sort_by(|a, b| {
        (&a.package.name, &a.package.version).cmp(&(&b.package.name, &b.package.version))
    });
    out.push_str("| Crate | Version | Licence |\n|---|---|---|\n");
    for krate in &crates {
        out.push_str(&format!(
            "| {} | {} | {} |\n",
            krate.package.name, krate.package.version, krate.license
        ));
    }
    out.push('\n');
    // One text per licence file: the crates that ship it (or use the
    // licence's text), the workspace's own crates left out.
    let mut texts: BTreeMap<(String, String, String), (String, BTreeSet<String>)> = BTreeMap::new();
    for license in &inputs.about.licenses {
        let users: BTreeSet<String> = license
            .used_by
            .iter()
            .filter(|used| used.krate.source.is_some())
            .map(|used| format!("{} {}", used.krate.name, used.krate.version))
            .collect();
        if users.is_empty() {
            continue;
        }
        texts
            .entry((
                license.id.clone(),
                license.name.clone(),
                words(&license.text),
            ))
            .or_insert_with(|| (license.text.trim().to_owned(), BTreeSet::new()))
            .1
            .extend(users);
    }
    for ((id, name, _), (text, users)) in texts {
        out.push_str(&format!("### {name} ({id})\n\n"));
        out.push_str(&format!(
            "Used by: {}\n\n",
            users.into_iter().collect::<Vec<_>>().join(", ")
        ));
        out.push_str(&fenced(&text));
        out.push('\n');
    }

    // Bun.
    out.push_str(&format!(
        "## Bun {} in {}\n\n",
        inputs.bun_version,
        target.pi_binary()
    ));
    let bun = read(root, "LICENSES/BUN.md")?;
    for line in bun.lines().filter(|line| !line.starts_with("<!--")) {
        if line.starts_with('#') {
            out.push_str("##");
        }
        out.push_str(line);
        out.push('\n');
    }
    out.push_str(
        "\n### GNU Lesser General Public License 2.1 (JavaScriptCore, WebKit, tinycc)\n\n",
    );
    out.push_str(&fenced(&read(root, "LICENSES/LGPL-2.1.txt")?));
    out.push('\n');

    out.push_str(&format!(
        "## npm packages bundled into {}\n\n",
        target.pi_binary()
    ));
    render_npm(&mut out, root, inputs.pi_packages);
    out.push_str(&format!(
        "## npm packages of the web app in {}\n\n",
        target.binary
    ));
    render_npm(&mut out, root, inputs.web_packages);
    Ok(out)
}

/// The Bun version the workspace pins (package.json `packageManager`).
pub fn pinned_bun(root: &Path) -> Result<String> {
    let manifest = manifest(root)?;
    manifest
        .get("packageManager")
        .and_then(|value| value.as_str())
        .and_then(|value| value.strip_prefix("bun@"))
        .map(str::to_owned)
        .context("package.json has no packageManager bun@<version>")
}

/// Checks the Bun that compiles `roamgate-pi` is the pinned one, whose
/// notice LICENSES/BUN.md holds.
pub fn check_bun(root: &Path) -> Result<String> {
    let pinned = pinned_bun(root)?;
    let output = Command::new("bun")
        .arg("--version")
        .output()
        .context("running bun --version")?;
    let found = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    ensure!(
        found == pinned,
        "roamgate-pi is compiled with Bun {found}, but package.json pins {pinned}, whose notice LICENSES/BUN.md holds"
    );
    let notice = read(root, "LICENSES/BUN.md")?;
    ensure!(
        notice.starts_with(&format!("<!-- Bun {pinned}: ")),
        "LICENSES/BUN.md is not Bun {pinned}'s notice: fetch https://github.com/oven-sh/bun/blob/bun-v{pinned}/LICENSE.md"
    );
    Ok(pinned)
}

/// THIRD_PARTY_LICENSES.md for `target`, whose sidecar was built with
/// `pi_metafile`.
pub fn generate(
    root: &Path,
    target: &Target,
    version: &str,
    pi_metafile: &Path,
    scratch: &Path,
) -> Result<String> {
    let accepted = accepted(root)?;
    let clarify = npm_clarifications(root)?;
    let bun_version = check_bun(root)?;
    let about = cargo_about(root, target, scratch)?;
    let metafile =
        std::fs::read_to_string(pi_metafile).with_context(|| pi_metafile.display().to_string())?;
    let pi_dirs = metafile_packages(&metafile, &root.join("server"))?;
    let pi_packages = npm_packages(root, &pi_dirs, &accepted, &clarify)?;
    let web_dirs = dependency_closure(root, &root.join("web"))?;
    let web_packages = npm_packages(root, &web_dirs, &accepted, &clarify)?;
    render(&Inputs {
        root,
        target,
        version,
        about: &about,
        bun_version: &bun_version,
        pi_packages: &pi_packages,
        web_packages: &web_packages,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn accepted() -> Vec<String> {
        super::accepted(&crate::repo_root()).unwrap()
    }

    #[test]
    fn spdx_expressions() {
        let accepted = accepted();
        for ok in [
            "MIT",
            "mit",
            "MIT OR Apache-2.0",
            "(MIT OR Apache-2.0) AND Unicode-3.0",
            "Apache-2.0 WITH LLVM-exception",
            "EPL-2.0 OR GPL-3.0-or-later",
            "(MPL-2.0 OR Apache-2.0)",
            "GPL-3.0 OR MIT",
        ] {
            assert!(satisfied(ok, &accepted).unwrap(), "{ok}");
        }
        for refused in [
            "GPL-3.0",
            "MIT AND GPL-2.0+",
            "AGPL-3.0-only",
            "SSPL-1.0 OR BUSL-1.1",
            "GPL-2.0 WITH Classpath-exception-2.0",
        ] {
            assert!(!satisfied(refused, &accepted).unwrap(), "{refused}");
        }
        for bad in ["", "(MIT", "MIT OR", "MIT WITH", "MIT Apache-2.0"] {
            assert!(satisfied(bad, &accepted).is_err(), "{bad}");
        }
    }

    #[test]
    fn package_dirs_of_metafile_inputs() {
        let metafile = r#"{"inputs": {
            "src/assistant/pi-sidecar-main.ts": {},
            "../node_modules/.bun/chalk@5.6.0/node_modules/chalk/source/index.js": {},
            "../node_modules/.bun/chalk@5.6.0/node_modules/chalk/source/vendor/x.js": {},
            "../node_modules/.bun/@scope+pkg@1.0.0/node_modules/@scope/pkg/dist/a.js": {},
            "..\\node_modules\\ms\\index.js": {}
        }, "outputs": {}}"#;
        let base = Path::new("/r/server");
        assert_eq!(
            metafile_packages(metafile, base).unwrap(),
            [
                base.join("../node_modules/.bun/@scope+pkg@1.0.0/node_modules/@scope/pkg"),
                base.join("../node_modules/.bun/chalk@5.6.0/node_modules/chalk"),
                base.join("../node_modules/ms"),
            ]
        );
        assert!(metafile_packages("{}", base).is_err());
    }

    fn put(dir: &Path, manifest: serde_json::Value, files: &[(&str, &str)]) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("package.json"), manifest.to_string()).unwrap();
        for (name, text) in files {
            std::fs::write(dir.join(name), text).unwrap();
        }
    }

    #[test]
    fn npm_closure_licences_and_texts() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let modules = root.join("node_modules");
        put(
            &root.join("web"),
            serde_json::json!({"name": "web", "version": "0.0.0",
                "dependencies": {"a": "1"}, "optionalDependencies": {"native-other-os": "1"}}),
            &[],
        );
        put(
            &modules.join("a"),
            serde_json::json!({"name": "a", "version": "1.0.0", "license": "MIT",
                "dependencies": {"@s/b": "2", "c": "1"}}),
            &[("LICENSE", "a's MIT")],
        );
        // A nested copy wins over the hoisted one.
        put(
            &modules.join("a/node_modules/c"),
            serde_json::json!({"name": "c", "version": "2.0.0",
                "licenses": [{"type": "MIT"}, {"type": "Apache-2.0"}]}),
            &[("license.md", "c's"), ("NOTICE", "c's notice")],
        );
        put(
            &modules.join("c"),
            serde_json::json!({"name": "c", "version": "1.0.0", "license": "GPL-3.0"}),
            &[],
        );
        put(
            &modules.join("@s/b"),
            serde_json::json!({"name": "@s/b", "version": "2.0.0", "license": {"type": "Apache-2.0"}}),
            &[],
        );
        let dirs = dependency_closure(root, &root.join("web")).unwrap();
        assert_eq!(dirs.len(), 3);
        // LICENSES/spdx of the repository serves @s/b's missing file.
        let repo = crate::repo_root();
        let clarify = BTreeMap::new();
        let packages =
            npm_packages(&repo, &dirs, &super::accepted(&repo).unwrap(), &clarify).unwrap();
        let summary: Vec<_> = packages
            .iter()
            .map(|p| {
                (
                    p.name.as_str(),
                    p.version.as_str(),
                    p.license.as_str(),
                    p.files.len(),
                )
            })
            .collect();
        assert_eq!(
            summary,
            [
                ("@s/b", "2.0.0", "Apache-2.0", 0),
                ("a", "1.0.0", "MIT", 1),
                ("c", "2.0.0", "MIT OR Apache-2.0", 2),
            ]
        );
        let mut out = String::new();
        render_npm(&mut out, &repo, &packages);
        assert!(out.contains("| c | 2.0.0 | MIT OR Apache-2.0 |"));
        assert!(out.contains("Used by: @s/b 2.0.0 (ships no licence file: the Apache-2.0 text)"));
        assert!(out.contains("Used by: c 2.0.0 (NOTICE)\n\n```text\nc's notice\n```"));

        // The hoisted GPL copy, reached directly, is refused; so is a
        // package naming no licence, unless clarified.
        assert!(npm_packages(&repo, &[modules.join("c")], &accepted(), &clarify).is_err());
        put(
            &modules.join("d"),
            serde_json::json!({"name": "d", "version": "1.0.0"}),
            &[("license", "MIT text")],
        );
        assert!(npm_packages(&repo, &[modules.join("d")], &accepted(), &clarify).is_err());
        let clarify = BTreeMap::from([("d".to_owned(), "MIT".to_owned())]);
        assert_eq!(
            npm_packages(&repo, &[modules.join("d")], &accepted(), &clarify).unwrap()[0].license,
            "MIT"
        );
        // A missing dependency that is not optional fails.
        std::fs::remove_dir_all(modules.join("@s")).unwrap();
        assert!(dependency_closure(root, &root.join("web")).is_err());
    }

    #[test]
    fn ci_installs_the_pinned_cargo_about() {
        let action = read(
            &crate::repo_root(),
            ".github/actions/rust-builder/action.yml",
        )
        .unwrap();
        assert!(action.contains(&format!(
            "cargo install --locked --features cli cargo-about@{CARGO_ABOUT_VERSION}"
        )));
    }

    #[test]
    fn fences_outlast_the_text() {
        assert_eq!(fenced("a\n"), "```text\na\n```\n");
        assert_eq!(fenced("x ```` y"), "`````text\nx ```` y\n`````\n");
    }

    #[test]
    fn the_repository_s_bun_notice_is_the_pinned_bun_s() {
        let root = crate::repo_root();
        let pinned = pinned_bun(&root).unwrap();
        assert!(
            read(&root, "LICENSES/BUN.md")
                .unwrap()
                .starts_with(&format!("<!-- Bun {pinned}: "))
        );
    }

    #[test]
    fn renders_every_part() {
        let root = crate::repo_root();
        let target = crate::targets::select(
            &crate::targets::load(&root).unwrap(),
            &["windows-x64".into()],
        )
        .unwrap()
        .remove(0);
        let package = |name: &str, source: Option<&str>| AboutPackage {
            name: name.into(),
            version: "1.0.0".into(),
            source: source.map(str::to_owned),
        };
        let registry = Some("registry+https://github.com/rust-lang/crates.io-index");
        let about = About {
            licenses: vec![AboutLicense {
                name: "MIT License".into(),
                id: "MIT".into(),
                text: "Copyright (c) serde".into(),
                used_by: vec![
                    AboutUse {
                        krate: package("serde", registry),
                    },
                    AboutUse {
                        krate: package("roamgate-base", None),
                    },
                ],
            }],
            crates: vec![
                AboutCrate {
                    package: package("serde", registry),
                    license: "MIT OR Apache-2.0".into(),
                },
                AboutCrate {
                    package: package("roamgate-base", None),
                    license: "MIT".into(),
                },
            ],
        };
        let text = render(&Inputs {
            root: &root,
            target: &target,
            version: "9.8.7",
            about: &about,
            bun_version: "1.4.4",
            pi_packages: &[],
            web_packages: &[],
        })
        .unwrap();
        for part in [
            "# Third-party licences of Roamgate 9.8.7 for windows-x64",
            "`roamgate-pi.exe` (Roamgate's Pi sidecar, a Bun 1.4.4 executable",
            "## Roamgate\n",
            "## Nerd Fonts",
            "### LICENSES/NERD-FONTS.txt",
            "## Rust crates in roamgate.exe (x86_64-pc-windows-msvc)",
            "| serde | 1.0.0 | MIT OR Apache-2.0 |",
            "### MIT License (MIT)\n\nUsed by: serde 1.0.0\n",
            "## Bun 1.4.4 in roamgate-pi.exe",
            "### JavaScriptCore",
            "GNU LESSER GENERAL PUBLIC LICENSE",
            "## npm packages bundled into roamgate-pi.exe",
            "## npm packages of the web app in roamgate.exe",
        ] {
            assert!(text.contains(part), "{part}");
        }
        assert!(!text.contains("roamgate-base"));
    }
}
