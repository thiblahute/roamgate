//! server/src/connections/profiles.test.ts.

use std::path::Path;

use serde_json::{Value, json};

use super::*;

fn local_socket_path(id: &str, client: bool) -> String {
    let name = format!("{id}{}.sock", if client { "-client" } else { "" });
    if cfg!(windows) {
        format!("\\\\.\\pipe\\herdr-gui-test-{name}")
    } else {
        format!("/tmp/{name}")
    }
}

fn local(id: &str) -> Value {
    json!({
        "id": id,
        "label": if id == "alpha" { "Alpha" } else { "Beta" },
        "type": "local",
        "control_socket_path": local_socket_path(id, false),
        "client_socket_path": local_socket_path(id, true),
        "auto_connect": true,
    })
}

fn ssh() -> Value {
    json!({
        "id": "remote",
        "label": "Remote",
        "type": "ssh",
        "ssh_destination": "operator@dev-box",
        "remote_control_socket_path": "/remote/herdr.sock",
        "remote_client_socket_path": "/remote/herdr-client.sock",
        "auto_connect": false,
    })
}

fn with(base: &Value, patch: Value) -> Value {
    let mut value = base.clone();
    for (key, field) in patch.as_object().unwrap() {
        if field.is_null() {
            value.as_object_mut().unwrap().remove(key);
        } else {
            value[key] = field.clone();
        }
    }
    value
}

fn registry() -> Value {
    json!({ "version": 1, "default_connection_id": "alpha", "profiles": [local("alpha")] })
}

fn registry_typed() -> PersistedConnectionRegistry {
    validate_connection_registry(&registry()).unwrap()
}

fn ssh_profile(value: &Value) -> ConnectionProfile {
    ConnectionProfile::Ssh(validate_ssh_connection_profile(value).unwrap())
}

#[test]
fn preserves_persisted_local_and_unix_ssh_fingerprints() {
    let local = ConnectionProfile::Local(
        validate_local_connection_profile(
            &with(
                &local("alpha"),
                json!({"control_socket_path": "/tmp/alpha.sock", "client_socket_path": "/tmp/alpha-client.sock"}),
            ),
            "linux",
        )
        .unwrap(),
    );
    assert_eq!(
        connection_recovery_fingerprint(&local),
        "1a7c9e2537a3a96fd4a80d280dc566f68b8c92e3a0dc8508dee2146f86b1551b"
    );
    assert_eq!(
        connection_recovery_fingerprint(&ssh_profile(&ssh())),
        "f332d70be95c37f234e1fa0d8876a1be4128960d06e7a83660532da13acd691c"
    );
}

#[test]
fn invalidates_windows_recovery_when_its_endpoint_changes() {
    let profile = SshConnectionProfile {
        id: "remote".into(),
        label: "Remote".into(),
        ssh_destination: "operator@dev-box".into(),
        remote_control_socket_path: String::new(),
        remote_client_socket_path: String::new(),
        auto_connect: false,
        remote_platform_windows: true,
        remote_herdr_path: Some(r"C:\Herdr\herdr.exe".into()),
        remote_session: Some("default".into()),
        node: false,
    };
    let fingerprint = connection_recovery_fingerprint(&ConnectionProfile::Ssh(profile.clone()));
    type Change = Box<dyn Fn(&mut SshConnectionProfile)>;
    let changes: [Change; 4] = [
        Box::new(|p| p.ssh_destination = "other-host".into()),
        Box::new(|p| p.remote_platform_windows = false),
        Box::new(|p| p.remote_herdr_path = Some(r"C:\Other\herdr.exe".into())),
        Box::new(|p| p.remote_session = Some("other-session".into())),
    ];
    for change in changes {
        let mut changed = profile.clone();
        change(&mut changed);
        assert_ne!(
            connection_recovery_fingerprint(&ConnectionProfile::Ssh(changed)),
            fingerprint
        );
    }
}

#[test]
fn accepts_the_bounded_versioned_local_schema() {
    assert_eq!(registry_typed().to_value(), registry());
}

