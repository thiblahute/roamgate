//! `roamgate doctor` (cli/doctor.ts): checks the installation (service
//! config, credentials, TLS certificate, user service, listener, network
//! exposure, local Herdr, saved connections, Web Push, the session archive
//! and updates) and reports problems with fixes. Exits 1 when a check fails.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use roamgate_base::env::roamgate_env;
use roamgate_connections::profile_service::{ProbeResult, test_connection_sockets};
use roamgate_exec::process::ProcessRunner;
use roamgate_exec::service::resolve_service_platform;
use roamgate_herdr::service::{HerdrServiceDeps, herdr_service_status};
use serde_json::{Map, Value, json};

use crate::args::{EXIT_FAILURE, EXIT_OK, Failure, Opt, parse_command_args, wants_help};
use crate::connections::{LocalFuture, Probe};
use crate::context::CliContext;
use crate::index::{Outcome, command_help};
use crate::server_config::{get_lan_ips, is_any_host};
use crate::service::resolve_legacy_service_paths;
use crate::service_context::{
    ServiceAccessInfo, ServiceSetup, access_urls, connection_profile_store, probe_listener,
    probe_url, read_service_access, read_service_setup, runtime_data_root, service_herdr_sockets,
    service_status,
};
use crate::update::{
    compare_version, fetch_latest_update_manifest, normalize_update_base_url,
    resolve_update_target, system_run_process,
};

const CERT_WARNING_DAYS: i64 = 14;
const DAY_MS: i64 = 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Ok,
    Warn,
    Fail,
    Skip,
}

impl Status {
    fn name(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Warn => "warn",
            Self::Fail => "fail",
            Self::Skip => "skip",
        }
    }

    /// STATUS_LABELS.
    fn label(self) -> &'static str {
        match self {
            Self::Ok => "ok  ",
            Self::Warn => "warn",
            Self::Fail => "FAIL",
            Self::Skip => "skip",
        }
    }
}

/// One check's result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Check {
    pub name: String,
    pub status: Status,
    pub detail: String,
    pub hint: Option<String>,
}

impl Check {
    fn new(name: &str, status: Status, detail: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            status,
            detail: detail.into(),
            hint: None,
        }
    }

    fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn to_json(&self) -> Value {
        let mut check = Map::new();
        check.insert("name".into(), self.name.clone().into());
        check.insert("status".into(), self.status.name().into());
        check.insert("detail".into(), self.detail.clone().into());
        if let Some(hint) = &self.hint {
            check.insert("hint".into(), hint.clone().into());
        }
        Value::Object(check)
    }
}

/// Tests Herdr's control and render sockets.
pub type TestSockets =
    Box<dyn for<'a> Fn(&'a str, &'a str) -> LocalFuture<'a, Result<ProbeResult, String>>>;

/// The latest release's version for this platform; None without a package.
pub type LatestVersion = Box<
    dyn for<'a> Fn(
        &'a CliContext,
        &'a BTreeMap<String, String>,
    ) -> LocalFuture<'a, Result<Option<String>, String>>,
>;

/// Whether another process holds a host and port.
pub type PortInUse = Box<dyn Fn(&str, u16) -> bool>;

/// The managed Herdr service: installed, running.
pub type HerdrService = Box<dyn Fn(&CliContext) -> Result<(bool, bool), String>>;

/// The session archive's check at a time (epoch ms).
pub type ArchiveCheck = Box<dyn Fn(&CliContext, i64) -> Check>;

/// The command's effects (DoctorDependencies).
pub struct DoctorDeps {
    pub probe: Probe,
    pub port_in_use: PortInUse,
    pub test_sockets: TestSockets,
    /// The managed Herdr service: installed, running.
    pub herdr_service: HerdrService,
    pub latest_version: LatestVersion,
    pub lan_ips: Box<dyn Fn() -> Vec<String>>,
    /// Now, in epoch milliseconds.
    pub now: Box<dyn Fn() -> i64>,
    /// The session archive's check at a time.
    pub archive: ArchiveCheck,
}

