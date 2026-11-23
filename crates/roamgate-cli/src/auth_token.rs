//! The generated login token (config/auth-token): 64 lowercase hex digits
//! and a newline in `<data>/auth-token`, 0600, read without following a
//! symlink, created once and never replaced by a concurrent creator (the
//! data paths' publish keeps the winner).

use std::io::Read;
use std::path::Path;

use roamgate_base::paths::DataContext;
use roamgate_base::private::{OpenMode, open_nofollow, set_file_mode};

pub const MIN_PASSWORD_LENGTH: usize = 8;
pub const MAX_PASSWORD_LENGTH: usize = 1024;

fn is_token(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Why a read failed, as Bun's `openSync` words it.
fn open_error(error: &std::io::Error, path: &Path) -> String {
    let path = path.display();
    match error.raw_os_error() {
        Some(2) => format!("ENOENT: no such file or directory, open '{path}'"),
        Some(13) => format!("EACCES: permission denied, open '{path}'"),
        Some(40) => format!("ELOOP: too many symbolic links encountered, open '{path}'"),
        _ => error.to_string(),
    }
}

/// The token in `path` (its mode set back to 0600); an error unless it is
/// a regular file holding one.
pub fn read_auth_token(path: &Path) -> Result<String, std::io::Error> {
    let mut file = open_nofollow(path, OpenMode::Read)?;
    if !file.metadata()?.is_file() {
        return Err(std::io::Error::other(format!(
            "generated auth token path is not a regular file: {}",
            path.display()
        )));
    }
    let mut text = String::new();
    file.read_to_string(&mut text)?;
    let token = text.trim();
    if !is_token(token) {
        return Err(std::io::Error::other(format!(
            "invalid generated auth token in {}; restore a valid token or replace it with a fresh 64-character lowercase hexadecimal secret",
            path.display()
        )));
    }
    set_file_mode(&file, 0o600)?;
    Ok(token.to_owned())
}

/// The token in `path`, created when there is none.
pub fn load_or_create_auth_token(data: &DataContext, path: &Path) -> Result<String, String> {
    let message = |error: std::io::Error| open_error(&error, path);
    data.assert_safe_data_path(path).map_err(message)?;
    match read_auth_token(path) {
        Ok(token) => return Ok(token),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(message(error)),
    }
    let token = hex::encode(rand::random::<[u8; 32]>());
    data.publish_data_file(path, format!("{token}\n").as_bytes(), 0o600)
        .map_err(message)?;
    read_auth_token(path).map_err(message)
}

#[cfg(all(test, unix))]
mod tests {
    use std::os::unix::fs::PermissionsExt;

    use roamgate_base::paths::Platform;

    use super::*;

    #[test]
    fn creates_once_keeps_and_repairs_the_token() {
        let home = tempfile::tempdir().unwrap();
        let data = DataContext::new(home.path(), Platform::Unix, None);
        let path = data.data_root().join("auth-token");
        let token = load_or_create_auth_token(&data, &path).unwrap();
        assert!(is_token(&token));
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{token}\n")
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(load_or_create_auth_token(&data, &path).unwrap(), token);
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        std::fs::write(&path, "nope\n").unwrap();
        let error = load_or_create_auth_token(&data, &path).unwrap_err();
        assert!(
            error.starts_with("invalid generated auth token in "),
            "{error}"
        );
        std::fs::remove_file(&path).unwrap();
        std::os::unix::fs::symlink(home.path().join("elsewhere"), &path).unwrap();
        let error = load_or_create_auth_token(&data, &path).unwrap_err();
        assert!(error.contains("symlink"), "{error}");
    }
}
