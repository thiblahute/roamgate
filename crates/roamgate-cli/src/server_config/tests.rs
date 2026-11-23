//! The server-config tests of the TS suite that are about reading the
//! configuration (config/server-config.test.ts).

use std::collections::HashMap;

use super::*;

fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs
        .iter()
        .map(|(key, value)| ((*key).to_owned(), (*value).to_owned()))
        .collect()
}

fn args(list: &[&str]) -> Vec<String> {
    list.iter().map(|arg| (*arg).to_owned()).collect()
}

fn runtime(home: &Path) -> ConfigRuntime {
    ConfigRuntime {
        platform: "linux".into(),
        home: home.into(),
        app_data: Some(home.into()),
        tmp: PathBuf::from("/tmp"),
    }
}

fn load(list: &[&str], pairs: &[(&str, &str)], home: &Path) -> Result<ServerConfig, Printed> {
    load_server_config(&args(list), &env(pairs), &runtime(home), "test")
}

fn no_data_dirs(home: &Path) -> bool {
    !home.join(".config/roamgate").exists() && !home.join("roamgate").exists()
}

#[test]
fn compiled_authentication_reads_runtime_node_env_instead_of_the_build_value() {
    let home = tempfile::tempdir().unwrap();
    for (node_env, host, required) in [
        (Some("production"), "127.0.0.1", true),
        (Some("development"), "127.0.0.1", false),
        (Some("development"), "0.0.0.0", true),
        (None, "127.0.0.1", true),
    ] {
        let mut pairs = vec![];
        if let Some(node_env) = node_env {
            pairs.push(("NODE_ENV", node_env));
        }
        let config = load(
            &["--host", host, "--password", "compiled-test-password"],
            &pairs,
            home.path(),
        )
        .unwrap();
        assert_eq!(config.auth_required, required);
        assert_eq!(
            config.password,
            if required {
                "compiled-test-password"
            } else {
                ""
            }
        );
    }
}

#[test]
fn production_requires_authentication_and_persists_a_token_on_every_listen_address() {
    let home = tempfile::tempdir().unwrap();
    let mut token: Option<String> = None;
    for host in ["127.0.0.1", "localhost", "::1", "0.0.0.0"] {
        let config = load(
            &["--host", host],
            &[("NODE_ENV", "production")],
            home.path(),
        )
        .unwrap();
        assert!(config.auth_required);
        assert_eq!(config.password.len(), 64);
        assert_eq!(
            config.generated_auth_token.as_deref(),
            Some(config.password.as_str())
        );
        let path = config.generated_auth_token_path.clone().unwrap();
        assert_eq!(
            std::fs::read_to_string(path).unwrap().trim(),
            config.password
        );
        if let Some(token) = &token {
            assert_eq!(&config.password, token);
        }
        token = Some(config.password);
    }
}

/// `NODE_ENV=%s HOST=%s requires authentication: %s`.
#[test]
fn node_env_and_host_decide_whether_authentication_is_required() {
    for (node_env, host, required) in [
        (Some("development"), "127.0.0.1", false),
        (Some("development"), "localhost", false),
        (Some("development"), "::1", false),
        (Some("development"), "0.0.0.0", true),
        (Some("development"), "::", true),
        (Some("development"), "192.0.2.10", true),
        (Some("development"), "127.0.0.2", true),
        (Some("development"), "::ffff:127.0.0.1", true),
        (Some("production"), "127.0.0.1", true),
        (Some("production"), "localhost", true),
        (Some("production"), "::1", true),
        (Some("test"), "127.0.0.1", true),
        (Some("test"), "localhost", true),
        (Some("test"), "::1", true),
        (None, "127.0.0.1", true),
        (None, "localhost", true),
        (None, "::1", true),
    ] {
        let home = tempfile::tempdir().unwrap();
        let mut pairs = vec![];
        if let Some(node_env) = node_env {
            pairs.push(("NODE_ENV", node_env));
        }
        let config = load(&["--host", host], &pairs, home.path()).unwrap();
        assert_eq!(config.auth_required, required, "{node_env:?} {host}");
        if required {
            assert_eq!(config.password.len(), 64);
            assert_eq!(
                config.generated_auth_token.as_deref(),
                Some(config.password.as_str())
            );
        } else {
            assert_eq!(config.password, "");
            assert_eq!(config.generated_auth_token, None);
            assert_eq!(config.generated_auth_token_path, None);
            assert!(no_data_dirs(home.path()));
        }
    }
}