impl Default for DoctorDeps {
    fn default() -> Self {
        Self {
            probe: Box::new(|access| {
                Box::pin(probe_listener(&access.host, access.port, access.tls))
            }),
            port_in_use: Box::new(default_port_in_use),
            test_sockets: Box::new(|control, client| {
                Box::pin(async move {
                    test_connection_sockets(control, client)
                        .await
                        .map_err(|error| error.message)
                })
            }),
            herdr_service: Box::new(|context| {
                let runtime = &context.runtime;
                let state = herdr_service_status(&HerdrServiceDeps {
                    platform: resolve_service_platform(&runtime.platform)?,
                    home: runtime.home.clone(),
                    app_data: runtime.app_data.clone(),
                    uid: runtime.uid,
                    run: context.run.as_ref(),
                });
                Ok((state.installed, state.active))
            }),
            latest_version: Box::new(|context, env| Box::pin(default_latest_version(context, env))),
            lan_ips: Box::new(get_lan_ips),
            now: Box::new(|| {
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |elapsed| elapsed.as_millis() as i64)
            }),
            archive: Box::new(archive_check),
        }
    }
}

/// Binds and releases the address to learn whether another process holds
/// it.
pub fn default_port_in_use(host: &str, port: u16) -> bool {
    match std::net::TcpListener::bind((host, port)) {
        Ok(_) => false,
        Err(error) => error.kind() == std::io::ErrorKind::AddrInUse,
    }
}

async fn default_latest_version(
    context: &CliContext,
    env: &BTreeMap<String, String>,
) -> Result<Option<String>, String> {
    let Some(target) = resolve_update_target(&context.runtime.platform, &context.runtime.arch)
    else {
        return Ok(None);
    };
    let base = roamgate_env(context.runtime.env.as_ref(), "UPDATE_BASE_URL")
        .or_else(|| roamgate_env(env, "UPDATE_BASE_URL"));
    let base = normalize_update_base_url(base.as_deref())?;
    let run = system_run_process(ProcessRunner::system());
    Ok(Some(
        fetch_latest_update_manifest(&base, &target, &run)
            .await?
            .version,
    ))
}

/// The session archive's check (cli/archive.ts archiveCheck), as far as
/// this build knows the archive: its database's place. Health needs the
/// archive's own crate.
pub fn archive_check(context: &CliContext, _now: i64) -> Check {
    let directory = archive_directory(context);
    let existing = ["archive.sqlite", "index.sqlite"]
        .iter()
        .map(|name| directory.join(name))
        .find(|path| path.exists());
    match existing {
        None => Check::new(
            "Archive",
            Status::Skip,
            "not set up (roamgate archive sync)",
        ),
        Some(_) => Check::new(
            "Archive",
            Status::Skip,
            "health is checked by `roamgate archive health`",
        )
        .hint("Run `roamgate archive health`."),
    }
}

/// archiveDirFor: ROAMGATE_ARCHIVE_DIR, else the `archive.dir` setting,
/// else `<data>/archive` (or a legacy `claude-archive` left in place).
fn archive_directory(context: &CliContext) -> PathBuf {
    let runtime = &context.runtime;
    let settings_path = read_service_setup(runtime)
        .ok()
        .and_then(|setup| roamgate_env(&setup.env, "SETTINGS_PATH"))
        .or_else(|| roamgate_env(runtime.env.as_ref(), "SETTINGS_PATH"))
        .map(PathBuf::from)
        .unwrap_or_else(|| runtime_data_root(runtime).join("settings.json"));
    let setting = std::fs::read_to_string(&settings_path)
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .and_then(|value| value["archive"]["dir"].as_str().map(str::to_owned))
        .filter(|dir| !dir.trim().is_empty());
    let explicit = runtime
        .env
        .var("ROAMGATE_ARCHIVE_DIR")
        .map(|dir| dir.trim().to_owned())
        .or(setting);
    if let Some(dir) = explicit.filter(|dir| !dir.trim().is_empty()) {
        return PathBuf::from(dir.trim());
    }
    let root = runtime_data_root(runtime);
    let directory = root.join("archive");
    let legacy = root.join("claude-archive");
    if !directory.exists() && legacy.exists() {
        return legacy;
    }
    directory
}

/// `toISOString().slice(0, 10)`.
fn iso_date(ms: i64) -> String {
    jiff::Timestamp::from_millisecond(ms)
        .map(|time| time.strftime("%Y-%m-%d").to_string())
        .unwrap_or_default()
}