#[test]
fn normalizes_windows_local_profiles_to_native_named_pipes() {
    let profile = with(
        &local("alpha"),
        json!({
            "control_socket_path": r"C:\Users\tester\AppData\Roaming\herdr\herdr.sock",
            "client_socket_path": r"C:\Users\tester\AppData\Roaming\herdr\herdr-client.sock",
        }),
    );
    let validated = validate_local_connection_profile(&profile, "win32").unwrap();
    assert_eq!(
        ConnectionProfile::Local(validated).to_value(),
        with(
            &profile,
            json!({
                "control_socket_path": r"\\.\pipe\C:\Users\tester\AppData\Roaming\herdr\herdr.sock",
                "client_socket_path": r"\\.\pipe\C:\Users\tester\AppData\Roaming\herdr\herdr-client.sock",
            })
        )
    );
}

#[test]
fn rejects_unsupported_versions_duplicates_and_missing_defaults() {
    let error = |value: Value| validate_connection_registry(&value).unwrap_err();
    assert!(
        error(with(&registry(), json!({"version": 3})))
            .contains("unsupported connection registry version")
    );
    assert!(
        error(with(
            &registry(),
            json!({"profiles": [local("alpha"), local("alpha")]})
        ))
        .contains("duplicate connection profile")
    );
    assert!(
        error(with(
            &registry(),
            json!({"default_connection_id": "missing"})
        ))
        .contains("default connection profile does not exist")
    );
}

#[test]
fn accepts_mixed_version_2_profiles_and_keeps_version_1_local_only() {
    let mixed = json!({ "version": 2, "default_connection_id": "remote", "profiles": [local("alpha"), ssh()] });
    assert_eq!(
        validate_connection_registry(&mixed).unwrap().to_value(),
        mixed
    );
    assert!(validate_connection_registry(&with(&mixed, json!({"version": 1}))).is_err());
    assert_eq!(
        public_connection_profile(&ssh_profile(&ssh()), false),
        with(&ssh(), json!({"read_only": false}))
    );
}

#[test]
fn validates_strict_ssh_destinations_paths_and_exact_fields() {
    assert_eq!(ssh_profile(&ssh()).to_value(), ssh());
    let long = "a".repeat(321);
    for destination in [
        "-oProxyCommand=touch",
        "host name",
        "ssh://host",
        "host:2222",
        "user@@host",
        "user@host/path",
        "user@host=bad",
        "user@host,bad",
        "",
        long.as_str(),
    ] {
        let error =
            validate_ssh_connection_profile(&with(&ssh(), json!({"ssh_destination": destination})))
                .unwrap_err();
        assert!(error.contains("OpenSSH alias"), "{destination}: {error}");
    }
    let long_path = format!("/tmp/{}", "x".repeat(100));
    for path in [
        "relative.sock",
        "/tmp/../secret.sock",
        "/tmp/socket:bad",
        "/tmp/socket path",
        long_path.as_str(),
    ] {
        let error = validate_ssh_connection_profile(&with(
            &ssh(),
            json!({"remote_control_socket_path": path}),
        ))
        .unwrap_err();
        assert!(
            error.contains("short absolute POSIX socket path"),
            "{path}: {error}"
        );
    }
    let error = validate_ssh_connection_profile(&with(
        &ssh(),
        json!({"remote_client_socket_path": "/remote/herdr.sock"}),
    ))
    .unwrap_err();
    assert!(error.contains("must differ"), "{error}");
    for forbidden in [
        "password",
        "passphrase",
        "private_key",
        "identity_file",
        "command",
        "options",
        "port",
        "control_socket_path",
    ] {
        let error = validate_ssh_connection_profile(&with(&ssh(), json!({ forbidden: "secret" })))
            .unwrap_err();
        assert!(
            error.contains(&format!("unknown field: {forbidden}")),
            "{error}"
        );
    }
}

