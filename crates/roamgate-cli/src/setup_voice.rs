//! `roamgate setup voice` (cli/setup.ts): detect the hardware, propose a
//! model for each part of the voice helper, download them and point
//! voice.json at them; `list` shows it all, `remove-unused` frees disk.
//! The work is roamgate-voice-server's setup assistant.

use std::sync::Arc;

use roamgate_voice_server::config::voice_config_path;
use roamgate_voice_server::hardware::{VoiceHardware, detect_hardware, system_probe};
use roamgate_voice_server::models::{
    CUSTOM_MODEL, NO_MODEL, Requirement, VOICE_COMPONENTS, VoiceChoices, default_helper_path,
    default_models_dir, format_bytes, normalize_choices, recommended_choices, requirement_holds,
    starting_choices,
};
use roamgate_voice_server::setup::{
    HardwareSource, InstallOptions, JobProgress, SetupDeps, SetupJob, install_voice_models,
    remove_unused_models, setup_plan, voice_setup_state,
};
use serde_json::Value;
use tokio::sync::{mpsc, watch};

use crate::BoxFuture;
use crate::archive::Output;
use crate::args::{Opt, parse_command_args};
use crate::commands::{CliRuntime, wants_help};
use crate::push::display_path;

/// Each part's option, as `--<flag>` names it.
const FLAG_OF: [(&str, &str); 7] = [
    ("speech", "speech"),
    ("reread", "reread"),
    ("tts", "tts"),
    ("stock_voices", "stock-voices"),
    ("speaker", "speaker"),
    ("turn", "turn"),
    ("text_turn", "text-turn"),
];

fn flag_of(component: &str) -> &'static str {
    FLAG_OF
        .iter()
        .find(|(part, _)| *part == component)
        .map_or("", |(_, flag)| flag)
}

/// `roamgate setup --help`, as printed (console.log adds the last
/// newline).
pub fn setup_help() -> &'static str {
    "Usage: roamgate setup voice [list | remove-unused] [options]

Set up voice chat's models: detect the GPU, memory and CPU, propose models
for each part of the voice helper, download them (resumed, checksums
checked) into the models directory and point voice.json at them. Run it
again to change a model, switch tier, or free disk.

Actions:
  (none)            choose the models, download them, write voice.json,
                    and download the voice helper of this release when it
                    is not installed
  helper            download the voice helper of this release (and its
                    CUDA pack), replacing the one installed
  list              show the hardware, the models and what is installed
  remove-unused     delete the models in the models directory voice.json
                    no longer uses, and unfinished downloads

Options:
  --tier heavy|light   start from this tier's models (default: the
                       hardware's, keeping what voice.json uses)
  --speech ID          speech recognition
  --reread ID|none     Whisper reading Parakeet's English again
  --tts ID             the reading voice
  --stock-voices ID|none
  --speaker ID|none    who speaks
  --turn ID|none       end of turn, from the voice
  --text-turn ID|none  end of turn, from the words
  --helper PATH        the voice helper voice.json names
  --no-helper-download do not download the voice helper
  --cuda, --no-cuda    with the helper, its CUDA pack (default: when an
                       NVIDIA GPU is found)
  --verify             check the checksums of files already in place
  --yes, -y            no questions: the choices as given
  --json               list as JSON

`roamgate setup voice list` shows each part's model ids."
}

/// Asks a question on the terminal: the answer's line.
pub type Ask = Arc<dyn Fn(String) -> BoxFuture<String> + Send + Sync>;

/// What the command works with (SetupCommandDeps).
#[derive(Clone)]
pub struct SetupCommandDeps {
    /// The hardware, detected on this machine by default.
    pub hardware: Option<HardwareSource>,
    /// None when there is no terminal.
    pub ask: Option<Ask>,
    /// The setup's own (tests: the catalog served locally, free space);
    /// the runtime's places by default.
    pub setup: Option<SetupDeps>,
    /// Stops a download on Ctrl-C.
    pub interrupt: bool,
    /// Where a release's voice helper is looked for (a release's download
    /// URL, or a mirror's); None: never (tests).
    pub helper_release: Option<HelperRelease>,
}

/// Where releases are downloaded from.
#[derive(Clone, Copy)]
pub enum HelperRelease {
    /// This version's release, or ROAMGATE_UPDATE_BASE_URL's mirror.
    System,
}

