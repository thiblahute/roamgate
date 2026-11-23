//! `roamgate reviews` (server/src/cli/reviews.ts): exports or imports what
//! the Reviews panel authored, without the server. The export and the
//! import are roamgate-mr-reviews' history module, the same code as
//! `bridge.mr_reviews.export|import`.

use std::path::{Path, PathBuf};

use roamgate_agents::js;
use roamgate_base::env::roamgate_env;
use roamgate_base::paths::resolve;
use roamgate_mr_reviews::history::{
    ChangeKind, ReviewsExport, apply_ledgers, export_reviews, import_changes, imported_mr_reviews,
    parse_reviews_export, stable_json,
};
use roamgate_mr_reviews::settings::normalize_stored_mr_reviews;
use serde_json::Value;

use crate::auth_token::open_error;
use crate::commands::{CliRuntime, Failure, finish, wants_help};
use crate::output::Printed;
use crate::push::display_path;
use crate::service_context::{read_service_setup, runtime_data_root};

/// `roamgate reviews --help`, as printed (console.log adds the last
/// newline).
pub const REVIEWS_HELP: &str = include_str!("../../../contract/cli/help/reviews.txt");

/// What `roamgate reviews` works with.
pub struct ReviewsCli<'a> {
    pub runtime: &'a CliRuntime,
    /// The export's time (`Date.now`), in milliseconds.
    pub now: &'a dyn Fn() -> f64,
}

/// settings.json read as an object; `{}` when missing or not an object.
fn read_settings_file(path: &Path) -> Result<serde_json::Map<String, Value>, Failure> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::Map::new());
        }
        Err(error) => return Err(Failure::Failed(open_error(&error, path))),
    };
    let value: Value =
        serde_json::from_str(&text).map_err(|error| Failure::Failed(error.to_string()))?;
    Ok(js::js_value(value).as_object().cloned().unwrap_or_default())
}

impl ReviewsCli<'_> {
    /// `roamgate reviews ...`.
    pub fn run(&self, args: &[String]) -> Printed {
        let mut printed = Printed::default();
        if wants_help(args) || args.is_empty() {
            printed.stdout.push_str(REVIEWS_HELP);
            return printed.exit(0);
        }
        let result = self.run_inner(args, &mut printed);
        finish("reviews", printed, result)
    }

    /// settings.json as the server finds it: the service's, else the
    /// default.
    fn settings_path(&self) -> PathBuf {
        read_service_setup(self.runtime)
            .ok()
            .and_then(|setup| roamgate_env(&setup.env, "SETTINGS_PATH"))
            .or_else(|| roamgate_env(self.runtime.env.as_ref(), "SETTINGS_PATH"))
            .map(PathBuf::from)
            .unwrap_or_else(|| self.data_root().join("settings.json"))
    }

    fn data_root(&self) -> PathBuf {
        runtime_data_root(self.runtime)
    }

    fn local(&self, settings: &Path, efforts_root: &Path) -> Result<ReviewsExport, Failure> {
        let stored = read_settings_file(settings)?;
        Ok(export_reviews(
            stored.get("mr_reviews"),
            efforts_root,
            (self.now)(),
        ))
    }

    fn run_inner(&self, args: &[String], printed: &mut Printed) -> Result<i32, Failure> {
        let action = args[0].as_str();
        let settings_file = self.settings_path();
        let efforts_root = self.data_root().join("mr-reviews").join("efforts");
        let context = self.runtime.service().data();
        let write_failed = |error: std::io::Error| Failure::Failed(error.to_string());
        match action {
            "export" => {
                let at = args.iter().position(|arg| arg == "--out");
                let out = at
                    .and_then(|at| args.get(at + 1))
                    .filter(|out| !out.is_empty());
                if at.is_some() && out.is_none() {
                    printed.error("--out needs a file");
                    return Ok(2);
                }
                let text = stable_json(&self.local(&settings_file, &efforts_root)?.to_value());
                let Some(out) = out else {
                    printed.log(js::trim_end(&text));
                    return Ok(0);
                };
                let out = resolve(Path::new(out));
                context
                    .replace_data_file(&out, text.as_bytes(), 0o600)
                    .map_err(write_failed)?;
                printed.log(&format!(
                    "Wrote the Reviews export to {}",
                    display_path(&out, self.runtime)
                ));
                Ok(0)
            }
            "import" => {
                let Some(file) = args[1..].iter().find(|arg| !arg.starts_with("--")) else {
                    printed.error("Usage: roamgate reviews import FILE [--apply]");
                    return Ok(2);
                };
                let path = resolve(Path::new(file));
                let incoming = std::fs::read_to_string(&path)
                    .map_err(|error| open_error(&error, &path))
                    .and_then(|text| parse_reviews_export(&text));
                let incoming = match incoming {
                    Ok(incoming) => incoming,
                    Err(message) => {
                        printed.error(&format!("{file}: {message}"));
                        return Ok(1);
                    }
                };
                let changes =
                    import_changes(&self.local(&settings_file, &efforts_root)?, &incoming);
                for change in &changes {
                    let sign = match change.kind {
                        ChangeKind::Added => "+",
                        ChangeKind::Removed => "-",
                        ChangeKind::Changed => "~",
                    };
                    let newer = if change.newer_local {
                        "  (yours is newer)"
                    } else {
                        ""
                    };
                    printed.log(&format!("{sign} {}{newer}", change.path));
                }
                if changes.is_empty() {
                    printed.log("Nothing would change.");
                }
                if !args.iter().any(|arg| arg == "--apply") {
                    if !changes.is_empty() {
                        printed.log(&format!("{} changes; --apply to make them.", changes.len()));
                    }
                    return Ok(0);
                }
                let mut settings = read_settings_file(&settings_file)?;
                let next = imported_mr_reviews(settings.get("mr_reviews"), &incoming);
                match normalize_stored_mr_reviews(Some(&Value::Object(next))) {
                    Some(next) => {
                        settings.insert("mr_reviews".into(), next);
                    }
                    None => js::delete(&mut settings, "mr_reviews"),
                }
                context
                    .replace_data_file(
                        &settings_file,
                        format!("{}\n", js::stringify_pretty(&Value::Object(settings))).as_bytes(),
                        0o600,
                    )
                    .map_err(write_failed)?;
                let ledgers =
                    apply_ledgers(&context, &incoming, &efforts_root).map_err(write_failed)?;
                printed.log(&format!(
                    "Applied {} changes ({ledgers} effort ledger{}).",
                    changes.len(),
                    if ledgers == 1 { "" } else { "s" }
                ));
                Ok(0)
            }
            other => {
                printed.error(&format!("Unknown reviews action: {other}"));
                Ok(2)
            }
        }
    }
}

#[cfg(test)]
mod tests;
