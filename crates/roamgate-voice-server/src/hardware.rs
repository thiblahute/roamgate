//! What the voice helper can run its models on
//! (server/src/voice/voice-hardware.ts): the GPUs, the memory and the CPU.
//! CUDA on Linux and Windows with nvidia-smi, Metal on Apple silicon, the
//! CPU otherwise.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::{Arc, LazyLock};

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::js;

pub const MIB: f64 = 1024.0 * 1024.0;
pub const GIB: f64 = 1024.0 * MIB;
/// Share of unified memory Metal lets the GPU take, about.
const UNIFIED_GPU_SHARE: f64 = 0.7;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GpuInfo {
    pub vendor: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vram_bytes: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unified_memory: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub driver: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compute_capability: Option<String>,
}

impl GpuInfo {
    fn new(vendor: &str, name: impl Into<String>) -> Self {
        Self {
            vendor: vendor.into(),
            name: name.into(),
            vram_bytes: None,
            unified_memory: None,
            driver: None,
            compute_capability: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Cpu {
    pub model: String,
    pub cores: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceHardware {
    pub platform: String,
    pub arch: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_name: Option<String>,
    pub cpu: Cpu,
    pub ram_bytes: f64,
    pub gpus: Vec<GpuInfo>,
    pub acceleration: String,
    pub gpu_bytes: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// Runs a program with its arguments; None when it is missing or fails.
pub type Capture = Arc<dyn Fn(&[&str]) -> Option<String> + Send + Sync>;
/// Reads a file, or lists a directory, by path.
pub type ReadPath<T> = Arc<dyn Fn(&str) -> T + Send + Sync>;

/// What the detection runs and reads.
#[derive(Clone)]
pub struct HardwareProbe {
    /// `process.platform`: linux, darwin, win32...
    pub platform: String,
    /// `process.arch`: x64, arm64...
    pub arch: String,
    /// Runs a program; None when it is missing or fails.
    pub capture: Capture,
    pub read_file: ReadPath<Option<String>>,
    pub list_dir: ReadPath<Vec<String>>,
    pub cpu: Arc<dyn Fn() -> Cpu + Send + Sync>,
    pub ram_bytes: Arc<dyn Fn() -> f64 + Send + Sync>,
}

/// Node's names for this machine's platform and architecture.
pub fn node_platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        "windows" => "win32",
        other => other,
    }
}

pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// The real machine.
pub fn system_probe() -> HardwareProbe {
    HardwareProbe {
        platform: node_platform().into(),
        arch: node_arch().into(),
        capture: Arc::new(|argv| {
            let (program, args) = argv.split_first()?;
            let mut child = std::process::Command::new(program)
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .ok()?;
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        let mut out = String::new();
                        if let Some(mut stdout) = child.stdout.take() {
                            use std::io::Read as _;
                            let _ = stdout.read_to_string(&mut out);
                        }
                        return status.success().then_some(out);
                    }
                    Ok(None) if std::time::Instant::now() < deadline => {
                        std::thread::sleep(std::time::Duration::from_millis(10));
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        return None;
                    }
                }
            }
        }),
        read_file: Arc::new(|path| std::fs::read_to_string(path).ok()),
        list_dir: Arc::new(|path| {
            std::fs::read_dir(path)
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|entry| entry.file_name().to_string_lossy().into_owned())
                        .collect()
                })
                .unwrap_or_default()
        }),
        cpu: Arc::new(system_cpu),
        ram_bytes: Arc::new(system_ram),
    }
}

/// `os.cpus()`: the first CPU's model, trimmed, and how many there are.
fn system_cpu() -> Cpu {
    let cores = std::thread::available_parallelism().map_or(1, |count| count.get()) as f64;
    let model = std::fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|info| {
            info.lines()
                .find(|line| line.starts_with("model name"))
                .and_then(|line| line.split_once(':'))
                .map(|(_, model)| model.trim().to_owned())
        })
        .unwrap_or_else(|| "unknown".into());
    Cpu { model, cores }
}

