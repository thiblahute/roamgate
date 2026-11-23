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
