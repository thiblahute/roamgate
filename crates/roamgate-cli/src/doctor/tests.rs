//! cli/doctor.test.ts.

use serde_json::Value;

use super::*;
use crate::context::testing::TestCli;

fn healthy() -> DoctorDeps {
    DoctorDeps {
        probe: Box::new(|_| Box::pin(async { true })),
        port_in_use: Box::new(|_, _| true),
        test_sockets: Box::new(|_, _| {
            Box::pin(async {
                Ok(SocketsTest {
                    version: Some("0.9.4".into()),
                    protocol: serde_json::json!(7),
                })
            })
        }),
        herdr_service: Box::new(|_| Ok((false, false))),
        latest_version: Box::new(|_, _| Box::pin(async { Ok(Some("1.2.3".to_owned())) })),
        lan_ips: Box::new(|| vec!["192.168.1.20".into()]),
        ..DoctorDeps::default()
    }
}

struct Ran {
    code: i32,
    result: Value,
}

impl Ran {
    fn check(&self, name: &str) -> &Value {
        self.result["checks"]
            .as_array()
            .unwrap()
            .iter()
            .find(|check| check["name"] == name)
            .unwrap_or_else(|| panic!("no {name} check in {}", self.result))
    }
}

async fn doctor(cli: &TestCli, deps: &DoctorDeps, args: &[&str]) -> Ran {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    let Outcome::Code(code) = run_with(&args, &cli.context, deps).await.unwrap() else {
        panic!("continued to the server");
    };
    Ran {
        code,
        result: serde_json::from_str(&cli.output().join("\n")).unwrap(),
    }
}

fn write_token(cli: &TestCli, contents: &str) {
    std::fs::write(cli.home().join(".config/roamgate/auth-token"), contents).unwrap();
}

#[tokio::test]
async fn passes_a_healthy_foreground_installation_and_redacts_the_token() {
    let cli = TestCli::new();
    cli.write_config("HOST=0.0.0.0\nPORT=8787\n");
    write_token(&cli, &"c".repeat(64));
    let ran = doctor(&cli, &healthy(), &["--json"]).await;
    assert_eq!(ran.code, 0);
    assert_eq!(ran.result["ok"], true);
    assert!(
        ran.check("Herdr")["detail"]
            .as_str()
            .unwrap()
            .contains("Herdr 0.9.4, protocol 7")
    );
    assert!(
        ran.check("Network")["detail"]
            .as_str()
            .unwrap()
            .contains("http://192.168.1.20:8787")
    );
    assert_eq!(ran.check("Service")["status"], "warn");
    assert_eq!(ran.check("Updates")["status"], "ok");
    assert!(!ran.result.to_string().contains(&"c".repeat(64)));
}

#[tokio::test]
async fn fails_on_an_invalid_service_config_with_a_fix() {
    let cli = TestCli::new();
    cli.write_config("PORT=0\n");
    let ran = doctor(&cli, &healthy(), &["--json"]).await;
    assert_eq!(ran.code, 1);
    assert_eq!(ran.check("Service config")["status"], "fail");
    assert!(
        ran.check("Service config")["hint"]
            .as_str()
            .unwrap()
            .contains("roamgate config edit")
    );
}

#[tokio::test]
async fn explains_a_port_held_by_another_process() {
    let cli = TestCli::new();
    cli.write_config("");
    let deps = DoctorDeps {
        probe: Box::new(|_| Box::pin(async { false })),
        ..healthy()
    };
    let ran = doctor(&cli, &deps, &["--json"]).await;
    assert_eq!(ran.check("Listener")["status"], "fail");
    assert!(
        ran.check("Listener")["detail"]
            .as_str()
            .unwrap()
            .contains("port 8787 is held")
    );
}

#[tokio::test]
async fn reports_an_unreachable_herdr_with_the_setup_command() {
    let cli = TestCli::new();
    cli.write_config("");
    let deps = DoctorDeps {
        test_sockets: Box::new(|_, _| Box::pin(async { Err("ENOENT".to_owned()) })),
        ..healthy()
    };
    let ran = doctor(&cli, &deps, &["--json"]).await;
    assert_eq!(ran.code, 1);
    let socket = cli.home().join(".config/herdr/herdr.sock");
    assert!(
        ran.check("Herdr")["detail"]
            .as_str()
            .unwrap()
            .contains(&socket.display().to_string())
    );
    assert!(
        ran.check("Herdr")["hint"]
            .as_str()
            .unwrap()
            .contains("roamgate herdr setup")
    );
}

#[tokio::test]
async fn skips_ssh_herdr_disabled_push_and_offline_update_checks() {
    let cli = TestCli::new();
    cli.write_config("HERDR_SSH_HOST=me@box\nROAMGATE_WEB_PUSH_SUBJECT=\n");
    let ran = doctor(&cli, &healthy(), &["--json", "--offline"]).await;
    assert_eq!(ran.check("Herdr")["status"], "skip");
    assert_eq!(ran.check("Web Push")["status"], "skip");
    assert_eq!(ran.check("Updates")["status"], "skip");
}