#[test]
fn accepts_empty_ssh_socket_paths_for_remote_home_inference() {
    let inferred = with(
        &ssh(),
        json!({"remote_control_socket_path": "", "remote_client_socket_path": ""}),
    );
    assert_eq!(ssh_profile(&inferred).to_value(), inferred);
    let mixed = with(&ssh(), json!({"remote_client_socket_path": ""}));
    assert_eq!(ssh_profile(&mixed).to_value(), mixed);
}

#[test]
fn persists_windows_bridge_options_and_rejects_ambiguous_or_unsafe_targets() {
    let windows = with(
        &ssh(),
        json!({
            "remote_control_socket_path": "",
            "remote_client_socket_path": "",
            "remote_platform": "windows",
            "remote_herdr_path": r"C:\Herdr O'Brien\herdr.exe",
            "remote_session": "isolated-session",
        }),
    );
    let profile = ssh_profile(&windows);
    assert_eq!(profile.to_value(), windows);
    let public = public_connection_profile(&profile, false);
    assert_eq!(public, with(&windows, json!({"read_only": false})));
    // read_only before the optional fields, as the TS spread order writes it.
    let keys: Vec<&String> = public.as_object().unwrap().keys().collect();
    assert_eq!(keys[7], "read_only");
    let long = format!("C:\\{}.exe", "a".repeat(1024));
    for patch in [
        json!({"remote_platform": "linux"}),
        json!({"remote_platform": null}),
        json!({"remote_control_socket_path": "/tmp/herdr.sock"}),
        json!({"remote_herdr_path": "herdr.exe --update"}),
        json!({"remote_herdr_path": r"\\server\share\herdr.exe"}),
        json!({"remote_herdr_path": r"C:\..\herdr.exe"}),
        json!({"remote_herdr_path": "C:\\herdr\n.exe"}),
        json!({"remote_herdr_path": "C:\\herdr\u{85}.exe"}),
        json!({"remote_herdr_path": long}),
        json!({"remote_session": "default --update"}),
        json!({"remote_session": "../default"}),
    ] {
        assert!(
            validate_ssh_connection_profile(&with(&windows, patch.clone())).is_err(),
            "{patch}"
        );
    }
}

#[test]
fn rejects_reserved_ids_control_characters_relative_traversal_paths_and_unknown_fields() {
    let platform = current_platform();
    let error = |patch: Value| {
        validate_local_connection_profile(&with(&local("alpha"), patch), platform).unwrap_err()
    };
    assert!(error(json!({"id": "legacy-default"})).contains("reserved"));
    assert!(error(json!({"label": "bad\nlabel"})).contains("label is invalid"));
    assert!(
        error(json!({"control_socket_path": "relative.sock"})).contains("absolute socket path")
    );
    let traversal = if cfg!(windows) {
        "C:\\tmp\\..\\secret.sock"
    } else {
        "/tmp/../secret.sock"
    };
    assert!(error(json!({"control_socket_path": traversal})).contains("parent traversal"));
    assert!(error(json!({"command": "ssh evil"})).contains("unknown field"));
}

#[cfg(unix)]
fn mode(path: &Path) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    std::fs::symlink_metadata(path)
        .unwrap()
        .permissions()
        .mode()
        & 0o777
}

#[test]
fn atomically_writes_mode_0600_under_a_mode_0700_directory() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("private").join("connections.json");
    let store = ConnectionProfileStore::at(path.clone()).unwrap();
    store.save(&registry_typed()).unwrap();
    assert_eq!(store.load().unwrap(), Some(registry_typed()));
    #[cfg(unix)]
    {
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
    }
    // JSON.stringify(registry, null, 2) and a newline.
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        format!("{}\n", serde_json::to_string_pretty(&registry()).unwrap())
    );
}

