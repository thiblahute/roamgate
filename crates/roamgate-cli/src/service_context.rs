//! What management commands read of the managed service
//! (cli/service-context.ts): its environment file, its access settings and
//! login URLs, and restarting it when it runs.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Duration;

use roamgate_base::env::roamgate_env;
use roamgate_base::paths::{DataContext, DataFile};
use roamgate_exec::service::{ServicePlatform, resolve_service_platform};

use crate::auth_token::{open_error, read_auth_token};
use crate::commands::CliRuntime;
use crate::context::CliContext;
use crate::server_config::{
    HerdrSocketSettings, browser_url_for, herdr_config_dir, is_any_host, resolve_herdr_socket_paths,
};
use crate::service::{
    DEFAULT_SERVICE_ENV_FILE, ServicePaths, ServiceStatus, parse_service_environment,
    prepare_service_access, resolve_legacy_service_paths, resolve_service_paths, restart_service,
    roamgate_service_status,
};

pub use roamgate_base::credentials::with_login_token;

/// The managed service's environment file, read but not parsed.
#[derive(Debug, Clone)]
pub struct ServiceConfigFile {
    pub platform: ServicePlatform,
    pub paths: ServicePaths,
    /// The herdr-gui layout the server still reads when files are missing.
    pub legacy_paths: ServicePaths,
    /// The file in effect: current, else legacy, else current.
    pub config_path: PathBuf,
    pub config_exists: bool,
    /// Its contents, or the default template when it does not exist.
    pub contents: String,
    pub home: PathBuf,
}

/// The service's configuration as the service process sees it.
#[derive(Debug, Clone)]
pub struct ServiceSetup {
    pub file: ServiceConfigFile,
    pub env: BTreeMap<String, String>,
}

impl std::ops::Deref for ServiceSetup {
    type Target = ServiceConfigFile;

    fn deref(&self) -> &ServiceConfigFile {
        &self.file
    }
}

fn data_context(runtime: &CliRuntime) -> DataContext {
    runtime.service().data()
}

/// The private data directory of the runtime's user.
pub fn runtime_data_root(runtime: &CliRuntime) -> PathBuf {
    runtime.data_root()
}

/// connections.json: `ROAMGATE_CONNECTIONS_PATH` of `env`, else the data
/// directory's.
pub fn connection_registry_path(
    runtime: &CliRuntime,
    env: &BTreeMap<String, String>,
) -> Result<PathBuf, String> {
    match roamgate_env(env, "CONNECTIONS_PATH") {
        Some(path) => Ok(PathBuf::from(path)),
        None => data_context(runtime)
            .default_data_file(DataFile::Connections)
            .map_err(|error| error.to_string()),
    }
}

/// The Herdr sockets the service resolves from its environment file.
pub fn service_herdr_sockets(
    runtime: &CliRuntime,
    env: &BTreeMap<String, String>,
) -> (String, String) {
    resolve_herdr_socket_paths(&HerdrSocketSettings {
        socket_path: env.get("HERDR_SOCKET_PATH").cloned(),
        client_socket_path: env.get("HERDR_CLIENT_SOCKET_PATH").cloned(),
        ssh_host: env.get("HERDR_SSH_HOST").cloned(),
        session: env.get("HERDR_SESSION").cloned(),
        herdr_dir: herdr_config_dir(
            &runtime.platform,
            runtime.app_data.as_deref(),
            &runtime.home,
        ),
        tmp: std::env::temp_dir(),
        platform: runtime.platform.clone(),
    })
}

/// Locates and reads the environment file without parsing it, so commands
/// that repair a broken file still work. Fails only for unsupported
/// platforms and unreadable or unsafe paths.
pub fn locate_service_config(runtime: &CliRuntime) -> Result<ServiceConfigFile, String> {
    let platform = resolve_service_platform(&runtime.platform)?;
    let paths = resolve_service_paths(platform, &runtime.home, runtime.app_data.as_deref());
    let legacy = resolve_legacy_service_paths(platform, &runtime.home, runtime.app_data.as_deref());
    // Inspection never migrates: the new file, then the legacy one.
    let config_path = [&paths.config, &legacy.config]
        .into_iter()
        .find(|path| path.exists())
        .unwrap_or(&paths.config)
        .clone();
    data_context(runtime)
        .assert_safe_data_path(&config_path)
        .map_err(|error| error.to_string())?;
    let config_exists = config_path.exists();
    let contents = if config_exists {
        std::fs::read_to_string(&config_path).map_err(|error| error.to_string())?
    } else {
        DEFAULT_SERVICE_ENV_FILE.to_owned()
    };
    Ok(ServiceConfigFile {
        platform,
        paths,
        legacy_paths: legacy,
        config_path,
        config_exists,
        contents,
        home: runtime.home.clone(),
    })
}

/// Also fails when the file has entries the service could not load.
pub fn read_service_setup(runtime: &CliRuntime) -> Result<ServiceSetup, String> {
    let file = locate_service_config(runtime)?;
    let env = parse_service_environment(
        &file.contents,
        &file.config_path.display().to_string(),
        file.platform,
        &file.home.display().to_string(),
    )?;
    Ok(ServiceSetup { file, env })
}

