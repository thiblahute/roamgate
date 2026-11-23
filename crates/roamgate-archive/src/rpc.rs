//! The archive search view's server side (archive/rpc.ts):
//! `bridge.archive.search` and `bridge.archive.open`, read-only, with
//! `archive.hide` applied.

use roamgate_agents::js::{js_trim, utf16_len};
use serde_json::Value;

use crate::search::SearchQuery;

/// A parameter error: shown to the user as is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArchiveRpcError(pub String);

impl std::fmt::Display for ArchiveRpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

/// An error of the parameters that is not shown as is (`invalid <key>`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParamError {
    /// `ArchiveRpcError`.
    User(String),
    /// A plain error.
    Invalid(String),
}

impl ParamError {
    pub fn message(&self) -> &str {
        match self {
            ParamError::User(message) | ParamError::Invalid(message) => message,
        }
    }
}

fn text(params: &Value, key: &str, max: usize) -> Result<Option<String>, ParamError> {
    match params.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(value)) if value.is_empty() => Ok(None),
        Some(Value::String(value)) if utf16_len(value) <= max => {
            let trimmed = js_trim(value);
            Ok((!trimmed.is_empty()).then(|| trimmed.to_owned()))
        }
        Some(_) => Err(ParamError::Invalid(format!("invalid {key}"))),
    }
}

fn flag(params: &Value, key: &str) -> bool {
    params.get(key) == Some(&Value::Bool(true))
}

/// The query of `bridge.archive.search`.
pub fn archive_search_query(params: &Value) -> Result<SearchQuery, ParamError> {
    let Some(query) = text(params, "query", 300)? else {
        return Err(ParamError::User("type something to search for".into()));
    };
    let terms = query
        .split(roamgate_agents::js::is_js_space)
        .filter(|term| !term.is_empty())
        .map(str::to_owned)
        .collect();
    let limit = match params.get("limit") {
        Some(Value::Number(number)) => match number.as_f64() {
            Some(limit) if limit.fract() == 0.0 => limit.clamp(1.0, 200.0) as usize,
            _ => 50,
        },
        _ => 50,
    };
    Ok(SearchQuery {
        terms,
        host: text(params, "host", 64)?,
        agent: text(params, "agent", 40)?,
        project: text(params, "project", 200)?,
        role: text(params, "role", 20)?,
        kind: None,
        since: text(params, "since", 32)?,
        until: text(params, "until", 32)?,
        recent: flag(params, "recent"),
        history: false,
        regex: flag(params, "regex"),
        tool_output: flag(params, "tool_output"),
        limit,
    })
}

/// The request of `bridge.archive.open`.
pub fn archive_open_request(params: &Value) -> Result<crate::open::OpenRequest, ParamError> {
    let key = text(params, "key", 1000)?;
    let line = params.get("line").and_then(|line| {
        let number = line.as_f64()?;
        (number.fract() == 0.0).then_some(number as i64)
    });
    match (key, line) {
        (Some(key), Some(line)) => Ok(crate::open::OpenRequest {
            key,
            line,
            raw: flag(params, "raw"),
            context: None,
        }),
        _ => Err(ParamError::User("invalid session".into())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn search_parameters_are_checked() {
        assert_eq!(
            archive_search_query(&json!({})).unwrap_err(),
            ParamError::User("type something to search for".into())
        );
        assert_eq!(
            archive_search_query(&json!({"query": 3})).unwrap_err(),
            ParamError::Invalid("invalid query".into())
        );
        assert_eq!(
            archive_search_query(&json!({"query": "x", "host": "h".repeat(65)})).unwrap_err(),
            ParamError::Invalid("invalid host".into())
        );
        let query = archive_search_query(
            &json!({"query": " a  b ", "limit": 900, "recent": true, "agent": ""}),
        )
        .unwrap();
        assert_eq!(query.terms, vec!["a", "b"]);
        assert_eq!(query.limit, 200);
        assert!(query.recent);
        assert_eq!(query.agent, None);
        assert_eq!(
            archive_search_query(&json!({"query": "a", "limit": 2.5}))
                .unwrap()
                .limit,
            50
        );
        assert_eq!(
            archive_open_request(&json!({"key": "h/claude/p/s.jsonl"})).unwrap_err(),
            ParamError::User("invalid session".into())
        );
        assert_eq!(
            archive_open_request(&json!({"key": "k", "line": 4}))
                .unwrap()
                .line,
            4
        );
    }
}
