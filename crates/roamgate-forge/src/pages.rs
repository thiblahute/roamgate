//! REST pages (review/forge-cli.ts `parseJsonPages`): `glab api --paginate`
//! and `gh api --paginate` print one JSON document per page back to back;
//! this splits them. A bare value is one page.

use serde_json::Value;

/// The pages of a paginated answer.
pub fn parse_json_pages(text: &str) -> Result<Vec<Value>, String> {
    let whole = || {
        serde_json::from_str::<Value>(text)
            .map(|v| vec![v])
            .map_err(|e| e.to_string())
    };
    let bytes = text.as_bytes();
    let mut values = Vec::new();
    let mut depth: i64 = 0;
    let mut start = 0;
    let mut in_string = false;
    let mut escaped = false;
    for (i, &byte) in bytes.iter().enumerate() {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
            continue;
        }
        match byte {
            b'"' => {
                // A bare string or number on its own is not a page.
                if depth == 0 {
                    return whole();
                }
                in_string = true;
            }
            b'[' | b'{' => {
                if depth == 0 {
                    start = i;
                }
                depth += 1;
            }
            b']' | b'}' => {
                depth -= 1;
                if depth < 0 {
                    return Err("GitLab: malformed answer".into());
                }
                if depth == 0 {
                    values.push(serde_json::from_str(&text[start..=i]).map_err(|e| e.to_string())?);
                }
            }
            _ if depth == 0 && !byte.is_ascii_whitespace() => return whole(),
            _ => {}
        }
    }
    if depth != 0 || in_string {
        return Err("GitLab: truncated answer".into());
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pages_back_to_back_are_split_and_a_bare_value_is_one() {
        assert_eq!(
            parse_json_pages("[1,\"]\"]\n[{\"a\":\"}\\\"\"}]").unwrap(),
            vec![json!([1, "]"]), json!([{"a": "}\""}])]
        );
        assert_eq!(parse_json_pages("42").unwrap(), vec![json!(42)]);
        assert_eq!(parse_json_pages("").unwrap(), Vec::<Value>::new());
        assert_eq!(
            parse_json_pages("[1]]").unwrap_err(),
            "GitLab: malformed answer"
        );
        assert_eq!(
            parse_json_pages("[1").unwrap_err(),
            "GitLab: truncated answer"
        );
    }
}