/// `os.totalmem()`.
fn system_ram() -> f64 {
    std::fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|info| {
            info.lines()
                .find(|line| line.starts_with("MemTotal:"))
                .and_then(|line| line.split_whitespace().nth(1))
                .and_then(|kb| kb.parse::<f64>().ok())
        })
        .map_or(0.0, |kb| kb * 1024.0)
}

fn number(text: &str) -> Option<f64> {
    let value = roamgate_agents::js::number_from_text(text);
    value.is_finite().then_some(value)
}

/// nvidia-smi's CSV: one GPU a line, memory in MiB.
pub fn parse_nvidia_smi(output: &str) -> Vec<GpuInfo> {
    static CAPABILITY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"^\d+\.\d+$").expect("regex"));
    let mut gpus = Vec::new();
    for line in output.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        let fields: Vec<&str> = line.split(',').map(js::trim).collect();
        if fields.len() < 2 || fields[0].is_empty() {
            continue;
        }
        let mut gpu = GpuInfo::new("nvidia", fields[0]);
        if let Some(mib) = number(fields[1]).filter(|mib| *mib > 0.0) {
            gpu.vram_bytes = Some(mib * MIB);
        }
        if let Some(driver) = fields.get(2).filter(|driver| !driver.is_empty()) {
            gpu.driver = Some((*driver).to_owned());
        }
        if let Some(capability) = fields.get(3).filter(|value| CAPABILITY.is_match(value)) {
            gpu.compute_capability = Some((*capability).to_owned());
        }
        gpus.push(gpu);
    }
    gpus
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => roamgate_base::log::js_number(number),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => "null".into(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// rocm-smi's JSON: an object per card.
pub fn parse_rocm_smi(output: &str) -> Vec<GpuInfo> {
    static CARD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^card\d+$").expect("regex"));
    let Some(Value::Object(parsed)) = serde_json::from_str::<Value>(output).ok() else {
        return Vec::new();
    };
    let mut gpus = Vec::new();
    for (card, value) in &parsed {
        let Some(object) = value.as_object().filter(|_| CARD.is_match(card)) else {
            continue;
        };
        let fields: BTreeMap<String, String> = object
            .iter()
            .map(|(key, field)| (key.to_lowercase(), js_string(field)))
            .collect();
        let name = fields
            .get("card series")
            .or_else(|| fields.get("card model"))
            .or_else(|| fields.get("marketing name"))
            .cloned()
            .unwrap_or_else(|| "AMD GPU".into());
        let mut gpu = GpuInfo::new("amd", name);
        if let Some(vram) = fields
            .get("vram total memory (b)")
            .and_then(|text| number(text))
            .filter(|vram| *vram > 0.0)
        {
            gpu.vram_bytes = Some(vram);
        }
        gpus.push(gpu);
    }
    gpus
}

/// The GPUs Linux's DRM lists.
pub fn drm_gpus(probe: &HardwareProbe) -> Vec<GpuInfo> {
    static CARD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^card\d+$").expect("regex"));
    let root = "/sys/class/drm";
    let mut cards = (probe.list_dir)(root);
    cards.sort();
    let mut gpus = Vec::new();
    for card in cards {
        if !CARD.is_match(&card) {
            continue;
        }
        let device = format!("{root}/{card}/device");
        let Some(vendor_id) = (probe.read_file)(&format!("{device}/vendor"))
            .map(|text| js::trim(&text).to_owned())
            .filter(|text| !text.is_empty())
        else {
            continue;
        };
        let device_id = (probe.read_file)(&format!("{device}/device"))
            .map(|text| js::trim(&text).to_owned())
            .unwrap_or_default();
        let vendor = match vendor_id.as_str() {
            "0x10de" => "nvidia",
            "0x1002" => "amd",
            "0x8086" => "intel",
            _ => "other",
        };
        let label = match vendor {
            "nvidia" => "NVIDIA".to_owned(),
            "amd" => "AMD".into(),
            "intel" => "Intel".into(),
            _ => vendor_id.clone(),
        };
        let mut gpu = GpuInfo::new(
            vendor,
            js::trim(&format!("{label} GPU {device_id}")).to_owned(),
        );
        if let Some(vram) = (probe.read_file)(&format!("{device}/mem_info_vram_total"))
            .and_then(|text| number(js::trim(&text)))
            .filter(|vram| *vram > 0.0)
        {
            gpu.vram_bytes = Some(vram);
        }
        gpus.push(gpu);
    }
    gpus
}

/// "32 GB", "4096 MB": bytes.
fn size_of(text: Option<&Value>) -> Option<f64> {
    static SIZE: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r"(?i)^([\d.]+)\s*(GB|MB|TB)$").expect("regex"));
    let text = text.map(js_string).unwrap_or_default();
    let found = SIZE.captures(js::trim(&text))?;
    let unit = match found[2].to_uppercase().as_str() {
        "MB" => MIB,
        "GB" => GIB,
        _ => 1024.0 * GIB,
    };
    let value = number(&found[1])?;
    Some(js::round(value * unit))
}

