//! The login credentials' rules (config/auth-token): what the CLI checks
//! at start and the front checks again when it builds its handlers.

pub const MIN_PASSWORD_LENGTH: usize = 8;
pub const MAX_PASSWORD_LENGTH: usize = 1024;
/// Shorter passwords are accepted, but startup warns about them.
pub const RECOMMENDED_PASSWORD_LENGTH: usize = 15;

pub fn assert_valid_auth_password(password: &str) -> Result<(), String> {
    let length = password.chars().count();
    if !(MIN_PASSWORD_LENGTH..=MAX_PASSWORD_LENGTH).contains(&length) {
        return Err(format!(
            "Login password must contain at least {MIN_PASSWORD_LENGTH} characters and at most {MAX_PASSWORD_LENGTH} characters (--password or ROAMGATE_PASSWORD)."
        ));
    }
    Ok(())
}

pub fn assert_valid_auth_pin(pin: &str) -> Result<(), String> {
    let valid = (6..=12).contains(&pin.len()) && pin.bytes().all(|byte| byte.is_ascii_digit());
    if !valid {
        return Err("ROAMGATE_PIN must contain 6 to 12 ASCII digits.".into());
    }
    Ok(())
}

/// `withLoginToken` (config/server-config.ts): the browser URL that logs in
/// with the generated token (`searchParams.set("token", ...)`).
pub fn with_login_token(address: &str, token: Option<&str>) -> String {
    let Some(token) = token.filter(|token| !token.is_empty()) else {
        return address.to_owned();
    };
    let Ok(mut url) = url::Url::parse(address) else {
        return address.to_owned();
    };
    let mut pairs: Vec<(String, String)> = url
        .query_pairs()
        .map(|(name, value)| (name.into_owned(), value.into_owned()))
        .collect();
    match pairs.iter().position(|(name, _)| name == "token") {
        Some(first) => {
            pairs[first].1 = token.to_owned();
            let mut index = 0;
            pairs.retain(|(name, _)| {
                index += 1;
                index - 1 == first || name != "token"
            });
        }
        None => pairs.push(("token".into(), token.into())),
    }
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (name, value) in &pairs {
        serializer.append_pair(name, value);
    }
    url.set_query(Some(&serializer.finish()));
    url.to_string()
}
