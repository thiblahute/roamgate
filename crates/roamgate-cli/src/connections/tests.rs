//! cli/connections.test.ts.

use serde_json::{Value, json};

use super::*;
use crate::args::{failure_code, report_failure};
use crate::context::testing::TestCli;

fn deps(serving: bool) -> ConnectionsDeps {
    ConnectionsDeps {
        probe: Box::new(move |_| Box::pin(async move { serving })),
        test: Box::new(|_| Box::pin(async { Err("not tested".to_owned()) })),
    }
}

fn idle() -> ConnectionsDeps {
    deps(false)
}

/// runCli of the command alone: its exit code, failures reported.
async fn connections(cli: &TestCli, args: &[&str], deps: &ConnectionsDeps) -> i32 {
    let args: Vec<String> = args.iter().map(|arg| (*arg).to_owned()).collect();
    match run_with(&args, &cli.context, deps).await {
        Ok(Outcome::Code(code)) => code,
        Ok(Outcome::ContinueToServer) => panic!("continued to the server"),
        Err(failure) => {
            report_failure("connections", &failure, &mut |line| cli.context.error(line));
            failure_code(&failure)
        }
    }
}

fn registry(cli: &TestCli) -> Value {
    serde_json::from_str(
        &std::fs::read_to_string(cli.in_home(".config/roamgate/connections.json")).unwrap(),
    )
    .unwrap()
}

fn printed(cli: &TestCli) -> Value {
    serde_json::from_str(&cli.output().join("\n")).unwrap()
}

/// What was printed after the first `skip` lines.
fn printed_after(cli: &TestCli, skip: usize) -> Value {
    serde_json::from_str(&cli.output()[skip..].join("\n")).unwrap()
}

fn second_to_last(cli: &TestCli) -> String {
    let errors = cli.errors();
    errors[errors.len() - 2].clone()
}

fn ids(saved: &Value) -> Vec<&str> {
    saved["profiles"]
        .as_array()
        .unwrap()
        .iter()
        .map(|profile| profile["id"].as_str().unwrap())
        .collect()
}

#[tokio::test]
async fn lists_the_implicit_default_from_the_service_config() {
    let cli = TestCli::new();
    cli.write_config("");
    assert_eq!(connections(&cli, &["list", "--json"], &idle()).await, 0);
    let listed = printed(&cli);
    assert_eq!(listed["default_connection_id"], "legacy-default");
    assert_eq!(listed["profiles"][0]["saved"], false);
    assert_eq!(
        listed["profiles"][0]["control_socket_path"],
        cli.in_home(".config/herdr/herdr.sock")
            .display()
            .to_string()
    );
}

#[tokio::test]
async fn the_first_saved_profile_keeps_the_local_server_like_the_web_ui() {
    let cli = TestCli::new();
    cli.write_config("");
    let code = connections(
        &cli,
        &[
            "add",
            "box",
            "--ssh",
            "me@box",
            "--label",
            "Box",
            "--auto-connect",
        ],
        &idle(),
    )
    .await;
    assert_eq!(code, 0);
    let saved = registry(&cli);
    assert_eq!(saved["default_connection_id"], "local");
    assert_eq!(ids(&saved), ["local", "box"]);
    assert_eq!(
        saved["profiles"][1],
        json!({
            "id": "box",
            "label": "Box",
            "type": "ssh",
            "ssh_destination": "me@box",
            "remote_control_socket_path": "",
            "remote_client_socket_path": "",
            "auto_connect": true,
        })
    );
    assert_eq!(cli.output(), ["Added connection box."]);
}

#[tokio::test]
async fn a_new_profile_named_local_seeds_localhost_instead() {
    let cli = TestCli::new();
    cli.write_config("");
    connections(
        &cli,
        &["add", "local", "--ssh", "me@box", "--default"],
        &idle(),
    )
    .await;
    let saved = registry(&cli);
    assert_eq!(saved["profiles"][0]["id"], "localhost");
    assert_eq!(saved["default_connection_id"], "local");
}

#[tokio::test]
async fn enforces_the_same_removal_and_default_rules_as_the_server() {
    let cli = TestCli::new();
    cli.write_config("");
    connections(&cli, &["add", "box", "--ssh", "me@box"], &idle()).await;
    assert_eq!(connections(&cli, &["remove", "local"], &idle()).await, 2);
    assert!(second_to_last(&cli).contains("cannot remove the default connection"));
    assert_eq!(connections(&cli, &["set-default", "box"], &idle()).await, 0);
    assert_eq!(connections(&cli, &["remove", "local"], &idle()).await, 0);
    // The last saved profile is always the default, as on the server.
    assert_eq!(connections(&cli, &["remove", "box"], &idle()).await, 2);
    assert!(second_to_last(&cli).contains("cannot remove the default connection"));
    assert_eq!(
        connections(&cli, &["add", "box", "--ssh", "me@other"], &idle()).await,
        2
    );
    assert!(second_to_last(&cli).contains("already exists"));
    assert_eq!(
        cli.errors().last().unwrap(),
        "Run `roamgate connections --help` for usage."
    );
}

