//! cli/url.test.ts (renderTerminalQr's case is qr::tests).

use serde_json::Value;

use crate::args::{EXIT_FAILURE, EXIT_OK, EXIT_USAGE};
use crate::context::testing::TestCli;

fn token() -> String {
    "a".repeat(64)
}

fn write_token(cli: &TestCli) {
    std::fs::write(
        cli.home().join(".config/roamgate/auth-token"),
        format!("{}\n", token()),
    )
    .unwrap();
}

fn json_output(cli: &TestCli) -> Value {
    serde_json::from_str(&cli.output().join("\n")).unwrap()
}

#[tokio::test]
async fn prints_tokenized_local_and_lan_urls_from_the_service_config() {
    let cli = TestCli::new();
    cli.write_config("HOST=0.0.0.0\nPORT=9100\n");
    write_token(&cli);
    assert_eq!(cli.run_cli(&["url", "--json"]).await, EXIT_OK);
    let result = json_output(&cli);
    assert_eq!(
        result["local"],
        format!("http://localhost:9100/?token={}", token())
    );
    assert_eq!(result["auth"], "token");
    assert!(result["lan"].is_array());
}

#[tokio::test]
async fn omits_the_token_for_fixed_password_services_and_applies_address() {
    let cli = TestCli::new();
    cli.write_config("ROAMGATE_PASSWORD=correct-horse-battery\n");
    write_token(&cli);
    cli.run_cli(&["url", "--json", "--address", "box.tailnet.ts.net"])
        .await;
    let result = json_output(&cli);
    assert_eq!(result["local"], "http://localhost:8787");
    assert_eq!(result["address"], "http://box.tailnet.ts.net:8787");
    // The keys and their order as printJson writes them.
    let keys: Vec<&String> = result.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "config_path",
            "config_exists",
            "auth",
            "local",
            "lan",
            "address"
        ]
    );
}

#[tokio::test]
async fn refuses_a_qr_code_that_only_this_machine_could_open() {
    let cli = TestCli::new();
    cli.write_config("HOST=127.0.0.1\n");
    write_token(&cli);
    assert_eq!(cli.run_cli(&["url", "--qr"]).await, EXIT_FAILURE);
    assert!(cli.errors()[0].contains("only listens on this machine"));
}

#[tokio::test]
async fn prints_a_qr_code_for_an_explicit_address_with_a_token_warning() {
    let cli = TestCli::new();
    cli.write_config("HOST=127.0.0.1\n");
    write_token(&cli);
    assert_eq!(
        cli.run_cli(&["url", "--qr", "--address", "10.0.0.5"]).await,
        EXIT_OK
    );
    let output = cli.output();
    assert!(output.contains(&"QR code opens: http://10.0.0.5:8787".to_owned()));
    assert!(output.last().unwrap().contains("contains your login token"));
    assert_eq!(
        output[0],
        format!("Address: http://10.0.0.5:8787/?token={}", token())
    );
}

#[tokio::test]
async fn validates_options() {
    let cli = TestCli::new();
    assert_eq!(cli.run_cli(&["url", "--qr", "--json"]).await, EXIT_USAGE);
    assert_eq!(cli.run_cli(&["url", "--address", "a/b"]).await, EXIT_USAGE);
    assert_eq!(
        cli.errors(),
        [
            "roamgate url: --qr and --json cannot be combined",
            "Run `roamgate url --help` for usage.",
            "roamgate url: --address must be a host name or IP address",
            "Run `roamgate url --help` for usage.",
        ]
    );
}

#[tokio::test]
async fn the_loopback_hint_is_a_command_that_works() {
    let cli = TestCli::new();
    cli.write_config("HOST=127.0.0.1\n");
    cli.run_cli(&["url", "--qr"]).await;
    let errors = cli.errors();
    let hint = errors
        .iter()
        .find(|line| line.contains("config set"))
        .unwrap();
    let start = hint.find("`roamgate ").unwrap() + "`roamgate ".len();
    let command = &hint[start..start + hint[start..].find('`').unwrap()];
    assert_eq!(command, "config set HOST=0.0.0.0 --restart");
    let argv: Vec<&str> = command.split(' ').collect();
    assert_eq!(cli.run_cli(&argv).await, EXIT_OK);
    assert!(
        std::fs::read_to_string(&cli.config_path)
            .unwrap()
            .contains("HOST=0.0.0.0")
    );
}
