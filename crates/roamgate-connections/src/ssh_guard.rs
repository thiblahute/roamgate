//! Why this Roamgate may not connect to SSH hosts
//! (server/src/connections/ssh-guard.ts): with a HOME of its own (a test
//! server) it has none of the real Roamgate's leases, and on a host it
//! would bind the same Roamgate socket over the real one.
//! `ROAMGATE_ALLOW_SSH=1` connects anyway.

use roamgate_base::env::Env;

/// The refusal, or None when SSH hosts may be reached. `account_home` is
/// the account's home directory ("" when unknown).
pub fn ssh_refusal(env: &dyn Env, account_home: &str) -> Option<String> {
    if env.var("ROAMGATE_ALLOW_SSH").as_deref() == Some("1") {
        return None;
    }
    let home = env.var("HOME").filter(|home| !home.is_empty())?;
    if account_home.is_empty() {
        return None;
    }
    let resolve = |path: &str| roamgate_base::paths::resolve(std::path::Path::new(path));
    if resolve(&home) == resolve(account_home) {
        return None;
    }
    Some(format!(
        "This Roamgate runs with its own HOME ({home}), as a test server does, so it does not connect to SSH hosts: it would take the host's Roamgate socket from the real one. Set ROAMGATE_ALLOW_SSH=1 to connect anyway."
    ))
}

/// The account's home directory from the password database (Node's
/// `os.userInfo().homedir`), "" when unknown.
pub fn account_home() -> String {
    #[cfg(unix)]
    {
        // SAFETY-free: getpwuid_r through std is not exposed; read /etc/passwd
        // for the current uid as Node's libuv does through getpwuid_r.
        let uid = rustix::process::getuid().as_raw();
        if let Ok(passwd) = std::fs::read_to_string("/etc/passwd") {
            for line in passwd.lines() {
                let fields: Vec<&str> = line.split(':').collect();
                if fields.len() >= 6 && fields[2].parse::<u32>().ok() == Some(uid) {
                    return fields[5].to_owned();
                }
            }
        }
        String::new()
    }
    #[cfg(not(unix))]
    {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_server_with_a_home_of_its_own_refuses_ssh_hosts_unless_allowed() {
        assert_eq!(ssh_refusal(&[("HOME", "/Users/me")], "/Users/me"), None);
        assert_eq!(ssh_refusal(&[("HOME", "/Users/me/")], "/Users/me"), None);
        let refusal = ssh_refusal(&[("HOME", "/tmp/test-home")], "/Users/me").unwrap();
        assert!(refusal.contains("own HOME (/tmp/test-home)"), "{refusal}");
        assert!(refusal.contains("ROAMGATE_ALLOW_SSH=1"), "{refusal}");
        assert_eq!(
            ssh_refusal(
                &[("HOME", "/tmp/test-home"), ("ROAMGATE_ALLOW_SSH", "1")],
                "/Users/me"
            ),
            None
        );
        // No HOME (Windows sets USERPROFILE), or no account home known.
        assert_eq!(ssh_refusal(&[("USERPROFILE", "x")], "C:\\Users\\me"), None);
        assert_eq!(ssh_refusal(&[("HOME", "/tmp/x")], ""), None);
    }
}
