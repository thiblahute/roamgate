//! State inspectors: what the server left on disk, read as a client would
//! never see it. JSON files parsed, SQLite tables as rows, zstd files by
//! content, git refs, file modes.

use std::path::Path;

use anyhow::{Context, Result};
use rusqlite::types::ValueRef;
use serde_json::{Map, Value, json};

pub fn json_file(path: &Path) -> Result<Value> {
    let text = std::fs::read_to_string(path).with_context(|| path.display().to_string())?;
    serde_json::from_str(&text).with_context(|| format!("{} is not JSON", path.display()))
}

/// JSON lines, each parsed.
pub fn jsonl_file(path: &Path) -> Result<Value> {
    let text = std::fs::read_to_string(path).with_context(|| path.display().to_string())?;
    Ok(Value::Array(
        text.lines()
            .filter(|line| !line.trim().is_empty())
            .map(serde_json::from_str)
            .collect::<Result<_, _>>()?,
    ))
}

/// The rows a query gives, as objects; blobs as `{"blob": <hex>}`.
pub fn sqlite_rows(path: &Path, sql: &str) -> Result<Value> {
    let connection = rusqlite::Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .with_context(|| path.display().to_string())?;
    let mut statement = connection.prepare(sql)?;
    let names: Vec<String> = statement
        .column_names()
        .map(|name| name.to_string())
        .collect();
    let rows = statement.query_map([], |row| {
        let mut object = Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(number) => json!(number),
                ValueRef::Real(number) => json!(number),
                ValueRef::Text(text) => Value::String(String::from_utf8_lossy(text).into_owned()),
                ValueRef::Blob(bytes) => {
                    json!({"blob": bytes.iter().map(|byte| format!("{byte:02x}")).collect::<String>()})
                }
            };
            object.insert(name.clone(), value);
        }
        Ok(Value::Object(object))
    })?;
    Ok(Value::Array(rows.collect::<Result<_, _>>()?))
}

/// A zstd file's content (all frames).
pub fn zstd_text(path: &Path) -> Result<String> {
    let bytes = std::fs::read(path).with_context(|| path.display().to_string())?;
    let plain = zstd::decode_all(bytes.as_slice())?;
    Ok(String::from_utf8_lossy(&plain).into_owned())
}

/// `refname -> object` of the refs under a prefix.
pub fn git_refs(repo: &Path, prefix: &str) -> Result<Value> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repo)
        .args(["for-each-ref", "--format=%(refname) %(objectname)", prefix])
        .output()?;
    if !output.status.success() {
        anyhow::bail!(
            "git for-each-ref: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let mut refs = Map::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some((name, object)) = line.split_once(' ') {
            refs.insert(name.to_owned(), Value::String(object.to_owned()));
        }
    }
    Ok(Value::Object(refs))
}

/// The permission bits, as `0600`.
pub fn mode(path: &Path) -> Result<String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let metadata =
            std::fs::symlink_metadata(path).with_context(|| path.display().to_string())?;
        Ok(format!("{:04o}", metadata.permissions().mode() & 0o7777))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok("n/a".into())
    }
}