impl SetupCommandDeps {
    /// This machine's hardware, its terminal when stdin is one.
    pub fn system() -> Self {
        Self {
            hardware: None,
            ask: terminal_ask(),
            setup: None,
            interrupt: true,
            helper_release: Some(HelperRelease::System),
        }
    }
}

fn terminal_ask() -> Option<Ask> {
    use std::io::IsTerminal;
    if !std::io::stdin().is_terminal() {
        return None;
    }
    Some(Arc::new(|question: String| {
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                use std::io::{BufRead, Write};
                let mut out = std::io::stdout().lock();
                let _ = out.write_all(question.as_bytes());
                let _ = out.flush();
                let mut line = String::new();
                let _ = std::io::stdin().lock().read_line(&mut line);
                line.trim_end_matches(['\r', '\n']).to_owned()
            })
            .await
            .unwrap_or_default()
        })
    }))
}

enum Failure {
    Failed(String),
    Usage(String),
}

impl From<crate::args::Failure> for Failure {
    fn from(failure: crate::args::Failure) -> Self {
        match failure {
            crate::args::Failure::Failed(message) => Failure::Failed(message),
            crate::args::Failure::Usage(message) => Failure::Usage(message),
        }
    }
}

/// The setup's places on this machine (the runtime's), its hardware
/// detected here: the CLI's and the server's setup alike.
pub fn runtime_setup_deps(runtime: &CliRuntime) -> SetupDeps {
    let app_data = runtime.app_data.as_deref();
    SetupDeps::new(
        default_models_dir(&runtime.home, &runtime.platform, app_data),
        voice_config_path(&runtime.service().data().data_root()),
        default_helper_path(&runtime.home, &runtime.platform, app_data),
        Arc::new(|| detect_hardware(&system_probe())),
    )
}

fn setup_deps(runtime: &CliRuntime, deps: &SetupCommandDeps) -> SetupDeps {
    let mut setup = deps
        .setup
        .clone()
        .unwrap_or_else(|| runtime_setup_deps(runtime));
    if let Some(hardware) = &deps.hardware {
        setup.hardware = hardware.clone();
    }
    setup
}

fn describe_hardware(hardware: &VoiceHardware) -> Vec<String> {
    let mut lines = vec![
        format!(
            "System: {} ({})",
            hardware.os_name.as_deref().unwrap_or(&hardware.platform),
            hardware.arch
        ),
        format!(
            "CPU: {}, {} threads",
            hardware.cpu.model,
            roamgate_voice_server::js::number_text(hardware.cpu.cores)
        ),
        format!("Memory: {}", format_bytes(hardware.ram_bytes)),
    ];
    for gpu in &hardware.gpus {
        let memory = gpu
            .vram_bytes
            .filter(|bytes| *bytes != 0.0)
            .map(|bytes| {
                format!(
                    ", {}{}",
                    format_bytes(bytes),
                    if gpu.unified_memory == Some(true) {
                        " shared"
                    } else {
                        ""
                    }
                )
            })
            .unwrap_or_default();
        let compute = gpu
            .compute_capability
            .as_deref()
            .filter(|compute| !compute.is_empty())
            .map(|compute| format!(", compute {compute}"))
            .unwrap_or_default();
        lines.push(format!("GPU: {}{memory}{compute}", gpu.name));
    }
    if hardware.gpus.is_empty() {
        lines.push("GPU: none found".into());
    }
    lines.push(format!(
        "Runs the GPU models with: {}",
        if hardware.acceleration == "cpu" {
            "the CPU".to_owned()
        } else {
            hardware.acceleration.to_uppercase()
        }
    ));
    if let Some(note) = hardware.note.as_deref().filter(|note| !note.is_empty()) {
        lines.push(note.into());
    }
    lines
}

fn components(state: &Value) -> &[Value] {
    state["components"].as_array().map_or(&[], Vec::as_slice)
}

fn options(component: &Value) -> &[Value] {
    component["options"].as_array().map_or(&[], Vec::as_slice)
}

fn text_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

fn requirement(value: &Value) -> Option<Requirement> {
    serde_json::from_value(value.get("requires")?.clone()).ok()
}

