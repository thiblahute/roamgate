//! The generated login token (config/auth-token): 64 lowercase hex digits
//! and a newline in `<data>/auth-token`, 0600, read without following a
//! symlink, created once and never replaced by a concurrent creator (the
//! data paths' publish keeps the winner).

use std::io::Read;
use std::path::Path;

use roamgate_base::paths::DataContext;
use roamgate_base::private::{OpenMode, open_nofollow, set_file_mode};

pub use roamgate_base::credentials::{
    MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, RECOMMENDED_PASSWORD_LENGTH,
};

fn is_token(text: &str) -> bool {
    text.len() == 64
        && text
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Why a read failed, as Bun's `openSync` and `readFileSync` word it.
pub(crate) fn open_error(error: &std::io::Error, path: &Path) -> String {
    let path = path.display();
    // Not found is ENOENT on Windows too, for a missing directory as well
    // (ERROR_PATH_NOT_FOUND), as libuv maps it.
    if error.kind() == std::io::ErrorKind::NotFound {
        return format!("ENOENT: no such file or directory, open '{path}'");
    }
    match error.raw_os_error() {
        Some(13) => format!("EACCES: permission denied, open '{path}'"),
        Some(40) => format!("ELOOP: too many symbolic links encountered, open '{path}'"),
        Some(21) => "EISDIR: illegal operation on a directory, read".into(),
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

/// Whether the password is shorter than recommended (Unicode characters).
pub fn is_short_auth_password(password: &str) -> bool {
    password.chars().count() < RECOMMENDED_PASSWORD_LENGTH
}

/// `<data>/auth-token`: APPDATA on Windows. Separators collapsed as Node's
/// `join` does, so a HOME ending in one prints `~/.config/...`.
pub fn default_auth_token_path(data: &DataContext) -> std::io::Result<std::path::PathBuf> {
    let path = data.default_data_file(roamgate_base::paths::DataFile::AuthToken)?;
    Ok(path.components().collect())
}

/// What follows `root` in `path` after a separator, keeping the boundary
/// even when the root ends in one.
fn path_under<'a>(path: &'a str, root: Option<&str>) -> Option<&'a str> {
    let root = root.filter(|root| !root.is_empty())?;
    let prefix = root.trim_end_matches(['/', '\\']);
    let rest = path.strip_prefix(prefix)?;
    rest.strip_prefix(['/', '\\'])
}

/// A host shell command that prints the generated token, for the login
/// page. It names the file relative to the home or APPDATA directory so the
/// unauthenticated page never reveals the account name.
pub fn auth_token_print_command(
    path: &str,
    home: &str,
    platform: roamgate_base::paths::Platform,
    app_data: Option<&str>,
) -> Option<String> {
    if platform == roamgate_base::paths::Platform::Windows {
        let in_app_data = path_under(path, app_data);
        let in_home = if in_app_data.is_none() {
            path_under(path, Some(home))
        } else {
            None
        };
        let rest = in_app_data.or(in_home)?;
        if rest.contains(['"', '`', '$']) {
            return None;
        }
        let root = if in_app_data.is_none() {
            "$HOME"
        } else {
            "$env:APPDATA"
        };
        return Some(format!(
            "Get-Content \"{root}\\{}\"",
            rest.replace('/', "\\")
        ));
    }
    let rest = path_under(path, Some(home))?;
    let safe = !rest.is_empty()
        && rest
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '-'));
    safe.then(|| format!("cat ~/{rest}"))
}

/// Replace the generated token; running servers keep the old one until
/// restart.
pub fn rotate_auth_token(data: &DataContext, path: &Path) -> Result<String, String> {
    let message = |error: std::io::Error| open_error(&error, path);
    data.assert_safe_data_path(path).map_err(message)?;
    let token = hex::encode(rand::random::<[u8; 32]>());
    data.replace_data_file(path, format!("{token}\n").as_bytes(), 0o600)
        .map_err(message)?;
    read_auth_token(path).map_err(message)
}

#[cfg(test)]
mod print_tests {
    use roamgate_base::paths::Platform;

    use super::*;

    #[test]
    fn flags_passwords_shorter_than_the_recommended_length() {
        assert!(is_short_auth_password(&"a".repeat(14)));
        assert!(is_short_auth_password(&"\u{1f600}".repeat(14)));
        assert!(!is_short_auth_password(&"a".repeat(15)));
        assert!(!is_short_auth_password(&"\u{1f600}".repeat(15)));
    }

    #[test]
    fn uses_appdata_for_the_windows_token() {
        let home = tempfile::tempdir().unwrap();
        let app_data = home.path().join("AppData").join("Roaming");
        let data = DataContext::new(home.path(), Platform::Windows, Some(app_data.clone()));
        assert_eq!(
            default_auth_token_path(&data).unwrap(),
            app_data.join("roamgate").join("auth-token")
        );
    }

