//! Pure helpers context.ts and actions.ts import from modules not ported
//! on this branch. Each says where it comes from, and moves to its home
//! crate when that lands (the rest of what they import is used from the
//! crates that have it).

use roamgate_agents::js;
use serde_json::Value;

use crate::errors::{AssistantError, AssistantResult};

const CONNECTION_ID_MAX_LENGTH: usize = 128;

/// A connection id, and every id checked like one
/// (connections/protocol.ts `validateConnectionId`): the error is
/// `ConnectionRoutingError("invalid connection_id")`. The same function is
/// `roamgate_connections::profiles::validate_connection_id` on `rust/main`
/// (S16): this one goes when that lands here.
pub fn validate_connection_id(value: Option<&Value>) -> AssistantResult<String> {
    let invalid = || AssistantError::internal("invalid connection_id");
    let Some(text) = value.and_then(Value::as_str) else {
        return Err(invalid());
    };
    let mut characters = text.chars();
    let valid = !text.is_empty()
        && js::len16(text) <= CONNECTION_ID_MAX_LENGTH
        && characters.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && characters.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'));
    if !valid {
        return Err(invalid());
    }
    Ok(text.to_owned())
}

/// A workspace-relative path as Files and Changes send it
/// (workspace/file-paths.ts `sanitizeExplorerPath`): slashes forward, no
/// leading slash, no `..`. The same function is
/// `roamgate_git::sanitize_explorer_path` on `rust/s17-workspace`: this one
/// goes when that lands here.
pub fn sanitize_explorer_path(value: Option<&Value>) -> AssistantResult<String> {
    let raw = value.and_then(Value::as_str).unwrap_or("");
    let normalized = raw.replace('\\', "/");
    let normalized = normalized.trim_start_matches('/');
    let parts: Vec<&str> = normalized.split('/').filter(|p| !p.is_empty()).collect();
    if parts.iter().any(|p| *p == ".." || p.contains('\0')) {
        return Err(AssistantError::internal("invalid file explorer path"));
    }
    Ok(parts.join("/"))
}

/// The workspace's checkout (workspace/utils.ts `checkoutPath`): its
/// worktree's checkout path, else its cwd, else "". Moves to the
/// workspace crate (S17).
pub fn checkout_path(workspace: &Value) -> String {
    let nonempty = |value: Option<&Value>| {
        value
            .and_then(Value::as_str)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    };
    nonempty(
        workspace
            .get("worktree")
            .and_then(|worktree| worktree.get("checkout_path")),
    )
    .or_else(|| nonempty(workspace.get("cwd")))
    .unwrap_or_default()
}

/// Where a worktree for `branch` goes in `directory`
/// (worktree/create.ts `worktreeCheckoutPath`). Moves to the worktree
/// crate.
pub fn worktree_checkout_path(directory: &str, branch: &str) -> AssistantResult<String> {
    let mut name = String::new();
    let mut in_run = false;
    for c in js::trim(branch).chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            name.push(c);
            in_run = false;
        } else if !in_run {
            name.push('-');
            in_run = true;
        }
    }
    let name = name
        .trim_start_matches(['-', '.'])
        .trim_end_matches('-')
        .to_owned();
    if name.is_empty() {
        return Err(AssistantError::internal("Worktree branch name is empty."));
    }
    Ok(format!("{}/{name}", directory.trim_end_matches('/')))
}

/// connections/unix-only.ts `assertUnixHost`: a Unix-only operation on a
/// Windows host is refused with a message safe to show.
pub fn assert_unix_host(remote_platform: Option<&str>, operation: &str) -> AssistantResult<()> {
    if remote_platform == Some("windows") {
        return Err(AssistantError::Platform(format!(
            "{operation} requires a Unix SSH host and is unavailable on Windows."
        )));
    }
    Ok(())
}

fn is_separator(c: char) -> bool {
    c == '/' || c == '\\'
}