#[test]
fn rejects_cli_and_environment_passwords_outside_8_1024_characters() {
    let long = "a".repeat(1025);
    for password in ["short", long.as_str()] {
        let home = tempfile::tempdir().unwrap();
        for source in ["cli", "ROAMGATE_PASSWORD", "HERDR_GUI_PASSWORD"] {
            let mut list = vec!["--host", "127.0.0.1"];
            let mut pairs = vec![("NODE_ENV", "production")];
            if source == "cli" {
                list.extend(["--password", password]);
            } else {
                pairs.push((source, password));
            }
            let exit = load(&list, &pairs, home.path()).unwrap_err();
            assert_eq!(exit.code, 2);
            assert!(
                exit.stderr
                    .contains("at least 8 characters and at most 1024 characters")
            );
            assert!(no_data_dirs(home.path()));
        }
    }
}

#[test]
fn uses_appdata_on_win32() {
    let app_data = Path::new("C:").join("AppData").join("Roaming");
    assert_eq!(
        herdr_config_dir("win32", Some(&app_data), Path::new("/h")),
        app_data.join("herdr")
    );
}

#[test]
fn falls_back_under_the_home_directory_on_win32_without_appdata() {
    let home = Path::new("C:").join("Users").join("me");
    assert_eq!(
        herdr_config_dir("win32", None, &home),
        home.join("AppData").join("Roaming").join("herdr")
    );
}

#[test]
fn uses_the_xdg_style_config_dir_on_other_platforms() {
    assert_eq!(
        herdr_config_dir("linux", None, Path::new("/home/me")),
        Path::new("/home/me/.config/herdr")
    );
}

#[test]
fn prefers_the_cli_value_over_the_environment() {
    assert_eq!(
        resolve_server_log_level(Some("debug"), Some("error")),
        Ok(LogLevel::Debug)
    );
    assert_eq!(
        resolve_server_log_level(None, Some("warn")),
        Ok(LogLevel::Warn)
    );
    assert_eq!(resolve_server_log_level(None, None), Ok(LogLevel::Info));
    let home = tempfile::tempdir().unwrap();
    let exit = load(&["--log-level", "loud"], &[], home.path()).unwrap_err();
    assert_eq!(exit.code, 2);
    assert!(
        exit.stderr
            .starts_with("[bridge] invalid log level \"loud\""),
        "{}",
        exit.stderr
    );
}

#[test]
fn is_opt_in_and_bounds_capture_duration() {
    let root = Path::new("/data");
    assert_eq!(resolve_server_profile(false, None, None, root), Ok(None));
    assert_eq!(
        resolve_server_profile(true, None, None, root)
            .unwrap()
            .unwrap()
            .duration_ms,
        30_000
    );
    let tmp = std::env::temp_dir();
    assert_eq!(
        resolve_server_profile(true, Some("300"), tmp.to_str(), root),
        Ok(Some(ProfileConfig {
            duration_ms: 300_000,
            directory: roamgate_base::paths::resolve(&tmp),
        }))
    );
    for duration in ["", "0", "-1", "301", "NaN", "Infinity", "1.5"] {
        let error = resolve_server_profile(true, Some(duration), None, root).unwrap_err();
        assert!(error.contains("1 to 300"), "{duration}");
    }
    assert!(
        resolve_server_profile(true, Some("30"), Some(" "), root)
            .unwrap_err()
            .contains("empty")
    );
}

#[test]
fn loads_cli_flags_with_precedence_over_environment_settings() {
    let home = tempfile::tempdir().unwrap();
    let tmp = std::env::temp_dir().display().to_string();
    let base = ["--host", "127.0.0.1", "--password", "test-password-long"];
    let mut pairs = vec![
        ("NODE_ENV", "production"),
        ("ROAMGATE_PROFILE", "1"),
        ("ROAMGATE_PROFILE_DURATION", "45"),
        ("ROAMGATE_PROFILE_DIR", tmp.as_str()),
    ];
    let config = load(&base, &pairs, home.path()).unwrap();
    assert_eq!(config.profile.unwrap().duration_ms, 45_000);
    pairs[1] = ("ROAMGATE_PROFILE", "0");
    assert_eq!(load(&base, &pairs, home.path()).unwrap().profile, None);
    let mut list = base.to_vec();
    list.extend([
        "--profile",
        "--profile-duration",
        "2",
        "--profile-dir",
        tmp.as_str(),
    ]);
    assert_eq!(
        load(&list, &pairs, home.path())
            .unwrap()
            .profile
            .unwrap()
            .duration_ms,
        2_000
    );
}