/// What system_profiler says of the Mac.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Profile {
    pub gpus: Vec<GpuInfo>,
    pub ram_bytes: Option<f64>,
    pub chip: Option<String>,
}

pub fn parse_system_profiler(output: &str) -> Profile {
    static APPLE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)^apple ").expect("regex"));
    let Some(Value::Object(parsed)) = serde_json::from_str::<Value>(output).ok() else {
        return Profile::default();
    };
    let hardware = parsed
        .get("SPHardwareDataType")
        .and_then(Value::as_array)
        .and_then(|list| list.first())
        .and_then(Value::as_object);
    let ram_bytes = size_of(hardware.and_then(|hardware| hardware.get("physical_memory")));
    let chip = hardware
        .and_then(|hardware| hardware.get("chip_type"))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let mut gpus = Vec::new();
    for entry in parsed
        .get("SPDisplaysDataType")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let name = entry
            .get("sppci_model")
            .filter(|value| !value.is_null())
            .or_else(|| entry.get("_name").filter(|value| !value.is_null()))
            .map_or_else(|| "GPU".to_owned(), js_string);
        let vendor_text = entry
            .get("spdisplays_vendor")
            .filter(|value| !value.is_null())
            .map(js_string)
            .unwrap_or_default()
            .to_lowercase();
        let vendor = if vendor_text.contains("apple") || APPLE.is_match(&name) {
            "apple"
        } else if vendor_text.contains("amd") || vendor_text.contains("ati") {
            "amd"
        } else if vendor_text.contains("intel") {
            "intel"
        } else if vendor_text.contains("nvidia") {
            "nvidia"
        } else {
            "other"
        };
        let vram = size_of(
            entry
                .get("spdisplays_vram")
                .filter(|value| !value.is_null())
                .or_else(|| entry.get("spdisplays_vram_shared")),
        );
        let mut gpu = GpuInfo::new(vendor, name);
        if vendor == "apple" {
            gpu.unified_memory = Some(true);
            gpu.vram_bytes = ram_bytes.filter(|ram| *ram != 0.0);
        } else if let Some(vram) = vram.filter(|vram| *vram != 0.0) {
            gpu.vram_bytes = Some(vram);
        }
        gpus.push(gpu);
    }
    Profile {
        gpus,
        ram_bytes,
        chip,
    }
}

