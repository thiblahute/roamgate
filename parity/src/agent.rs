//! The agent socket (`POST /v1/<command>` on a Unix socket) and its real
//! clients: `roamgate-review` as the server installs it (its own binary),
//! and the Python one SSH hosts run.

use std::path::{Path, PathBuf};
use std::time::Duration;

use anyhow::Result;
use serde_json::Value;

use crate::http::{self, Request, Response, Target};

/// Where the server puts its agent socket under a HOME.
pub fn socket_path(home: &Path) -> PathBuf {
    home.join(".cache").join("roamgate").join("review.sock")
}

/// Where the server installs its client under a HOME.
pub fn client_path(home: &Path) -> PathBuf {
    crate::run::home_path(
        home,
        &Path::new(".cache/roamgate/bin").join("roamgate-review"),
    )
}

/// The Python client SSH hosts get (contract/assets/python).
pub fn python_client_path() -> PathBuf {
    crate::paths::repo_root()
        .join("contract")
        .join("assets")
        .join("python")
        .join("roamgate-review.py")
}

pub async fn post(
    socket: &Path,
    command: &str,
    body: &Value,
    headers: &[(String, String)],
    timeout: Duration,
) -> Result<Response> {
    let mut all = vec![("content-type".to_owned(), "application/json".to_owned())];
    all.extend(headers.iter().cloned());
    http::send(
        &Target::Unix(socket.to_path_buf()),
        &Request {
            method: "POST".into(),
            path: format!("/v1/{command}"),
            headers: all,
            body: body.to_string().into_bytes(),
        },
        timeout,
    )
    .await
}