#[test]
fn keeps_http_by_default_and_rejects_incomplete_or_unreadable_tls_settings() {
    assert_eq!(load_server_tls(None, None), Ok(None));
    assert!(
        load_server_tls(Some("cert.pem"), None)
            .unwrap_err()
            .contains("requires both")
    );
    assert!(
        load_server_tls(None, Some("key.pem"))
            .unwrap_err()
            .contains("requires both")
    );
    assert_eq!(
        load_server_tls(
            Some("/nonexistent-roamgate-test/cert.pem"),
            Some("/nonexistent-roamgate-test/key.pem")
        ),
        Err("Invalid TLS configuration: ENOENT: no such file or directory, open '/nonexistent-roamgate-test/cert.pem'".into())
    );
    assert_eq!(
        browser_url_for("0.0.0.0", 8787, false),
        "http://localhost:8787"
    );
    assert_eq!(
        browser_url_for("0.0.0.0", 8443, true),
        "https://localhost:8443"
    );
    assert_eq!(
        browser_url_for("192.0.2.10", 8443, true),
        "https://192.0.2.10:8443"
    );
    assert_eq!(
        browser_url_for("2001:db8::1", 8443, true),
        "https://[2001:db8::1]:8443"
    );
    // An incomplete pair from the command is an exit 2, as Bun's.
    let home = tempfile::tempdir().unwrap();
    let exit = load(&["--tls-cert", "cert.pem"], &[], home.path()).unwrap_err();
    assert_eq!(
        exit,
        Printed {
            code: 2,
            stdout: String::new(),
            stderr: "[bridge] TLS requires both --tls-cert and --tls-key (or ROAMGATE_TLS_CERT and ROAMGATE_TLS_KEY).\n".into()
        }
    );
}

/// The PEM checks of createSecureContext, with BoringSSL's reasons (not a
/// TS row by itself: its row also serves HTTPS, which is the front's).
#[test]
fn loads_pem_files_and_gives_boringssl_s_reasons() {
    let dir = tempfile::tempdir().unwrap();
    let path = |name: &str| dir.path().join(name).display().to_string();
    let generate = |key: &str, cert: &str| {
        std::process::Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-sha256",
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
                "-keyout",
            ])
            .arg(path(key))
            .arg("-out")
            .arg(path(cert))
            .output()
            .is_ok_and(|output| output.status.success())
    };
    if !generate("key.pem", "cert.pem") || !generate("other-key.pem", "other-cert.pem") {
        return;
    }
    let loaded = load_server_tls(Some(&path("cert.pem")), Some(&path("key.pem")))
        .unwrap()
        .unwrap();
    assert_eq!(loaded.cert, std::fs::read(path("cert.pem")).unwrap());
    let invalid =
        |cert: &str, key: &str| load_server_tls(Some(&path(cert)), Some(&path(key))).unwrap_err();
    assert_eq!(
        invalid("cert.pem", "other-key.pem"),
        format!("Invalid TLS configuration: {KEY_VALUES_MISMATCH}")
    );
    std::fs::write(path("garbage.pem"), "not a PEM private key").unwrap();
    assert_eq!(
        invalid("cert.pem", "garbage.pem"),
        format!("Invalid TLS configuration: {NO_START_LINE}")
    );
    assert_eq!(
        invalid("garbage.pem", "key.pem"),
        format!("Invalid TLS configuration: {NO_START_LINE}")
    );
    assert_eq!(
        invalid("key.pem", "cert.pem"),
        format!("Invalid TLS configuration: {NO_START_LINE}")
    );
    let home = tempfile::tempdir().unwrap();
    let config = load(
        &[
            "--host",
            "127.0.0.1",
            "--tls-cert",
            &path("cert.pem"),
            "--tls-key",
            &path("key.pem"),
            "--password",
            "test-password-long",
        ],
        &[
            ("NODE_ENV", "production"),
            ("ROAMGATE_TLS_CERT", "missing-cert.pem"),
            ("ROAMGATE_TLS_KEY", "missing-key.pem"),
        ],
        home.path(),
    )
    .unwrap();
    assert_eq!(config.tls, Some(loaded));
}