/// PowerShell's Win32_VideoController list: one object, or a list.
pub fn parse_windows_video_controllers(output: &str) -> Vec<GpuInfo> {
    let Ok(parsed) = serde_json::from_str::<Value>(output) else {
        return Vec::new();
    };
    let list = match parsed {
        Value::Array(list) => list,
        other => vec![other],
    };
    list.iter()
        .filter_map(|entry| {
            let name = entry.get("Name")?.as_str()?.to_owned();
            let lower = name.to_lowercase();
            let vendor = if lower.contains("nvidia") {
                "nvidia"
            } else if lower.contains("amd") || lower.contains("radeon") {
                "amd"
            } else if lower.contains("intel") {
                "intel"
            } else {
                "other"
            };
            let mut gpu = GpuInfo::new(vendor, name);
            if let Some(ram) = entry
                .get("AdapterRAM")
                .and_then(|value| match value {
                    Value::Number(number) => number.as_f64(),
                    Value::String(text) => number(text),
                    _ => None,
                })
                .filter(|ram| *ram > 0.0)
            {
                gpu.vram_bytes = Some(ram);
            }
            if let Some(driver) = entry.get("DriverVersion").and_then(Value::as_str) {
                gpu.driver = Some(driver.to_owned());
            }
            Some(gpu)
        })
        .collect()
}

/// /etc/os-release's PRETTY_NAME.
pub fn parse_os_release(text: &str) -> Option<String> {
    static PRETTY: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?m)^PRETTY_NAME=(?:"([^"]*)"|(.*))$"#).expect("regex"));
    let found = PRETTY.captures(text)?;
    let name = found.get(1).or_else(|| found.get(2))?.as_str();
    let name = js::trim(name);
    (!name.is_empty()).then(|| name.to_owned())
}

fn nvidia_gpus(probe: &HardwareProbe) -> Option<Vec<GpuInfo>> {
    let output = (probe.capture)(&[
        "nvidia-smi",
        "--query-gpu=name,memory.total,driver_version,compute_cap",
        "--format=csv,noheader,nounits",
    ])
    .or_else(|| {
        (probe.capture)(&[
            "nvidia-smi",
            "--query-gpu=name,memory.total,driver_version",
            "--format=csv,noheader,nounits",
        ])
    })?;
    Some(parse_nvidia_smi(&output))
}

/// `os.release()` on Windows: the kernel's version ("10.0.19045").
fn os_release() -> String {
    if !cfg!(windows) {
        return String::new();
    }
    std::process::Command::new("cmd")
        .args(["/C", "ver"])
        .output()
        .ok()
        .and_then(|output| {
            let text = String::from_utf8_lossy(&output.stdout).into_owned();
            let start = text.find("Version ")? + "Version ".len();
            let rest = &text[start..];
            let end = rest.find(']').unwrap_or(rest.len());
            let parts: Vec<&str> = rest[..end].trim().split('.').take(3).collect();
            Some(parts.join("."))
        })
        .unwrap_or_default()
}

