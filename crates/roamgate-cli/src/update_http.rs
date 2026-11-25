//! `/api/update/check` and `/api/update/install` (http/update
//! createUpdateHandlers), as status codes and JSON bodies (always sent
//! `cache-control: no-store`); the HTTP plumbing is the caller's.

use std::cmp::Ordering;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering as AtomicOrdering};

use roamgate_base::clock::SharedClock;
use roamgate_base::env::{Env, roamgate_env};
use serde_json::{Map, Value, json};

use crate::update::{
    RunProcess, UPDATE_CHECK_CACHE_MS, UpdateManifest, UpdateTarget, compare_version,
    fetch_latest_update_manifest, install_update, is_supervisor_managed, normalize_update_base_url,
    resolve_update_target, run_failure,
};

pub type Answer = (u16, Value);

/// The executable a front runs, as the updater sees it.
#[derive(Debug, Clone)]
pub struct UpdateRuntime {
    pub platform: String,
    pub arch: String,
    /// What an install replaces.
    pub exec_path: String,
    /// The standalone binary, not `bun src/index.ts`.
    pub standalone: bool,
}

/// Exits the front after an install, for its supervisor to start the new
/// one.
pub type ScheduleExit = Arc<dyn Fn() + Send + Sync>;

pub struct UpdateHandlers {
    app_version: String,
    run: RunProcess,
    runtime: UpdateRuntime,
    env: Arc<dyn Env>,
    clock: SharedClock,
    schedule_exit: ScheduleExit,
    target: Option<UpdateTarget>,
    base_url: Result<String, String>,
    installing: AtomicBool,
    cache: std::sync::Mutex<Option<(i64, UpdateManifest)>>,
    /// One manifest download at a time; the others wait for its answer.
    loading: tokio::sync::Mutex<()>,
}

/// The browser's confirmation that it asked (a header other sites cannot
/// send without a preflight).
pub fn has_update_confirmation(header: impl Fn(&str) -> Option<String>) -> bool {
    header("x-roamgate-update")
        .or_else(|| header("x-herdr-gui-update"))
        .as_deref()
        == Some("1")
}

fn error_body(message: &str, extra: Map<String, Value>) -> Value {
    let mut body = Map::new();
    body.insert("error".into(), message.into());
    body.extend(extra);
    Value::Object(body)
}

impl UpdateHandlers {
    pub fn new(
        app_version: String,
        run: RunProcess,
        runtime: UpdateRuntime,
        env: Arc<dyn Env>,
        clock: SharedClock,
        schedule_exit: ScheduleExit,
    ) -> Self {
        let target = resolve_update_target(&runtime.platform, &runtime.arch);
        let base_url =
            normalize_update_base_url(roamgate_env(env.as_ref(), "UPDATE_BASE_URL").as_deref());
        Self {
            app_version,
            run,
            runtime,
            env,
            clock,
            schedule_exit,
            target,
            base_url,
            installing: AtomicBool::new(false),
            cache: std::sync::Mutex::default(),
            loading: tokio::sync::Mutex::new(()),
        }
    }

    fn archive_url(&self, base: &str) -> String {
        match &self.target {
            Some(target) => format!("{base}/{}", target.archive_name),
            None => base.to_owned(),
        }
    }

    fn manifest_url(&self, base: &str) -> String {
        match &self.target {
            Some(target) => format!("{base}/{}", target.manifest_name),
            None => base.to_owned(),
        }
    }

    fn source_details(&self) -> Map<String, Value> {
        let mut details = Map::new();
        if let Ok(base) = &self.base_url {
            details.insert("source_url".into(), self.archive_url(base).into());
            details.insert("metadata_url".into(), self.manifest_url(base).into());
        }
        details
    }

    /// Whether this executable may replace itself, and why not.
    fn capability(&self) -> Result<(), String> {
        if self.target.is_none() {
            return Err(format!(
                "Auto update is not available for {}-{}.",
                self.runtime.platform, self.runtime.arch
            ));
        }
        if !self.runtime.standalone {
            return Err("Auto update is only available in the standalone binary.".into());
        }
        if !is_supervisor_managed(self.env.as_ref()) {
            return Err(
                "Automatic updates require an external process supervisor such as systemd or launchd."
                    .into(),
            );
        }
        Ok(())
    }