/// Node's `normalizeString` (path.js) with Windows separators.
fn normalize_string(path: &str, allow_above_root: bool) -> String {
    let chars: Vec<char> = path.chars().collect();
    let mut res: Vec<char> = Vec::new();
    let mut last_segment_length = 0usize;
    let mut last_slash: isize = -1;
    let mut dots: isize = 0;
    let mut code = '\0';
    for i in 0..=chars.len() {
        if i < chars.len() {
            code = chars[i];
        } else if is_separator(code) {
            break;
        } else {
            code = '/';
        }
        if is_separator(code) {
            if last_slash == i as isize - 1 || dots == 1 {
                // Nothing to add.
            } else if dots == 2 {
                if res.len() < 2 || last_segment_length != 2 || !res.ends_with(&['.', '.']) {
                    if res.len() > 2 {
                        match res.iter().rposition(|c| *c == '\\') {
                            None => {
                                res.clear();
                                last_segment_length = 0;
                            }
                            Some(at) => {
                                res.truncate(at);
                                let previous = res
                                    .iter()
                                    .rposition(|c| *c == '\\')
                                    .map_or(-1, |p| p as isize);
                                last_segment_length = (res.len() as isize - 1 - previous) as usize;
                            }
                        }
                        last_slash = i as isize;
                        dots = 0;
                        continue;
                    } else if !res.is_empty() {
                        res.clear();
                        last_segment_length = 0;
                        last_slash = i as isize;
                        dots = 0;
                        continue;
                    }
                }
                if allow_above_root {
                    if !res.is_empty() {
                        res.push('\\');
                    }
                    res.extend(['.', '.']);
                    last_segment_length = 2;
                }
            } else {
                if !res.is_empty() {
                    res.push('\\');
                }
                res.extend(&chars[(last_slash + 1) as usize..i]);
                last_segment_length = (i as isize - last_slash - 1) as usize;
            }
            last_slash = i as isize;
            dots = 0;
        } else if code == '.' && dots != -1 {
            dots += 1;
        } else {
            dots = -1;
        }
    }
    res.into_iter().collect()
}

/// Node's `path.win32.normalize` for the absolute paths actions.ts lets
/// through (a drive path or a UNC path). Moves with the path helpers.
pub fn win32_normalize(path: &str) -> String {
    let chars: Vec<char> = path.chars().collect();
    let len = chars.len();
    if len == 0 {
        return ".".into();
    }
    if len == 1 {
        return if chars[0] == '/' {
            "\\".into()
        } else {
            path.into()
        };
    }
    let slice = |from: usize, to: usize| chars[from..to].iter().collect::<String>();
    let mut root_end = 0usize;
    let mut device: Option<String> = None;
    let mut absolute = false;
    if is_separator(chars[0]) {
        absolute = true;
        if is_separator(chars[1]) {
            let mut j = 2;
            let mut last = j;
            while j < len && !is_separator(chars[j]) {
                j += 1;
            }
            if j < len && j != last {
                let first = slice(last, j);
                last = j;
                while j < len && is_separator(chars[j]) {
                    j += 1;
                }
                if j < len && j != last {
                    last = j;
                    while j < len && !is_separator(chars[j]) {
                        j += 1;
                    }
                    if j == len {
                        return format!("\\\\{first}\\{}\\", slice(last, len));
                    }
                    if j != last {
                        device = Some(format!("\\\\{first}\\{}", slice(last, j)));
                        root_end = j;
                    }
                }
            }
        } else {
            root_end = 1;
        }
    } else if chars[0].is_ascii_alphabetic() && chars[1] == ':' {
        device = Some(slice(0, 2));
        root_end = 2;
        if len > 2 && is_separator(chars[2]) {
            absolute = true;
            root_end = 3;
        }
    }
    let mut tail = if root_end < len {
        normalize_string(&slice(root_end, len), !absolute)
    } else {
        String::new()
    };
    if tail.is_empty() && !absolute {
        tail = ".".into();
    }
    if !tail.is_empty() && is_separator(chars[len - 1]) {
        tail.push('\\');
    }
    match device {
        None if absolute => format!("\\{tail}"),
        None => tail,
        Some(device) if absolute => format!("{device}\\{tail}"),
        Some(device) => format!("{device}{tail}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn ids_paths_and_checkouts_read_as_the_ts_does() {
        assert_eq!(
            validate_connection_id(Some(&json!("w1:p1"))).unwrap(),
            "w1:p1"
        );
        assert!(validate_connection_id(Some(&json!(""))).is_err());
        assert!(validate_connection_id(Some(&json!("invalid/id"))).is_err());
        assert!(validate_connection_id(Some(&json!("w".repeat(129)))).is_err());
        assert_eq!(
            sanitize_explorer_path(Some(&json!("src\\main.ts"))).unwrap(),
            "src/main.ts"
        );
        assert!(sanitize_explorer_path(Some(&json!("src/../../x"))).is_err());
        assert_eq!(
            worktree_checkout_path("/srv/trees/", "feature/ranger").unwrap(),
            "/srv/trees/feature-ranger"
        );
        assert!(worktree_checkout_path("/srv", "///").is_err());
        assert_eq!(
            checkout_path(&json!({"cwd": "/a", "worktree": {"checkout_path": "/b"}})),
            "/b"
        );
        assert_eq!(
            win32_normalize("C:\\Users\\.\\x\\..\\project"),
            "C:\\Users\\project"
        );
        assert_eq!(win32_normalize("C:/a//b/"), "C:\\a\\b\\");
        assert_eq!(
            win32_normalize("\\\\server\\share\\x"),
            "\\\\server\\share\\x"
        );
        assert_eq!(win32_normalize("\\\\server\\share"), "\\\\server\\share\\");
    }
}