/// The TS row's parts roamgate-cli owns: the PEM files load, the flags win
/// over the environment, the environment alone gives the same pair, a
/// service file with them gives https login URLs, and a key of another
/// certificate is refused. Serving HTTPS and WSS with them is the Rust
/// listener's (Phase 7), not here.
#[test]
fn loads_pem_files_honors_cli_precedence_and_serves_trusted_https_and_wss() {
    let dir = tempfile::tempdir().unwrap();
    let path = |name: &str| dir.path().join(name).display().to_string();
    std::fs::write(
        path("openssl.cnf"),
        "[req]\ndistinguished_name=dn\nx509_extensions=extensions\n[dn]\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
    )
    .unwrap();
    let generated = std::process::Command::new("openssl")
        .args([
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
        ])
        .args(["-subj", "/CN=localhost", "-keyout"])
        .arg(path("key.pem"))
        .arg("-out")
        .arg(path("cert.pem"))
        .arg("-config")
        .arg(path("openssl.cnf"))
        .output()
        .is_ok_and(|output| output.status.success());
    if !generated {
        return;
    }
    let tls = load_server_tls(Some(&path("cert.pem")), Some(&path("key.pem")))
        .unwrap()
        .unwrap();
    let home = tempfile::tempdir().unwrap();
    let flags = load(
        &[
            "--host",
            "127.0.0.1",
            "--tls-cert",
            &path("cert.pem"),
            "--tls-key",
            &path("key.pem"),
            "--password",
            "test-password-long",
        ],
        &[
            ("NODE_ENV", "production"),
            ("ROAMGATE_TLS_CERT", "missing-cert.pem"),
            ("ROAMGATE_TLS_KEY", "missing-key.pem"),
        ],
        home.path(),
    )
    .unwrap();
    assert_eq!(flags.tls.as_ref(), Some(&tls));
    let environment = load(
        &["--host", "127.0.0.1", "--password", "test-password-long"],
        &[
            ("NODE_ENV", "production"),
            ("ROAMGATE_TLS_CERT", &path("cert.pem")),
            ("ROAMGATE_TLS_KEY", &path("key.pem")),
        ],
        home.path(),
    )
    .unwrap();
    assert_eq!(environment.tls, Some(tls));
    // A service file with the pair: its login URLs are https.
    let contents = format!(
        "HOST=0.0.0.0\nPORT=8443\nROAMGATE_TLS_CERT={:?}\nROAMGATE_TLS_KEY={:?}\n",
        path("cert.pem"),
        path("key.pem")
    );
    let access = crate::service::prepare_service_access(
        "/env",
        &contents,
        roamgate_exec::service::ServicePlatform::Systemd,
        "/home/me",
    )
    .unwrap();
    assert!(access.tls);
    let urls = crate::service_context::access_urls(
        &crate::service_context::ServiceAccessInfo {
            host: access.host,
            port: access.port,
            tls: access.tls,
            password: false,
            token: Some("t".repeat(64)),
            token_error: None,
            token_path: "/x".into(),
            pin_enabled: false,
        },
        || vec!["192.0.2.10".into()],
    );
    assert!(urls.local.starts_with("https://localhost:8443/"));
    assert!(urls.lan[0].starts_with("https://192.0.2.10:8443/"));
    let other = std::process::Command::new("openssl")
        .args(["genrsa", "-out"])
        .arg(path("other-key.pem"))
        .arg("2048")
        .output()
        .is_ok_and(|output| output.status.success());
    assert!(other);
    assert!(
        load_server_tls(Some(&path("cert.pem")), Some(&path("other-key.pem")))
            .unwrap_err()
            .contains("Invalid TLS configuration")
    );
}