fn choices_of(value: &Value) -> VoiceChoices {
    value
        .as_object()
        .map(|map| {
            map.iter()
                .filter_map(|(part, id)| id.as_str().map(|id| (part.clone(), id.to_owned())))
                .collect()
        })
        .unwrap_or_default()
}

fn runs_on(option: &Value) -> String {
    match text_of(option, "runsOn") {
        "any" => "GPU or CPU".into(),
        other => other.to_uppercase(),
    }
}

fn option_line(state: &Value, component: &str, id: &str) -> String {
    if id == NO_MODEL {
        return "none".into();
    }
    if id == CUSTOM_MODEL {
        return "as voice.json has it".into();
    }
    components(state)
        .iter()
        .find(|entry| entry["id"] == component)
        .and_then(|entry| options(entry).iter().find(|option| option["id"] == id))
        .map_or_else(
            || id.to_owned(),
            |option| {
                format!(
                    "{} ({})",
                    text_of(option, "name"),
                    format_bytes(option["sizeBytes"].as_f64().unwrap_or(0.0))
                )
            },
        )
}

/// `text.padEnd(24)`.
fn pad(text: &str) -> String {
    format!("{text:<24}")
}

fn list_state(out: &mut dyn Output, runtime: &CliRuntime, state: &Value, hardware: &VoiceHardware) {
    let shown = |path: &str| display_path(std::path::Path::new(path), runtime);
    for line in describe_hardware(hardware) {
        out.log(&line);
    }
    out.log(&format!("Proposed tier: {}", text_of(state, "tier")));
    out.log(&format!("Models: {}", shown(text_of(state, "modelsDir"))));
    let helper = &state["helper"];
    out.log(&format!(
        "Helper: {}{}",
        shown(text_of(helper, "path")),
        if helper["found"] == true {
            ""
        } else {
            " (not found: `roamgate setup voice helper` downloads it when this release has one for this platform; else build it with voice/helper/linux/build.sh, or cargo build --release in voice/helper)"
        }
    ));
    if let Some(free) = state["freeBytes"].as_f64() {
        out.log(&format!("Free disk: {}", format_bytes(free)));
    }
    if let Some(error) = state["configError"]
        .as_str()
        .filter(|error| !error.is_empty())
    {
        out.log(&format!("voice.json: {error}"));
    }
    for component in components(state) {
        let id = text_of(component, "id");
        out.log("");
        out.log(&format!(
            "{} (--{}): {}",
            text_of(component, "title"),
            flag_of(id),
            text_of(component, "description")
        ));
        for option in options(component) {
            let option_id = text_of(option, "id");
            let marks: Vec<&str> = [
                (state["current"][id] == option_id, "in use"),
                (state["recommended"]["heavy"][id] == option_id, "heavy"),
                (state["recommended"]["light"][id] == option_id, "light"),
                (option["installed"] == true, "downloaded"),
            ]
            .into_iter()
            .filter_map(|(on, mark)| on.then_some(mark))
            .collect();
            out.log(&format!(
                "  {} {}, {}, {}{}",
                pad(option_id),
                text_of(option, "name"),
                format_bytes(option["sizeBytes"].as_f64().unwrap_or(0.0)),
                runs_on(option),
                if marks.is_empty() {
                    String::new()
                } else {
                    format!(" [{}]", marks.join(", "))
                }
            ));
            out.log(&format!("  {} {}", pad(""), text_of(option, "speed")));
        }
        if component["optional"] == true {
            out.log(&format!("  {} without it", pad("none")));
        }
    }
    let unused = state["unused"].as_array().map_or(&[][..], Vec::as_slice);
    if !unused.is_empty() {
        out.log("");
        out.log("Unused (roamgate setup voice remove-unused):");
        for model in unused {
            out.log(&format!(
                "  {}, {}: {}",
                text_of(model, "name"),
                format_bytes(model["sizeBytes"].as_f64().unwrap_or(0.0)),
                shown(text_of(model, "path"))
            ));
        }
    }
}

