//! `roamgate url` (cli/url.ts): the managed service's login URLs, and a QR
//! code to open one on a phone.

use serde_json::{Map, Value, json};

use crate::args::{EXIT_FAILURE, EXIT_OK, Failure, Opt, parse_command_args, wants_help};
use crate::context::CliContext;
use crate::index::{Outcome, command_help};
use crate::qr::render_terminal_qr;
use crate::server_config::{browser_url_for, get_lan_ips};
use crate::service_context::{
    access_urls, read_service_access, read_service_setup, with_login_token,
};

const LOOPBACK_HOSTS: &[&str] = &["localhost", "127.0.0.1", "::1", "[::1]"];

/// JavaScript's `\s`.
pub(crate) fn js_space(character: char) -> bool {
    character.is_whitespace() || character == '\u{feff}'
}

/// `roamgate url <args>`.
pub async fn run(args: &[String], context: &CliContext) -> Result<Outcome, Failure> {
    run_with(args, context, get_lan_ips)
}

/// [`run`] with the LAN addresses `lan_ips` gives.
pub fn run_with(
    args: &[String],
    context: &CliContext,
    lan_ips: fn() -> Vec<String>,
) -> Result<Outcome, Failure> {
    if wants_help(args) {
        context.log(command_help("url"));
        return Ok(Outcome::Code(EXIT_OK));
    }
    let parsed = parse_command_args(
        args,
        &[Opt::flag("qr"), Opt::string("address"), Opt::flag("json")],
        0,
    )?;
    let (qr, json) = (parsed.flag("qr"), parsed.flag("json"));
    if qr && json {
        return Err(Failure::usage("--qr and --json cannot be combined"));
    }
    let given = parsed.string("address");
    let address = given.map(|value| roamgate_base::settings::js_trim(value).to_owned());
    if given.is_some() && address.as_deref() == Some("") {
        return Err(Failure::usage("--address must not be empty"));
    }
    if let Some(address) = &address
        && address.chars().any(|c| js_space(c) || "/?#@".contains(c))
    {
        return Err(Failure::usage(
            "--address must be a host name or IP address",
        ));
    }

    let setup = read_service_setup(&context.runtime).map_err(Failure::Failed)?;
    let access = read_service_access(&context.runtime, &setup).map_err(Failure::Failed)?;
    let urls = access_urls(&access, lan_ips);
    let custom = address.as_ref().map(|address| {
        with_login_token(
            &browser_url_for(address, access.port, access.tls),
            if access.password {
                None
            } else {
                access.token.as_deref()
            },
        )
    });
    let missing_token = !access.password && access.token.is_none();

    if json {
        let mut out = Map::new();
        out.insert(
            "config_path".into(),
            json!(setup.config_path.display().to_string()),
        );
        out.insert("config_exists".into(), json!(setup.config_exists));
        out.insert(
            "auth".into(),
            json!(if access.password { "password" } else { "token" }),
        );
        if !access.password {
            out.insert("token_available".into(), json!(!missing_token));
        }
        out.insert("local".into(), json!(urls.local));
        out.insert("lan".into(), json!(urls.lan));
        if let Some(custom) = &custom {
            out.insert("address".into(), json!(custom));
        }
        context.print_json(&Value::Object(out));
        return Ok(Outcome::Code(EXIT_OK));
    }

    if !setup.config_exists {
        context.error(&format!(
            "No service environment at {}; showing defaults.",
            context.display_path(&setup.config_path)
        ));
    }
    if let Some(error) = &access.token_error {
        context.error(&format!(
            "The login token file is invalid ({error}); run `roamgate auth rotate`."
        ));
    } else if missing_token {
        context.error(
            "No login token yet: it is created by `roamgate service install` or the first server start.",
        );
    }
    if let Some(custom) = &custom {
        context.log(&format!("Address: {custom}"));
    }
    context.log(&format!("Local:   {}", urls.local));
    for url in &urls.lan {
        context.log(&format!("LAN:     {url}"));
    }
    if !qr {
        return Ok(Outcome::Code(EXIT_OK));
    }

    let target = custom
        .clone()
        .or_else(|| urls.lan.first().cloned())
        .unwrap_or_else(|| urls.local.clone());
    let parsed_target = url::Url::parse(&target).map_err(Failure::failed)?;
    let host = parsed_target.host_str().unwrap_or_default();
    if custom.is_none() && LOOPBACK_HOSTS.contains(&host) {
        context.error(
            "The service only listens on this machine, so another device cannot open this URL.",
        );
        context.error(
            "Use --address with a reachable name, or `roamgate config set HOST=0.0.0.0 --restart`.",
        );
        return Ok(Outcome::Code(EXIT_FAILURE));
    }
    context.log("");
    context.log(&render_terminal_qr(&target));
    context.log(&format!(
        "QR code opens: {}",
        parsed_target.origin().ascii_serialization()
    ));
    if !access.password && access.token.is_some() {
        context.log("This code contains your login token. Anyone who scans it can sign in.");
    }
    Ok(Outcome::Code(EXIT_OK))
}

#[cfg(test)]
mod tests;