fn socket_config(list: &[&str], pairs: &[(&str, &str)]) -> ServerConfig {
    let home = tempfile::tempdir().unwrap();
    let mut all = vec!["--host", "127.0.0.1", "--password", "test-password-long"];
    all.extend_from_slice(list);
    let mut env = vec![("NODE_ENV", "production")];
    env.extend_from_slice(pairs);
    load(&all, &env, home.path()).unwrap()
}

#[test]
fn uses_stable_12_hex_sha_256_identifiers_for_each_socket_kind() {
    let args = ["--ssh-host", "alice@example.com", "--session", "work"];
    let first = socket_config(&args, &[]);
    let second = socket_config(&args, &[]);
    assert_eq!(first.socket_path, "/tmp/roamgate-cce73172d55b-control.sock");
    assert_eq!(
        first.client_socket_path,
        "/tmp/roamgate-4796b7bb06b9-client.sock"
    );
    assert_eq!(second.socket_path, first.socket_path);
    assert!(!first.has_explicit_socket_path && !first.has_explicit_client_socket_path);
}

#[test]
fn distinguishes_hosts_sessions_and_the_default_session() {
    let configs: Vec<ServerConfig> = [
        vec!["--ssh-host", "alice@example.com"],
        vec!["--ssh-host", "alice@example.com", "--session", "work"],
        vec!["--ssh-host", "bob@example.com", "--session", "work"],
        vec!["--ssh-host", "alice@example.com", "--session", "other"],
    ]
    .iter()
    .map(|args| socket_config(args, &[]))
    .collect();
    let controls: std::collections::BTreeSet<_> =
        configs.iter().map(|c| c.socket_path.clone()).collect();
    let clients: std::collections::BTreeSet<_> = configs
        .iter()
        .map(|c| c.client_socket_path.clone())
        .collect();
    assert_eq!((controls.len(), clients.len()), (4, 4));
    assert_eq!(
        configs[0].socket_path,
        "/tmp/roamgate-3c8b63447e14-control.sock"
    );
    assert_eq!(
        configs[0].client_socket_path,
        "/tmp/roamgate-d2b2306369cc-client.sock"
    );
}

#[test]
fn separates_host_and_session_fields_before_hashing() {
    let first = socket_config(&["--ssh-host", "host-a", "--session", "bc"], &[]);
    let second = socket_config(&["--ssh-host", "host-ab", "--session", "c"], &[]);
    assert_ne!(first.socket_path, second.socket_path);
    assert_ne!(first.client_socket_path, second.client_socket_path);
}

#[test]
fn keeps_long_host_and_session_inputs_out_of_socket_filenames() {
    let host = format!("{}@{}", "u".repeat(64), "h".repeat(253));
    let session = "s".repeat(1000);
    let config = socket_config(&["--ssh-host", &host, "--session", &session], &[]);
    for (path, kind) in [
        (&config.socket_path, "control"),
        (&config.client_socket_path, "client"),
    ] {
        let path = Path::new(path);
        assert_eq!(path.parent(), Some(Path::new("/tmp")));
        let name = path.file_name().unwrap().to_str().unwrap();
        assert_eq!(
            name.len(),
            format!("roamgate-000000000000-{kind}.sock").len()
        );
        assert!(path.as_os_str().len() < 100);
    }
}

/// `preserves explicit %s socket paths`.
#[test]
fn preserves_explicit_socket_paths() {
    for source in ["cli", "environment"] {
        let mut args = vec!["--ssh-host", "alice@example.com", "--session", "work"];
        if source == "cli" {
            args.extend([
                "--socket-path",
                "/tmp/explicit-control.sock",
                "--client-socket-path",
                "/tmp/explicit-client.sock",
            ]);
        }
        let (control, client) = if source == "cli" {
            ("/tmp/ignored-control.sock", "/tmp/ignored-client.sock")
        } else {
            ("/tmp/explicit-control.sock", "/tmp/explicit-client.sock")
        };
        let config = socket_config(
            &args,
            &[
                ("HERDR_SOCKET_PATH", control),
                ("HERDR_CLIENT_SOCKET_PATH", client),
            ],
        );
        assert_eq!(config.socket_path, "/tmp/explicit-control.sock");
        assert_eq!(config.client_socket_path, "/tmp/explicit-client.sock");
        assert!(config.has_explicit_socket_path && config.has_explicit_client_socket_path);
    }
}