/// Asks each part's model, Enter keeping the one proposed.
async fn ask_choices(
    out: &mut dyn Output,
    state: &Value,
    choices: &VoiceChoices,
    ask: &Ask,
) -> VoiceChoices {
    let normalized =
        |chosen: &VoiceChoices| normalize_choices(chosen).unwrap_or_else(|_| chosen.clone());
    let mut chosen = choices.clone();
    for component in components(state) {
        chosen = normalized(&chosen);
        let id = text_of(component, "id");
        let proposed = chosen.get(id).cloned();
        if !requirement_holds(requirement(component).as_ref(), &chosen) {
            continue;
        }
        let offered: Vec<&Value> = options(component)
            .iter()
            .filter(|option| requirement_holds(requirement(option).as_ref(), &chosen))
            .collect();
        let mut ids: Vec<String> = offered
            .iter()
            .map(|option| text_of(option, "id").to_owned())
            .collect();
        if component["optional"] == true {
            ids.push(NO_MODEL.into());
        }
        if proposed.as_deref() == Some(CUSTOM_MODEL) {
            ids.push(CUSTOM_MODEL.into());
        }
        out.log("");
        out.log(&format!(
            "{}: {}",
            text_of(component, "title"),
            text_of(component, "description")
        ));
        for (index, each) in ids.iter().enumerate() {
            let detail = offered
                .iter()
                .find(|option| option["id"] == each.as_str())
                .map(|option| {
                    format!(
                        "{}{}",
                        text_of(option, "speed"),
                        if option["installed"] == true {
                            ", downloaded"
                        } else {
                            ""
                        }
                    )
                })
                .unwrap_or_default();
            out.log(&format!(
                "  {}. {}{}{}",
                index + 1,
                option_line(state, id, each),
                if detail.is_empty() {
                    String::new()
                } else {
                    format!(": {detail}")
                },
                if Some(each) == proposed.as_ref() {
                    "  <-"
                } else {
                    ""
                }
            ));
        }
        let default = ids
            .iter()
            .position(|each| Some(each) == proposed.as_ref())
            .map_or(1, |at| at + 1);
        for _ in 0..5 {
            let answer = ask(format!("Choice [{default}]: ")).await;
            let answer = roamgate_voice_server::js::trim(&answer).to_owned();
            if answer.is_empty() {
                break;
            }
            // `ids[Number(answer) - 1] ?? ids.find(id => id === answer)`.
            let numbered = answer
                .parse::<f64>()
                .ok()
                .filter(|number| number.fract() == 0.0 && *number >= 1.0)
                .and_then(|number| ids.get(number as usize - 1));
            let picked = numbered.or_else(|| ids.iter().find(|each| **each == answer));
            if let Some(picked) = picked {
                chosen.insert(id.to_owned(), picked.clone());
                break;
            }
            out.log(&format!("  1 to {}, or Enter to keep it.", ids.len()));
        }
    }
    normalized(&chosen)
}

fn progress_line(job: &SetupJob) -> String {
    let percent = if job.total_bytes != 0.0 {
        (job.done_bytes * 100.0 / job.total_bytes).floor()
    } else {
        100.0
    };
    let speed = if job.bytes_per_second != 0.0 {
        format!(", {}/s", format_bytes(job.bytes_per_second))
    } else {
        String::new()
    };
    format!(
        "{}% of {}{speed}{}",
        roamgate_voice_server::js::number_text(percent),
        format_bytes(job.total_bytes),
        job.current
            .as_deref()
            .filter(|current| !current.is_empty())
            .map(|current| format!(": {current}"))
            .unwrap_or_default()
    )
}

/// `/^y(es)?$/i` and `/^n(o)?$/i`.
fn is_word(answer: &str, short: &str, long: &str) -> bool {
    let lower = answer.to_ascii_lowercase();
    lower == short || lower == long
}

const SETUP_OPTIONS: [Opt; 15] = [
    Opt::string("tier"),
    Opt::string("speech"),
    Opt::string("reread"),
    Opt::string("tts"),
    Opt::string("stock-voices"),
    Opt::string("speaker"),
    Opt::string("turn"),
    Opt::string("text-turn"),
    Opt::string("helper"),
    Opt::flag("verify"),
    Opt::flag("no-helper-download"),
    Opt::flag("cuda"),
    Opt::flag("no-cuda"),
    Opt::flag("yes").short('y'),
    Opt::flag("json"),
];