#[tokio::test]
async fn warns_about_available_updates() {
    let cli = TestCli::new();
    cli.write_config("");
    let deps = DoctorDeps {
        latest_version: Box::new(|_, _| Box::pin(async { Ok(Some("1.3.0".to_owned())) })),
        ..healthy()
    };
    let ran = doctor(&cli, &deps, &["--json"]).await;
    assert_eq!(ran.check("Updates")["status"], "warn");
    assert_eq!(ran.check("Updates")["hint"], "Run `roamgate update`.");
}

#[tokio::test]
async fn warns_about_a_certificate_that_expires_soon() {
    let cli = TestCli::new();
    let cert = cli.home().join("cert.pem");
    let key = cli.home().join("key.pem");
    let Ok(generated) = std::process::Command::new("openssl")
        .args([
            "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "3",
        ])
        .args(["-subj", "/CN=roamgate.test", "-keyout"])
        .arg(&key)
        .arg("-out")
        .arg(&cert)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
    else {
        // No openssl: skipped, as the TS test is.
        return;
    };
    assert!(generated.success());
    cli.write_config(&format!(
        "HOST=0.0.0.0\nROAMGATE_TLS_CERT={}\nROAMGATE_TLS_KEY={}\n",
        cert.display(),
        key.display()
    ));
    let ran = doctor(&cli, &healthy(), &["--json"]).await;
    assert_eq!(ran.check("TLS certificate")["status"], "warn");
    let detail = ran.check("TLS certificate")["detail"].as_str().unwrap();
    assert!(detail.contains("CN=roamgate.test"), "{detail}");
    assert!(detail.contains(", 2 days left (") || detail.contains(", 3 days left ("));
    assert!(
        ran.check("Network")["detail"]
            .as_str()
            .unwrap()
            .contains("HTTPS")
    );
}

#[tokio::test]
async fn flags_an_invalid_connection_registry() {
    let cli = TestCli::new();
    cli.write_config("");
    let registry = cli.home().join(".config/roamgate/connections.json");
    std::fs::write(&registry, "{").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&registry, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
    let ran = doctor(&cli, &healthy(), &["--json"]).await;
    assert_eq!(ran.check("Connections")["status"], "fail");
    assert_eq!(
        ran.check("Connections")["detail"],
        "invalid registry: connection registry is not valid JSON"
    );
}

#[tokio::test]
async fn prints_a_readable_summary() {
    let cli = TestCli::new();
    cli.write_config("");
    let Outcome::Code(code) = run_with(&[], &cli.context, &healthy()).await.unwrap() else {
        panic!("continued to the server");
    };
    assert_eq!(code, 0);
    let output = cli.output();
    // Not installed as a service, and no login token has been created yet.
    let last = output.last().unwrap();
    assert!(
        regex::Regex::new(r"^\d+ ok, 2 warnings, 0 failures$")
            .unwrap()
            .is_match(last),
        "{last}"
    );
    assert!(
        output.contains(
            &"                      Run `roamgate service install` to start Roamgate at login."
                .to_owned()
        )
    );
    assert_eq!(
        output[..4],
        [
            "ok    Roamgate        1.2.3 on linux-x64, ~/bin/roamgate".to_owned(),
            "ok    Service config  ~/.config/roamgate/roamgate.env".to_owned(),
            "warn  Login           no login token yet".to_owned(),
            "                      It is created by `roamgate service install` or the first start."
                .to_owned(),
        ]
    );
    assert!(output.contains(&"ok    Herdr           Herdr 0.9.4, protocol 7".to_owned()));
    assert!(output.contains(
        &"ok    Network         only this machine can connect (HOST=127.0.0.1)".to_owned()
    ));
}

#[tokio::test]
async fn fails_on_a_corrupt_token_with_the_rotate_command() {
    let cli = TestCli::new();
    cli.write_config("");
    write_token(&cli, "x\n");
    let ran = doctor(&cli, &healthy(), &["--json"]).await;
    assert_eq!(ran.code, 1);
    assert!(
        ran.check("Login")["hint"]
            .as_str()
            .unwrap()
            .contains("roamgate auth rotate")
    );
}

#[tokio::test]
async fn a_loaded_but_crashed_launch_agent_is_not_reported_as_running() {
    let cli = TestCli::with_runtime(
        |runtime| runtime.platform = "darwin".into(),
        |_| None,
        |_| {
            Some((
                0,
                "gui/501/dev.roamgate = {\n\tstate = waiting\n\tendpoints = {\n\t\tstate = active\n\t}\n}\n"
                    .to_owned(),
            ))
        },
    );
    cli.write_config("");
    let agents = cli.home().join("Library/LaunchAgents");
    std::fs::create_dir_all(&agents).unwrap();
    std::fs::write(agents.join("dev.roamgate.plist"), "<plist/>").unwrap();
    let deps = DoctorDeps {
        probe: Box::new(|_| Box::pin(async { false })),
        port_in_use: Box::new(|_, _| false),
        ..healthy()
    };
    let ran = doctor(&cli, &deps, &["--json"]).await;
    assert_eq!(ran.check("Service")["status"], "fail");
    assert_eq!(ran.check("Service")["detail"], "installed but not running");
}