/// How the service lets browsers in (ServiceAccessInfo).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServiceAccessInfo {
    pub host: String,
    pub port: u16,
    pub tls: bool,
    /// A fixed password, else the generated token.
    pub password: bool,
    /// The token, when its file exists and is valid.
    pub token: Option<String>,
    /// Why an existing token file is unusable; the server would not start.
    pub token_error: Option<String>,
    pub token_path: PathBuf,
    pub pin_enabled: bool,
}

/// Like the server: the current token, else a legacy one it would migrate.
pub fn generated_token_path(file: &ServiceConfigFile) -> PathBuf {
    let current = roamgate_base::paths::dirname(&file.paths.config).join("auth-token");
    let legacy = roamgate_base::paths::dirname(&file.legacy_paths.config).join("auth-token");
    if current.exists() || !legacy.exists() {
        current
    } else {
        legacy
    }
}

/// Validated access settings and the existing token; never creates one.
pub fn read_service_access(
    runtime: &CliRuntime,
    setup: &ServiceSetup,
) -> Result<ServiceAccessInfo, String> {
    let access = prepare_service_access(
        &setup.config_path.display().to_string(),
        &setup.contents,
        setup.platform,
        &setup.home.display().to_string(),
    )?;
    let token_path = generated_token_path(setup);
    let (mut token, mut token_error) = (None, None);
    if !access.uses_fixed_password && token_path.exists() {
        // Reported, not failed, so `auth rotate` can replace a broken token.
        match data_context(runtime).assert_safe_data_path(&token_path) {
            Err(error) => token_error = Some(error.to_string()),
            Ok(()) => match read_auth_token(&token_path) {
                Ok(value) => token = Some(value),
                Err(error) => token_error = Some(open_error(&error, &token_path)),
            },
        }
    }
    Ok(ServiceAccessInfo {
        host: access.host,
        port: access.port,
        tls: access.tls,
        password: access.uses_fixed_password,
        token,
        token_error,
        token_path,
        pin_enabled: roamgate_env(&setup.env, "PIN").is_some_and(|pin| !pin.is_empty()),
    })
}

/// Login URLs for this machine and, on wildcard binds, every LAN address.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccessUrls {
    pub local: String,
    pub lan: Vec<String>,
}

pub fn access_urls(
    access: &ServiceAccessInfo,
    lan_ips: impl FnOnce() -> Vec<String>,
) -> AccessUrls {
    let with_token = |url: String| {
        if access.password {
            url
        } else {
            with_login_token(&url, access.token.as_deref())
        }
    };
    AccessUrls {
        local: with_token(browser_url_for(&access.host, access.port, access.tls)),
        lan: if is_any_host(&access.host) {
            lan_ips()
                .iter()
                .map(|ip| with_token(browser_url_for(ip, access.port, access.tls)))
                .collect()
        } else {
            Vec::new()
        },
    }
}

/// roamgateServiceStatus with the context's commands.
pub fn service_status(context: &CliContext) -> Result<ServiceStatus, String> {
    roamgate_service_status(&context.service(), context.run.as_ref())
}

/// Restarts the managed service when it runs, so a change takes effect:
/// the exit code, or None when nothing was running.
pub fn restart_running_service(context: &CliContext) -> Result<Option<i32>, String> {
    let status = service_status(context)?;
    if !status.installed || !status.active {
        return Ok(None);
    }
    Ok(Some(restart_service(
        &context.service(),
        context.run.as_ref(),
        &mut |line| context.log(line),
        &mut |line| context.error(line),
    )))
}

/// The address a local client uses to reach the configured listener.
pub fn probe_url(host: &str, port: u16, tls: bool) -> String {
    let host = if is_any_host(host) {
        if host == "::" { "[::1]" } else { "127.0.0.1" }.to_owned()
    } else if host.contains(':') && !host.starts_with('[') {
        format!("[{host}]")
    } else {
        host.to_owned()
    };
    format!(
        "{}://{host}:{port}/healthz",
        if tls { "https" } else { "http" }
    )
}

/// Whether a Roamgate listener answers its unauthenticated health check
/// (`Ok`, 200) within 2 s. Self-signed local certificates are accepted: the
/// check only identifies the listener and sends no credentials.
pub async fn probe_listener(host: &str, port: u16, tls: bool) -> bool {
    let Ok(client) = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .danger_accept_invalid_certs(true)
        .timeout(Duration::from_secs(2))
        .build()
    else {
        return false;
    };
    let Ok(response) = client.get(probe_url(host, port, tls)).send().await else {
        return false;
    };
    let status = response.status().as_u16();
    matches!(response.text().await, Ok(body) if status == 200 && body == "Ok")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probes_the_address_a_local_client_reaches() {
        assert_eq!(probe_url("0.0.0.0", 1, false), "http://127.0.0.1:1/healthz");
        assert_eq!(probe_url("::", 2, true), "https://[::1]:2/healthz");
        assert_eq!(probe_url("fe80::1", 3, false), "http://[fe80::1]:3/healthz");
        assert_eq!(probe_url("[::1]", 4, false), "http://[::1]:4/healthz");
        assert_eq!(probe_url("box", 5, false), "http://box:5/healthz");
    }
}