/// The certificate's expiry (epoch ms) and its subject as Node prints it.
fn read_certificate(path: &Path) -> Result<(i64, String), String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    let der = match x509_parser::pem::parse_x509_pem(&bytes) {
        Ok((_, pem)) => pem.contents,
        Err(_) => bytes,
    };
    let (_, certificate) =
        x509_parser::parse_x509_certificate(&der).map_err(|error| error.to_string())?;
    let expires = certificate.validity().not_after.timestamp() * 1000;
    let registry = x509_parser::objects::oid_registry();
    let subject: Vec<String> = certificate
        .subject()
        .iter()
        .map(|rdn| {
            rdn.iter()
                .map(|attribute| {
                    let name = x509_parser::objects::oid2abbrev(attribute.attr_type(), registry)
                        .map(str::to_owned)
                        .unwrap_or_else(|_| attribute.attr_type().to_id_string());
                    let value = attribute.as_str().unwrap_or_default();
                    format!("{name}={value}")
                })
                .collect::<Vec<_>>()
                .join("+")
        })
        .collect();
    Ok((expires, subject.join(", ")))
}

fn certificate_check(path: &str, now: i64) -> Check {
    let name = "TLS certificate";
    let (expires, subject) = match read_certificate(Path::new(path)) {
        Ok(read) => read,
        Err(error) => {
            return Check::new(name, Status::Fail, format!("cannot read {path}: {error}"));
        }
    };
    let days = (expires - now).div_euclid(DAY_MS);
    if days < 0 {
        return Check::new(
            name,
            Status::Fail,
            format!("expired on {} ({subject})", iso_date(expires)),
        )
        .hint("Renew the certificate, then run `roamgate service restart`.");
    }
    let check = Check::new(
        name,
        if days < CERT_WARNING_DAYS {
            Status::Warn
        } else {
            Status::Ok
        },
        format!(
            "valid until {}, {days} days left ({subject})",
            iso_date(expires)
        ),
    );
    if days < CERT_WARNING_DAYS {
        check.hint("Renew the certificate soon.")
    } else {
        check
    }
}

fn service_checks(context: &CliContext, setup: &ServiceSetup) -> Result<Vec<Check>, String> {
    let status = service_status(context)?;
    let mut checks = vec![if !status.installed {
        Check::new("Service", Status::Warn, "not installed")
            .hint("Run `roamgate service install` to start Roamgate at login.")
    } else if status.active {
        Check::new(
            "Service",
            Status::Ok,
            format!(
                "installed and running ({})",
                context.display_path(&status.definition)
            ),
        )
    } else {
        Check::new("Service", Status::Fail, "installed but not running")
            .hint("Run `roamgate service logs` to see why, then `roamgate service restart`.")
    }];
    let legacy = resolve_legacy_service_paths(
        setup.platform,
        &context.runtime.home,
        context.runtime.app_data.as_deref(),
    );
    if legacy.definition.exists() {
        checks.push(
            Check::new(
                "Legacy service",
                Status::Warn,
                format!(
                    "herdr-gui service definition found: {}",
                    context.display_path(&legacy.definition)
                ),
            )
            .hint("See docs/DEPLOYMENT.md#transition-from-herdr-studio--herdr-gui."),
        );
    }
    Ok(checks)
}

async fn listener_check(
    access: &ServiceAccessInfo,
    service_active: bool,
    deps: &DoctorDeps,
) -> Check {
    let probe = probe_url(&access.host, access.port, access.tls);
    let url = probe.strip_suffix("/healthz").unwrap_or(&probe);
    if (deps.probe)(access).await {
        return Check::new("Listener", Status::Ok, format!("Roamgate answers at {url}"));
    }
    if (deps.port_in_use)(&access.host, access.port) {
        return Check::new(
            "Listener",
            Status::Fail,
            format!(
                "port {} is held by a process that is not answering as Roamgate",
                access.port
            ),
        )
        .hint("Stop the other process, or choose another port with `roamgate config set PORT=<n> --restart`.");
    }
    if service_active {
        Check::new(
            "Listener",
            Status::Fail,
            format!("the service runs but nothing answers at {url}"),
        )
        .hint("Run `roamgate service logs` to see why.")
    } else {
        Check::new(
            "Listener",
            Status::Warn,
            format!("nothing answers at {url}"),
        )
        .hint("Start it with `roamgate service install`, or run `roamgate`.")
    }
}