async fn run_setup(
    runtime: &CliRuntime,
    deps: &SetupCommandDeps,
    args: &[String],
    out: &mut dyn Output,
) -> Result<i32, Failure> {
    let parsed = parse_command_args(args, &SETUP_OPTIONS, 1).map_err(Failure::from)?;
    let action = parsed.positionals.first().map(String::as_str);
    if let Some(action) = action
        && action != "list"
        && action != "remove-unused"
        && action != "helper"
    {
        return Err(Failure::Usage(format!("unknown action: {action}")));
    }
    let tier = parsed.text("tier");
    if let Some(tier) = &tier
        && tier != "heavy"
        && tier != "light"
    {
        return Err(Failure::Usage("--tier is heavy or light".into()));
    }
    let setup = setup_deps(runtime, deps);
    let state = voice_setup_state(&setup, None).map_err(Failure::Failed)?;
    // The hardware the state was made with: detected once.
    let hardware: VoiceHardware = serde_json::from_value(state["hardware"].clone())
        .map_err(|error| Failure::Failed(error.to_string()))?;
    let shown = |path: &std::path::Path| display_path(path, runtime);

    if action == Some("list") {
        if parsed.flag("json") {
            let text = roamgate_base::json_store::to_js_json(
                &state,
                roamgate_base::json_store::JsonFormat::Pretty,
            )
            .unwrap_or_default();
            out.log(text.trim_end_matches('\n'));
        } else {
            list_state(out, runtime, &state, &hardware);
        }
        return Ok(0);
    }
    if action == Some("helper") {
        let path = parsed
            .text("helper")
            .filter(|helper| !helper.is_empty())
            .map_or_else(|| setup.helper_path.clone(), std::path::PathBuf::from);
        return match download_helper(runtime, deps, &parsed, &hardware, &path, out).await? {
            true => Ok(0),
            false => Ok(1),
        };
    }
    if action == Some("remove-unused") {
        let unused = state["unused"].as_array().cloned().unwrap_or_default();
        if unused.is_empty() {
            out.log("Nothing unused in the models directory.");
            return Ok(0);
        }
        for model in &unused {
            out.log(&format!(
                "{}, {}: {}",
                text_of(model, "name"),
                format_bytes(model["sizeBytes"].as_f64().unwrap_or(0.0)),
                shown(std::path::Path::new(text_of(model, "path")))
            ));
        }
        if !parsed.flag("yes") {
            let Some(ask) = &deps.ask else {
                return Err(Failure::Usage("--yes is needed without a terminal".into()));
            };
            let answer = ask("Delete them? [y/N] ".into()).await;
            if !is_word(roamgate_voice_server::js::trim(&answer), "y", "yes") {
                return Ok(0);
            }
        }
        let (_, freed) = remove_unused_models(None, &setup).map_err(Failure::Failed)?;
        out.log(&format!("Freed {}.", format_bytes(freed)));
        return Ok(0);
    }

    for line in describe_hardware(&hardware) {
        out.log(&line);
    }
    let proposed = text_of(&state, "tier").to_owned();
    let mut choices = starting_choices(
        &recommended_choices(&hardware),
        &proposed,
        &choices_of(&state["current"]),
        tier.as_deref(),
    );
    for component in VOICE_COMPONENTS {
        if let Some(value) = parsed.text(flag_of(component)) {
            choices.insert(component.to_owned(), value);
        }
    }
    choices = normalize_choices(&choices).map_err(Failure::Usage)?;
    let yes = parsed.flag("yes");
    if !yes && let Some(ask) = &deps.ask {
        out.log(&format!(
            "\nProposed: the {} tier. Enter keeps each choice.",
            tier.as_deref().unwrap_or(&proposed)
        ));
        choices = ask_choices(out, &state, &choices, ask).await;
    }
    let plan = setup_plan(&choices, &setup).map_err(Failure::Failed)?;
    let total: f64 = plan.downloads.iter().map(|file| file.target.size).sum();
    out.log("");
    for component in components(&state) {
        let id = text_of(component, "id");
        if let Some(choice) = choices.get(id) {
            out.log(&format!(
                "{}: {}",
                text_of(component, "title"),
                option_line(&state, id, choice)
            ));
        }
    }
    out.log(&if total != 0.0 {
        format!(
            "To download: {} into {}",
            format_bytes(total),
            shown(&setup.models_dir)
        )
    } else {
        "Everything is downloaded already.".into()
    });
    if !yes {
        let Some(ask) = &deps.ask else {
            return Err(Failure::Usage("--yes is needed without a terminal".into()));
        };
        let question = if total != 0.0 {
            "Download and write voice.json? [Y/n] "
        } else {
            "Write voice.json? [Y/n] "
        };
        let answer = ask(question.into()).await;
        if is_word(roamgate_voice_server::js::trim(&answer), "n", "no") {
            return Ok(0);
        }
    }
    let (stop, signal) = watch::channel(false);
    // Kept while the download runs: a dropped sender reads as a stop.
    let stop = Arc::new(stop);
    let interrupt = deps.interrupt.then(|| {
        let stop = stop.clone();
        tokio::spawn(async move {
            if tokio::signal::ctrl_c().await.is_ok() {
                let _ = stop.send(true);
            }
        })
    });
    let (lines, mut printed) = mpsc::unbounded_channel::<String>();
    let clock = setup.clock.clone();
    let last = std::sync::Mutex::new((0i64, -1f64));
    let on_progress: JobProgress = Arc::new(move |job: &SetupJob| {
        if job.state != "downloading" || job.total_bytes == 0.0 {
            return;
        }
        let percent = (job.done_bytes * 100.0 / job.total_bytes).floor();
        let now = clock.now();
        let mut last = last.lock().unwrap_or_else(|poison| poison.into_inner());
        if percent != last.1 && (now - last.0 >= 2000 || percent == 100.0) {
            *last = (now, percent);
            let _ = lines.send(progress_line(job));
        }
    });
    let options = InstallOptions {
        signal: Some(signal.clone()),
        on_progress: Some(on_progress),
        verify: parsed.flag("verify"),
        helper: parsed.text("helper").filter(|helper| !helper.is_empty()),
    };
    let result = {
        let install = install_voice_models(&choices, &setup, &options);
        tokio::pin!(install);
        loop {
            tokio::select! {
                result = &mut install => break result,
                Some(line) = printed.recv() => out.log(&line),
            }
        }
    };
    drop(options);
    while let Ok(line) = printed.try_recv() {
        out.log(&line);
    }
    if let Some(interrupt) = interrupt {
        interrupt.abort();
    }
    match result {
        Ok((_, patch)) => {
            let keys: Vec<&str> = patch.keys().map(String::as_str).collect();
            out.log(&format!(
                "Wrote {}: {}.",
                shown(&setup.config_path),
                if keys.is_empty() {
                    "nothing changed".to_owned()
                } else {
                    keys.join(", ")
                }
            ));
        }
        Err(_) if *signal.borrow() => {
            out.error("Stopped: run it again to resume where the download stopped.");
            return Ok(1);
        }
        Err(error) => return Err(Failure::Failed(error.message)),
    }
    let mut after = voice_setup_state(&setup, None).map_err(Failure::Failed)?;
    if after["helper"]["found"] != true && !parsed.flag("no-helper-download") {
        let path = std::path::PathBuf::from(text_of(&after["helper"], "path"));
        download_helper(runtime, deps, &parsed, &hardware, &path, out).await?;
        after = voice_setup_state(&setup, None).map_err(Failure::Failed)?;
    }
    if after["helper"]["found"] != true {
        out.log(&format!(
            "The voice helper is not at {} yet: build it (voice/helper/linux/build.sh on Linux) and install it there, or pass --helper.",
            shown(std::path::Path::new(text_of(&after["helper"], "path")))
        ));
    }
    out.log(
        "A running voice helper keeps the models it loaded until it stops: `roamgate service restart` loads the new ones now.",
    );
    let unused = after["unused"].as_array().map_or(&[][..], Vec::as_slice);
    if !unused.is_empty() {
        let bytes: f64 = unused
            .iter()
            .map(|model| model["sizeBytes"].as_f64().unwrap_or(0.0))
            .sum();
        out.log(&format!(
            "{} unused model(s), {}: `roamgate setup voice remove-unused` frees them.",
            unused.len(),
            format_bytes(bytes)
        ));
    }
    Ok(0)
}

