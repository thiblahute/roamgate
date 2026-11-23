//! Forge host discovery (mr-reviews/hosts.ts): the hosts glab and gh have a
//! login for, read from their own config files. A glab token is only ever
//! sent to a host glab itself has a login for (or its default host).

use std::path::{Path, PathBuf};

use roamgate_base::env::Env;

/// Which forge a host is.
pub use crate::complexity::Provider;

/// A host and its forge.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ForgeHost {
    pub host: String,
    pub provider: Provider,
}

/// shared/forge.ts `validHost`.
pub fn valid_host(host: &str) -> bool {
    let (name, port) = match host.rsplit_once(':') {
        Some((name, port)) => (name, Some(port)),
        None => (host, None),
    };
    host.len() <= 253
        && port.is_none_or(|port| !port.is_empty() && port.bytes().all(|b| b.is_ascii_digit()))
        && name
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
}

fn yaml_key(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let trimmed = trimmed.trim_end();
    let body = trimmed.strip_suffix(':')?.trim_end();
    let body = body.strip_prefix('"').unwrap_or(body);
    let body = body.strip_suffix('"').unwrap_or(body);
    (!body.is_empty()
        && body
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b':' || b == b'-'))
    .then(|| body.to_ascii_lowercase())
}

/// The host blocks of a glab or gh config (`hosts:` entries, or top-level
/// keys for gh's hosts.yml), each with its lines, trimmed.
pub fn yaml_host_blocks(text: &str, top_level: bool) -> Vec<(String, String)> {
    let mut blocks: Vec<(String, String)> = Vec::new();
    let mut in_hosts = top_level;
    let mut indent: i64 = if top_level { 0 } else { -1 };
    let mut current: Option<usize> = None;
    for line in text.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.trim().is_empty() || line.trim().starts_with('#') {
            continue;
        }
        let lead = (line.len() - line.trim_start().len()) as i64;
        if !top_level && lead == 0 {
            in_hosts = line
                .strip_prefix("hosts:")
                .is_some_and(|rest| rest.trim().is_empty());
            indent = -1;
            current = None;
            continue;
        }
        if !in_hosts {
            continue;
        }
        if indent < 0 {
            indent = lead;
        }
        let key = yaml_key(line).filter(|_| lead == indent);
        if let Some(key) = key {
            blocks.retain(|(k, _)| *k != key);
            blocks.push((key, String::new()));
            current = Some(blocks.len() - 1);
        } else if let Some(at) = current.filter(|_| lead > indent) {
            let block = &mut blocks[at].1;
            block.push_str(line.trim());
            block.push('\n');
        } else if lead <= indent {
            current = None;
        }
    }
    blocks
}

fn first_file(paths: Vec<PathBuf>) -> Option<PathBuf> {
    paths.into_iter().find(|path| path.exists())
}

fn config_home(env: &dyn Env, home: &Path) -> PathBuf {
    env.var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"))
}

/// glab's config file, if any.
pub fn glab_config_path(env: &dyn Env, home: &Path) -> Option<PathBuf> {
    let mut paths = Vec::new();
    if let Some(dir) = env.var("GLAB_CONFIG_DIR").filter(|d| !d.is_empty()) {
        paths.push(PathBuf::from(dir).join("config.yml"));
    }
    paths.push(config_home(env, home).join("glab-cli").join("config.yml"));
    paths.push(home.join("Library/Application Support/glab-cli/config.yml"));
    first_file(paths)
}

/// gh's hosts file, if any.
pub fn gh_hosts_path(env: &dyn Env, home: &Path) -> Option<PathBuf> {
    let mut paths = Vec::new();
    if let Some(dir) = env.var("GH_CONFIG_DIR").filter(|d| !d.is_empty()) {
        paths.push(PathBuf::from(dir).join("hosts.yml"));
    }
    paths.push(config_home(env, home).join("gh").join("hosts.yml"));
    first_file(paths)
}

fn line_value<'a>(block: &'a str, key: &str) -> Option<&'a str> {
    block.lines().find_map(|line| {
        line.strip_prefix(key)
            .and_then(|rest| rest.strip_prefix(':'))
    })
}

/// The hosts glab has a login for: a token, a keyring token, or its
/// default host.
pub fn glab_hosts(text: &str) -> Vec<String> {
    let default_host = text.lines().find_map(|line| {
        let rest = line.strip_prefix("host:")?.trim_start();
        let rest = rest.strip_prefix('"').unwrap_or(rest);
        let rest = rest
            .strip_prefix("https://")
            .or_else(|| rest.strip_prefix("http://"))
            .unwrap_or(rest);
        let host: String = rest
            .chars()
            .take_while(|c| *c != '"' && !c.is_whitespace() && *c != '/')
            .collect();
        (!host.is_empty()).then(|| host.to_ascii_lowercase())
    });
    yaml_host_blocks(text, false)
        .into_iter()
        .filter(|(host, block)| {
            let token = line_value(block, "token")
                .map(str::trim)
                .filter(|t| !t.is_empty());
            let signed_in = token.is_some_and(|t| t != "\"\"" && t != "''")
                || line_value(block, "is_keyring_token")
                    .is_some_and(|v| v.trim_start().starts_with("true"))
                || default_host.as_deref() == Some(host.as_str());
            signed_in && valid_host(host)
        })
        .map(|(host, _)| host)
        .collect()
}

/// The hosts gh has a login for.
pub fn gh_hosts(text: &str) -> Vec<String> {
    yaml_host_blocks(text, true)
        .into_iter()
        .map(|(host, _)| host)
        .filter(|host| valid_host(host))
        .collect()
}

/// The forge hosts this machine's glab and gh have logins for, glab's
/// first; a host is listed once.
pub fn discover_forge_hosts(glab: Option<&str>, gh: Option<&str>) -> Vec<ForgeHost> {
    let mut out: Vec<ForgeHost> = Vec::new();
    let mut add = |host: String, provider: Provider| {
        if !out.iter().any(|entry| entry.host == host) {
            out.push(ForgeHost { host, provider });
        }
    };
    for host in glab.map(glab_hosts).unwrap_or_default() {
        add(host, Provider::Gitlab);
    }
    for host in gh.map(gh_hosts).unwrap_or_default() {
        add(host, Provider::Github);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glab_and_gh_logins_are_found_and_listed_once() {
        let glab = "host: gitlab.com\nhosts:\n    gitlab.com:\n        token: \"\"\n    gitlab.example.com:\n        token: glpat-x\n    keyring.example.com:\n        is_keyring_token: true\n    nologin.example.com:\n        api_protocol: https\n";
        let gh = "github.com:\n    user: me\ngitlab.example.com:\n    user: me\n";
        assert_eq!(
            discover_forge_hosts(Some(glab), Some(gh)),
            vec![
                ForgeHost {
                    host: "gitlab.com".into(),
                    provider: Provider::Gitlab
                },
                ForgeHost {
                    host: "gitlab.example.com".into(),
                    provider: Provider::Gitlab
                },
                ForgeHost {
                    host: "keyring.example.com".into(),
                    provider: Provider::Gitlab
                },
                ForgeHost {
                    host: "github.com".into(),
                    provider: Provider::Github
                },
            ]
        );
        assert!(valid_host("gitlab.example.com:8443"));
        assert!(!valid_host("-bad") && !valid_host("a/b") && !valid_host("h:"));
    }
}
