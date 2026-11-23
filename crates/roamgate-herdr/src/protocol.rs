//! The Herdr protocols this build talks (bridge/protocol-compat): 14 to 20
//! and 22; 21 and anything newer is refused.

use serde_json::Value;

pub const MINIMUM_HERDR_PROTOCOL: i64 = 14;
pub const MAXIMUM_HERDR_PROTOCOL: i64 = 22;

/// Whether a ping's `protocol` is one this build supports.
pub fn is_supported_herdr_protocol(protocol: &Value) -> bool {
    let Some(number) = protocol.as_f64() else {
        return false;
    };
    if number.fract() != 0.0 || number.abs() > 9_007_199_254_740_991.0 {
        return false;
    }
    let protocol = number as i64;
    (MINIMUM_HERDR_PROTOCOL..=20).contains(&protocol) || protocol == 22
}

/// Refuses an unsupported protocol with the message the TS build gives.
pub fn assert_supported_herdr_protocol(protocol: &Value) -> Result<(), String> {
    if is_supported_herdr_protocol(protocol) {
        return Ok(());
    }
    let actual = match protocol {
        Value::Number(number) => js_number_text(number),
        Value::String(text) => text
            .chars()
            .map(|character| {
                if (character as u32) < 0x20 || (0x7f..=0x9f).contains(&(character as u32)) {
                    '?'
                } else {
                    character
                }
            })
            .collect::<String>(),
        _ => "unknown".into(),
    };
    let actual = roamgate_base::log::slice_utf16(&actual, 20);
    Err(format!(
        "Herdr protocol {actual} is not supported by this Roamgate build (supports protocols 14-20 and 22). Use a Roamgate release explicitly supporting this server, or a separate compatible server. Do not downgrade a live server."
    ))
}

fn js_number_text(number: &serde_json::Number) -> String {
    roamgate_base::log::js_number(number)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn accepts_14_to_20_and_22_only() {
        for good in [14, 20, 22] {
            assert!(is_supported_herdr_protocol(&json!(good)));
        }
        for bad in [
            json!(13),
            json!(21),
            json!(23),
            json!(22.5),
            json!("22"),
            Value::Null,
        ] {
            assert!(!is_supported_herdr_protocol(&bad), "{bad}");
        }
        let error = assert_supported_herdr_protocol(&json!(21)).unwrap_err();
        assert!(
            error.starts_with("Herdr protocol 21 is not supported"),
            "{error}"
        );
        assert!(
            assert_supported_herdr_protocol(&Value::Null)
                .unwrap_err()
                .starts_with("Herdr protocol unknown ")
        );
    }
}