/// `preserves local Herdr socket paths for session %s`.
#[test]
fn preserves_local_herdr_socket_paths_for_session() {
    for session in [None, Some("work")] {
        let home = tempfile::tempdir().unwrap();
        let mut list = vec!["--host", "127.0.0.1", "--password", "test-password-long"];
        if let Some(session) = session {
            list.extend(["--session", session]);
        }
        let config = load(&list, &[("NODE_ENV", "production")], home.path()).unwrap();
        let mut base = home.path().join(".config/herdr");
        if let Some(session) = session {
            base = base.join("sessions").join(session);
        }
        assert_eq!(
            config.socket_path,
            base.join("herdr.sock").display().to_string()
        );
        assert_eq!(
            config.client_socket_path,
            base.join("herdr-client.sock").display().to_string()
        );
        assert!(!config.has_explicit_socket_path && !config.has_explicit_client_socket_path);
    }
}

#[test]
fn maps_herdr_s_windows_socket_name_onto_its_named_pipe() {
    let logical = r"C:\AppData\Roaming\herdr\herdr.sock";
    let native = r"\\.\pipe\C:\AppData\Roaming\herdr\herdr.sock";
    assert_eq!(native_socket_path(logical, "win32"), native);
    assert_eq!(native_socket_path(native, "win32"), native);
    let upper = r"\\.\PIPE\existing";
    assert_eq!(native_socket_path(upper, "win32"), upper);
    assert_eq!(native_socket_path(logical, "linux"), logical);
}

#[test]
fn reading_configuration_for_management_commands_does_not_create_or_rotate_session_signing_state() {
    let home = tempfile::tempdir().unwrap();
    let state = home.path().join(".config/roamgate/session-secret.json");
    let load_with = |password: &str| {
        load(
            &[],
            &[("NODE_ENV", "production"), ("ROAMGATE_PASSWORD", password)],
            home.path(),
        )
        .unwrap();
    };
    load_with("first-test-password");
    assert!(!state.exists());
    std::fs::create_dir_all(state.parent().unwrap()).unwrap();
    std::fs::write(&state, "existing-signing-state").unwrap();
    load_with("other-test-password");
    load_with("");
    assert_eq!(
        std::fs::read_to_string(&state).unwrap(),
        "existing-signing-state"
    );
}

/// `validates ROAMGATE_PIN=%s without weakening the strong credential`.
#[test]
fn validates_roamgate_pin_without_weakening_the_strong_credential() {
    for pin in [
        None,
        Some(""),
        Some("012345"),
        Some("123456789012"),
        Some("12345"),
        Some("1234567890123"),
        Some("12345a"),
        Some(" 123456"),
        Some("\u{ff11}\u{ff12}\u{ff13}\u{ff14}\u{ff15}\u{ff16}"),
    ] {
        let home = tempfile::tempdir().unwrap();
        let mut pairs = vec![
            ("NODE_ENV", "production"),
            ("ROAMGATE_PASSWORD", "strong-test-password"),
        ];
        if let Some(pin) = pin {
            pairs.push(("ROAMGATE_PIN", pin));
        }
        let valid = pin.is_none_or(|pin| {
            pin.is_empty()
                || (6..=12).contains(&pin.len()) && pin.bytes().all(|b| b.is_ascii_digit())
        });
        match load(&[], &pairs, home.path()) {
            Ok(config) => {
                assert!(valid, "{pin:?}");
                assert_eq!(config.pin.as_deref(), pin.filter(|pin| !pin.is_empty()));
                assert_eq!(config.password, "strong-test-password");
                assert_eq!(config.generated_auth_token, None);
            }
            Err(exit) => {
                assert!(!valid, "{pin:?}");
                assert_eq!(exit.code, 2);
                assert!(exit.stderr.contains("6 to 12 ASCII digits"));
                assert!(!exit.stderr.contains(pin.unwrap()) || pin.unwrap().trim().is_empty());
            }
        }
        assert!(no_data_dirs(home.path()));
    }
}

