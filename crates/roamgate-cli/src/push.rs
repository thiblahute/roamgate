//! `roamgate push` (cli/push.ts): roamgate-notify's test delivery, with
//! the service's environment (its VAPID subject and registry path) and the
//! CLI's flags and output.

use std::sync::Arc;

use roamgate_base::env::roamgate_env;
use roamgate_base::json_store::{JsonFormat, to_js_json};
use roamgate_notify::cli::{Outcome, PUSH_HELP, push_test, result_lines};
use roamgate_notify::web_push::{DEFAULT_SUBJECT, PushSender, web_push_path};
use serde_json::json;

use crate::commands::{CliRuntime, Failure, finish, parse_flags, wants_help};
use crate::output::Printed;
use crate::service::read_service_environment;

/// `displayPath`: home-relative outside Windows.
fn display_path(path: &std::path::Path, runtime: &CliRuntime) -> String {
    let text = path.display().to_string();
    if runtime.platform == "win32" {
        return text;
    }
    let home = runtime.home.display().to_string();
    if text == home {
        "~".into()
    } else if let Some(rest) = text.strip_prefix(&format!("{home}/")) {
        format!("~/{rest}")
    } else {
        text
    }
}

/// `roamgate push ...`; `now_ms` signs the VAPID authorization.
pub async fn push(
    runtime: &CliRuntime,
    sender: Arc<dyn PushSender>,
    now_ms: i64,
    args: &[String],
) -> Printed {
    let mut printed = Printed::default();
    let action = args.first().map(String::as_str);
    if wants_help(args) || action.is_none() {
        printed.stdout.push_str(PUSH_HELP);
        return printed.exit(0);
    }
    let result = push_inner(runtime, sender, now_ms, args, &mut printed).await;
    finish("push", printed, result)
}

async fn push_inner(
    runtime: &CliRuntime,
    sender: Arc<dyn PushSender>,
    now_ms: i64,
    args: &[String],
    printed: &mut Printed,
) -> Result<i32, Failure> {
    let action = args.first().map(String::as_str).unwrap_or("");
    if action != "test" {
        return Err(Failure::Usage(format!("unknown push action: {action}")));
    }
    let flags = parse_flags(&args[1..], &["json"])?;
    let json = flags.iter().any(|flag| flag == "json");
    let service = runtime.service();
    let env = read_service_environment(&service).map_err(Failure::Failed)?;
    let subject = roamgate_env(&env, "WEB_PUSH_SUBJECT").unwrap_or_else(|| DEFAULT_SUBJECT.into());
    let context = service.data();
    let path = web_push_path(&env, &context.data_root());
    let shown = display_path(&path, runtime);
    match push_test(&context, &subject, &path, &shown, sender, now_ms).await {
        Outcome::Refused(message) => {
            printed.error(&message);
            Ok(1)
        }
        Outcome::Sent(results) => {
            if json {
                let text = to_js_json(&json!({ "devices": results }), JsonFormat::Pretty)
                    .unwrap_or_default();
                printed.log(text.trim_end_matches('\n'));
            } else {
                for line in result_lines(&results) {
                    printed.log(&line);
                }
            }
            Ok(if results.iter().all(|result| result["ok"] == true) {
                0
            } else {
                1
            })
        }
    }
}