    async fn latest(&self, force: bool) -> Result<UpdateManifest, String> {
        let cached = |handlers: &Self| {
            let cache = handlers.cache.lock().unwrap();
            cache
                .as_ref()
                .filter(|(expires, _)| *expires > handlers.clock.now())
                .map(|(_, manifest)| manifest.clone())
        };
        if !force && let Some(manifest) = cached(self) {
            return Ok(manifest);
        }
        let _loading = self.loading.lock().await;
        if !force && let Some(manifest) = cached(self) {
            return Ok(manifest);
        }
        let Some(target) = &self.target else {
            return Err(format!(
                "no update package is available for {}-{}",
                self.runtime.platform, self.runtime.arch
            ));
        };
        let base = self.base_url.clone()?;
        let manifest = fetch_latest_update_manifest(&base, target, &self.run).await?;
        *self.cache.lock().unwrap() =
            Some((self.clock.now() + UPDATE_CHECK_CACHE_MS, manifest.clone()));
        Ok(manifest)
    }

    async fn info(&self) -> Result<Value, String> {
        let capability = self.capability();
        let mut body = Map::new();
        body.insert("current_version".into(), self.app_version.clone().into());
        let Some(target) = &self.target else {
            body.insert("update_available".into(), false.into());
            body.insert("can_auto_update".into(), false.into());
            if let Err(reason) = &capability {
                body.insert("reason".into(), reason.clone().into());
            }
            body.insert(
                "platform".into(),
                format!("{}-{}", self.runtime.platform, self.runtime.arch).into(),
            );
            body.extend(self.source_details());
            return Ok(Value::Object(body));
        };
        if roamgate_env(self.env.as_ref(), "DISABLE_UPDATE_CHECK").as_deref() == Some("1") {
            body.insert("update_available".into(), false.into());
            body.insert("can_auto_update".into(), false.into());
            body.insert(
                "reason".into(),
                "Update checks are disabled by ROAMGATE_DISABLE_UPDATE_CHECK or HERDR_GUI_DISABLE_UPDATE_CHECK."
                    .into(),
            );
            body.insert("platform".into(), target.platform.clone().into());
            body.extend(self.source_details());
            return Ok(Value::Object(body));
        }
        let latest = self.latest(false).await?;
        body.insert("latest_version".into(), latest.version.clone().into());
        body.insert(
            "update_available".into(),
            (compare_version(&latest.version, &self.app_version)? == Ordering::Greater).into(),
        );
        body.insert("can_auto_update".into(), capability.is_ok().into());
        if let Err(reason) = &capability {
            body.insert("reason".into(), reason.clone().into());
        }
        body.insert("platform".into(), latest.platform.into());
        body.extend(self.source_details());
        Ok(Value::Object(body))
    }

    /// `GET /api/update/check`.
    pub async fn check(&self, confirmed: bool) -> Answer {
        if !confirmed {
            return (
                403,
                json!({"error": "Update confirmation header is required."}),
            );
        }
        match self.info().await {
            Ok(body) => (200, body),
            Err(message) => (502, error_body(&message, self.source_details())),
        }
    }

    /// `POST /api/update/install`.
    pub async fn install(&self, confirmed: bool) -> Answer {
        if !confirmed {
            return (
                403,
                json!({"error": "Update confirmation header is required."}),
            );
        }
        let current = || {
            let mut map = Map::new();
            map.insert("current_version".into(), self.app_version.clone().into());
            map
        };
        if let Err(reason) = self.capability() {
            let mut extra = current();
            extra.extend(self.source_details());
            return (409, error_body(&reason, extra));
        }
        let base = match &self.base_url {
            Ok(base) => base.clone(),
            Err(message) => return (500, error_body(message, current())),
        };
        if self.installing.swap(true, AtomicOrdering::SeqCst) {
            return (
                409,
                error_body("An update installation is already in progress.", current()),
            );
        }
        let mut waiting_for_restart = false;
        let answer = self.install_latest(&base, &mut waiting_for_restart).await;
        // Kept until this process exits after a successful install, so no
        // other browser replaces the binary during the restart.
        if !waiting_for_restart {
            self.installing.store(false, AtomicOrdering::SeqCst);
        }
        answer
    }

