//! Running the server's CLI (`<server command> <args>`) with the run's
//! environment.

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use anyhow::{Context, Result};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone)]
pub struct Output {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

pub async fn run(
    command: &[String],
    args: &[String],
    env: &BTreeMap<String, String>,
    cwd: &Path,
    stdin: Option<&str>,
    timeout: Duration,
) -> Result<Output> {
    let (program, base) = command.split_first().context("empty server command")?;
    let mut child = tokio::process::Command::new(program);
    child
        .args(base)
        .args(args)
        .env_clear()
        .envs(env)
        .current_dir(cwd)
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = child.spawn().with_context(|| format!("spawn {program}"))?;
    if let Some(text) = stdin
        && let Some(mut input) = child.stdin.take()
    {
        input.write_all(text.as_bytes()).await?;
        drop(input);
    }
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .with_context(|| format!("{} {} timed out", program, args.join(" ")))??;
    Ok(Output {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}