fn network_check(access: &ServiceAccessInfo, deps: &DoctorDeps) -> Check {
    if ["127.0.0.1", "localhost", "::1"].contains(&access.host.as_str()) {
        return Check::new(
            "Network",
            Status::Ok,
            format!("only this machine can connect (HOST={})", access.host),
        );
    }
    let origins = access_urls(
        &ServiceAccessInfo {
            token: None,
            password: true,
            ..access.clone()
        },
        || (deps.lan_ips)(),
    );
    let reachable = if is_any_host(&access.host) {
        origins.lan
    } else {
        vec![origins.local]
    };
    let transport = if access.tls {
        "HTTPS"
    } else {
        "plain HTTP; use a trusted private network or VPN"
    };
    let mut parts = vec![format!(
        "listening on {}:{}, {transport}",
        access.host, access.port
    )];
    if !reachable.is_empty() {
        parts.push(format!("reachable at {}", reachable.join(", ")));
    }
    if access.pin_enabled {
        return Check::new(
            "Network",
            Status::Warn,
            format!("{}; PIN login is enabled", parts.join("; ")),
        )
        .hint("PIN login is meant for trusted private networks only.");
    }
    Check::new("Network", Status::Ok, parts.join("; "))
}

fn setting<'a>(setup: &'a ServiceSetup, name: &str) -> Option<&'a str> {
    setup
        .env
        .get(name)
        .map(String::as_str)
        .filter(|value| !value.is_empty())
}

async fn herdr_check(context: &CliContext, setup: &ServiceSetup, deps: &DoctorDeps) -> Check {
    if let Some(host) = setting(setup, "HERDR_SSH_HOST") {
        return Check::new(
            "Herdr",
            Status::Skip,
            format!("remote Herdr over SSH ({host})"),
        )
        .hint("Run `roamgate connections test` to check the SSH connection.");
    }
    let (control, client) = service_herdr_sockets(&context.runtime, &setup.env);
    // The service's state is supplementary.
    let managed = match (deps.herdr_service)(context) {
        Ok((true, active)) => format!(
            "; managed Herdr service {}",
            if active { "running" } else { "not running" }
        ),
        _ => String::new(),
    };
    match (deps.test_sockets)(&control, &client).await {
        Ok(result) => Check::new(
            "Herdr",
            Status::Ok,
            format!(
                "Herdr {}, protocol {}{managed}",
                result.version.as_deref().unwrap_or("(unknown version)"),
                crate::connections::template_text(&serde_json::json!(result.protocol))
            ),
        ),
        Err(error) => {
            let explicit = setting(setup, "HERDR_SOCKET_PATH").is_some()
                || setting(setup, "HERDR_CLIENT_SOCKET_PATH").is_some();
            Check::new(
                "Herdr",
                Status::Fail,
                format!("cannot reach {control}: {error}{managed}"),
            )
            .hint(if explicit {
                "Check HERDR_SOCKET_PATH and HERDR_CLIENT_SOCKET_PATH with `roamgate config show`."
            } else {
                "Run `roamgate herdr setup` to install and start Herdr."
            })
        }
    }
}

fn connections_check(context: &CliContext, setup: &ServiceSetup) -> Check {
    let loaded =
        connection_profile_store(&context.runtime, &setup.env).and_then(|store| store.load());
    match loaded {
        Ok(registry) => Check::new(
            "Connections",
            Status::Ok,
            match registry {
                Some(registry) => format!(
                    "{} saved profile{}, default {}",
                    registry.profiles.len(),
                    if registry.profiles.len() == 1 {
                        ""
                    } else {
                        "s"
                    },
                    registry.default_connection_id
                ),
                None => "default local connection only".into(),
            },
        ),
        Err(error) => Check::new(
            "Connections",
            Status::Fail,
            format!("invalid registry: {error}"),
        )
        .hint("Roamgate preserves the file and disables profile edits until it is fixed."),
    }
}

