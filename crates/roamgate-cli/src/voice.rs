//! `roamgate voice` (cli/voice.ts): the low-GPU profile held on or let go,
//! its status and its models set by hand, in low-gpu.json, which the
//! running server follows; the work is roamgate-voice-server's.

use std::path::PathBuf;
use std::sync::Arc;

use roamgate_base::clock::{Clock, SystemClock};
use roamgate_base::json_store::{JsonFormat, to_js_json};
use roamgate_voice_server::config::{read_voice_config, voice_config_path};
use roamgate_voice_server::helper::{BoxFuture, Reload};
use roamgate_voice_server::low_gpu::{
    GAMING_HOLDER, HoldChange, LowGpuDeps, LowGpuHelper, VoiceLowGpu, hold_low_gpu, is_holder_name,
    low_gpu_path, set_low_gpu_models,
};
use roamgate_voice_server::models::{VOICE_COMPONENTS, default_models_dir, format_bytes};
use serde_json::{Map, Value, json};

use crate::args::{Opt, Parsed, parse_command_args};
use crate::commands::{CliRuntime, Failure, finish, wants_help};
use crate::output::Printed;
use crate::push::display_path;

/// The profile `roamgate voice profile` knows.
pub const LOW_GPU_PROFILE: &str = "low-gpu";