/// The hardware the voice helper would run on.
pub fn detect_hardware(probe: &HardwareProbe) -> VoiceHardware {
    let platform = probe.platform.clone();
    let arch = probe.arch.clone();
    let mut ram_bytes = (probe.ram_bytes)();
    let mut cpu = (probe.cpu)();
    let os_name: Option<String>;
    let mut gpus: Vec<GpuInfo>;
    let mut nvidia_smi = false;
    if platform == "darwin" {
        let profile = parse_system_profiler(
            &(probe.capture)(&[
                "system_profiler",
                "SPDisplaysDataType",
                "SPHardwareDataType",
                "-json",
            ])
            .unwrap_or_default(),
        );
        gpus = profile.gpus;
        if let Some(ram) = profile.ram_bytes.filter(|ram| *ram != 0.0) {
            ram_bytes = ram;
        }
        if let Some(chip) = profile.chip.filter(|chip| !chip.is_empty())
            && cpu.model == "unknown"
        {
            cpu.model = chip;
        }
        let version =
            (probe.capture)(&["sw_vers", "-productVersion"]).map(|text| js::trim(&text).to_owned());
        os_name = Some(match version.filter(|version| !version.is_empty()) {
            Some(version) => format!("macOS {version}"),
            None => "macOS".into(),
        });
    } else {
        let nvidia = nvidia_gpus(probe);
        nvidia_smi = nvidia.as_ref().is_some_and(|gpus| !gpus.is_empty());
        gpus = nvidia.unwrap_or_default();
        if platform == "win32" {
            let controllers = parse_windows_video_controllers(
                &(probe.capture)(&[
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM,DriverVersion | ConvertTo-Json",
                ])
                .unwrap_or_default(),
            );
            gpus.extend(
                controllers
                    .into_iter()
                    .filter(|gpu| !(nvidia_smi && gpu.vendor == "nvidia")),
            );
            os_name = Some(format!("Windows {}", os_release()));
        } else {
            let rocm = parse_rocm_smi(
                &(probe.capture)(&[
                    "rocm-smi",
                    "--showproductname",
                    "--showmeminfo",
                    "vram",
                    "--json",
                ])
                .unwrap_or_default(),
            );
            let drm: Vec<GpuInfo> = drm_gpus(probe)
                .into_iter()
                .filter(|gpu| {
                    !(nvidia_smi && gpu.vendor == "nvidia")
                        && !(!rocm.is_empty() && gpu.vendor == "amd")
                })
                .collect();
            gpus.extend(rocm);
            gpus.extend(drm);
            let from_release =
                (probe.read_file)("/etc/os-release").and_then(|text| parse_os_release(&text));
            os_name = Some(from_release.unwrap_or_else(|| {
                if platform == "linux" {
                    "Linux".into()
                } else {
                    platform.clone()
                }
            }));
        }
    }
    let (acceleration, gpu_bytes, note) =
        acceleration_for(&platform, &arch, &gpus, nvidia_smi, ram_bytes);
    VoiceHardware {
        platform,
        arch,
        os_name: os_name.filter(|name| !name.is_empty()),
        cpu,
        ram_bytes,
        gpus,
        acceleration: acceleration.into(),
        gpu_bytes,
        note,
    }
}

/// Which GPU the helper's models run on, and how much memory they may take.
pub fn acceleration_for(
    platform: &str,
    arch: &str,
    gpus: &[GpuInfo],
    nvidia_smi: bool,
    ram_bytes: f64,
) -> (&'static str, f64, Option<String>) {
    let nvidia: Vec<&GpuInfo> = gpus.iter().filter(|gpu| gpu.vendor == "nvidia").collect();
    if !nvidia.is_empty() && nvidia_smi && platform != "darwin" {
        let bytes = nvidia
            .iter()
            .map(|gpu| gpu.vram_bytes.unwrap_or(0.0))
            .fold(f64::NEG_INFINITY, f64::max);
        return ("cuda", bytes, None);
    }
    if platform == "darwin" && arch == "arm64" {
        return ("metal", js::round(ram_bytes * UNIFIED_GPU_SHARE), None);
    }
    if !nvidia.is_empty() {
        return (
            "cpu",
            0.0,
            Some("An NVIDIA GPU is here but nvidia-smi is not: with the NVIDIA driver installed, the GPU models can run on it.".into()),
        );
    }
    if platform == "darwin" {
        return (
            "cpu",
            0.0,
            Some("The voice helper runs its GPU models with Metal on Apple silicon only: this Mac runs them on the CPU.".into()),
        );
    }
    if let Some(other) = gpus
        .iter()
        .find(|gpu| gpu.vendor == "amd" || gpu.vendor == "intel")
    {
        return (
            "cpu",
            0.0,
            Some(format!(
                "The voice helper runs its GPU models with CUDA (NVIDIA) or Metal (Apple): {} is not used (no ROCm or Vulkan build), the models run on the CPU.",
                other.name
            )),
        );
    }
    ("cpu", 0.0, None)
}

/// Whether `path` exists (for the probes' callers).
pub fn exists(path: &str) -> bool {
    Path::new(path).exists()
}

#[cfg(test)]
mod tests;