fn push_check(context: &CliContext, setup: &ServiceSetup) -> Check {
    use roamgate_notify::web_push::{
        read_push_registry, valid_push_subject, web_push_path, web_push_subject,
    };
    let subject = web_push_subject(&setup.env);
    if subject.is_empty() {
        return Check::new(
            "Web Push",
            Status::Skip,
            "disabled (ROAMGATE_WEB_PUSH_SUBJECT is empty)",
        );
    }
    if !valid_push_subject(&subject) {
        return Check::new(
            "Web Push",
            Status::Fail,
            format!("invalid ROAMGATE_WEB_PUSH_SUBJECT: {subject}"),
        )
        .hint("Use a mailto: address or an HTTPS URL.");
    }
    let path = web_push_path(&setup.env, &runtime_data_root(&context.runtime));
    if !path.exists() {
        return Check::new("Web Push", Status::Ok, "no devices enrolled yet");
    }
    let mut next = 0;
    match read_push_registry(&context.service().data(), &path, &mut || {
        next += 1;
        next
    }) {
        Ok(registry) => {
            let devices = registry.devices.len();
            let check = Check::new(
                "Web Push",
                Status::Ok,
                format!(
                    "{devices} device{} enrolled",
                    if devices == 1 { "" } else { "s" }
                ),
            );
            if devices > 0 {
                check.hint("Run `roamgate push test` to check delivery.")
            } else {
                check
            }
        }
        Err(error) => Check::new(
            "Web Push",
            Status::Fail,
            format!("unusable registry {}: {}", path.display(), error.0),
        )
        .hint("Roamgate preserves the file and disables push until it is restored."),
    }
}

async fn update_check(
    context: &CliContext,
    setup: Option<&ServiceSetup>,
    offline: bool,
    deps: &DoctorDeps,
) -> Check {
    if offline {
        return Check::new("Updates", Status::Skip, "skipped (--offline)");
    }
    let empty = BTreeMap::new();
    let env = setup.map_or(&empty, |setup| &setup.env);
    if roamgate_env(context.runtime.env.as_ref(), "DISABLE_UPDATE_CHECK").as_deref() == Some("1")
        || roamgate_env(env, "DISABLE_UPDATE_CHECK").as_deref() == Some("1")
    {
        return Check::new(
            "Updates",
            Status::Skip,
            "disabled by ROAMGATE_DISABLE_UPDATE_CHECK",
        );
    }
    let latest = (deps.latest_version)(context, env)
        .await
        .and_then(|latest| {
            latest
                .map(|latest| {
                    compare_version(&latest, &context.runtime.version)
                        .map(|order| (latest, order == std::cmp::Ordering::Greater))
                })
                .transpose()
        });
    match latest {
        Ok(None) => Check::new(
            "Updates",
            Status::Skip,
            "no update package for this platform",
        ),
        Ok(Some((latest, true))) => Check::new(
            "Updates",
            Status::Warn,
            format!("roamgate {latest} is available"),
        )
        .hint("Run `roamgate update`."),
        Ok(Some((_, false))) => Check::new("Updates", Status::Ok, "up to date"),
        Err(error) => Check::new(
            "Updates",
            Status::Warn,
            format!(
                "could not check: {}",
                error.split('\n').next().unwrap_or_default()
            ),
        ),
    }
}