    async fn install_latest(&self, base: &str, waiting_for_restart: &mut bool) -> Answer {
        let target = self.target.clone().expect("checked by capability");
        let latest = match self.latest(true).await {
            Ok(latest) => latest,
            Err(message) => return (500, error_body(&message, self.source_details())),
        };
        match compare_version(&latest.version, &self.app_version) {
            Err(message) => return (500, error_body(&message, self.source_details())),
            Ok(Ordering::Greater) => {}
            Ok(_) => {
                return (
                    200,
                    json!({
                        "ok": true,
                        "installed": false,
                        "current_version": self.app_version,
                        "latest_version": latest.version,
                        "message": "Already up to date.",
                    }),
                );
            }
        }
        let ran = match install_update(&self.runtime.exec_path, &target, &latest, base, &self.run)
            .await
        {
            Ok(ran) => ran,
            Err(message) => return (500, error_body(&message, self.source_details())),
        };
        if ran.code != 0 {
            return (
                500,
                json!({
                    "error": run_failure(&ran, "install", 1000),
                    "current_version": self.app_version,
                    "latest_version": latest.version,
                }),
            );
        }
        (self.schedule_exit)();
        *waiting_for_restart = true;
        (
            200,
            json!({
                "ok": true,
                "installed": true,
                "current_version": self.app_version,
                "installed_version": latest.version,
                "restart_required": true,
                "restart_scheduled": true,
                "restart_mode": "supervisor",
                "target_path": self.runtime.exec_path,
                "backup_path": format!("{}.previous", self.runtime.exec_path),
            }),
        )
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;
    use std::sync::atomic::AtomicUsize;

    use roamgate_base::clock::SystemClock;

    use super::*;
    use crate::update::Ran;

    const SHA: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn manifest(version: &str, platform: &str) -> String {
        json!({
            "schema": 1, "name": "roamgate", "version": version, "platform": platform,
            "archive": format!("roamgate-{platform}.tar.xz"), "sha256": SHA,
        })
        .to_string()
    }

    fn darwin() -> UpdateRuntime {
        UpdateRuntime {
            platform: "darwin".into(),
            arch: "arm64".into(),
            exec_path: "/Applications/roamgate".into(),
            standalone: true,
        }
    }

    fn linux() -> UpdateRuntime {
        UpdateRuntime {
            platform: "linux".into(),
            arch: "x64".into(),
            exec_path: "/opt/roamgate/roamgate".into(),
            standalone: true,
        }
    }

    fn env(pairs: &[(&str, &str)]) -> Arc<dyn Env> {
        Arc::new(
            pairs
                .iter()
                .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
                .collect::<HashMap<_, _>>(),
        )
    }

    /// Records each run's argv; answers with `answer(call index, argv)`.
    struct Fake {
        calls: Arc<Mutex<Vec<Vec<String>>>>,
        run: RunProcess,
    }

    fn fake(
        answer: impl Fn(usize, &[String]) -> Result<Ran, String> + Send + Sync + 'static,
    ) -> Fake {
        let calls = Arc::new(Mutex::new(Vec::new()));
        let recorded = calls.clone();
        let answer = Arc::new(answer);
        Fake {
            calls,
            run: Arc::new(move |argv, _| {
                let index = {
                    let mut calls = recorded.lock().unwrap();
                    calls.push(argv.clone());
                    calls.len()
                };
                let answer = answer.clone();
                Box::pin(async move { answer(index, &argv) })
            }),
        }
    }

    fn ok(stdout: String) -> Result<Ran, String> {
        Ok(Ran {
            code: 0,
            stdout,
            stderr: String::new(),
        })
    }

    fn handlers(
        version: &str,
        run: RunProcess,
        runtime: UpdateRuntime,
        env: Arc<dyn Env>,
    ) -> (UpdateHandlers, Arc<AtomicUsize>) {
        let exits = Arc::new(AtomicUsize::new(0));
        let counted = exits.clone();
        (
            UpdateHandlers::new(
                version.into(),
                run,
                runtime,
                env,
                Arc::new(SystemClock),
                Arc::new(move || {
                    counted.fetch_add(1, AtomicOrdering::SeqCst);
                }),
            ),
            exits,
        )
    }

    fn launchd() -> Arc<dyn Env> {
        env(&[("XPC_SERVICE_NAME", "dev.herdr.herdr-gui")])
    }

    fn systemd() -> Arc<dyn Env> {
        env(&[("INVOCATION_ID", "invocation-id")])
    }

    #[tokio::test]
    async fn checks_the_package_matching_a_darwin_arm64_standalone_binary() {
        let fake = fake(|_, _| ok(manifest("0.2.17", "darwin-arm64")));
        let (handlers, _) = handlers("0.2.16", fake.run.clone(), darwin(), launchd());
        let (status, body) = handlers.check(true).await;
        assert_eq!(status, 200);
        assert_eq!(body["current_version"], "0.2.16");
        assert_eq!(body["latest_version"], "0.2.17");
        assert_eq!(body["update_available"], true);
        assert_eq!(body["can_auto_update"], true);
        assert_eq!(body["platform"], "darwin-arm64");
        assert_eq!(
            body["source_url"],
            "https://github.com/powerfooI/roamgate/releases/latest/download/roamgate-darwin-arm64.tar.xz"
        );
        let calls = fake.calls.lock().unwrap();
        assert_eq!(calls.len(), 1);
        let command = calls[0].join(" ");
        assert!(command.contains("--max-filesize 4096"));
        assert!(command.contains("roamgate-darwin-arm64.update.json"));
        assert!(!command.contains(".tar.xz") && !command.contains("roamgate-linux-x64"));
    }

    #[tokio::test]
    async fn keeps_linux_x64_update_checks_on_the_linux_archive() {
        let fake = fake(|_, _| ok(manifest("0.2.17", "linux-x64")));
        let (handlers, _) = handlers("0.2.16", fake.run.clone(), linux(), systemd());
        let (status, body) = handlers.check(true).await;
        assert_eq!(status, 200);
        assert_eq!(body["platform"], "linux-x64");
        assert_eq!(body["can_auto_update"], true);
        let command = fake.calls.lock().unwrap()[0].join(" ");
        assert!(command.contains("roamgate-linux-x64.update.json"));
        assert!(!command.contains(".tar.xz") && !command.contains("roamgate-darwin-arm64"));
    }

    #[tokio::test]
    async fn rejects_malformed_manifests_instead_of_treating_them_as_legacy() {
        let fake = fake(|_, _| ok("{}".into()));
        let (handlers, _) = handlers("0.2.16", fake.run.clone(), linux(), systemd());
        let (status, body) = handlers.check(true).await;
        assert_eq!(status, 502);
        assert_eq!(body["error"], "invalid update manifest");
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn does_not_expose_credentials_from_an_invalid_update_base_url() {
        let fake = fake(|_, _| Err("should not run".into()));
        let (handlers, _) = handlers(
            "0.2.16",
            fake.run.clone(),
            linux(),
            env(&[
                ("INVOCATION_ID", "id"),
                (
                    "HERDR_GUI_UPDATE_BASE_URL",
                    "https://example-user:example-password@downloads.example.com/herdr",
                ),
            ]),
        );
        let (status, body) = handlers.check(true).await;
        assert_eq!(status, 502);
        assert_eq!(
            body,
            json!({"error": "ROAMGATE_UPDATE_BASE_URL must not contain credentials"})
        );
        assert!(fake.calls.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn does_not_check_a_mismatched_package_on_unsupported_architectures() {
        let fake = fake(|_, _| Err("should not run".into()));
        let runtime = UpdateRuntime {
            platform: "linux".into(),
            arch: "riscv64".into(),
            ..darwin()
        };
        let (handlers, _) = handlers("0.2.16", fake.run.clone(), runtime, env(&[]));
        let (status, body) = handlers.check(true).await;
        assert_eq!(status, 200);
        assert_eq!(body["update_available"], false);
        assert_eq!(body["can_auto_update"], false);
        assert_eq!(body["platform"], "linux-riscv64");
        assert_eq!(
            body["reason"],
            "Auto update is not available for linux-riscv64."
        );
    }

    #[tokio::test]
    async fn rejects_installation_when_no_external_supervisor_owns_restart() {
        let fake = fake(|_, _| ok(manifest("0.2.17", "darwin-arm64")));
        let (handlers, exits) = handlers("0.2.16", fake.run.clone(), darwin(), env(&[]));
        let (status, body) = handlers.install(true).await;
        assert_eq!(status, 409);
        assert_eq!(
            body["error"],
            "Automatic updates require an external process supervisor such as systemd or launchd."
        );
        assert_eq!(body["current_version"], "0.2.16");
        assert!(fake.calls.lock().unwrap().is_empty());
        assert_eq!(exits.load(AtomicOrdering::SeqCst), 0);
    }

    #[tokio::test]
    async fn rejects_a_release_archive_whose_platform_metadata_does_not_match() {
        let fake = fake(|_, _| ok(manifest("0.2.17", "linux-x64")));
        let (handlers, _) = handlers("0.2.16", fake.run.clone(), darwin(), env(&[]));
        let (status, body) = handlers.check(true).await;
        assert_eq!(status, 502);
        assert_eq!(
            body["error"],
            "latest update platform is linux-x64, expected darwin-arm64"
        );
    }

    #[tokio::test]
    async fn installs_a_darwin_update_and_schedules_only_the_managed_process_exit() {
        let fake = fake(|index, _| {
            if index == 1 {
                ok(manifest("0.2.17", "darwin-arm64"))
            } else {
                ok(String::new())
            }
        });
        let (handlers, exits) = handlers("0.2.16", fake.run.clone(), darwin(), launchd());
        let (status, body) = handlers.install(true).await;
        assert_eq!(status, 200);
        assert_eq!(body["installed"], true);
        assert_eq!(body["installed_version"], "0.2.17");
        assert_eq!(body["restart_mode"], "supervisor");
        assert_eq!(body["target_path"], "/Applications/roamgate");
        let calls = fake.calls.lock().unwrap();
        assert_eq!(calls.len(), 2);
        let script = &calls[1][2];
        for want in [
            "roamgate-darwin-arm64.tar.xz",
            &format!("expected_sha256='{SHA}'"),
            "shasum -a 256 \"$archive\"",
            "sha256sum \"$archive\"",
            "version_file=\"$package_dir/VERSION\"",
            "binary=\"$package_dir/roamgate\"",
            "tar -xJf \"$archive\" -C \"$tmp\"",
            "'roamgate-darwin-arm64/VERSION'",
            "'roamgate-darwin-arm64/roamgate'",
            "target='/Applications/roamgate'",
            "backup=\"$target.previous\"",
            "mktemp \"$target_dir/.$target_base.new.",
        ] {
            assert!(script.contains(want), "{want}");
        }
        assert!(!script.contains(".sha256") && !script.contains("roamgate-linux-x64"));
        let syntax = std::process::Command::new("sh")
            .args(["-n", "-c", script])
            .status()
            .unwrap();
        assert!(syntax.success());
        assert_eq!(exits.load(AtomicOrdering::SeqCst), 1);
    }

    #[tokio::test]
    async fn serializes_update_installs_across_connected_clients() {
        let (gate_tx, gate_rx) = tokio::sync::watch::channel(false);
        let started = Arc::new(tokio::sync::Notify::new());
        let notify = started.clone();
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        let run: RunProcess = Arc::new(move |_, _| {
            let index = counted.fetch_add(1, AtomicOrdering::SeqCst) + 1;
            let notify = notify.clone();
            let mut gate = gate_rx.clone();
            Box::pin(async move {
                if index == 1 {
                    notify.notify_one();
                    let _ = gate.wait_for(|open| *open).await;
                    return ok(manifest("0.2.17", "darwin-arm64"));
                }
                ok(String::new())
            })
        });
        let (handlers, _) = handlers("0.2.16", run, darwin(), launchd());
        let handlers = Arc::new(handlers);
        let first = tokio::spawn({
            let handlers = handlers.clone();
            async move { handlers.install(true).await }
        });
        started.notified().await;
        let (status, body) = handlers.install(true).await;
        assert_eq!(status, 409);
        assert_eq!(
            body["error"],
            "An update installation is already in progress."
        );
        gate_tx.send(true).unwrap();
        assert_eq!(first.await.unwrap().0, 200);
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 2);
        // The restart window keeps the lock.
        assert_eq!(handlers.install(true).await.0, 409);
        assert_eq!(calls.load(AtomicOrdering::SeqCst), 2);
    }

    #[tokio::test]
    async fn does_not_download_an_update_when_the_current_version_is_latest() {
        let fake = fake(|_, _| ok(manifest("0.2.17", "darwin-arm64")));
        let (handlers, exits) = handlers("0.2.17", fake.run.clone(), darwin(), launchd());
        assert_eq!(
            handlers.install(true).await,
            (
                200,
                json!({
                    "ok": true, "installed": false, "current_version": "0.2.17",
                    "latest_version": "0.2.17", "message": "Already up to date.",
                })
            )
        );
        assert_eq!(fake.calls.lock().unwrap().len(), 1);
        assert_eq!(exits.load(AtomicOrdering::SeqCst), 0);
    }

    #[tokio::test]
    async fn returns_an_install_failure_without_scheduling_a_restart() {
        let fake = fake(|index, _| {
            if index % 2 == 1 {
                ok(manifest("0.2.17", "darwin-arm64"))
            } else {
                Ok(Ran {
                    code: 1,
                    stdout: String::new(),
                    stderr: "install failed".into(),
                })
            }
        });
        let (handlers, exits) = handlers("0.2.16", fake.run.clone(), darwin(), launchd());
        assert_eq!(
            handlers.install(true).await,
            (
                500,
                json!({"error": "install failed", "current_version": "0.2.16", "latest_version": "0.2.17"})
            )
        );
        assert_eq!(fake.calls.lock().unwrap().len(), 2);
        assert_eq!(exits.load(AtomicOrdering::SeqCst), 0);
        assert_eq!(handlers.install(true).await.0, 500);
        assert_eq!(fake.calls.lock().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn rejects_install_requests_on_unsupported_architectures_before_download() {
        let fake = fake(|_, _| Err("should not run".into()));
        let runtime = UpdateRuntime {
            platform: "linux".into(),
            arch: "riscv64".into(),
            ..darwin()
        };
        let (handlers, _) = handlers("0.2.16", fake.run.clone(), runtime, env(&[]));
        let (status, body) = handlers.install(true).await;
        assert_eq!(status, 409);
        assert_eq!(
            body["error"],
            "Auto update is not available for linux-riscv64."
        );
        assert_eq!(body["current_version"], "0.2.16");
    }

    /// The real installer against a local mirror: verified, narrowed and
    /// swapped in, the old executable kept; a wrong digest changes nothing.
    #[cfg(unix)]
    async fn install_against_a_mirror(bad_digest: bool) {
        {
            let Some(fixture) = install_fixture(bad_digest) else {
                return;
            };
            let run =
                crate::update::system_run_process(roamgate_exec::process::ProcessRunner::system());
            let runtime = UpdateRuntime {
                platform: roamgate_exec::service::node_platform().into(),
                arch: roamgate_exec::service::node_arch().into(),
                exec_path: fixture.install.display().to_string(),
                standalone: true,
            };
            let (handlers, exits) = handlers(
                "9.8.6",
                run,
                runtime,
                env(&[
                    ("HERDR_GUI_UPDATE_BASE_URL", &fixture.base_url),
                    ("HERDR_GUI_RESTART_SUPERVISOR", "1"),
                ]),
            );
            let (status, body) = handlers.install(true).await;
            let previous = format!("{}.previous", fixture.install.display());
            if bad_digest {
                assert_eq!(status, 500, "{body}");
                assert_eq!(
                    body["error"],
                    "downloaded archive checksum does not match update manifest"
                );
                assert_eq!(exits.load(AtomicOrdering::SeqCst), 0);
                assert_eq!(
                    std::fs::read_to_string(&fixture.install).unwrap(),
                    "old executable\n"
                );
                assert!(!Path::new(&previous).exists());
            } else {
                assert_eq!(status, 200, "{body}");
                assert_eq!(body["installed_version"], "9.8.7");
                assert_eq!(body["backup_path"], previous);
                assert_eq!(exits.load(AtomicOrdering::SeqCst), 1);
                assert_eq!(
                    std::fs::read_to_string(&previous).unwrap(),
                    "old executable\n"
                );
                let version = std::process::Command::new(&fixture.install)
                    .arg("--version")
                    .output()
                    .unwrap();
                assert_eq!(
                    String::from_utf8_lossy(&version.stdout).trim(),
                    "roamgate 9.8.7"
                );
            }
            fixture.server.abort();
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn verifies_narrows_and_atomically_replaces_the_running_executable() {
        install_against_a_mirror(false).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn keeps_the_old_executable_when_the_archive_digest_does_not_match() {
        install_against_a_mirror(true).await;
    }

    #[cfg(unix)]
    use std::path::{Path, PathBuf};

    #[cfg(unix)]
    struct Fixture {
        _dir: tempfile::TempDir,
        install: PathBuf,
        base_url: String,
        server: tokio::task::JoinHandle<()>,
    }

    /// A release of 9.8.7 for this platform served on loopback; None when
    /// this platform has no update package.
    #[cfg(unix)]
    fn install_fixture(bad_digest: bool) -> Option<Fixture> {
        use sha2::{Digest, Sha256};
        use std::os::unix::fs::PermissionsExt;
        let target = resolve_update_target(
            roamgate_exec::service::node_platform(),
            roamgate_exec::service::node_arch(),
        )?;
        let dir = tempfile::tempdir().unwrap();
        let assets = dir.path().join("assets");
        let package = assets.join(&target.package_dir);
        std::fs::create_dir_all(&package).unwrap();
        std::fs::create_dir_all(dir.path().join("installed")).unwrap();
        let install = dir.path().join("installed").join("roamgate");
        std::fs::write(&install, "old executable\n").unwrap();
        std::fs::set_permissions(&install, std::fs::Permissions::from_mode(0o755)).unwrap();
        let binary = package.join("roamgate");
        std::fs::write(
            &binary,
            "#!/bin/sh\n[ \"${1:-}\" = \"--version\" ] && { echo \"roamgate 9.8.7\"; exit 0; }\nexit 1\n",
        )
        .unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::write(
            package.join("VERSION"),
            format!("roamgate 9.8.7 {}\n", target.platform),
        )
        .unwrap();
        let archive = assets.join(&target.archive_name);
        let packed = std::process::Command::new("tar")
            .arg("-C")
            .arg(&assets)
            .arg("-cJf")
            .arg(&archive)
            .arg(&target.package_dir)
            .env("COPYFILE_DISABLE", "1")
            .status()
            .unwrap();
        assert!(packed.success());
        let digest = hex::encode(Sha256::digest(std::fs::read(&archive).unwrap()));
        std::fs::write(
            assets.join(&target.manifest_name),
            json!({
                "schema": 1, "name": "roamgate", "version": "9.8.7", "platform": target.platform,
                "archive": target.archive_name, "sha256": if bad_digest { "0".repeat(64) } else { digest },
            })
            .to_string(),
        )
        .unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let listener = tokio::net::TcpListener::from_std(listener).unwrap();
        let served = assets.clone();
        let server = tokio::spawn(async move {
            use tokio::io::{AsyncReadExt, AsyncWriteExt};
            while let Ok((mut stream, _)) = listener.accept().await {
                let served = served.clone();
                tokio::spawn(async move {
                    let mut request = vec![0u8; 4096];
                    let read = stream.read(&mut request).await.unwrap_or(0);
                    let line = String::from_utf8_lossy(&request[..read]).into_owned();
                    let path = line.split_whitespace().nth(1).unwrap_or("/").to_owned();
                    let name = path.rsplit('/').next().unwrap_or("");
                    let response = match std::fs::read(served.join(name)) {
                        Ok(body) => {
                            let mut head = format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n", body.len()).into_bytes();
                            head.extend(body);
                            head
                        }
                        Err(_) => b"HTTP/1.1 404 Not Found\r\ncontent-length: 9\r\nconnection: close\r\n\r\nnot found".to_vec(),
                    };
                    let _ = stream.write_all(&response).await;
                });
            }
        });
        Some(Fixture {
            _dir: dir,
            install,
            base_url: format!("http://127.0.0.1:{port}"),
            server,
        })
    }

    #[test]
    fn confirmation_headers_share_one_boundary() {
        let headers = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(header, _)| *header == name)
                    .map(|(_, value)| (*value).to_owned())
            }
        };
        assert!(has_update_confirmation(headers(&[(
            "x-roamgate-update",
            "1"
        )])));
        assert!(has_update_confirmation(headers(&[(
            "x-herdr-gui-update",
            "1"
        )])));
        assert!(!has_update_confirmation(headers(&[(
            "x-roamgate-update",
            "0"
        )])));
        assert!(!has_update_confirmation(headers(&[
            ("x-roamgate-update", ""),
            ("x-herdr-gui-update", "1")
        ])));
    }
}