/// `roamgate voice --help`, as printed (console.log adds the last newline).
pub fn voice_help() -> String {
    format!(
        "Usage: roamgate voice profile low-gpu on|off|status|models [options]
       roamgate voice gaming on|off|status [options]

The low-GPU profile: while it is on, the voice helper starts with a lighter
set of models, leaving the GPU to a game or another job: the setup
assistant's light tier among the models already here (Parakeet without
Whisper reading again, Kokoro reading on the CPU, the speaker and turn
models). voice.json is not changed. A helper running with the other set
switches once the call or listening it serves ends, or at once with --now
(the call goes on after a short notice and a few seconds' gap).

It is on while someone holds it, or while GameMode (gamemoded) runs as a
call starts. `gaming` is `profile low-gpu --by gaming`.

Actions:
  on              hold it on (as --by, \"manual\" by default)
  off             let it go (as --by; without --by, every holder)
  status          who holds it, and the models it uses
  models [PART=ID ...]
                  set parts of its set by hand (the ids `roamgate setup
                  voice list` shows; PART is {});
                  --reset goes back to the light tier

Options:
  --by NAME       who holds it: a game hook, a job (\"gaming\", \"render\")
  --now           switch a call going on now, not when it ends
  --reset         with models: the light tier for every part
  --json          status as JSON

The state is kept in low-gpu.json in the voice data directory
(~/.local/share/roamgate/voice), which the running server follows.
",
        VOICE_COMPONENTS.join(", ")
    )
}

struct VoicePaths {
    path: PathBuf,
    config_path: PathBuf,
    models_dir: PathBuf,
}

fn paths_for(runtime: &CliRuntime) -> VoicePaths {
    let app_data = runtime.app_data.as_deref();
    VoicePaths {
        path: low_gpu_path(&runtime.home, &runtime.platform, app_data),
        config_path: voice_config_path(&runtime.service().data().data_root()),
        models_dir: default_models_dir(&runtime.home, &runtime.platform, app_data),
    }
}

/// This process has no helper of its own.
struct NoHelper;

impl LowGpuHelper for NoHelper {
    fn reload_models(&self) -> Reload {
        Reload::NotRunning
    }

    fn reload_models_and_wait(&self) -> BoxFuture<Reload> {
        Box::pin(async { Reload::NotRunning })
    }

    fn restart_models(&self) -> bool {
        false
    }

    fn running_profile(&self) -> Option<&'static str> {
        None
    }

    fn current_call_id(&self) -> Option<u64> {
        None
    }

    fn speak_in_call(
        &self,
        _call: u64,
        _text: &str,
        _language: &str,
    ) -> BoxFuture<Result<(), String>> {
        Box::pin(async { Err("no helper".into()) })
    }
}

/// The status as this process sees it: no helper of its own
/// (lowGpuStatus).
fn low_gpu_status(paths: &VoicePaths) -> Value {
    let config_path = paths.config_path.clone();
    VoiceLowGpu::new(LowGpuDeps::new(
        paths.path.clone(),
        Arc::new(move || read_voice_config(&config_path)),
        paths.models_dir.clone(),
        Arc::new(NoHelper),
    ))
    .status()
}

fn strings(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn print_json(printed: &mut Printed, value: &Value) {
    let text = to_js_json(value, JsonFormat::Pretty).unwrap_or_default();
    printed.log(text.trim_end_matches('\n'));
}

fn print_status(status: &Value, runtime: &CliRuntime, json: bool, printed: &mut Printed) {
    if json {
        print_json(printed, status);
        return;
    }
    let holders = strings(&status["holders"]);
    printed.log(&if status["active"] == true {
        format!("Low-GPU voice: on, for {}", holders.join(", "))
    } else {
        "Low-GPU voice: off".into()
    });
    printed.log(
        "(GameMode running as a call starts turns it on too; the server says what the running helper has.)",
    );
    match status["error"].as_str().filter(|error| !error.is_empty()) {
        Some(error) => printed.log(&format!("Its models cannot be chosen: {error}")),
        None => {
            let gpu = status["gpuBytes"].as_f64().unwrap_or(0.0);
            printed.log(&format!(
                "Its models (about {} of GPU memory):",
                format_bytes(gpu)
            ));
            for model in status["models"].as_array().into_iter().flatten() {
                let runs_on = model["runsOn"].as_str().unwrap_or("");
                let place = match runs_on {
                    "none" => String::new(),
                    "any" => " (CPU or GPU)".into(),
                    other => format!(" ({})", other.to_uppercase()),
                };
                printed.log(&format!(
                    "  {}: {}{place}",
                    model["title"].as_str().unwrap_or(""),
                    model["name"].as_str().unwrap_or(""),
                ));
            }
        }
    }
    if let Some(overrides) = status["overrides"]
        .as_object()
        .filter(|map| !map.is_empty())
    {
        let set: Vec<String> = overrides
            .iter()
            .map(|(part, id)| match id {
                Value::String(id) => format!("{part}={id}"),
                other => format!("{part}={other}"),
            })
            .collect();
        printed.log(&format!("Set by hand: {}", set.join(" ")));
    }
    let path = status["path"].as_str().unwrap_or("");
    printed.log(&format!(
        "State: {}",
        display_path(std::path::Path::new(path), runtime)
    ));
}

fn parse_models(words: &[String]) -> Result<Map<String, Value>, Failure> {
    let mut models = Map::new();
    for word in words {
        // `word.split("=", 2)`: the first two pieces.
        let mut pieces = word.split('=');
        let part = pieces.next().unwrap_or("").replace('-', "_");
        let id = pieces.next().unwrap_or("");
        if id.is_empty() || !VOICE_COMPONENTS.contains(&part.as_str()) {
            return Err(Failure::Usage(format!(
                "{word}: PART=ID, PART one of {}",
                VOICE_COMPONENTS.join(", ")
            )));
        }
        models.insert(part, json!(id));
    }
    Ok(models)
}

const PROFILE_OPTIONS: [Opt; 4] = [
    Opt::string("by"),
    Opt::flag("now"),
    Opt::flag("reset"),
    Opt::flag("json"),
];

/// on, off, status, models for `holder` (None: as --by says).
fn run_profile(
    runtime: &CliRuntime,
    args: &[String],
    holder: Option<&str>,
    printed: &mut Printed,
) -> Result<i32, Failure> {
    let action = args.first().map(String::as_str);
    let rest = args.get(1..).unwrap_or_default();
    let max = if action == Some("models") { 32 } else { 0 };
    let parsed: Parsed = parse_command_args(rest, &PROFILE_OPTIONS, max)?;
    let by = holder.map(str::to_owned).or_else(|| parsed.text("by"));
    if let Some(by) = &by
        && !is_holder_name(by)
    {
        return Err(Failure::Usage(format!(
            "--by {by}: letters, digits, dots, dashes or underscores"
        )));
    }
    let paths = paths_for(runtime);
    match action {
        Some("on" | "off") => {
            let change = HoldChange {
                on: action == Some("on"),
                holder: by,
                now: parsed.flag("now"),
            };
            let now = SystemClock.now() as f64;
            let file = hold_low_gpu(&paths.path, &change, now).map_err(Failure::Failed)?;
            let holders: Vec<&str> = file.holders.keys().map(String::as_str).collect();
            printed.log(&if holders.is_empty() {
                "Low-GPU voice: off (unless GameMode runs as a call starts)".to_owned()
            } else {
                format!("Low-GPU voice: on, for {}", holders.join(", "))
            });
            printed.log(if parsed.flag("now") {
                "A call going on switches now, after a short notice."
            } else {
                "A call going on switches when it ends."
            });
            Ok(0)
        }
        Some("status") | None => {
            print_status(
                &low_gpu_status(&paths),
                runtime,
                parsed.flag("json"),
                printed,
            );
            Ok(0)
        }
        Some("models") => {
            let reset = parsed.flag("reset");
            if reset && !parsed.positionals.is_empty() {
                return Err(Failure::Usage("--reset or PART=ID, not both".into()));
            }
            if !reset && parsed.positionals.is_empty() {
                return Err(Failure::Usage("models: PART=ID ..., or --reset".into()));
            }
            let models = if reset {
                None
            } else {
                Some(parse_models(&parsed.positionals)?)
            };
            set_low_gpu_models(&paths.path, models.as_ref()).map_err(Failure::Usage)?;
            print_status(
                &low_gpu_status(&paths),
                runtime,
                parsed.flag("json"),
                printed,
            );
            Ok(0)
        }
        Some(other) => Err(Failure::Usage(format!("unknown action: {other}"))),
    }
}

/// `roamgate voice ...`.
pub fn voice(runtime: &CliRuntime, args: &[String]) -> Printed {
    let mut printed = Printed::default();
    if wants_help(args) {
        printed.log(&voice_help());
        return printed.exit(0);
    }
    let result = match args
        .first()
        .map(String::as_str)
        .filter(|arg| !arg.is_empty())
    {
        Some("gaming") => run_profile(runtime, &args[1..], Some(GAMING_HOLDER), &mut printed),
        Some("profile") => match args
            .get(1)
            .map(String::as_str)
            .filter(|arg| !arg.is_empty())
        {
            Some(LOW_GPU_PROFILE) => run_profile(runtime, &args[2..], None, &mut printed),
            Some(other) => Err(Failure::Usage(format!(
                "unknown voice profile: {other} (there is {LOW_GPU_PROFILE})"
            ))),
            None => Err(Failure::Usage(format!("which profile: {LOW_GPU_PROFILE}"))),
        },
        Some(other) => Err(Failure::Usage(format!("unknown voice command: {other}"))),
        None => Err(Failure::Usage("profile or gaming".into())),
    };
    finish("voice", printed, result)
}

#[cfg(test)]
mod tests;