/// runDoctorChecks.
pub async fn run_doctor_checks(
    context: &CliContext,
    offline: bool,
    deps: &DoctorDeps,
) -> Vec<Check> {
    let runtime = &context.runtime;
    let mut checks = vec![Check::new(
        "Roamgate",
        Status::Ok,
        format!(
            "{} on {}-{}, {}",
            runtime.version,
            runtime.platform,
            runtime.arch,
            if runtime.standalone {
                context.display_path(&runtime.exec_path)
            } else {
                "source checkout".into()
            }
        ),
    )];
    let setup = match read_service_setup(runtime) {
        Ok(setup) => setup,
        Err(error) => {
            checks.push(Check::new("Service config", Status::Fail, error));
            checks.push(update_check(context, None, offline, deps).await);
            return checks;
        }
    };
    let access = match read_service_access(runtime, &setup) {
        Ok(access) => {
            checks.push(if setup.config_exists {
                Check::new(
                    "Service config",
                    Status::Ok,
                    context.display_path(&setup.config_path),
                )
            } else {
                Check::new(
                    "Service config",
                    Status::Warn,
                    format!(
                        "{} does not exist; defaults apply",
                        context.display_path(&setup.config_path)
                    ),
                )
                .hint("`roamgate service install` creates it.")
            });
            Some(access)
        }
        Err(error) => {
            checks.push(
                Check::new(
                    "Service config",
                    Status::Fail,
                    format!("{}: {error}", context.display_path(&setup.config_path)),
                )
                .hint("The service refuses to start; fix it with `roamgate config edit`."),
            );
            None
        }
    };
    if let Some(access) = &access {
        checks.push(if access.password {
            Check::new(
                "Login",
                Status::Ok,
                "fixed password from the service config",
            )
        } else if let Some(error) = &access.token_error {
            Check::new(
                "Login",
                Status::Fail,
                format!("invalid token file: {error}"),
            )
            .hint("The service refuses to start; run `roamgate auth rotate`.")
        } else if access.token.is_some() {
            Check::new(
                "Login",
                Status::Ok,
                format!(
                    "generated token in {}",
                    context.display_path(&access.token_path)
                ),
            )
        } else {
            Check::new("Login", Status::Warn, "no login token yet")
                .hint("It is created by `roamgate service install` or the first start.")
        });
        if let Some(certificate) = roamgate_env(&setup.env, "TLS_CERT")
            .filter(|certificate| access.tls && !certificate.is_empty())
        {
            checks.push(certificate_check(&certificate, (deps.now)()));
        }
    }
    let mut service_active = false;
    match service_checks(context, &setup) {
        Ok(service) => {
            service_active = service
                .first()
                .is_some_and(|check| check.status == Status::Ok);
            checks.extend(service);
        }
        Err(error) => checks.push(Check::new("Service", Status::Fail, error)),
    }
    let listener = async {
        match &access {
            Some(access) => Some(listener_check(access, service_active, deps).await),
            None => None,
        }
    };
    let (listener, herdr, update) = tokio::join!(
        listener,
        herdr_check(context, &setup, deps),
        update_check(context, Some(&setup), offline, deps)
    );
    checks.extend(listener);
    if let Some(access) = &access {
        checks.push(network_check(access, deps));
    }
    checks.push(herdr);
    checks.push(connections_check(context, &setup));
    checks.push(push_check(context, &setup));
    checks.push((deps.archive)(context, (deps.now)()));
    checks.push(update);
    checks
}

/// `roamgate doctor <args>`.
pub async fn run(args: &[String], context: &CliContext) -> Result<Outcome, Failure> {
    run_with(args, context, &DoctorDeps::default()).await
}

/// [`run`] with the effects `deps` gives.
pub async fn run_with(
    args: &[String],
    context: &CliContext,
    deps: &DoctorDeps,
) -> Result<Outcome, Failure> {
    if wants_help(args) {
        context.log(command_help("doctor"));
        return Ok(Outcome::Code(EXIT_OK));
    }
    let values = parse_command_args(args, &[Opt::flag("offline"), Opt::flag("json")], 0)?;
    let checks = run_doctor_checks(context, values.flag("offline"), deps).await;
    let failed = checks.iter().any(|check| check.status == Status::Fail);
    let code = if failed { EXIT_FAILURE } else { EXIT_OK };
    if values.flag("json") {
        context.print_json(&json!({
            "version": context.runtime.version,
            "ok": !failed,
            "checks": checks.iter().map(Check::to_json).collect::<Vec<_>>(),
        }));
        return Ok(Outcome::Code(code));
    }
    let width = checks
        .iter()
        .map(|check| check.name.chars().count())
        .max()
        .unwrap_or(0);
    for check in &checks {
        context.log(&format!(
            "{}  {:width$}  {}",
            check.status.label(),
            check.name,
            check.detail
        ));
        if let Some(hint) = check.hint.as_ref().filter(|_| check.status != Status::Ok) {
            context.log(&format!("{}{hint}", " ".repeat(width + 8)));
        }
    }
    let count = |status: Status| checks.iter().filter(|check| check.status == status).count();
    let plural = |count: usize| if count == 1 { "" } else { "s" };
    context.log("");
    context.log(&format!(
        "{} ok, {} warning{}, {} failure{}",
        count(Status::Ok),
        count(Status::Warn),
        plural(count(Status::Warn)),
        count(Status::Fail),
        plural(count(Status::Fail))
    ));
    Ok(Outcome::Code(code))
}

#[cfg(test)]
mod tests;