#[test]
fn failed_replacement_preserves_the_previous_complete_file() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("private").join("connections.json");
    let initial = ConnectionProfileStore::at(path.clone()).unwrap();
    initial.save(&registry_typed()).unwrap();
    let before = std::fs::read_to_string(&path).unwrap();
    let failing = ConnectionProfileStore::at(path.clone())
        .unwrap()
        .with_before_rename(Box::new(|_, _| Err("simulated persistence failure".into())));
    let beta = validate_connection_registry(&json!({
        "version": 1, "default_connection_id": "beta", "profiles": [local("beta")],
    }))
    .unwrap();
    assert!(
        failing
            .save(&beta)
            .unwrap_err()
            .contains("simulated persistence failure")
    );
    assert_eq!(std::fs::read_to_string(&path).unwrap(), before);
    assert_eq!(initial.load().unwrap(), Some(registry_typed()));
}

#[cfg(unix)]
fn private_dir(path: &Path) {
    use std::os::unix::fs::DirBuilderExt;
    std::fs::DirBuilder::new().mode(0o700).create(path).unwrap();
}

#[cfg(unix)]
fn write_mode(path: &Path, contents: &[u8], mode: u32) {
    use std::os::unix::fs::OpenOptionsExt;
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(mode)
        .open(path)
        .unwrap();
    std::io::Write::write_all(&mut file, contents).unwrap();
}

#[cfg(unix)]
#[test]
fn rejects_oversized_registries_before_parsing() {
    let root = tempfile::tempdir().unwrap();
    let parent = root.path().join("private");
    private_dir(&parent);
    let path = parent.join("connections.json");
    write_mode(&path, &vec![b'x'; 1024 * 1024 + 1], 0o600);
    assert!(
        ConnectionProfileStore::at(path)
            .unwrap()
            .load()
            .unwrap_err()
            .contains("too large")
    );
}

#[cfg(unix)]
#[test]
fn rejects_insecure_override_permissions_without_changing_them() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    let path = root.path().join("connections.json");
    write_mode(&path, registry().to_string().as_bytes(), 0o644);
    assert!(
        ConnectionProfileStore::at(path.clone())
            .unwrap()
            .load()
            .unwrap_err()
            .contains("permissions must be 0700/0600")
    );
    assert_eq!(mode(&path), 0o644);
    assert!(
        ConnectionProfileStore::at(path)
            .unwrap()
            .save(&registry_typed())
            .unwrap_err()
            .contains("parent permissions must be 0700")
    );
}

#[cfg(unix)]
#[test]
fn does_not_chmod_or_write_through_an_existing_shared_parent() {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir().unwrap();
    std::fs::set_permissions(root.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(
        ConnectionProfileStore::at(root.path().join("connections.json"))
            .unwrap()
            .save(&registry_typed())
            .unwrap_err()
            .contains("parent permissions must be 0700")
    );
    assert_ne!(mode(root.path()) & 0o077, 0);
}

#[cfg(unix)]
#[test]
fn never_follows_a_symlink_at_the_registry_or_parent() {
    let root = tempfile::tempdir().unwrap();
    let real = root.path().join("real.json");
    std::fs::write(&real, registry().to_string()).unwrap();
    let linked_file = root.path().join("linked.json");
    std::os::unix::fs::symlink(&real, &linked_file).unwrap();
    assert!(
        ConnectionProfileStore::at(linked_file)
            .unwrap()
            .load()
            .unwrap_err()
            .contains("symlink")
    );
    let real_dir = root.path().join("real-dir");
    std::fs::create_dir(&real_dir).unwrap();
    let linked_dir = root.path().join("linked-dir");
    std::os::unix::fs::symlink(&real_dir, &linked_dir).unwrap();
    assert!(
        ConnectionProfileStore::at(linked_dir.join("connections.json"))
            .unwrap()
            .save(&registry_typed())
            .unwrap_err()
            .contains("symlink")
    );
    let clear_target = real_dir.join("connections.json");
    write_mode(&clear_target, registry().to_string().as_bytes(), 0o600);
    assert!(
        ConnectionProfileStore::at(linked_dir.join("connections.json"))
            .unwrap()
            .clear()
            .unwrap_err()
            .contains("symlink")
    );
    assert!(clear_target.exists());
}