/// The base URL of this version's release assets: ROAMGATE_UPDATE_BASE_URL's
/// mirror when set, else this version's GitHub release.
fn release_base_url(runtime: &CliRuntime) -> Result<String, String> {
    match roamgate_base::env::roamgate_env(runtime.env.as_ref(), "UPDATE_BASE_URL") {
        Some(mirror) => crate::update::normalize_update_base_url(Some(&mirror)),
        None => Ok(format!(
            "{}/download/v{}",
            crate::update::RELEASES_URL,
            runtime.version
        )),
    }
}

/// Downloads this release's voice helper for this platform to `path`, with
/// its CUDA pack when asked or when an NVIDIA GPU is found, after asking
/// unless --yes. False when it was not installed (no helper in this
/// release for this platform, declined, or no terminal to ask on).
async fn download_helper(
    runtime: &CliRuntime,
    deps: &SetupCommandDeps,
    parsed: &crate::args::Parsed,
    hardware: &VoiceHardware,
    path: &std::path::Path,
    out: &mut dyn Output,
) -> Result<bool, Failure> {
    use roamgate_voice_server::helper_release::{
        fetch_helper_manifest, helper_platform, install_helper_release,
    };
    if deps.helper_release.is_none() {
        return Ok(false);
    }
    let Some(platform) = helper_platform(&runtime.platform, &runtime.arch) else {
        out.log(&format!(
            "Releases carry no voice helper for {}-{}.",
            runtime.platform, runtime.arch
        ));
        return Ok(false);
    };
    let base = release_base_url(runtime).map_err(Failure::Failed)?;
    let setup = setup_deps(runtime, deps);
    let manifest =
        match fetch_helper_manifest(&base, &platform, &runtime.version, setup.fetch.as_ref()).await
        {
            Ok(Some(manifest)) => manifest,
            Ok(None) => {
                out.log(&format!(
                    "This release ({}) has no voice helper for {platform}.",
                    runtime.version
                ));
                return Ok(false);
            }
            Err(error) => {
                out.error(&format!("The voice helper could not be looked up: {error}"));
                return Ok(false);
            }
        };
    let nvidia = hardware.gpus.iter().any(|gpu| gpu.vendor == "nvidia");
    let cuda =
        manifest.cuda.is_some() && !parsed.flag("no-cuda") && (parsed.flag("cuda") || nvidia);
    let size = manifest.helper.size
        + manifest
            .cuda
            .as_ref()
            .filter(|_| cuda)
            .map_or(0.0, |pack| pack.size);
    out.log(&format!(
        "Voice helper {}{}: {} into {}",
        manifest.version,
        if cuda { " with its CUDA pack" } else { "" },
        format_bytes(size),
        display_path(path.parent().unwrap_or(path), runtime)
    ));
    if !parsed.flag("yes") {
        let Some(ask) = &deps.ask else {
            out.log("Pass --yes to download it without a terminal.");
            return Ok(false);
        };
        let answer = ask("Download the voice helper? [Y/n] ".into()).await;
        if is_word(roamgate_voice_server::js::trim(&answer), "n", "no") {
            return Ok(false);
        }
    }
    let options = roamgate_voice_server::download::DownloadOptions {
        fetch: setup.fetch.clone(),
        retry_delay_ms: setup.retry_delay_ms,
        ..Default::default()
    };
    match install_helper_release(&base, &manifest, path, cuda, &options).await {
        Ok(installed) => {
            out.log(&format!(
                "Installed the voice helper at {}{}.",
                display_path(&installed.helper, runtime),
                if installed.cuda {
                    " with its CUDA pack"
                } else {
                    ""
                }
            ));
            Ok(true)
        }
        Err(error) => Err(Failure::Failed(format!("the voice helper: {error}"))),
    }
}

/// `roamgate setup ...`; returns the exit code.
pub async fn setup(
    runtime: &CliRuntime,
    deps: &SetupCommandDeps,
    args: &[String],
    out: &mut dyn Output,
) -> i32 {
    if wants_help(args) {
        out.log(setup_help());
        return 0;
    }
    let result = match args.first().map(String::as_str) {
        Some("voice") => run_setup(runtime, deps, &args[1..], out).await,
        Some(other) if !other.is_empty() => Err(Failure::Usage(format!("unknown setup: {other}"))),
        _ => Err(Failure::Usage("what to set up: voice".into())),
    };
    match result {
        Ok(code) => code,
        Err(Failure::Failed(message)) => {
            out.error(&format!("roamgate setup: {message}"));
            1
        }
        Err(Failure::Usage(message)) => {
            out.error(&format!("roamgate setup: {message}"));
            out.error("Run `roamgate setup --help` for usage.");
            2
        }
    }
}

#[cfg(test)]
mod tests;
