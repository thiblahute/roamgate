//! The request references of `shared/forge.ts` and the pipeline states of
//! `review/forge.ts` the inbox's parsers use.

use std::sync::LazyLock;

use regex::Regex;
use roamgate_agents::js::Obj;
use serde_json::{Value, json};

static GITLAB_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/(.+?)/-/merge_requests/([0-9]{1,9})(?:/.*)?$").expect("pattern")
});
static GITHUB_PATH: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^/([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)/pull/([0-9]{1,9})(?:/.*)?$").expect("pattern")
});

/// `validProject` and `validHost` of shared/forge.ts, one copy in roamgate-base.
pub use roamgate_base::settings::sections::{valid_host, valid_project};

/// A request reference: provider, host, project, number.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ForgeRef {
    pub provider: String,
    pub host: String,
    pub project: String,
    pub number: u64,
}

impl ForgeRef {
    pub fn key(&self) -> String {
        format!(
            "{}:{}/{}#{}",
            self.provider,
            self.host.to_lowercase(),
            self.project.to_lowercase(),
            self.number
        )
    }

    /// `{provider, host, project, number}`, in that order.
    pub fn to_obj(&self) -> Obj {
        let mut o = Obj::new();
        o.insert("provider".into(), json!(self.provider));
        o.insert("host".into(), json!(self.host));
        o.insert("project".into(), json!(self.project));
        o.insert("number".into(), json!(self.number));
        o
    }

    pub fn from_obj(value: &Value) -> Option<ForgeRef> {
        Some(ForgeRef {
            provider: value.get("provider")?.as_str()?.to_owned(),
            host: value.get("host")?.as_str()?.to_owned(),
            project: value.get("project")?.as_str()?.to_owned(),
            number: value
                .get("number")?
                .as_f64()
                .filter(|n| *n > 0.0 && n.fract() == 0.0)? as u64,
        })
    }
}

/// `url.host` as WHATWG URL gives it: the host, and the port unless default.
fn url_host(url: &url::Url) -> String {
    let host = url.host_str().unwrap_or("").to_owned();
    match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host,
    }
}

/// `parseForgeUrl`: the request a web URL names (https only, no credentials).
pub fn parse_forge_url(value: &str) -> Option<ForgeRef> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = url_host(&url).to_lowercase();
    if !valid_host(&host) {
        return None;
    }
    let path = url.path().trim_end_matches('/');
    if let Some(c) = GITLAB_PATH.captures(path) {
        let project = &c[1];
        if !valid_project(project) {
            return None;
        }
        return Some(ForgeRef {
            provider: "gitlab".into(),
            host,
            project: project.to_owned(),
            number: c[2].parse().ok()?,
        });
    }
    let c = GITHUB_PATH.captures(path)?;
    valid_project(&c[1]).then(|| ForgeRef {
        provider: "github".into(),
        host,
        project: c[1].to_owned(),
        number: c[2].parse().unwrap_or(0),
    })
}

/// `ownRequestUrl`: a URL the forge answered, when it is the request's own page.
pub fn own_request_url(reference: &ForgeRef, value: Option<&Value>) -> Option<String> {
    let text = value?.as_str()?;
    let parsed = parse_forge_url(text)?;
    if parsed.provider != reference.provider
        || parsed.host != reference.host.to_lowercase()
        || parsed.number != reference.number
    {
        return None;
    }
    let mut url = url::Url::parse(text).ok()?;
    url.set_fragment(None);
    url.set_query(None);
    Some(url.to_string())
}

/// A GitLab pipeline status, folded to the chip's.
pub fn gitlab_pipeline_status(value: &str) -> &'static str {
    match value {
        "success" => "success",
        "failed" => "failed",
        "canceled" | "canceling" => "canceled",
        "skipped" => "skipped",
        "manual" => "manual",
        "running" => "running",
        _ => "pending",
    }
}

/// A GitHub status check rollup state, folded to the chip's.
pub fn github_pipeline_status(value: Option<&Value>) -> &'static str {
    match value.and_then(Value::as_str) {
        Some("SUCCESS") => "success",
        Some("FAILURE") | Some("ERROR") => "failed",
        Some("PENDING") => "running",
        _ => "pending",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_request_urls_of_both_forges() {
        let gl = parse_forge_url("https://GitLab.example.org/a/b/c/-/merge_requests/12/diffs?x=1")
            .unwrap();
        assert_eq!(gl.key(), "gitlab:gitlab.example.org/a/b/c#12");
        let gh = parse_forge_url("https://github.com/o/r/pull/3/").unwrap();
        assert_eq!(gh.key(), "github:github.com/o/r#3");
        assert!(parse_forge_url("http://github.com/o/r/pull/3").is_none());
        assert!(parse_forge_url("https://u:p@github.com/o/r/pull/3").is_none());
        assert!(parse_forge_url("https://h/a/../-/merge_requests/1").is_none());
        assert_eq!(
            own_request_url(&gh, Some(&json!("https://github.com/o/r/pull/3?a#b"))).as_deref(),
            Some("https://github.com/o/r/pull/3")
        );
        assert!(own_request_url(&gh, Some(&json!("https://github.com/o/r/pull/4"))).is_none());
    }
}