    #[test]
    fn prints_the_token_without_revealing_the_account_name() {
        let home = "C:\\Users\\tester";
        let app_data = "C:\\Users\\tester\\AppData\\Roaming";
        assert_eq!(
            auth_token_print_command(
                &format!("{app_data}\\roamgate\\auth-token"),
                home,
                Platform::Windows,
                Some(app_data)
            )
            .unwrap(),
            "Get-Content \"$env:APPDATA\\roamgate\\auth-token\""
        );
        assert_eq!(
            auth_token_print_command(
                &format!("{home}\\.config\\roamgate\\auth-token"),
                home,
                Platform::Windows,
                None
            )
            .unwrap(),
            "Get-Content \"$HOME\\.config\\roamgate\\auth-token\""
        );
        for user in ["/home/tester", "/Users/tester"] {
            assert_eq!(
                auth_token_print_command(
                    &format!("{user}/.config/roamgate/auth-token"),
                    user,
                    Platform::Unix,
                    None
                )
                .unwrap(),
                "cat ~/.config/roamgate/auth-token"
            );
        }
    }

    #[test]
    fn prints_the_default_token_command_with_trailing_home_separators() {
        let home = tempfile::tempdir().unwrap();
        let home = home.path().to_str().unwrap().to_owned();
        for suffix in ["/", "//"] {
            let with = format!("{home}{suffix}");
            let data = DataContext::new(&with, Platform::Unix, None);
            let path = default_auth_token_path(&data).unwrap();
            assert_eq!(
                auth_token_print_command(path.to_str().unwrap(), &with, Platform::Unix, Some(""))
                    .unwrap(),
                "cat ~/.config/roamgate/auth-token"
            );
        }
    }

    #[test]
    fn handles_filesystem_root_home_without_losing_the_boundary() {
        assert_eq!(
            auth_token_print_command("/.config/roamgate/auth-token", "/", Platform::Unix, None)
                .unwrap(),
            "cat ~/.config/roamgate/auth-token"
        );
        assert_eq!(
            auth_token_print_command("relative/auth-token", "/", Platform::Unix, None),
            None
        );
    }

    #[test]
    fn prints_windows_commands_with_trailing_appdata_or_home_separators() {
        let home = "C:\\Users\\tester";
        let app_data = format!("{home}\\AppData\\Roaming");
        for suffix in ["\\", "\\\\", "/"] {
            assert_eq!(
                auth_token_print_command(
                    &format!("{app_data}\\roamgate\\auth-token"),
                    home,
                    Platform::Windows,
                    Some(&format!("{app_data}{suffix}"))
                )
                .unwrap(),
                "Get-Content \"$env:APPDATA\\roamgate\\auth-token\""
            );
            assert_eq!(
                auth_token_print_command(
                    &format!("{home}\\.config\\roamgate\\auth-token"),
                    &format!("{home}{suffix}"),
                    Platform::Windows,
                    Some("")
                )
                .unwrap(),
                "Get-Content \"$HOME\\.config\\roamgate\\auth-token\""
            );
            assert_eq!(
                auth_token_print_command(
                    &format!("{app_data}Extra\\auth-token"),
                    "C:\\OtherUser",
                    Platform::Windows,
                    Some(&format!("{app_data}{suffix}"))
                ),
                None
            );
        }
    }

    #[test]
    fn keeps_adjacent_prefixes_and_unsafe_shell_paths_omitted() {
        assert_eq!(
            auth_token_print_command(
                "/home/tester-other/auth-token",
                "/home/tester/",
                Platform::Unix,
                None
            ),
            None
        );
        for name in ["token name", "token;echo", "token$HOME"] {
            assert_eq!(
                auth_token_print_command(
                    &format!("/home/tester/{name}"),
                    "/home/tester/",
                    Platform::Unix,
                    None
                ),
                None
            );
        }
        for name in ["token\"", "token`", "token$HOME"] {
            assert_eq!(
                auth_token_print_command(
                    &format!("C:\\Users\\tester\\{name}"),
                    "C:\\Users\\tester\\",
                    Platform::Windows,
                    Some("")
                ),
                None
            );
        }
    }

    #[test]
    fn omits_the_token_command_outside_the_home_directory() {
        for path in ["/srv/roamgate/auth-token", "/home/testerx/auth-token"] {
            assert_eq!(
                auth_token_print_command(path, "/home/tester", Platform::Unix, None),
                None
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn replaces_the_token_atomically_with_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let home = tempfile::tempdir().unwrap();
        let data = DataContext::new(home.path(), Platform::Unix, None);
        let path = data.data_root().join("auth-token");
        let original = load_or_create_auth_token(&data, &path).unwrap();
        let rotated = rotate_auth_token(&data, &path).unwrap();
        assert!(is_token(&rotated));
        assert_ne!(rotated, original);
        assert_eq!(
            std::fs::read_to_string(&path).unwrap(),
            format!("{rotated}\n")
        );
        assert_eq!(
            std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_symlinked_token_paths() {
        let home = tempfile::tempdir().unwrap();
        let data = DataContext::new(home.path(), Platform::Unix, None);
        let path = data.data_root().join("auth-token");
        load_or_create_auth_token(&data, &path).unwrap();
        let link = home.path().join("link-token");
        std::os::unix::fs::symlink(&path, &link).unwrap();
        let error = rotate_auth_token(&data, &link).unwrap_err();
        assert!(error.contains("symlink"), "{error}");
    }
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