#[test]
fn pin_keeps_generated_token_recovery_and_follows_environment_precedence() {
    let home = tempfile::tempdir().unwrap();
    let mut token: Option<String> = None;
    for (pin, legacy, expected) in [
        (None, "012345", Some("012345")),
        (Some(""), "012345", None),
        (Some("654321"), "invalid", Some("654321")),
    ] {
        let mut pairs = vec![
            ("NODE_ENV", "production"),
            ("ROAMGATE_PASSWORD", ""),
            ("HERDR_GUI_PIN", legacy),
        ];
        if let Some(pin) = pin {
            pairs.push(("ROAMGATE_PIN", pin));
        }
        let config = load(&[], &pairs, home.path()).unwrap();
        assert_eq!(config.pin.as_deref(), expected);
        let generated = config.generated_auth_token.clone().unwrap();
        assert_eq!(generated.len(), 64);
        assert_eq!(config.password, generated);
        if let Some(token) = &token {
            assert_eq!(&generated, token);
        }
        token = Some(generated);
    }
}

#[test]
fn prefers_explicit_paths_then_ssh_tunnels_then_the_session_layout() {
    let settings =
        |socket: Option<&str>, client: Option<&str>, ssh: Option<&str>, session: Option<&str>| {
            HerdrSocketSettings {
                socket_path: socket.map(str::to_owned),
                client_socket_path: client.map(str::to_owned),
                ssh_host: ssh.map(str::to_owned),
                session: session.map(str::to_owned),
                herdr_dir: PathBuf::from("/h/.config/herdr"),
                tmp: PathBuf::from("/tmp"),
                platform: "linux".into(),
            }
        };
    assert_eq!(
        resolve_herdr_socket_paths(&settings(
            Some("/run/a.sock"),
            Some("/run/b.sock"),
            Some("me@box"),
            None
        )),
        ("/run/a.sock".into(), "/run/b.sock".into())
    );
    let (control, client) = resolve_herdr_socket_paths(&settings(None, None, Some("me@box"), None));
    assert!(control.starts_with("/tmp/roamgate-") && control.ends_with("-control.sock"));
    assert!(client.ends_with("-client.sock"));
    assert_eq!(
        resolve_herdr_socket_paths(&settings(None, None, None, Some("work"))),
        (
            "/h/.config/herdr/sessions/work/herdr.sock".into(),
            "/h/.config/herdr/sessions/work/herdr-client.sock".into()
        )
    );
}

#[test]
fn the_herdr_command_ends_where_load_server_config_would() {
    let home = tempfile::tempdir().unwrap();
    let exit = load(&["--nope"], &[], home.path()).unwrap_err();
    assert_eq!(
        exit.stderr,
        "[bridge] Unknown option '--nope'\nRun `roamgate --help` for usage.\n"
    );
    assert_eq!(
        load(&["-V"], &[], home.path()).unwrap_err().stdout,
        "roamgate test\n"
    );
    let help = load(&["--help"], &[], home.path()).unwrap_err();
    assert_eq!(help.code, 0);
    assert!(
        help.stdout
            .starts_with("Roamgate \u{2014} Web and PWA client for Herdr\n")
    );
    let source = load(&["--notification-source", "pager"], &[], home.path()).unwrap_err();
    assert_eq!(
        source.stderr,
        "[bridge] Invalid notification source \"pager\" (expected herdr or status)\n"
    );
    // A token that cannot be read is fatal (exit 1).
    let token = home.path().join(".config/roamgate/auth-token");
    std::fs::create_dir_all(token.parent().unwrap()).unwrap();
    std::fs::write(&token, "nope\n").unwrap();
    let fatal = load(&[], &[("NODE_ENV", "production")], home.path()).unwrap_err();
    assert_eq!(fatal.code, 1);
    assert!(fatal.stderr.starts_with(
        "[bridge] FATAL: could not load the generated auth token: invalid generated auth token in "
    ));
}

#[test]
fn requires_8_to_1024_unicode_characters_for_login_secrets() {
    assert!(assert_valid_auth_password("12345678").is_ok());
    assert!(assert_valid_auth_password("1234567").is_err());
    // Characters, not bytes nor UTF-16 units.
    assert!(assert_valid_auth_password(&"\u{1f600}".repeat(8)).is_ok());
    assert!(assert_valid_auth_password(&"\u{1f600}".repeat(7)).is_err());
    assert!(assert_valid_auth_password(&"\u{e9}".repeat(1024)).is_ok());
    assert!(assert_valid_auth_password(&"\u{e9}".repeat(1025)).is_err());
}