#[tokio::test]
async fn rejects_invalid_profiles_as_usage_errors() {
    let cli = TestCli::new();
    cli.write_config("");
    assert_eq!(connections(&cli, &["add", "x"], &idle()).await, 2);
    assert_eq!(
        connections(
            &cli,
            &["add", "x", "--windows", "--control-socket", "/a"],
            &idle()
        )
        .await,
        2
    );
    assert_eq!(
        connections(&cli, &["add", "x", "--ssh", "-oProxyCommand=evil"], &idle()).await,
        2
    );
    assert_eq!(
        cli.errors(),
        [
            "roamgate connections: add needs --ssh <destination>, or both --control-socket and --client-socket",
            "Run `roamgate connections --help` for usage.",
            "roamgate connections: --windows requires --ssh",
            "Run `roamgate connections --help` for usage.",
            "roamgate connections: Option '--ssh' argument is ambiguous.",
            "Did you forget to specify the option argument for '--ssh'?",
            "To specify an option argument starting with a dash use '--ssh=-XYZ'.",
            "Run `roamgate connections --help` for usage.",
        ]
    );
    assert!(!cli.in_home(".config/roamgate/connections.json").exists());
}

#[tokio::test]
async fn refuses_edits_while_a_roamgate_listener_holds_its_own_copy() {
    let cli = TestCli::new();
    cli.write_config("");
    assert_eq!(
        connections(&cli, &["add", "box", "--ssh", "me@box"], &deps(true)).await,
        1
    );
    assert!(cli.errors()[0].contains("would overwrite this change"));
    assert!(!cli.in_home(".config/roamgate/connections.json").exists());
}

#[tokio::test]
async fn restarts_a_running_managed_service_with_restart() {
    let cli = TestCli::with(
        |argv| {
            Some(if argv.iter().any(|arg| arg == "herdr-gui.service") {
                4
            } else {
                0
            })
        },
        |_| None,
    );
    cli.write_config("");
    let units = cli.in_home(".config/systemd/user");
    std::fs::create_dir_all(&units).unwrap();
    std::fs::write(
        units.join("roamgate.service"),
        "# Generated by roamgate service install.\n",
    )
    .unwrap();
    assert_eq!(
        connections(&cli, &["add", "box", "--ssh", "me@box"], &deps(true)).await,
        1
    );
    assert!(cli.errors()[1].contains("--restart"));
    assert_eq!(
        connections(
            &cli,
            &["add", "box", "--ssh", "me@box", "--restart"],
            &deps(true)
        )
        .await,
        0
    );
    assert_eq!(registry(&cli)["profiles"].as_array().unwrap().len(), 2);
    let restart: Vec<String> = ["systemctl", "--user", "restart", "roamgate.service"]
        .iter()
        .map(|arg| (*arg).to_owned())
        .collect();
    assert!(cli.commands().contains(&restart));
    assert_eq!(
        cli.output(),
        ["Added connection box.", "Restarted the service."]
    );
}

#[tokio::test]
async fn test_reports_each_profile_and_fails_when_any_is_unreachable() {
    let cli = TestCli::new();
    cli.write_config("");
    connections(&cli, &["add", "box", "--ssh", "me@box"], &idle()).await;
    let skip = cli.output().len();
    let tested = ConnectionsDeps {
        probe: Box::new(|_| Box::pin(async { false })),
        test: Box::new(|profile| {
            let ssh = profile.is_ssh();
            Box::pin(async move {
                if ssh {
                    Err("ssh: connection refused".to_owned())
                } else {
                    Ok(ProbeResult {
                        ok: true,
                        version: Some("0.9.4".into()),
                        protocol: 7,
                    })
                }
            })
        }),
    };
    assert_eq!(connections(&cli, &["test", "--json"], &tested).await, 1);
    assert_eq!(
        printed_after(&cli, skip)["results"],
        json!([
            {"id": "local", "ok": true, "version": "0.9.4", "protocol": 7},
            {"id": "box", "ok": false, "error": "ssh: connection refused"},
        ])
    );
    let skip = cli.output().len();
    assert_eq!(connections(&cli, &["test"], &tested).await, 1);
    assert_eq!(
        cli.output()[skip..],
        [
            "ok    local  Herdr 0.9.4, protocol 7",
            "fail  box  ssh: connection refused",
        ]
    );
    assert_eq!(connections(&cli, &["test", "nope"], &tested).await, 2);
}

#[tokio::test]
async fn explicit_herdr_settings_stay_out_of_a_saved_registry() {
    let cli = TestCli::new();
    cli.write_config("");
    connections(&cli, &["add", "box", "--ssh", "me@box"], &idle()).await;
    cli.write_config("HERDR_SESSION=work\n");
    assert_eq!(
        connections(&cli, &["add", "lab", "--ssh", "me@lab"], &idle()).await,
        0
    );
    assert_eq!(connections(&cli, &["remove", "box"], &idle()).await, 0);
    assert_eq!(ids(&registry(&cli)), ["local", "lab"]);
    let skip = cli.output().len();
    connections(&cli, &["list", "--json"], &idle()).await;
    let listed = printed_after(&cli, skip);
    assert_eq!(listed["default_connection_id"], "legacy-default");
    assert_eq!(listed["profiles"][0]["id"], "legacy-default");
    assert_eq!(listed["profiles"][0]["saved"], false);
    assert_eq!(
        listed["profiles"][0]["control_socket_path"],
        cli.in_home(".config/herdr/sessions/work/herdr.sock")
            .display()
            .to_string()
    );
    let skip = cli.output().len();
    connections(&cli, &["list"], &idle()).await;
    assert_eq!(
        cli.output()[skip..],
        [
            cli.shown(".config/roamgate/connections.json"),
            format!(
                "* legacy-default  local  {}  Default  [default, auto-connect, from service config]",
                cli.in_home(".config/herdr/sessions/work/herdr.sock")
                    .display()
            ),
            "  local           local  ".to_owned()
                + &cli
                    .home()
                    .join(".config/herdr/herdr.sock")
                    .display()
                    .to_string()
                + "  Local  [auto-connect]",
            "  lab             ssh    me@lab  lab".to_owned(),
        ]
    );
}
