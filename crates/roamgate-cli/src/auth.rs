//! `roamgate auth` (cli/auth.ts): show the login method, rotate the
//! generated token, sign out every browser.

use std::path::Path;

use roamgate_base::env::roamgate_env;
use roamgate_base::session_secret::{revoke_session_secret, session_secret_path};
use serde_json::{Map, Value, json};

use crate::args::{EXIT_FAILURE, EXIT_OK, Failure, Opt, parse_command_args, wants_help};
use crate::auth_token::rotate_auth_token;
use crate::context::CliContext;
use crate::index::{Outcome, command_help};
use crate::server_config::get_lan_ips;
use crate::service_context::{
    ServiceAccessInfo, access_urls, read_service_access, read_service_setup,
    restart_running_service, runtime_data_root,
};

fn mask(token: &str) -> String {
    let chars: Vec<char> = token.chars().collect();
    let tail: String = chars[chars.len().saturating_sub(4)..].iter().collect();
    let head: String = chars.iter().take(4).collect();
    format!("{head}...{tail}")
}

/// The restart after a change, or the reminder to do it.
fn finish(context: &CliContext, restart: bool) -> i32 {
    if !restart {
        context.log("Restart Roamgate to apply: `roamgate service restart`.");
        return EXIT_OK;
    }
    match restart_running_service(context) {
        Err(message) => {
            context.error(&format!("roamgate auth: {message}"));
            EXIT_FAILURE
        }
        Ok(None) => {
            context.log(
                "The managed service is not running; restart any foreground roamgate process to apply.",
            );
            EXIT_OK
        }
        Ok(Some(code)) => {
            if code == 0 {
                context.log("Restarted the service.");
            }
            code
        }
    }
}

fn show(
    context: &CliContext,
    access: &ServiceAccessInfo,
    rest: &[String],
    secret: &Path,
) -> Result<i32, Failure> {
    let parsed = parse_command_args(rest, &[Opt::flag("reveal"), Opt::flag("json")], 0)?;
    let token = access.token.as_ref().map(|token| {
        if parsed.flag("reveal") {
            token.clone()
        } else {
            mask(token)
        }
    });
    if parsed.flag("json") {
        let mut out = Map::new();
        out.insert(
            "method".into(),
            json!(if access.password { "password" } else { "token" }),
        );
        if !access.password {
            out.insert(
                "token_path".into(),
                json!(access.token_path.display().to_string()),
            );
            out.insert("token".into(), json!(token));
        }
        if let Some(error) = &access.token_error {
            out.insert("token_error".into(), json!(error));
        }
        out.insert("pin_enabled".into(), json!(access.pin_enabled));
        out.insert(
            "session_secret_path".into(),
            json!(secret.display().to_string()),
        );
        out.insert("session_secret_exists".into(), json!(secret.exists()));
        context.print_json(&Value::Object(out));
        return Ok(EXIT_OK);
    }
    if access.password {
        context.log("Login: fixed password (ROAMGATE_PASSWORD in the service config)");
    } else {
        context.log("Login: generated token");
        context.log(&format!(
            "Token file: {}",
            context.display_path(&access.token_path)
        ));
        context.log(&format!(
            "Token: {}",
            match (&access.token_error, &token) {
                (Some(error), _) => format!("invalid ({error}); run `roamgate auth rotate`"),
                (None, Some(token)) => token.clone(),
                (None, None) => "(not created yet)".into(),
            }
        ));
    }
    context.log(&format!(
        "PIN login: {}",
        if access.pin_enabled {
            "enabled"
        } else {
            "disabled"
        }
    ));
    Ok(EXIT_OK)
}

/// `roamgate auth <args>`.
pub async fn run(args: &[String], context: &CliContext) -> Result<Outcome, Failure> {
    let Some(action) = args.first().filter(|_| !wants_help(args)) else {
        context.log(command_help("auth"));
        return Ok(Outcome::Code(EXIT_OK));
    };
    let rest = &args[1..];
    let setup = read_service_setup(&context.runtime).map_err(Failure::Failed)?;
    let secret = session_secret_path(
        roamgate_env(&setup.env, "SETTINGS_PATH").as_deref(),
        &runtime_data_root(&context.runtime),
    );

    if action == "show" {
        let access = read_service_access(&context.runtime, &setup).map_err(Failure::Failed)?;
        return show(context, &access, rest, &secret).map(Outcome::Code);
    }

    let parsed = parse_command_args(rest, &[Opt::flag("no-restart")], 0)?;
    let restart = !parsed.flag("no-restart");

    if action == "rotate" {
        // A broken token file is reported, not failed, so rotate replaces it.
        let access = read_service_access(&context.runtime, &setup).map_err(Failure::Failed)?;
        if access.password {
            context
                .error("roamgate auth: the service uses a fixed password, not a generated token.");
            context.error("Change it with `roamgate config set ROAMGATE_PASSWORD=- --restart`.");
            return Ok(Outcome::Code(EXIT_FAILURE));
        }
        // The server reads the current location; it migrates only when absent.
        let token_path = roamgate_base::paths::dirname(&setup.paths.config).join("auth-token");
        let token =
            rotate_auth_token(&context.service().data(), &token_path).map_err(Failure::Failed)?;
        context.log(&format!(
            "Rotated the login token in {}.",
            context.display_path(&token_path)
        ));
        context.log("Every signed-in browser must sign in again with the new URL.");
        if access.pin_enabled {
            context.log("PIN login stays enabled with the same PIN.");
        }
        let code = finish(context, restart);
        let urls = access_urls(
            &ServiceAccessInfo {
                token: Some(token),
                token_path,
                ..access
            },
            get_lan_ips,
        );
        context.log(&format!("Open: {}", urls.local));
        for url in &urls.lan {
            context.log(&format!("LAN: {url}"));
        }
        return Ok(Outcome::Code(code));
    }

    if action == "revoke-sessions" {
        let removed =
            revoke_session_secret(&context.service().data(), &secret).map_err(Failure::failed)?;
        context.log(if removed {
            "Discarded the session signing secret; every browser must sign in again."
        } else {
            "No session signing secret exists yet; there are no sessions to revoke."
        });
        return Ok(Outcome::Code(if removed {
            finish(context, restart)
        } else {
            EXIT_OK
        }));
    }

    Err(Failure::usage(format!("unknown auth action: {action}")))
}

#[cfg(test)]
mod tests;
